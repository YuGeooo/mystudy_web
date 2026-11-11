// 只读 SQL 执行器：stdin 进一条查询，stdout 出一条 JSON。
//
// 为什么单独一个文件：SQLite 是嵌入式库，没有网络协议，"直连数据库"只能是
// 「在数据所在的那台机器上执行」。本机查镜像、服务器查真源，跑的是同一份代码，
// 输出格式一致，CLI 那边就不用写两套解析。
//
// 用法（都是只读）：
//   echo 'select 1' | node server/sqlrun.mjs --db data/mem.db
//   echo '{"sql":"select 1","maxRows":50}' | node server/sqlrun.mjs --db data/mem.db
//   服务器上：
//   ssh host 'timeout 20 /opt/node22/bin/node /www/api/server/sqlrun.mjs --db /www/data/mem.db'
//
// 三道闸：连接 readOnly + PRAGMA query_only、语句必须单条且以只读关键字开头、
// 结果行数有上限。写操作一律走 /api/*，那边有校验、快照和页表重建。
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const MAX_SQL_BYTES = 8000;
const DEFAULT_MAX_ROWS = 1000;
const HARD_MAX_ROWS = 5000;
const TIMEOUT_HINT = 20;

// PRAGMA 只放行"看一眼结构"的那些；带赋值的一律拒绝（journal_mode 之类会改文件）。
const SAFE_PRAGMA = new Set([
  'table_info', 'table_xinfo', 'index_list', 'index_info', 'index_xinfo',
  'foreign_key_list', 'database_list', 'compile_options', 'encoding', 'page_count',
  'page_size', 'schema_version', 'user_version', 'freelist_count',
]);

// 按「写语句的完整形态」匹配，而不是单个关键字。否则 replace(...) 这个字符串函数
// 会被当成 REPLACE INTO，正常查询直接被拒——这类误杀比放过更伤使用体验。
// 真正的兜底是 readOnly 连接，这里只负责给出可读的拒绝理由。
const WRITE_PATTERNS = [
  /\binsert\s+into\b/i,
  /\breplace\s+into\b/i,
  /\bupdate\s+\S+\s+set\b/i,
  /\bdelete\s+from\b/i,
  /\bdrop\s+(table|index|view|trigger)\b/i,
  /\balter\s+table\b/i,
  /\bcreate\s+(table|index|view|trigger|virtual)\b/i,
  /\battach\s+(database\s+)?['"]/i,
  /\bdetach\s+(database\s+)?['"]/i,
  /\b(vacuum|reindex)\b/i,
  /\bsavepoint\b/i,
];

function fail(message, code = 'bad_request') {
  process.stdout.write(JSON.stringify({ ok: false, error: message, code }) + '\n');
  process.exit(1);
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith('--')) fail(`--${name} 缺值`);
  return v;
}

// 把字符串字面量、注释抹成占位，剩下的才是可判定的语法骨架。
// 不这么做的话，where topic = 'insert' 这类正常查询会被误杀。
function skeleton(sql) {
  return sql
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
}

function validate(sql) {
  if (!sql) fail('SQL 为空');
  if (Buffer.byteLength(sql) > MAX_SQL_BYTES) fail(`SQL 太长（上限 ${MAX_SQL_BYTES} 字节）`);
  if (sql.includes('\0')) fail('SQL 里有空字符');

  // body 只用于判定；真正执行的是原文（去尾分号），否则字符串字面量会被抹掉。
  const source = sql.trim().replace(/;\s*$/, '');
  const body = skeleton(source).trim();
  if (body.includes(';')) fail('只允许单条语句（检测到分号后的第二条）');

  const head = body.match(/^([a-z]+)/i)?.[1]?.toLowerCase();
  if (!['select', 'with', 'explain', 'values', 'pragma'].includes(head)) {
    fail(`只读执行器只接受 select / with / explain / values / pragma，收到 ${head || '空'}`);
  }
  if (WRITE_PATTERNS.some((re) => re.test(body))) {
    fail('语句里出现写操作（insert/update/delete/drop…），这个执行器只读；改数据用 mem a set / mem s new');
  }

  if (head === 'pragma') {
    const name = body.replace(/^pragma\s+/i, '').split(/[\s(=]/)[0].toLowerCase();
    if (!SAFE_PRAGMA.has(name)) fail(`PRAGMA ${name} 不在只读白名单里`);
  }
  return source;
}

function columnsOf(stmt, rows) {
  if (typeof stmt.columns === 'function') {
    try {
      return stmt.columns().map((c) => c.name);
    } catch { /* 老版本没有，回退 */ }
  }
  return rows.length ? Object.keys(rows[0]) : [];
}

const dbPath = arg('db', process.env.MEM_DB || 'data/mem.db');
const maxRows = Math.min(
  Math.max(Number(arg('max-rows', DEFAULT_MAX_ROWS)) || DEFAULT_MAX_ROWS, 1),
  HARD_MAX_ROWS
);

const raw = fs.readFileSync(0, 'utf8').trim();
if (!raw) fail('stdin 没有内容');

let sql = raw;
let limit = maxRows;
if (raw.startsWith('{')) {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    fail(`stdin 是 JSON 但解析失败：${err.message}`);
  }
  sql = String(payload.sql ?? '');
  if (payload.maxRows) limit = Math.min(Math.max(Number(payload.maxRows) || 1, 1), HARD_MAX_ROWS);
}

const body = validate(sql);

if (!fs.existsSync(dbPath)) fail(`数据库不存在：${dbPath}`, 'no_database');

let db;
try {
  db = new DatabaseSync(dbPath, { readOnly: true });
} catch (err) {
  fail(`打不开 ${dbPath}（${err.message}）`, 'open_failed');
}

// 双保险：readOnly 已经挡住写入，query_only 再挡一层，防止将来有人改成可写连接。
try {
  db.exec('PRAGMA query_only = 1');
} catch { /* 只读连接上这句可能直接报错，不影响 */ }

const t0 = performance.now();
let rows = [];
let truncated = false;
let columns = [];
let stmt;
try {
  stmt = db.prepare(body);
  const it = typeof stmt.iterate === 'function' ? stmt.iterate() : null;
  if (it) {
    for (const row of it) {
      if (rows.length >= limit) { truncated = true; break; }
      rows.push(row);
    }
  } else {
    const all = stmt.all();
    rows = all.slice(0, limit);
    truncated = all.length > limit;
  }
  columns = columnsOf(stmt, rows);
} catch (err) {
  const message = String(err.message || err);
  const code = /no such (table|column)|syntax error/i.test(message) ? 'bad_sql' : 'exec_failed';
  fail(message, code);
} finally {
  try { stmt?.finalize?.(); } catch { /* ignore */ }
  try { db.close(); } catch { /* ignore */ }
}

process.stdout.write(JSON.stringify({
  ok: true,
  db: dbPath,
  columns,
  rows,
  count: rows.length,
  truncated,
  ms: Math.round((performance.now() - t0) * 10) / 10,
  limit,
  hint: truncated ? `结果超过 ${limit} 行已截断，加 limit 或 --max-rows` : undefined,
  timeoutHint: TIMEOUT_HINT,
}) + '\n');
