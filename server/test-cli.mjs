// CLI 验收：在独立测试库（8138）上跑一遍日常动作，确认「查得到、写得进、退得出」。
//
// 用法：node server/test-cli.mjs
//
// 与 test-write-api.mjs 的分工：那边测 HTTP 契约，这边测人/Agent 真正敲的命令，
// 包括退出码、人类可读表格、--json、--dry-run 和 token 缺失时的提示。
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'mem');
const BASE = 'http://127.0.0.1:8138';
const TOKEN = createHash('sha256').update(`cli-${Date.now()}`).digest('hex').slice(0, 32);
const TODAY = '2026-11-11';
const SESSION_ID = 'cli-test-a1';

let failed = 0;
let passed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

const sha256 = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const stat = (p) => {
  try {
    const s = fs.statSync(p);
    return { size: s.size, hash: sha256(p) };
  } catch {
    return null;
  }
};

function sh(cmd, args, env = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} 退出 ${code}: ${out}`))));
  });
}

/** 跑一次 mem 命令：返回退出码与两路输出。 */
function mem(args, { input, env = {} } = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      // 清掉外部 MEM_WRITE_TOKEN：npm test 会 export 一把测试 token，
      // 不清就会让「无 token 应被本地拦住」这条用例误判。
      env: { ...process.env, MEM_WRITE_TOKEN: '', HOME: FAKE_HOME, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('close', (code) => resolve({ code, stdout, stderr, text: stdout + stderr }));
    if (input !== undefined) p.stdin.end(input);
    else p.stdin.end();
  });
}

function json(res, label) {
  try {
    return JSON.parse(res.stdout);
  } catch {
    throw new Error(`${label} 输出不是 JSON：${res.text.slice(0, 300)}`);
  }
}

async function api(method, p, body, token = null) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + p, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* 保留原文 */ }
  return { status: res.status, body: parsed, text };
}

async function waitHealthy(retries = 60) {
  for (let i = 0; i < retries; i += 1) {
    try {
      const r = await api('GET', '/api/health');
      if (r.status === 200) return r.body;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('测试服务未在超时内就绪');
}

/** 等上一个测试进程真的放开 8138：SIGTERM 到端口释放有几毫秒空窗，
 *  紧接着起服务会连到正在退出的旧进程，后面全盘皆错。 */
async function waitPortFree(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await api('GET', '/api/health');
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('8138 仍被占用，无法起测试服务');
}

// ---------------------------------------------------------------- 准备

const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-cli-home-'));
const FORMAL_DB = path.join(ROOT, 'data/mem.db');
const before = { db: stat(FORMAL_DB), index: stat(path.join(ROOT, 'data/index.json')) };

console.log('=== 0. 准备测试库 ===');
await sh('sqlite3', [FORMAL_DB, `.backup '${path.join(ROOT, 'data/test.db')}'`]);
for (const suffix of ['-wal', '-shm']) {
  fs.rmSync(path.join(ROOT, 'data/test.db' + suffix), { force: true });
}
fs.rmSync(path.join(ROOT, 'data/test-backups'), { recursive: true, force: true });
await sh(process.execPath, ['server/export-cli.mjs'], {
  MEM_CONFIG: 'config.test.json',
  MEM_WRITE_TOKEN: TOKEN,
  NODE_NO_WARNINGS: '1',
});
console.log(`  测试库 ${(stat(path.join(ROOT, 'data/test.db')).size / 1024 / 1024).toFixed(1)} MB`);

console.log('\n=== 1. 起写模式服务（8138）===');
await waitPortFree();
const child = spawn(process.execPath, ['server/dev.mjs'], {
  cwd: ROOT,
  env: { ...process.env, MEM_CONFIG: 'config.test.json', MEM_WRITE_TOKEN: TOKEN, NODE_NO_WARNINGS: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
child.stdout.on('data', (d) => (serverLog += d));
child.stderr.on('data', (d) => (serverLog += d));

try {
  await waitHealthy();

  // ---- 只读 ----
  console.log('\n=== 2. 查询 ===');
  await check('health --json 报告可写', async () => {
    const r = await mem(['--test', '--json', 'health']);
    assert.equal(r.code, 0);
    assert.equal(json(r, 'health').writeEnabled, true);
  });

  await check('p ls 人类表格', async () => {
    const r = await mem(['--test', 'p', 'ls']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /2024-exam/);
    assert.match(r.stdout, /─/, '应有表头分隔线');
  });

  await check('p get 带题号清单', async () => {
    const r = await mem(['--test', 'p', 'get', '2024-exam']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /2024-exam-q001/);
  });

  await check('q ls --limit 生效', async () => {
    const r = await mem(['--test', '--json', 'q', 'ls', '--paper', '2024-exam', '--limit', '2']);
    const d = json(r, 'q ls');
    assert.equal(d.questions.length, 2);
  });

  await check('q ls 人类模式带题干摘要', async () => {
    const r = await mem(['--test', 'q', 'ls', '--paper', '2024-exam', '--limit', '1']);
    assert.equal(r.code, 0);
    const bodyLine = r.stdout.split('\n').find((l) => l.includes('2024-exam-q001'));
    assert.ok(bodyLine, '找不到题目行');
    const cells = bodyLine.trim().split(/\s{2,}/);
    // 最后一列是题干摘要；只有 include=content 生效时才有内容
    assert.ok(cells.length >= 6 && cells[cells.length - 1].length >= 4,
      `题干列缺失（include=content 未生效？）：${bodyLine}`);
  });

  await check('q get 默认带题干，--meta 不带', async () => {
    const full = json(await mem(['--test', '--json', 'q', 'get', '2024-exam-q001']), 'q get');
    assert.ok(full.contentMd && full.contentMd.length > 20);
    const meta = json(await mem(['--test', '--json', 'q', 'get', '2024-exam-q001', '--meta']), 'q get --meta');
    assert.equal(meta.contentMd, undefined);
  });

  await check('s ls / s get 可读', async () => {
    const list = json(await mem(['--test', '--json', 's', 'ls', '--limit', '3']), 's ls');
    assert.ok(list.sessions.length > 0 && list.sessions.length <= 3);
    const id = list.sessions[0].id;
    const one = await mem(['--test', 's', 'get', id]);
    assert.equal(one.code, 0);
    assert.match(one.stdout, new RegExp(id.split('-').pop()));
  });

  await check('redo 带日期与题号', async () => {
    const d = json(await mem(['--test', '--json', 'redo']), 'redo');
    assert.ok(d.redo.length > 0);
    assert.ok(d.redo.every((x) => x.sessionDate && x.questionNumber), '每条都应有 sessionDate / questionNumber');
  });

  await check('a ls 支持按题过滤', async () => {
    const d = json(await mem(['--test', '--json', 'a', 'ls', '--question', '2024-exam-q001', '--limit', '5']), 'a ls');
    assert.ok(d.attempts.every((a) => a.questionId === '2024-exam-q001'));
  });

  // ---- 鉴权 ----
  console.log('\n=== 3. token 缺失与错误 ===');
  const payload = {
    paperSlug: '2024-exam',
    date: TODAY,
    timingMode: 'session',
    durationMin: 30,
    sessionId: SESSION_ID,
    attempts: [{ questionId: '2024-exam-q001', userAnswer: 'E', correct: true, process: 'CLI 验收。' }],
  };

  await check('无 token 时本地就拦住（退出码 2）', async () => {
    const r = await mem(['--test', 's', 'new', '-'], { input: JSON.stringify(payload) });
    assert.equal(r.code, 2);
    assert.match(r.text, /写操作需要 token/);
  });

  await check('错 token 返回 401 并带 code', async () => {
    const r = await mem(['--test', '--token', 'wrong-token-wrong-token-1234', '--json', 's', 'new', '-'], {
      input: JSON.stringify(payload),
    });
    assert.equal(r.code, 1);
    const d = json(r, '401');
    assert.equal(d.status, 401);
    assert.equal(d.code, 'unauthorized');
  });

  // ---- 写入 ----
  console.log('\n=== 4. 写入闭环 ===');
  await check('--dry-run 不发请求', async () => {
    const r = await mem(['--test', '--token', TOKEN, '--dry-run', 's', 'new', '-'], {
      input: JSON.stringify(payload),
    });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /POST .*\/api\/sessions/);
    const probe = await api('GET', `/api/sessions/${SESSION_ID}`);
    assert.equal(probe.status, 404);
  });

  await check('s new 从 stdin 创建一场', async () => {
    const r = await mem(['--test', '--json', 's', 'new', '-'], {
      input: JSON.stringify(payload),
      env: { MEM_WRITE_TOKEN: TOKEN },
    });
    assert.equal(r.code, 0, r.text);
    const d = json(r, 's new');
    assert.equal(d.ok, true);
    assert.equal(d.sessionId, SESSION_ID);
    assert.ok(d.site && d.site.pages > 0, '写后应重建页表');
  });

  await check('新场次立刻可查（含作答）', async () => {
    const d = json(await mem(['--test', '--json', 's', 'get', SESSION_ID]), 's get');
    assert.equal(d.id, SESSION_ID);
    assert.equal(d.attempts.length, 1);
  });

  const attemptId = `${TODAY}-${SESSION_ID}-2024-exam-q001`;

  await check('a set 改判定后 a done 被拒（不是「对」）', async () => {
    const set = await mem(['--test', 'a', 'set', attemptId, 'correct=false', '--json'], {
      env: { MEM_WRITE_TOKEN: TOKEN },
    });
    assert.equal(set.code, 0, set.text);
    const done = await mem(['--test', 'a', 'done', attemptId, '--json'], {
      env: { MEM_WRITE_TOKEN: TOKEN },
    });
    assert.equal(done.code, 1);
    assert.equal(json(done, 'a done').code, 'not_yet_correct');
  });

  await check('a set 改回来 + a done 销账', async () => {
    const set = await mem(['--test', 'a', 'set', attemptId, 'correct=true', 'errorTag=审题', '--json'], {
      env: { MEM_WRITE_TOKEN: TOKEN },
    });
    assert.equal(set.code, 0, set.text);
    const done = await mem(['--test', '--json', 'a', 'done', attemptId, '--date', TODAY], {
      env: { MEM_WRITE_TOKEN: TOKEN },
    });
    assert.equal(done.code, 0, done.text);
    assert.equal(json(done, 'a done').attemptId, attemptId);
  });

  await check('s set 改时长并同步到查询', async () => {
    const r = await mem(['--test', '--json', 's', 'set', SESSION_ID, 'durationMin=42'], {
      env: { MEM_WRITE_TOKEN: TOKEN },
    });
    assert.equal(r.code, 0, r.text);
    const d = json(await mem(['--test', '--json', 's', 'get', SESSION_ID]), 's get');
    assert.equal(d.durationMin, 42);
  });

  await check('写操作自动留快照', async () => {
    const d = json(await mem(['--test', '--json', 'backups']), 'backups');
    assert.ok(d.backups.length > 0, '写前快照缺失');
  });

  await check('export 重建页表版本递增', async () => {
    const before = json(await mem(['--test', '--json', 'health']), 'health').site.version;
    const r = await mem(['--test', '--json', 'export'], { env: { MEM_WRITE_TOKEN: TOKEN } });
    assert.equal(r.code, 0, r.text);
    const d = json(r, 'export');
    assert.ok(d.site.version > before, `版本未递增：${before} → ${d.site.version}`);
  });

  await check('s rm 删除后 404', async () => {
    const rm = await mem(['--test', '--json', 's', 'rm', SESSION_ID], { env: { MEM_WRITE_TOKEN: TOKEN } });
    assert.equal(rm.code, 0, rm.text);
    const probe = await api('GET', `/api/sessions/${SESSION_ID}`);
    assert.equal(probe.status, 404);
  });

  await check('未知命令退出码 2 且给提示', async () => {
    const r = await mem(['--test', 'nonsense']);
    assert.equal(r.code, 2);
    assert.match(r.text, /未知命令/);
  });

  // ---- SQL 直连：走 --local 读正式库的只读连接，不碰测试库也不打线上 ----
  await check('sql --local --json 返回列与行', async () => {
    const r = await mem(['sql', '--local', '--json', 'select count(*) as n from attempts']);
    assert.equal(r.code, 0, r.text);
    const d = JSON.parse(r.stdout);
    assert.equal(d.ok, true);
    assert.deepEqual(d.columns, ['n']);
    assert.ok(d.rows[0].n > 0);
    assert.ok(d.mirror.ageHours >= 0);
  });

  await check('sql --local --csv 输出表头与数据行', async () => {
    const r = await mem(['sql', '--local', '--csv', 'select 1 as a, 2 as b']);
    assert.equal(r.code, 0, r.text);
    assert.equal(r.stdout.trim().split('\n')[0], 'a,b');
    assert.equal(r.stdout.trim().split('\n')[1], '1,2');
  });

  await check('sql 写操作退出码 2 且说明去向', async () => {
    const r = await mem(['sql', '--local', 'delete from attempts']);
    assert.equal(r.code, 2);
    assert.match(r.text, /只读|mem a set/);
  });

  await check('sql --dry-run 只打印请求', async () => {
    const r = await mem(['sql', '--local', '--dry-run', 'select 1']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /"sql":"select 1"/);
    assert.ok(!r.stdout.includes('"rows"'));
  });

  await check('schema --local 列出字段', async () => {
    const r = await mem(['schema', '--local', 'attempts']);
    assert.equal(r.code, 0, r.text);
    assert.match(r.stdout, /attempts/);
    assert.match(r.stdout, /question_id/);
    assert.match(r.stdout, /redo_status/);
  });

  await check('sql 表名写错时提示语法错误（退出码 2）', async () => {
    const r = await mem(['sql', '--local', '--json', 'select * from nope']);
    assert.equal(r.code, 2);
    const d = JSON.parse(r.stdout);
    assert.equal(d.code, 'bad_sql');
  });
} finally {
  if (!child.killed) child.kill('SIGTERM');
  await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once('close', resolve);
    setTimeout(resolve, 3000);
  });
  fs.rmSync(FAKE_HOME, { recursive: true, force: true });
  // 测试库与契约留在原地无妨，但正式库必须一字节未动
  const after = { db: stat(FORMAL_DB), index: stat(path.join(ROOT, 'data/index.json')) };
  if (before.db && after.db && before.db.hash !== after.db.hash) {
    console.log('\n  FAIL  正式库 data/mem.db 被改动');
    failed += 1;
  } else {
    console.log('\n  正式库未改动（sha256 一致）');
  }
}

console.log(`\n${failed === 0 ? '全部通过' : '有失败'}：${passed} 通过 / ${failed} 失败`);
if (failed > 0 && serverLog) console.log(`\n--- 服务日志 ---\n${serverLog.slice(-2000)}`);
process.exitCode = failed === 0 ? 0 : 1;
