// 日常使用的命令行入口：mem <组> <动作> [参数]
//
// 为什么要有这一层：
// 接口本身够用，但日常高频动作是「查一下这题」「补一条判定」「记一场」，
// 每次手写 curl + Bearer + URL 编码不现实，Agent 也容易拼错。
// CLI 只做三件事：拼 URL、带 token、把 JSON 压成能一眼看懂的表。
//
// 约束：不 import server/config.mjs。CLI 是纯 HTTP 客户端，不该因为本机
// 数据库配置不对而起不来；它只认 --base / MEM_API。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// 只取错误码清单：与服务端 /api/sql 判「这是 SQL 错误而不是网络错误」用同一份定义。
// 注意不能 import server/config.mjs —— CLI 是纯 HTTP 客户端，不该依赖本机数据库配置。
import { SQL_ERROR_CODES } from './sql.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULT_BASE = 'https://geyuqi.me';
const LOCAL_BASE = 'http://127.0.0.1:8137';
const TEST_BASE = 'http://127.0.0.1:8138';

// SQL 直连的默认落点：线上真源。SQLite 没有网络协议，所以走 SSH 到那台机器上执行。
const DEFAULT_SSH = 'root@121.89.87.48';
const REMOTE_DB = '/www/data/mem.db';
const REMOTE_NODE = '/opt/node22/bin/node';
const REMOTE_SQLRUN = '/www/api/server/sqlrun.mjs';
const LOCAL_DB = 'data/mem.db';
const TEST_DB = 'data/test.db';

// 只要出现就必须带值的选项；其余 --xxx 视为拼错，直接报用法。
const VALUED = new Set([
  'base', 'token', 'paper', 'topic', 'search', 'limit', 'offset',
  'from', 'to', 'question', 'redo', 'date', 'status', 'file',
  'db', 'ssh', 'max-rows', 'sql',
]);
const BOOLEAN = new Set([
  'json', 'help', 'local', 'test', 'content', 'process', 'meta', 'dry-run', 'no-content',
  'csv', 'quiet', 'http',
]);

class UsageError extends Error {}
class NetworkError extends Error {}
class HttpError extends Error {
  constructor(status, data) {
    super((data && data.error) || `HTTP ${status}`);
    this.status = status;
    this.data = data;
  }
}

// ---------------------------------------------------------------- 参数解析

function parseArgv(argv) {
  const opts = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h') { opts.help = true; continue; }
    if (arg === '-') { positional.push(arg); continue; }
    if (!arg.startsWith('--')) { positional.push(arg); continue; }

    let key = arg.slice(2);
    let value;
    const eq = key.indexOf('=');
    if (eq >= 0) {
      value = key.slice(eq + 1);
      key = key.slice(0, eq);
    }
    if (BOOLEAN.has(key)) {
      if (value !== undefined) throw new UsageError(`--${key} 是开关，不接受值`);
      opts[key] = true;
      continue;
    }
    if (!VALUED.has(key)) throw new UsageError(`未知选项 --${key}（mem --help 看全部）`);
    if (value === undefined) {
      value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new UsageError(`--${key} 需要一个值`);
      }
      i += 1;
    }
    opts[key] = value;
  }
  return { opts, positional };
}

function parseValue(raw) {
  if (raw === 'null') return null;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  if (raw.startsWith('[') || raw.startsWith('{')) {
    try { return JSON.parse(raw); } catch { return raw; }
  }
  return raw;
}

/** k=v → 对象。数字、布尔、null、JSON 数组自动还原，其余按字符串。 */
function parsePairs(list) {
  const out = {};
  for (const item of list) {
    const i = item.indexOf('=');
    if (i <= 0) throw new UsageError(`参数应为 k=v 形式：${item}`);
    out[item.slice(0, i)] = parseValue(item.slice(i + 1));
  }
  return out;
}

/** 请求体来源：JSON 文件 / `-` 标准输入 / k=v。后者覆盖前者。 */
async function buildBody(args, opts) {
  let body = {};
  const pairs = [];
  const files = [];
  for (const arg of args) {
    if (arg.includes('=')) pairs.push(arg);
    else files.push(arg);
  }
  if (opts.file) files.push(opts.file);
  if (files.length > 1) throw new UsageError(`只能给一个 JSON 文件：${files.join(' ')}`);
  if (files.length === 1) {
    const src = files[0];
    const text = src === '-'
      ? fs.readFileSync(0, 'utf8')
      : fs.readFileSync(path.resolve(src), 'utf8');
    try {
      body = JSON.parse(text);
    } catch (err) {
      throw new UsageError(`${src} 不是合法 JSON：${err.message}`);
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new UsageError(`${src} 的顶层必须是对象`);
    }
  }
  Object.assign(body, parsePairs(pairs));
  if (Object.keys(body).length === 0) {
    throw new UsageError('需要 JSON 文件、-（标准输入）或 k=v 参数');
  }
  return body;
}

// ---------------------------------------------------------------- 输出工具

const out = (s = '') => process.stdout.write(`${s}\n`);
const CJK = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;

function displayWidth(s) {
  let n = 0;
  for (const ch of String(s)) n += CJK.test(ch) ? 2 : 1;
  return n;
}

function pad(s, n) {
  const text = String(s ?? '');
  return text + ' '.repeat(Math.max(0, n - displayWidth(text)));
}

function cut(s, max) {
  const text = String(s ?? '').replace(/\s+/g, ' ').trim();
  let width = 0;
  let result = '';
  for (const ch of text) {
    const w = CJK.test(ch) ? 2 : 1;
    if (width + w > max - 1) return `${result}…`;
    result += ch;
    width += w;
  }
  return result;
}

function table(headers, rows) {
  const widths = headers.map((h, i) => Math.max(
    displayWidth(h),
    ...rows.map((r) => displayWidth(r[i] ?? ''))
  ));
  const line = (cells) => cells
    .map((c, i) => (i === cells.length - 1 ? String(c ?? '') : pad(c, widths[i])))
    .join('  ');
  out(line(headers));
  out(widths.map((w) => '─'.repeat(w)).join('  '));
  for (const row of rows) out(line(row));
}

function printJson(data) {
  out(JSON.stringify(data, null, 2));
}

function die(message) {
  throw new UsageError(message);
}

// ---------------------------------------------------------------- HTTP

function resolveBase(opts) {
  if (opts.base) return String(opts.base).replace(/\/+$/, '');
  if (opts.test) return TEST_BASE;
  if (opts.local) return LOCAL_BASE;
  if (process.env.MEM_API) return process.env.MEM_API.replace(/\/+$/, '');
  return DEFAULT_BASE;
}

function resolveToken(opts) {
  if (opts.token) return opts.token;
  if (process.env.MEM_WRITE_TOKEN) return process.env.MEM_WRITE_TOKEN.trim();
  const file = path.join(os.homedir(), '.mem-api-token');
  if (fs.existsSync(file)) {
    const token = fs.readFileSync(file, 'utf8').trim();
    if (token) return token;
  }
  return null;
}

function qs(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === false) continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

async function request(ctx, method, pathname, { body, auth = false } = {}) {
  const url = `${ctx.base}${pathname}`;
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth) {
    if (!ctx.token) {
      die('写操作需要 token：放到 ~/.mem-api-token、设 MEM_WRITE_TOKEN，或加 --token');
    }
    headers.Authorization = `Bearer ${ctx.token}`;
  }
  if (ctx.dryRun) {
    out(`${method} ${url}`);
    if (body !== undefined) out(JSON.stringify(body, null, 2));
    return { dryRun: true };
  }
  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    throw new NetworkError(
      `连不上 ${ctx.base}（${err.cause?.code || err.message}）` +
      `${ctx.base === LOCAL_BASE ? '；本机服务没起就 ./dev.sh' : ''}`
    );
  }
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) throw new HttpError(res.status, data);
  return data;
}

// ---------------------------------------------------------------- SQL 直连
//
// 预设命令覆盖不了的聚合/筛选，直接写 SQL 更快：按知识点算正确率、按周做
// 重做转化、JOIN 三张表看某题的历次判定。三条路：
//   --http   POST /api/sql，一个 HTTPS 请求就到线上真源（不需要 SSH）
//   默认     SSH 到数据所在的机器上执行（免密没配好时用 --http）
//   --local  读本机镜像 data/mem.db
// 三条路跑的是同一个只读执行器（server/sqlrun.mjs），闸门完全一致。

class SqlError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code || 'sql_error';
  }
}

function runProcess(cmd, args, input, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new NetworkError(`执行超时（${timeoutMs / 1000}s）`));
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new NetworkError(`无法执行 ${cmd}：${err.message}`));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.on('error', () => {});   // 进程提前退出时写 stdin 会 EPIPE
    child.stdin.end(input);
  });
}

// ssh 每次都会打一段 post-quantum 警告，用户看的是查询结果，不是这个。
function cleanStderr(text) {
  return String(text || '')
    .split('\n')
    .filter((l) => l.trim() && !/post-quantum|store now|openssh\.com\/pq|^\*\*/.test(l))
    .join('\n')
    .trim();
}

function parseRunner(r, label) {
  const line = r.stdout.trim().split('\n').filter((l) => l.trim()).pop() || '';
  let data = null;
  try {
    data = JSON.parse(line);
  } catch { /* 下面统一报错 */ }

  if (!data) {
    const err = cleanStderr(r.stderr);
    if (r.code === 255) {
      throw new NetworkError(
        `连不上 ${label}（SSH 免密没配好？或用 --ssh user@host 指定）` + (err ? `\n${err}` : '')
      );
    }
    if (r.code === 124) throw new NetworkError(`${label} 执行超时（服务器端 timeout 20s 已终止）`);
    throw new NetworkError(`${label} 没有返回结果（exit ${r.code}）` + (err ? `\n${err}` : ''));
  }
  if (!data.ok) throw new SqlError(data.error || 'SQL 执行失败', data.code);
  return data;
}

async function executeSql(sql, opts, ctx) {
  const maxRows = opts['max-rows'] ? Number(opts['max-rows']) : undefined;
  const payload = JSON.stringify({ sql, maxRows });

  if (opts.http && (opts.db || opts.local)) {
    throw new UsageError('--http 与 --local / --db 互斥：--http 查线上真源，--local 查本机镜像');
  }

  // `--test` 的语义是「打测试库」，SQL 这条路上以前没有对应分支：会静默落到
  // 下面的 SSH 分支，读线上真源。以为在查 test.db、实际查生产库，是最难发现的一类错。
  if (opts.test && !opts.http && !opts.db && !opts.local) {
    opts.db = TEST_DB;
  }

  if (opts['dry-run']) {
    const target = opts.http
      ? `${ctx ? ctx.base : DEFAULT_BASE}/api/sql`
      : opts.db || opts.local ? `本机 ${opts.db || LOCAL_DB}` : `${opts.ssh || DEFAULT_SSH}:${REMOTE_DB}`;
    out(`# ${target}`);
    out(payload);
    return null;
  }

  if (opts.http) {
    if (!ctx.token) {
      throw new UsageError('--http 需要 token：放到 ~/.mem-api-token、设 MEM_WRITE_TOKEN，或加 --token');
    }
    let data;
    try {
      data = await request(ctx, 'POST', '/api/sql', { body: { sql, maxRows }, auth: true });
    } catch (err) {
      // 服务端把只读闸门的拒绝包成 400 + code；映射回 SqlError 才保持「SQL 出错 = 退出码 2」
      if (err instanceof HttpError && err.data && SQL_ERROR_CODES.has(err.data.code)) {
        throw new SqlError(err.data.error || `HTTP ${err.status}`, err.data.code);
      }
      throw err;
    }
    if (data.dryRun) return null;
    return { ...data, db: `${ctx.base}/api/sql` };
  }

  if (opts.db || opts.local) {
    const db = opts.db || LOCAL_DB;
    const abs = path.isAbsolute(db) ? db : path.join(ROOT, db);
    if (!fs.existsSync(abs)) {
      throw new UsageError(`${db} 不存在；先 mem pull 拉一份线上镜像，或用 mem sql 直接查线上`);
    }
    const r = await runProcess(
      process.execPath,
      ['--no-warnings', path.join(ROOT, 'server/sqlrun.mjs'), '--db', abs],
      payload
    );
    const data = parseRunner(r, `本机 ${db}`);
    // 本机这份是镜像，线上才是真源。查出来的是旧数据却说"线上没更新"，最容易误判。
    data.mirror = {
      ageHours: Math.round(((Date.now() - fs.statSync(abs).mtimeMs) / 3600000) * 10) / 10,
    };
    return data;
  }

  const host = opts.ssh || process.env.MEM_SSH || DEFAULT_SSH;
  const db = process.env.MEM_REMOTE_DB || REMOTE_DB;
  const remote = `timeout 20 ${REMOTE_NODE} --no-warnings ${REMOTE_SQLRUN} --db ${db}`;
  // 复用 SSH 连接：首次 0.8s，之后同一条长连接上每次查询 ~30ms。
  // 没有这层的话，连着查十条就是八秒，SQL 再灵活也没人愿意用。
  const r = await runProcess(
    'ssh',
    [
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=10',
      '-o', 'ControlMaster=auto',
      '-o', 'ControlPath=/tmp/mem-ssh-%r@%h:%p',
      '-o', 'ControlPersist=300',
      host,
      remote,
    ],
    payload,
    40000
  );
  return parseRunner(r, `${host}:${db}`);
}

function printSql(data, opts) {
  if (!data) return;                       // --dry-run 已经打印过了
  if (opts.json) return printJson(data);

  const { columns = [] } = data;
  const rows = data.rows || [];
  if (!columns.length) { out('（没有结果列）'); return; }

  if (opts.csv) {
    const esc = (v) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    out(columns.map(esc).join(','));
    for (const r of rows) out(columns.map((c) => esc(r[c])).join(','));
    return;
  }

  if (!rows.length) {
    out(`（0 行 · ${data.ms}ms）`);
    return;
  }
  const cell = (v) => (v === null || v === undefined
    ? '—'
    : cut(String(v).replace(/\s+/g, ' '), 48));
  table(columns, rows.map((r) => columns.map((c) => cell(r[c]))));

  const bits = [`${data.count} 行`, `${data.ms}ms`];
  if (data.truncated) bits.push(`超过 ${data.limit} 行已截断，加 limit 或 --max-rows`);
  out(`— ${bits.join(' · ')}  ${data.db}`);
  if (data.mirror && data.mirror.ageHours >= 24) {
    const days = Math.floor(data.mirror.ageHours / 24);
    out(`  注意：这是本机镜像，${days >= 1 ? `${days} 天` : `${data.mirror.ageHours} 小时`}没更新了。mem pull 可同步，或者去掉 --local 直接查线上。`);
  }
}

function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { buf += d; });
    process.stdin.on('end', () => resolve(buf));
  });
}

async function readSqlText(args, opts) {
  if (opts.sql) return String(opts.sql);
  if (opts.file) {
    const p = opts.file === '-' ? null : (path.isAbsolute(opts.file) ? opts.file : path.join(process.cwd(), opts.file));
    if (!p) return readStdin();
    if (!fs.existsSync(p)) throw new UsageError(`找不到文件：${opts.file}`);
    return fs.readFileSync(p, 'utf8');
  }
  if (args.length) return args.join(' ');
  if (!process.stdin.isTTY) return readStdin();
  throw new UsageError('用法：mem sql "select ..." / mem sql -f q.sql / echo "..." | mem sql');
}

async function runSqlCommand(args, opts, ctx) {
  const sql = (await readSqlText(args, opts)).trim();
  if (!sql) throw new UsageError('SQL 为空');
  const data = await executeSql(sql, opts, ctx);
  printSql(data, opts);
}

async function runSchema(args, opts, ctx) {
  const name = args[0];
  if (name && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new UsageError(`表名不合法：${name}`);
  }
  const filter = name ? ` AND m.name = '${name}'` : '';
  const sql = `
SELECT m.name AS 表, p.cid AS 序, p.name AS 列, p.type AS 类型,
       CASE p."notnull" WHEN 1 THEN 'NOT NULL' ELSE '' END AS 约束,
       p.dflt_value AS 默认, p.pk AS 主键
FROM sqlite_master m
JOIN pragma_table_info(m.name) p
WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%'${filter}
ORDER BY m.name, p.cid`;
  const data = await executeSql(sql.replace(/\s+/g, ' ').trim(), opts, ctx);
  if (!data) return;
  if (opts.json) return printJson(data);

  if (!data.rows.length) { out(`（没有表${name ? `：${name}` : ''}）`); return; }
  let current = null;
  for (const r of data.rows) {
    if (r['表'] !== current) {
      if (current !== null) out('');
      current = r['表'];
      out(`▌ ${current}`);
    }
    const flags = [r['类型'] || '', r['约束'] || '', r['主键'] ? 'PK' : '', r['默认'] === null ? '' : `默认 ${r['默认']}`]
      .filter(Boolean).join(' ');
    out(`   ${pad(r['列'], 22)}${flags}`);
  }
}

async function runPull() {
  const r = await runProcess('bash', [path.join(ROOT, 'scripts/pull-data.sh')], '', 120000);
  process.stdout.write(r.stdout);
  if (r.code !== 0) {
    throw new NetworkError(`拉取失败（exit ${r.code}）\n${cleanStderr(r.stderr)}`);
  }
}

// ---------------------------------------------------------------- 只读命令

function printHealth(d) {
  const rows = [
    ['服务', d.ok ? 'ok' : '异常'],
    ['SQLite', d.sqlite],
    ['可写', d.writeEnabled ? '是' : '否（只读进程）'],
    ['数据库', d.database],
    ['配置', d.config],
    ['页表', d.site ? `v${d.site.version} · ${d.site.pages} 页 · ${d.site.ms}ms` : '未建立'],
  ];
  if (d.site?.error) rows.push(['页表错误', d.site.error]);
  for (const [k, v] of rows) out(`${pad(k, 10)}${v}`);
}

function printPapers(d) {
  const rows = d.papers.map((p) => [p.slug, String(p.questionCount ?? p.question_count ?? ''), p.title]);
  table(['slug', '题数', '标题'], rows);
}

function stripMd(s) {
  return String(s || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*`_|-]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^\s*\d+[.、]\s*/, '')   // 题干首行常带「1. 」编号，摘要里去掉
    .trim();
}

function printQuestions(list) {
  if (!list.length) { out('（无匹配）'); return; }
  table(['id', '#', '类型', 'topic', '答案', '题干'], list.map((q) => [
    q.id,
    String(q.number ?? ''),
    q.type || '',
    q.topic || '',
    q.answer ?? '—',
    cut(stripMd(q.contentMd) || q.note || '', 40),
  ]));
}

function printMeta(d) {
  const c = d.coverage || {};
  const v = d.verdict || {};
  const t = d.timing || {};
  out(`覆盖   ${c.papers} 卷 / ${c.questions} 题 / ${c.sessions} 场 / ${c.attempts} 条件答`);
  out(`判定   对 ${v.correct}  错 ${v.wrong}  未判 ${v.unjudged}  实质正确 ${v.substantiveCorrect}`);
  out(`计时   session ${t.session}  per-question ${t.perQuestion ?? t['per-question']}  ` +
    `mixed ${t.mixed}  无 ${t.none}`);
  out(`答案   已确认 ${d.answers?.confirmed}  估算 ${d.answers?.estimated}`);
  if (d.durationUnknownSessions !== undefined) out(`缺时长 ${d.durationUnknownSessions} 场`);
}

function printDays(d) {
  const s = d.summary || {};
  out(`学习日 ${s.learningDays}  场次 ${s.sessions}  作答 ${s.attempts}  ` +
    `对 ${s.correct} / 错 ${s.wrong}  时长 ${Math.round((s.minutes || 0) / 60)}h`);
  out(`连续 ${d.streaks?.currentStreak ?? '—'} 天  最长 ${d.streaks?.longestStreak ?? '—'} 天  ` +
    `${s.firstDay ?? ''} → ${s.lastDay ?? ''}`);
  // 接口按日期倒序返回，取最近 14 天即可
  const days = (d.days || []).slice(0, 14);
  if (!days.length) return;
  out('');
  table(['日期', '周几', '场次'], days.map((x) => [
    x.date, x.weekday ?? '', String((x.sessions || []).length),
  ]));
}

function printSessions(list) {
  if (!list.length) { out('（无记录）'); return; }
  table(['id', '日期', '卷', '题数', '时长'], list.map((s) => [
    s.id,
    s.date,
    s.paperSlug,
    String(s.questionCount ?? ''),
    s.durationMin === null || s.durationMin === undefined ? '—' : `${s.durationMin}min`,
  ]));
}

function markOf(correct) {
  if (correct === true) return '✅';
  if (correct === false) return '❌';
  return '❔';
}

function printSession(d, questionsById) {
  out(`${d.id}  ${d.date}  ${d.paperSlug}  ${d.questionCount} 题` +
    `${d.durationMin ? `  ${d.durationMin}min` : ''}  timing=${d.timingMode}`);
  const rows = d.attempts.map((a) => {
    const q = questionsById?.get(a.questionId);
    return [
      String(q?.number ?? ''),
      markOf(a.correct),
      a.userAnswer ?? '—',
      q?.answer ?? '—',
      a.primaryTag ?? a.errorTag ?? '',
      a.redoStatus ? `redo:${a.redoStatus}` : '',
      cut(stripMd(q?.contentMd), 32),
    ];
  });
  table(['题', '判定', '作答', '答案', '标签', '重做', '题干'], rows);
  if (d.note) { out(''); out(d.note); }
}

function printAttempts(list) {
  if (!list.length) { out('（无匹配）'); return; }
  table(['id', '题', '作答', '判定', '标签', '重做'], list.map((a) => [
    a.id,
    a.questionId,
    a.userAnswer ?? '—',
    markOf(a.correct),
    a.errorTag ?? '',
    a.redoStatus ?? '',
  ]));
}

function printRedo(list) {
  if (!list.length) { out('（没有待重做的题）'); return; }
  table(['id', '题', '日期', '状态', 'topic', '作答'], list.map((r) => [
    r.id,
    String(r.questionNumber ?? ''),
    r.sessionDate ?? '',
    r.resolved ? 'resolved' : (r.redoStatus || 'pending'),
    r.questionTopic || '',
    r.userAnswer ?? '—',
  ]));
}

function printBackups(d) {
  out(`保留 ${d.keep} 份，写前快照：${d.beforeWrite ? '开' : '关'}`);
  if (!d.backups.length) { out('（还没有快照）'); return; }
  table(['时间', '原因', '体积', '行数', '目录'], d.backups.map((b) => {
    const bytes = b.dbBytes ?? b.bytes ?? 0;
    return [
      (b.createdAt ?? '').replace('T', ' ').slice(0, 19),
      b.reason ?? '—',
      bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`,
      b.rows ? `${b.rows.questions ?? '?'} 题 / ${b.rows.sessions ?? '?'} 场` : '—',
      b.path ?? b.name ?? '',
    ];
  }));
}

/** 写操作成功后统一收口：主 id + 页表版本。 */
function printWrite(d, fallback) {
  if (d.dryRun) return;
  const id = d.sessionId || d.attemptId || d.slug || d.id || d.paperSlug || fallback || '';
  const site = d.site ? ` · 页表 v${d.site.version}（${d.site.pages} 页，${d.site.ms}ms）` : '';
  out(`✓ ${id}${site}`);
  if (d.exportError) out(`! 导出失败：${d.exportError}（库已写入，页面可能没更新）`);
  if (d.site?.error) out(`! 页表重建失败：${d.site.error}（旧页面仍在服务）`);
}

// ---------------------------------------------------------------- 命令表

const GROUP_ALIAS = {
  p: 'papers', paper: 'papers', papers: 'papers',
  q: 'questions', question: 'questions', questions: 'questions',
  s: 'sessions', session: 'sessions', sessions: 'sessions',
  a: 'attempts', attempt: 'attempts', attempts: 'attempts',
};

async function runRead(ctx, group, action, rest, opts) {
  if (group === 'papers') {
    if (action === 'ls' || action === 'list') {
      const d = await request(ctx, 'GET', '/api/papers');
      return opts.json ? printJson(d) : printPapers(d);
    }
    const slug = rest[0];
    if (!slug) die('用法：mem p get <slug>');
    const d = await request(ctx, 'GET', `/api/papers/${encodeURIComponent(slug)}`);
    if (opts.json) return printJson(d);
    out(`${d.slug}  ${d.title}  ${d.questionCount} 题  ${d.subject || ''}`);
    if (d.note) out(d.note);
    table(['#', 'id', '类型', 'topic', '答案'], d.questions.map((q) => [
      String(q.number), q.id, q.type || '', q.topic || '', q.answer ?? '—',
    ]));
    return undefined;
  }

  if (group === 'questions') {
    if (action === 'ls' || action === 'list' || action === 'search') {
      // 人类可读模式总要题干摘要，所以始终带 include=content；--json 时不擅自加字段
      const query = qs({
        paper: opts.paper,
        topic: opts.topic,
        q: opts.search ?? (action === 'search' ? rest.filter((x) => !x.includes('='))[0] : null),
        limit: opts.limit,
        offset: opts.offset,
        include: opts.json ? (opts.content ? 'content' : null) : 'content',
      });
      const d = await request(ctx, 'GET', `/api/questions${query}`);
      return opts.json ? printJson(d) : printQuestions(d.questions);
    }
    const id = rest[0];
    if (!id) die('用法：mem q get <id>');
    const query = qs({ include: opts.meta ? 'meta' : 'content' });
    const d = await request(ctx, 'GET', `/api/questions/${encodeURIComponent(id)}${query}`);
    if (opts.json) return printJson(d);
    out(`${d.id}  ${d.paperSlug} #${d.number}  ${d.type}  ${d.topic}`);
    out(`知识点 ${d.topicId}   答案 ${d.answer ?? '—'}   可判分 ${d.scorable ? '是' : '否'}`);
    if (d.contentMd) { out(''); out(d.contentMd); }
    return undefined;
  }

  if (group === 'sessions') {
    if (action === 'ls' || action === 'list') {
      const query = qs({
        from: opts.from, to: opts.to, paper: opts.paper,
        limit: opts.limit, offset: opts.offset,
      });
      const d = await request(ctx, 'GET', `/api/sessions${query}`);
      return opts.json ? printJson(d) : printSessions(d.sessions);
    }
    const id = rest[0];
    if (!id) die('用法：mem s get <id>');
    const query = qs({ include: opts.process ? 'process' : null });
    const d = await request(ctx, 'GET', `/api/sessions/${encodeURIComponent(id)}${query}`);
    if (opts.json) return printJson(d);
    // 人类可读模式补一份题号/答案，否则每行只有 id 看不出是哪题
    let byId = null;
    try {
      const qs1 = await request(ctx, 'GET',
        `/api/questions?paper=${encodeURIComponent(d.paperSlug)}&limit=500&include=content`);
      byId = new Map((qs1.questions || []).map((q) => [q.id, q]));
    } catch { /* 题目拉不到就退化成只显示作答 */ }
    return printSession(d, byId);
  }

  if (group === 'attempts') {
    if (action === 'ls' || action === 'list') {
      const query = qs({
        questionId: opts.question, redoStatus: opts.redo,
        limit: opts.limit, offset: opts.offset,
        include: opts.process ? 'process' : null,
      });
      const d = await request(ctx, 'GET', `/api/attempts${query}`);
      return opts.json ? printJson(d) : printAttempts(d.attempts);
    }
    const id = rest[0];
    if (!id) die('用法：mem a get <id>');
    const query = qs({ include: opts.process ? 'process' : null });
    const d = await request(ctx, 'GET', `/api/attempts/${encodeURIComponent(id)}${query}`);
    if (opts.json) return printJson(d);
    out(`${d.id}  ${markOf(d.correct)}  作答 ${d.userAnswer ?? '—'}  标签 ${d.errorTag ?? '—'}` +
      `${d.redoStatus ? `  重做 ${d.redoStatus}` : ''}`);
    if (d.processMd) { out(''); out(d.processMd); }
    return undefined;
  }

  return undefined;
}

async function runWrite(ctx, group, action, rest, opts) {
  // 每个写动作：路径 + 请求体
  if (group === 'sessions') {
    if (action === 'new' || action === 'create') {
      const body = await buildBody(rest, opts);
      const d = await request(ctx, 'POST', '/api/sessions', { body, auth: true });
      return opts.json ? printJson(d) : printWrite(d, body.sessionId);
    }
    const id = rest[0];
    if (!id) die('用法：mem s set <id> k=v ... / mem s rm <id>');
    if (action === 'set' || action === 'edit' || action === 'update') {
      const body = await buildBody(rest.slice(1), opts);
      const d = await request(ctx, 'PATCH', `/api/sessions/${encodeURIComponent(id)}`, { body, auth: true });
      return opts.json ? printJson(d) : printWrite(d, id);
    }
    if (action === 'rm' || action === 'delete') {
      const d = await request(ctx, 'DELETE', `/api/sessions/${encodeURIComponent(id)}`, { auth: true });
      return opts.json ? printJson(d) : printWrite(d, id);
    }
    die(`s 不支持的动作：${action}（可用 new / set / rm）`);
  }

  if (group === 'attempts') {
    if (action === 'add') {
      const sid = rest[0];
      if (!sid) die('用法：mem a add <sessionId> <file|-> [k=v ...]');
      const body = await buildBody(rest.slice(1), opts);
      const d = await request(ctx, 'POST', `/api/sessions/${encodeURIComponent(sid)}/attempts`, { body, auth: true });
      return opts.json ? printJson(d) : printWrite(d, body.questionId);
    }
    const id = rest[0];
    if (!id) die('用法：mem a set <id> k=v ... / mem a rm <id> / mem a done <id>');
    if (action === 'set' || action === 'edit' || action === 'update') {
      const body = await buildBody(rest.slice(1), opts);
      const d = await request(ctx, 'PATCH', `/api/attempts/${encodeURIComponent(id)}`, { body, auth: true });
      return opts.json ? printJson(d) : printWrite(d, id);
    }
    if (action === 'rm' || action === 'delete') {
      const d = await request(ctx, 'DELETE', `/api/attempts/${encodeURIComponent(id)}`, { auth: true });
      return opts.json ? printJson(d) : printWrite(d, id);
    }
    if (action === 'done' || action === 'resolve') {
      const body = {};
      if (opts.date) body.date = opts.date;
      if (opts.status) body.status = opts.status;
      const d = await request(ctx, 'POST', `/api/attempts/${encodeURIComponent(id)}/resolve`, { body, auth: true });
      return opts.json ? printJson(d) : printWrite(d, id);
    }
    die(`a 不支持的动作：${action}（可用 add / set / rm / done）`);
  }

  if (group === 'papers') {
    if (action === 'new' || action === 'create') {
      const body = await buildBody(rest, opts);
      const d = await request(ctx, 'POST', '/api/papers', { body, auth: true });
      return opts.json ? printJson(d) : printWrite(d, body.slug);
    }
    const slug = rest[0];
    if (!slug) die('用法：mem p set <slug> k=v ... / mem p rm <slug>');
    if (action === 'set' || action === 'edit' || action === 'update') {
      const body = await buildBody(rest.slice(1), opts);
      const d = await request(ctx, 'PATCH', `/api/papers/${encodeURIComponent(slug)}`, { body, auth: true });
      return opts.json ? printJson(d) : printWrite(d, slug);
    }
    if (action === 'rm' || action === 'delete') {
      const d = await request(ctx, 'DELETE', `/api/papers/${encodeURIComponent(slug)}`, { auth: true });
      return opts.json ? printJson(d) : printWrite(d, slug);
    }
    die(`p 不支持的动作：${action}（可用 new / set / rm）`);
  }

  if (group === 'questions') {
    if (action === 'new' || action === 'create') {
      const body = await buildBody(rest, opts);
      const d = await request(ctx, 'POST', '/api/questions', { body, auth: true });
      return opts.json ? printJson(d) : printWrite(d, body.id || body.questionId);
    }
    const id = rest[0];
    if (!id) die('用法：mem q set <id> k=v ... / mem q rm <id>');
    if (action === 'set' || action === 'edit' || action === 'update') {
      const body = await buildBody(rest.slice(1), opts);
      const d = await request(ctx, 'PATCH', `/api/questions/${encodeURIComponent(id)}`, { body, auth: true });
      return opts.json ? printJson(d) : printWrite(d, id);
    }
    if (action === 'rm' || action === 'delete') {
      const d = await request(ctx, 'DELETE', `/api/questions/${encodeURIComponent(id)}`, { auth: true });
      return opts.json ? printJson(d) : printWrite(d, id);
    }
    die(`q 不支持的动作：${action}（可用 new / set / rm）`);
  }

  return undefined;
}

async function runTop(ctx, cmd, rest, opts) {
  if (cmd === 'sql') {
    await runSqlCommand(rest, opts, ctx);
    return true;
  }
  if (cmd === 'schema') {
    await runSchema(rest, opts, ctx);
    return true;
  }
  if (cmd === 'pull') {
    await runPull();
    return true;
  }
  if (cmd === 'health') {
    const d = await request(ctx, 'GET', '/api/health');
    return opts.json ? printJson(d) : printHealth(d);
  }
  if (cmd === 'meta') {
    const d = await request(ctx, 'GET', '/api/meta');
    return opts.json ? printJson(d) : printMeta(d);
  }
  if (cmd === 'days') {
    const d = await request(ctx, 'GET', '/api/days');
    return opts.json ? printJson(d) : printDays(d);
  }
  if (cmd === 'redo') {
    const d = await request(ctx, 'GET', '/api/redo');
    return opts.json ? printJson(d) : printRedo(d.redo || []);
  }
  if (cmd === 'backups') {
    const d = await request(ctx, 'GET', '/api/backups');
    return opts.json ? printJson(d) : printBackups(d);
  }
  if (cmd === 'export') {
    const d = await request(ctx, 'POST', '/api/export', { auth: true });
    if (opts.json) return printJson(d);
    out(`✓ 已重导 JSON，页表 v${d.site?.version}（${d.site?.pages} 页，${d.site?.ms}ms）`);
    return undefined;
  }
  if (cmd === 'backup') {
    const d = await request(ctx, 'POST', '/api/backups', { auth: true });
    if (opts.json) return printJson(d);
    out(`✓ 快照 ${d.name || d.file || ''}`);
    return undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------- 帮助

const HELP = `mem · 学习记录命令行

用法
  mem <组> <动作> [参数]        组：p 卷 / q 题 / s 场次 / a 作答
  mem <命令> [参数]

查询（无需 token）
  mem health                        服务、数据库与页表状态
  mem meta                          覆盖 / 判定 / 计时口径
  mem days                          学习日历与连续天数
  mem p ls                          卷列表
  mem p get <slug>                  单卷（含题号清单）
  mem q ls [--paper P] [--topic T] [--search 文本] [--limit N] [--content]
  mem q get <id> [--meta]           单题，默认带题干
  mem s ls [--from D] [--to D] [--paper P] [--limit N]
  mem s get <id> [--process]        场次 + 逐题判定
  mem a ls [--question Q] [--redo S] [--limit N]
  mem a get <id> [--process]
  mem redo                          待重做台账
  mem backups                       快照列表

SQL 直连（只读，预设命令覆盖不了就用这个）
  mem sql "select ..."              在线上真源执行（SSH，服务端 20s 超时）
  mem sql --http "..."              走 HTTPS /api/sql，不用 SSH；需 token，延迟更低
  mem sql -f q.sql                  从文件读；也可 echo "..." | mem sql
  mem sql --local "..."             打本机镜像 data/mem.db（先 mem pull 更新）
  mem sql --csv "..."               输出 CSV；--json 输出原始结果
  mem schema [表]                   表与字段
  mem pull                          拉线上库到 data/mem.db（先备份本机）

写入（需要 token）
  mem s new <file|->                录入一场（JSON，单事务）
  mem s set <id> k=v ...            改场次头（date / durationMin / timingMode / note / fullText）
  mem s rm <id>                     删整场
  mem a add <sessionId> <file|->    往场次里追加一题
  mem a set <id> k=v ...            改判定、标签、推演
  mem a rm <id>                     删一条作答（最后一条不能删）
  mem a done <id> [--date D]        重做销账（该题最近一次判定须为「对」）
  mem p new|set|rm ...              卷增删改
  mem q new|set|rm ...              题增删改
  mem export                        重导 JSON + 重建页表
  mem backup                        立即做一次快照

通用选项
  --json          原样输出 JSON（脚本与 Agent 用）
  --local         打本机 127.0.0.1:8137（只读实例）
  --test          打测试实例 127.0.0.1:8138
  --base <url>    指定服务，默认 https://geyuqi.me
  --token <t>     写 token，默认读 ~/.mem-api-token
  --dry-run       只打印请求，不发送
  --db <path>     SQL 打指定库文件（本机路径）
  --ssh <u@h>     SQL 走哪台机器，默认 root@121.89.87.48
  --http          SQL 走 HTTPS /api/sql（--ssh 的替代，需 token）
  --max-rows N    SQL 结果上限，默认 1000（硬顶 5000）

示例
  mem q ls --paper 2024-exam --search 排列组合
  mem s new - < session.json
  mem a set 2026-11-11-2024-exam-a12-2024-exam-q003 correct=true errorTag=审题
  mem a done 2026-11-11-2024-exam-a12-2024-exam-q003
  mem q new --file question.json --dry-run
  mem sql "select topic, count(*) n, avg(correct) rate from attempts join questions q on q.id=attempts.question_id group by topic order by n desc"
  mem sql "select substr(date,1,7) m, count(*) from sessions group by m" --csv
`;

// ---------------------------------------------------------------- 入口

async function main() {
  const { opts, positional } = parseArgv(process.argv.slice(2));
  const ctx = { base: resolveBase(opts), token: resolveToken(opts), dryRun: Boolean(opts['dry-run']) };

  if (opts.help || positional.length === 0 || positional[0] === 'help') {
    out(HELP);
    return 0;
  }

  const [head, second, ...rest] = positional;
  const group = GROUP_ALIAS[head];

  let result;
  if (group) {
    const action = (second || 'ls').toLowerCase();
    const args = second ? rest : [];
    const readActions = new Set(['ls', 'list', 'get', 'search']);
    if (readActions.has(action)) {
      result = await runRead(ctx, group, action, args, opts);
    } else {
      result = await runWrite(ctx, group, action, args, opts);
    }
  } else {
    result = await runTop(ctx, head, positional.slice(1), opts);
    if (result === undefined && !['health', 'meta', 'days', 'redo', 'backups', 'export', 'backup'].includes(head)) {
      die(`未知命令：${head}（mem --help 看全部）`);
    }
  }
  return 0;
}

main()
  .then((code) => { process.exitCode = code || 0; })
  .catch((err) => {
    const json = process.argv.includes('--json');
    if (err instanceof HttpError) {
      if (json) {
        out(JSON.stringify({
          ok: false,
          status: err.status,
          error: err.data?.error ?? err.message,
          code: err.data?.code ?? null,
          details: err.data?.details ?? null,
        }, null, 2));
      } else {
        out(`✗ ${err.status} ${err.data?.code ? `${err.data.code} · ` : ''}${err.data?.error ?? err.message}`);
        if (err.status === 401) {
          out('  需要 token：把 token 放进 ~/.mem-api-token，或设 MEM_WRITE_TOKEN（写操作与 --http 的 SQL 都要）。');
        }
        if (err.data?.details) out(`  ${JSON.stringify(err.data.details)}`);
      }
      process.exitCode = 1;
      return;
    }
    if (err instanceof NetworkError) {
      if (json) out(JSON.stringify({ ok: false, error: err.message }, null, 2));
      else out(`✗ ${err.message}`);
      process.exitCode = 1;
      return;
    }
    if (err instanceof SqlError) {
      if (json) out(JSON.stringify({ ok: false, error: err.message, code: err.code }, null, 2));
      else {
        out(`✗ ${err.message}`);
        if (err.code === 'bad_sql') out('  表结构用 mem schema 看；字段名区分大小写。');
      }
      process.exitCode = 2;
      return;
    }
    if (err instanceof UsageError) {
      if (json) out(JSON.stringify({ ok: false, error: err.message }, null, 2));
      else { out(`✗ ${err.message}`); out('  mem --help 看用法'); }
      process.exitCode = 2;
      return;
    }
    out(`✗ ${err?.stack || err}`);
    process.exitCode = 1;
  });
