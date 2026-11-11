import { timingSafeEqual } from 'node:crypto';
import config from './config.mjs';
import { get } from './db.mjs';
import { buildMeta, buildDays } from './aggregate.mjs';
import { todayLocal } from './dates.mjs';
import { serveStatic } from './static.mjs';
import * as read from './read-api.mjs';
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
    throw new ApiError(401, 'unauthorized', '写操作需要 Authorization: Bearer <token>');
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
  return send(res, status, {
    ok: true,
    ...payload,
    ...(exported ? { exported } : {}),
    ...(exportError ? { exportError } : {}),
  });
}

// 只有这几个前缀是可写端点。只读进程对它们返回 404（不暴露能力），
// 对其余路径的非 GET 仍返回 405（确实是方法用错了）。
const WRITABLE_ROOTS = new Set(['sessions', 'attempts', 'export', 'papers', 'questions', 'backups']);

export async function handle(req, res) {
  const url = new URL(req.url, `http://${config.host}:${config.port}`);

  // 站点静态产物
  if (url.pathname === '/' || url.pathname === '/study') {
    res.writeHead(302, { Location: '/study/' });
    return res.end();
  }
  if (url.pathname.startsWith('/study/')) {
    return serveStatic(req, res, url.pathname);
  }

  if (!url.pathname.startsWith('/api')) {
    return send(res, 404, { error: 'not found', path: url.pathname, hint: '站点在 /study/' });
  }

  const method = req.method;
  const seg = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const [, a, b, c] = seg;

  try {
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
        return send(res, 200, { ok: true, ...exportAll(config) });
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
        database: config.database,
        config: config.configName,
      });
    }
    if (a === 'meta') return send(res, 200, buildMeta({ timeZone: config.timeZone }));
    if (a === 'days') {
      return send(res, 200, buildDays({
        timeZone: config.timeZone,
        today: todayLocal(config.timeZone),
      }));
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
        'GET /api/papers', 'GET /api/papers/:slug',
        'GET /api/questions', 'GET /api/questions/:id',
        'GET /api/sessions', 'GET /api/sessions/:id',
        'GET /api/attempts', 'GET /api/attempts/:id', 'GET /api/redo',
        'GET /api/backups',
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
