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

const DEFAULT_BASE = 'https://geyuqi.me';
const LOCAL_BASE = 'http://127.0.0.1:8137';
const TEST_BASE = 'http://127.0.0.1:8138';

// 只要出现就必须带值的选项；其余 --xxx 视为拼错，直接报用法。
const VALUED = new Set([
  'base', 'token', 'paper', 'topic', 'search', 'limit', 'offset',
  'from', 'to', 'question', 'redo', 'date', 'status', 'file',
]);
const BOOLEAN = new Set([
  'json', 'help', 'local', 'test', 'content', 'process', 'meta', 'dry-run', 'no-content',
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

示例
  mem q ls --paper 2024-exam --search 排列组合
  mem s new - < session.json
  mem a set 2026-11-11-2024-exam-a12-2024-exam-q003 correct=true errorTag=审题
  mem a done 2026-11-11-2024-exam-a12-2024-exam-q003
  mem q new --file question.json --dry-run
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
          out('  写操作需要 token：把 token 放进 ~/.mem-api-token，或设 MEM_WRITE_TOKEN。');
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
    if (err instanceof UsageError) {
      if (json) out(JSON.stringify({ ok: false, error: err.message }, null, 2));
      else { out(`✗ ${err.message}`); out('  mem --help 看用法'); }
      process.exitCode = 2;
      return;
    }
    out(`✗ ${err?.stack || err}`);
    process.exitCode = 1;
  });
