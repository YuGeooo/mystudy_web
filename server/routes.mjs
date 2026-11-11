import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import config from './config.mjs';
import { get } from './db.mjs';
import { buildMeta, buildDays } from './aggregate.mjs';
import { todayLocal } from './dates.mjs';
import * as pages from './pages.mjs';
import * as read from './read-api.mjs';
import { runSqlIsolated, toCsv, SqlError } from './sql.mjs';
import { ApiError, createSession, patchSession, addAttempt, patchAttempt, resolveRedo, deleteSession, deleteAttempt } from './write.mjs';
import {
  createPaper, patchPaper, deletePaper, createQuestion, patchQuestion, deleteQuestion,
} from './catalog.mjs';
import { snapshot, listBackups } from './backup.mjs';
import { exportAll } from './export.mjs';

const MAX_BODY = 2 * 1024 * 1024;

function send(res, status, data) {
  const body = JSON.stringify(data, null, 2) + '\n';
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new ApiError(413, 'body_too_large', `请求体超过 ${MAX_BODY} 字节`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new ApiError(400, 'invalid_json', '请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

/** 写操作必须带 Bearer token；token 来自环境变量或配置，不进版本库。 */
function requireAuth(req) {
  const header = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m || !config.writeToken || !safeEqual(m[1], config.writeToken)) {
    throw new ApiError(401, 'unauthorized', '需要 Authorization: Bearer <token>');
  }
}

const q = (url, key) => url.searchParams.get(key) || null;

/**
 * 写成功后立刻重导 JSON（index.json / content.json）。
 *
 * 线上页面由定时任务按 `data/` 四个文件的 sha256 变化触发重建，只写库不导 JSON，
 * 页面就永远停留在旧数据。导出失败不能让写请求报错 —— 库已经改好了，
 * 报 500 会让人误以为没写进去，所以只把错误挂在响应里。
 */
function sendAfterWrite(res, status, payload) {
  let exported = null;
  let exportError = null;
  try {
    exported = exportAll(config);
  } catch (err) {
    exportError = err.message;
    console.error(`[export] 写后导出失败：${err.message}`);
  }
  // JSON 契约换好之后立刻重建页表：这一次请求返回时，页面已经是新的了。
  const site = pages.rebuildSafe('write');
  return send(res, status, {
    ok: true,
    ...payload,
    ...(exported ? { exported } : {}),
    ...(exportError ? { exportError } : {}),
    site: { version: site.version, pages: site.pages, ms: site.ms, error: site.error },
  });
}

// 只有这几个前缀是可写端点。只读进程对它们返回 404（不暴露能力），
// 对其余路径的非 GET 仍返回 405（确实是方法用错了）。
const WRITABLE_ROOTS = new Set(['sessions', 'attempts', 'export', 'papers', 'questions', 'backups']);

/**
 * 只读 SQL：`GET /api/sql?sql=...` 或 `POST /api/sql {"sql":"..."}`。
 *
 * 是读操作，但仍然要 token —— 一条 `select * from attempts` 就能把整库导走，
 * 和写一样属于「只有本人能做的事」。加 `?format=csv` 直接拿 CSV。
 *
 * 语句在子进程里执行，校验与超时都在 `server/sqlrun.mjs`（与 SSH 那条路同一份代码）。
 */
async function handleSql(req, res, url, method) {
  if (!['GET', 'HEAD', 'POST'].includes(method)) {
    return send(res, 405, {
      error: 'method not allowed', method,
      hint: 'GET /api/sql?sql=select+1  或  POST /api/sql {"sql":"select 1"}',
    });
  }
  requireAuth(req);

  const payload = method === 'POST' ? await readBody(req) : {};
  const sql = String(payload.sql ?? q(url, 'sql') ?? '');
  const maxRows = payload.maxRows ?? q(url, 'maxRows');
  const format = String(payload.format ?? q(url, 'format') ?? 'json').toLowerCase();

  if (!sql.trim()) {
    throw new ApiError(400, 'bad_request', 'sql 为空：POST {"sql":"..."} 或 ?sql=...');
  }
  if (format !== 'json' && format !== 'csv') {
    throw new ApiError(400, 'bad_format', 'format 只支持 json / csv');
  }

  let result;
  try {
    result = await runSqlIsolated(config.dbPath, sql, { maxRows });
  } catch (err) {
    if (err instanceof SqlError) {
      const status = err.code === 'timeout' ? 408
        : (err.code === 'no_database' || err.code === 'open_failed') ? 500
          : 400;
      throw new ApiError(status, err.code, err.message);
    }
    throw err;
  }

  if (format === 'csv') {
    const body = toCsv(result.columns, result.rows);
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
    });
    return res.end(method === 'HEAD' ? undefined : body);
  }

  // db 只回文件名：绝对路径是服务器内部结构，没必要出现在响应里
  return send(res, 200, { ok: true, db: path.basename(config.dbPath), ...result });
}

export async function handle(req, res) {
  const url = new URL(req.url, `http://${config.host}:${config.port}`);

  // 站点静态产物
  if (url.pathname === '/' || url.pathname === '/study') {
    res.writeHead(302, { Location: '/study/' });
    return res.end();
  }
  if (url.pathname.startsWith('/study/')) {
    // 页面在进程内按请求给出，数据变了立刻可见（不再等构建产物刷新）
    return pages.serve(req, res, url.pathname, todayLocal(config.timeZone));
  }

  if (!url.pathname.startsWith('/api')) {
    return send(res, 404, { error: 'not found', path: url.pathname, hint: '站点在 /study/' });
  }

  const method = req.method;
  const seg = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const [, a, b, c] = seg;

  try {
    // ---------- 只读 SQL（不走写模式开关，但同样要 token） ----------
    if (a === 'sql' && !b) {
      return await handleSql(req, res, url, method);
    }

    // ---------- 写入（未开启写模式时完全不注册，返回 404） ----------
    if (method !== 'GET' && method !== 'HEAD') {
      if (!config.writeEnabled) {
        if (WRITABLE_ROOTS.has(a)) {
          return send(res, 404, {
            error: 'not found',
            path: url.pathname,
            hint: '本进程以只读模式运行，写接口未启用',
          });
        }
        return send(res, 405, { error: '只提供 GET / HEAD', method: req.method });
      }
      requireAuth(req);

      // 写库前先留快照：题/卷改动最容易一键改坏，没有退路就不动数据。
      // 导出与手动备份本身不写库，跳过。
      if (config.backupBeforeWrite && a !== 'export' && a !== 'backups') {
        snapshot(`${method}-${a}`);
      }

      if (method === 'POST' && a === 'sessions' && !b) {
        const body = await readBody(req);
        return sendAfterWrite(res, 201, createSession(body));
      }
      if (method === 'POST' && a === 'sessions' && b && c === 'attempts') {
        const body = await readBody(req);
        return sendAfterWrite(res, 201, addAttempt(b, body));
      }
      if (method === 'PATCH' && a === 'sessions' && b && !c) {
        const body = await readBody(req);
        return sendAfterWrite(res, 200, patchSession(b, body));
      }
      if (method === 'DELETE' && a === 'sessions' && b) {
        return sendAfterWrite(res, 200, deleteSession(b));
      }
      if (method === 'DELETE' && a === 'attempts' && b && !c) {
        return sendAfterWrite(res, 200, deleteAttempt(b));
      }
      if (method === 'PATCH' && a === 'attempts' && b && !c) {
        const body = await readBody(req);
        return sendAfterWrite(res, 200, patchAttempt(b, body));
      }
      if (method === 'POST' && a === 'attempts' && b && c === 'resolve') {
        const body = await readBody(req);
        return sendAfterWrite(res, 200, resolveRedo(b, body));
      }
      if (method === 'POST' && a === 'export' && !b) {
        // 手动重导出：把库导成 JSON，并重建页表（否则页面还是旧的）
        const exported = exportAll(config);
        const site = pages.rebuildSafe('export');
        return send(res, 200, {
          ok: true,
          ...exported,
          site: { version: site.version, pages: site.pages, ms: site.ms, error: site.error },
        });
      }
      if (method === 'POST' && a === 'backups' && !b) {
        return send(res, 201, { ok: true, ...snapshot('manual') });
      }
      if (method === 'POST' && a === 'papers' && !b) {
        const body = await readBody(req);
        return sendAfterWrite(res, 201, createPaper(body));
      }
      if (method === 'PATCH' && a === 'papers' && b && !c) {
        const body = await readBody(req);
        return sendAfterWrite(res, 200, patchPaper(b, body));
      }
      if (method === 'DELETE' && a === 'papers' && b && !c) {
        return sendAfterWrite(res, 200, deletePaper(b));
      }
      if (method === 'POST' && a === 'questions' && !b) {
        const body = await readBody(req);
        return sendAfterWrite(res, 201, createQuestion(body));
      }
      if (method === 'PATCH' && a === 'questions' && b && !c) {
        const body = await readBody(req);
        return sendAfterWrite(res, 200, patchQuestion(b, body));
      }
      if (method === 'DELETE' && a === 'questions' && b && !c) {
        return sendAfterWrite(res, 200, deleteQuestion(b));
      }
      return send(res, 405, {
        error: 'method not allowed', method, path: url.pathname,
        hint: '可写端点：POST /api/sessions · PATCH /api/sessions/:id · ' +
          'POST /api/sessions/:id/attempts · DELETE /api/sessions/:id · ' +
          'PATCH /api/attempts/:id · DELETE /api/attempts/:id · ' +
          'POST /api/attempts/:id/resolve · ' +
          'POST /api/papers · PATCH /api/papers/:slug · DELETE /api/papers/:slug · ' +
          'POST /api/questions · PATCH /api/questions/:id · DELETE /api/questions/:id · ' +
          'POST /api/export · POST /api/backups',
      });
    }

    // ---------- 只读 ----------
    if (a === 'health') {
      return send(res, 200, {
        ok: true,
        sqlite: get('SELECT sqlite_version() AS version').version,
        readOnly: config.readOnly,
        writeEnabled: config.writeEnabled,
        sql: Boolean(config.writeToken),
        database: config.database,
        config: config.configName,
        site: pages.status(),
      });
    }
    if (a === 'meta') return send(res, 200, buildMeta({ timeZone: config.timeZone }));
    if (a === 'days') {
      return send(res, 200, buildDays({
        timeZone: config.timeZone,
        today: todayLocal(config.timeZone),
      }));
    }
    // 页面数据的全集：直接返回渲染页表时算好的那份 buildData()。
    // 加 `?section=` 只取一节（stats / volumes / knowledge / days / weeks / countdown…）。
    if (a === 'study') {
      // 与页面请求走同一个新鲜度检查：绕过接口改了库，接口也不能给旧数据
      pages.ensureFresh(todayLocal(config.timeZone));
      const data = pages.getSiteData();
      if (!data) throw new ApiError(503, 'site_unavailable', '页表还没建好，稍后重试');
      const section = q(url, 'section');
      if (!section) return send(res, 200, data);
      if (!Object.hasOwn(data, section)) {
        throw new ApiError(400, 'bad_section', `没有这一节：${section}`, {
          sections: Object.keys(data),
        });
      }
      return send(res, 200, data[section]);
    }
    if (a === 'papers') {
      if (!b) return send(res, 200, { papers: read.listPapers() });
      const paper = read.getPaper(b);
      if (!paper) throw new ApiError(404, 'not_found', `卷不存在：${b}`);
      return send(res, 200, paper);
    }
    if (a === 'questions') {
      if (!b) {
        return send(res, 200, {
          questions: read.listQuestions({
            paper: q(url, 'paper'),
            topic: q(url, 'topic'),
            q: q(url, 'q'),
            limit: q(url, 'limit'),
            offset: q(url, 'offset'),
            content: q(url, 'include') === 'content',
          }),
        });
      }
      const question = read.getQuestion(b, { content: q(url, 'include') !== 'meta' });
      if (!question) throw new ApiError(404, 'not_found', `题目不存在：${b}`);
      return send(res, 200, question);
    }
    if (a === 'sessions') {
      if (!b) {
        return send(res, 200, {
          sessions: read.listSessions({
            from: q(url, 'from'),
            to: q(url, 'to'),
            paper: q(url, 'paper'),
            limit: q(url, 'limit'),
            offset: q(url, 'offset'),
          }),
        });
      }
      const session = read.getSession(b, { process: q(url, 'include') === 'process' });
      if (!session) throw new ApiError(404, 'not_found', `场次不存在：${b}`);
      return send(res, 200, session);
    }
    if (a === 'attempts') {
      if (b) {
        const attempt = read.getAttempt(b, { process: q(url, 'include') === 'process' });
        if (!attempt) throw new ApiError(404, 'not_found', `作答不存在：${b}`);
        return send(res, 200, attempt);
      }
      return send(res, 200, {
        attempts: read.listAttempts({
          questionId: q(url, 'questionId'),
          redoStatus: q(url, 'redoStatus'),
          limit: q(url, 'limit'),
          offset: q(url, 'offset'),
          process: q(url, 'include') === 'process',
        }),
      });
    }
    if (a === 'backups') {
      return send(res, 200, {
        keep: config.backupKeep,
        beforeWrite: config.backupBeforeWrite,
        backups: listBackups(),
        restore: 'scripts/restore.sh <备份目录>（恢复需停服务，故不提供 HTTP 接口）',
      });
    }
    if (a === 'redo') return send(res, 200, { redo: read.listRedo() });

    return send(res, 404, {
      error: 'not found', path: url.pathname,
      endpoints: [
        'GET /api/health', 'GET /api/meta', 'GET /api/days',
        'GET /api/study?section=stats|volumes|knowledge|days|weeks|countdown',
        'GET /api/papers', 'GET /api/papers/:slug',
        'GET /api/questions', 'GET /api/questions/:id',
        'GET /api/sessions', 'GET /api/sessions/:id',
        'GET /api/attempts', 'GET /api/attempts/:id', 'GET /api/redo',
        'GET /api/backups',
        'GET|POST /api/sql （需 token）',
      ],
    });
  } catch (err) {
    if (err instanceof ApiError) {
      return send(res, err.status, { error: err.message, code: err.code, details: err.details });
    }
    // 唯一约束冲突等 SQLite 层错误，转成可读的 409
    if (/UNIQUE constraint failed/i.test(err.message)) {
      return send(res, 409, { error: err.message, code: 'constraint_violation' });
    }
    if (/FOREIGN KEY constraint failed/i.test(err.message)) {
      return send(res, 409, { error: err.message, code: 'foreign_key_violation' });
    }
    console.error(err);
    return send(res, 500, { error: err.message, code: 'internal' });
  }
}
