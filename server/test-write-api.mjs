// 写接口验收：在独立测试库上跑完整用例，全程不碰 data/mem.db。
//
// 用法：node server/test-write-api.mjs
//
// 做的事：
//   1. 记录正式库 data/mem.db 与 data/index.json 的 sha256
//   2. 用 sqlite3 .backup 重建 data/test.db（从正式库只读复制）
//   3. 用 MEM_CONFIG=config.test.json 起一个写模式服务（8138，随机 token）
//   4. 跑鉴权 / 创建 / 校验 / 冲突 / 订正 / 销账 / 撤销 / 导出 全量用例
//   5. 停服务，复查正式库哈希未变
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'http://127.0.0.1:8138';
const TOKEN = createHash('sha256').update(String(Date.now())).digest('hex').slice(0, 32);
const TODAY = '2026-11-11';

const results = [];
let failed = 0;

function check(name, fn) {
  try {
    fn();
    results.push({ ok: true, name });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed += 1;
    results.push({ ok: false, name, err: err.message });
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

const sha256 = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const stat = (p) => {
  try {
    const s = fs.statSync(p);
    return { size: s.size, mtimeMs: Math.round(s.mtimeMs), hash: sha256(p) };
  } catch {
    return null;
  }
};

function sh(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} 退出 ${code}: ${out}`))));
  });
}

async function api(method, p, body, { token = TOKEN, timeout = 15000 } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + p, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 响应原样保留 */
  }
  return { status: res.status, body: json, text };
}

async function waitHealthy(retries = 60) {
  for (let i = 0; i < retries; i += 1) {
    try {
      const r = await api('GET', '/api/health', undefined, { token: null, timeout: 1500 });
      if (r.status === 200) return r.body;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('测试服务未在超时内就绪');
}

// ---------------------------------------------------------------- 主流程

const FORMAL_DB = path.join(ROOT, 'data/mem.db');
const FORMAL_INDEX = path.join(ROOT, 'data/index.json');
const before = { db: stat(FORMAL_DB), index: stat(FORMAL_INDEX) };

console.log('=== 0. 准备测试库 ===');
await sh('sqlite3', [FORMAL_DB, `.backup '${path.join(ROOT, 'data/test.db')}'`]);
for (const suffix of ['-wal', '-shm']) {
  fs.rmSync(path.join(ROOT, 'data/test.db' + suffix), { force: true });
}
const testDbStat = stat(path.join(ROOT, 'data/test.db'));
assert.ok(testDbStat.size > 1000, '测试库未生成');
console.log(`  测试库 ${(testDbStat.size / 1024 / 1024).toFixed(1)} MB`);

console.log('\n=== 1. 起写模式服务（8138）===');
const child = spawn(process.execPath, ['server/dev.mjs'], {
  cwd: ROOT,
  env: {
    ...process.env,
    MEM_CONFIG: 'config.test.json',
    MEM_WRITE_TOKEN: TOKEN,
    MEM_BUILD_SITE: '0',
    NODE_NO_WARNINGS: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
child.stdout.on('data', (d) => (serverLog += d));
child.stderr.on('data', (d) => (serverLog += d));

function stopServer() {
  if (!child.killed) child.kill('SIGTERM');
}

try {
  const health = await waitHealthy();
  console.log(`  health: ${JSON.stringify(health)}`);

  const shape = await api('GET', '/api/health', undefined, { token: null });
  check('写模式已启用且连接可写', () => {
    assert.equal(shape.body.writeEnabled, true);
    assert.equal(shape.body.readOnly, false);
  });

  const baseMeta = (await api('GET', '/api/meta', undefined, { token: null })).body;
  const baseSessions = baseMeta.coverage.sessions;
  const baseAttempts = baseMeta.coverage.attempts;
  const baseCorrect = baseMeta.verdict.correct;
  console.log(`  基线：sessions=${baseSessions} attempts=${baseAttempts} correct=${baseCorrect}`);

  // ---- 鉴权 ----
  console.log('\n=== 2. 鉴权 ===');
  const noToken = await api('POST', '/api/sessions', { paperSlug: '2024-exam', date: TODAY, attempts: [] }, { token: null });
  check('无 token 写 → 401', () => assert.equal(noToken.status, 401));

  const badToken = await api('POST', '/api/sessions', { paperSlug: '2024-exam', date: TODAY, attempts: [] }, { token: 'wrong-token-wrong-token-1234' });
  check('错误 token 写 → 401', () => assert.equal(badToken.status, 401));

  const readNoToken = await api('GET', '/api/meta', undefined, { token: null });
  check('只读端点不需要 token', () => assert.equal(readNoToken.status, 200));

  // ---- 取题目上下文 ----
  console.log('\n=== 3. 录入前上下文 ===');
  const papers = await api('GET', '/api/papers', undefined, { token: null });
  check('GET /api/papers 返回 7 卷', () => assert.equal(papers.body.papers.length, 7));

  const q1 = (await api('GET', '/api/questions/2024-exam-q001', undefined, { token: null })).body;
  const q2 = (await api('GET', '/api/questions/2024-exam-q002', undefined, { token: null })).body;
  const q3 = (await api('GET', '/api/questions/2024-exam-q003', undefined, { token: null })).body;
  check('单题带题干全文', () => {
    assert.ok(q1.contentMd && q1.contentMd.length > 20);
    assert.ok(q1.answer, '客观题应有答案');
  });

  // 注意 LaTeX 原文是 `$S_9 = 26$`（等号两侧有空格），检索串不能写成 S_9=26
  const search = await api('GET', '/api/questions?q=S_9', undefined, { token: null });
  check('题干可全文检索（S_9 命中 2024 Q25）', () => {
    assert.ok(search.body.questions.some((x) => x.id === '2024-exam-q025'));
  });

  // ---- 创建场次 ----
  console.log('\n=== 4. 创建场次 ===');
  const createBody = {
    paperSlug: '2024-exam',
    date: TODAY,
    timingMode: 'session',
    durationMin: 35,
    fullText: '# 2024 管综真题 · 第 N 场（API 录入）\n\n本场用于写接口验收。\n',
    attempts: [
      // 不传 correct：应自动按答案判定
      { questionId: q1.id, userAnswer: q1.answer, process: '直接代入，一次算对。' },
      // 故意答错
      { questionId: q2.id, userAnswer: 'ZZZ', process: '选项看错，误选了不存在的项。', errorTag: '审题' },
      // 显式判定
      { questionId: q3.id, userAnswer: q3.answer, correct: true, substantiveCorrect: false, process: '答案对，思路有绕路。' },
    ],
  };
  const created = await api('POST', '/api/sessions', createBody);
  check('POST /api/sessions → 201', () => assert.equal(created.status, 201));
  const sessionId = created.body?.sessionId;
  check('自动生成 sessionId 且题目数正确', () => {
    assert.match(sessionId, /^2024-exam-a\d+$/);
    assert.equal(created.body.attemptCount, 3);
  });

  const afterCreate = (await api('GET', '/api/meta', undefined, { token: null })).body;
  check('coverage 增加 1 场 3 答', () => {
    assert.equal(afterCreate.coverage.sessions, baseSessions + 1);
    assert.equal(afterCreate.coverage.attempts, baseAttempts + 3);
  });

  const detail = (await api('GET', `/api/sessions/${sessionId}`, undefined, { token: null })).body;
  check('场次详情含 3 条作答', () => assert.equal(detail.attempts.length, 3));
  check('客观题按答案自动判定', () => {
    const a = detail.attempts.find((x) => x.questionId === q1.id);
    assert.equal(a.correct, true, '答对却没判对');
    assert.equal(a.substantiveCorrect, true);
  });
  check('答错的题判为错并记错因', () => {
    const a = detail.attempts.find((x) => x.questionId === q2.id);
    assert.equal(a.correct, false);
    assert.equal(a.errorTag, '审题');
    assert.deepEqual(a.errorTags, ['审题']);
  });
  check('显式 substantiveCorrect 被保留（答案对思路不对）', () => {
    const a = detail.attempts.find((x) => x.questionId === q3.id);
    assert.equal(a.correct, true);
    assert.equal(a.substantiveCorrect, false);
  });
  check('场次文件路径使用卷目录约定', () => {
    assert.match(detail.file, /^2024-exam\/answer\d+\.md$/);
  });

  const withProcess = (await api('GET', `/api/sessions/${sessionId}?include=process`, undefined, { token: null })).body;
  check('第一条作答承载整份场次正文', () => {
    const first = withProcess.attempts[0];
    assert.ok(first.processMd.includes('===== 场次全文：'), '缺少全文标记');
    assert.ok(first.processMd.includes('本场用于写接口验收'), '正文未写入');
    assert.ok(first.processMd.includes('<!-- attempt:'), '缺少 attempt 索引注释');
  });

  // ---- 冲突与校验 ----
  console.log('\n=== 5. 校验与冲突 ===');
  const dup = await api('POST', '/api/sessions', { ...createBody, sessionId });
  check('重复 sessionId → 409', () => assert.equal(dup.status, 409));

  const badPaper = await api('POST', '/api/sessions', {
    paperSlug: 'not-a-paper', date: TODAY, attempts: [{ questionId: q1.id, userAnswer: 'A' }],
  });
  check('未知卷 → 400 unknown_paper', () => {
    assert.equal(badPaper.status, 400);
    assert.equal(badPaper.body.code, 'unknown_paper');
  });

  const crossPaper = await api('POST', '/api/sessions', {
    paperSlug: '2024-exam', date: TODAY, attempts: [{ questionId: '2020-exam-q001', userAnswer: 'A' }],
  });
  check('题不属于该卷 → 400 question_not_in_paper', () => {
    assert.equal(crossPaper.status, 400);
    assert.equal(crossPaper.body.code, 'question_not_in_paper');
  });

  const emptyAttempts = await api('POST', '/api/sessions', { paperSlug: '2024-exam', date: TODAY, attempts: [] });
  check('空 attempts → 400', () => assert.equal(emptyAttempts.status, 400));

  const badDate = await api('POST', '/api/sessions', {
    paperSlug: '2024-exam', date: '2026/11/11', attempts: [{ questionId: q1.id }],
  });
  check('日期格式错 → 400', () => assert.equal(badDate.status, 400));

  const badMode = await api('POST', '/api/sessions', {
    paperSlug: '2024-exam', date: TODAY, timingMode: 'xxx', attempts: [{ questionId: q1.id }],
  });
  check('timingMode 越界 → 400', () => assert.equal(badMode.status, 400));

  const dupQ = await api('POST', '/api/sessions', {
    paperSlug: '2024-exam', date: TODAY,
    attempts: [{ questionId: q1.id }, { questionId: q1.id }],
  });
  check('同场同题出现两次 → 400', () => {
    assert.equal(dupQ.status, 400);
    assert.equal(dupQ.body.code, 'duplicate_question');
  });

  const afterBad = (await api('GET', '/api/meta', undefined, { token: null })).body;
  check('所有失败请求都没留下脏数据（事务性）', () => {
    assert.equal(afterBad.coverage.sessions, baseSessions + 1);
    assert.equal(afterBad.coverage.attempts, baseAttempts + 3);
  });

  // ---- 订正判定 ----
  console.log('\n=== 6. 订正与销账 ===');
  const wrongAttempt = detail.attempts.find((x) => x.questionId === q2.id);
  const patched = await api('PATCH', `/api/attempts/${wrongAttempt.id}`, {
    userAnswer: q2.answer, correct: true, process: '重看一遍，其实是选对了的，之前填错。',
  });
  check('PATCH 判定 → 200', () => assert.equal(patched.status, 200));

  const afterPatch = (await api('GET', `/api/sessions/${sessionId}`, undefined, { token: null })).body;
  const fixed = afterPatch.attempts.find((x) => x.questionId === q2.id);
  check('判定与作答都已更新', () => {
    assert.equal(fixed.correct, true);
    assert.equal(fixed.substantiveCorrect, true);
    assert.equal(fixed.userAnswer, q2.answer);
  });
  const afterPatchProcess = (await api('GET', `/api/sessions/${sessionId}?include=process`, undefined, { token: null })).body;
  check('订正后仍保留整份场次正文', () => {
    assert.ok(afterPatchProcess.attempts[0].processMd.includes('===== 场次全文：'));
  });

  const badField = await api('PATCH', `/api/attempts/${wrongAttempt.id}`, { id: 'hacked' });
  check('改不可改字段 → 400', () => {
    assert.equal(badField.status, 400);
    assert.equal(badField.body.code, 'unknown_field');
  });

  const notFound = await api('PATCH', '/api/attempts/not-exist', { correct: true });
  check('改不存在的作答 → 404', () => assert.equal(notFound.status, 404));

  const resolveOk = await api('POST', `/api/attempts/${wrongAttempt.id}/resolve`, { date: TODAY });
  check('做对后可销账', () => {
    assert.equal(resolveOk.status, 200);
    assert.equal(resolveOk.body.redoStatus, 'resolved');
  });

  const resolveBad = await api('POST', `/api/attempts/${wrongAttempt.id}/resolve`, {});
  check('已销账再销账不报错（幂等）', () => assert.equal(resolveBad.status, 200));

  const unresolved = await api('POST', `/api/attempts/${detail.attempts[0].id}/resolve`, {});
  check('销账要求最近一次判定为对（本用例应成功）', () => assert.equal(unresolved.status, 200));

  // ---- 撤销场次 ----
  console.log('\n=== 7. 撤销场次 ===');
  const del = await api('DELETE', `/api/sessions/${sessionId}`);
  check('DELETE 场次 → 200 且级联删作答', () => {
    assert.equal(del.status, 200);
    assert.equal(del.body.deletedAttempts, 3);
  });

  const afterDelete = (await api('GET', '/api/meta', undefined, { token: null })).body;
  check('撤销后回到基线', () => {
    assert.equal(afterDelete.coverage.sessions, baseSessions);
    assert.equal(afterDelete.coverage.attempts, baseAttempts);
    assert.equal(afterDelete.verdict.correct, baseCorrect);
  });

  const delAgain = await api('DELETE', `/api/sessions/${sessionId}`);
  check('重复删除 → 404', () => assert.equal(delAgain.status, 404));

  // ---- 导出联动 ----
  console.log('\n=== 8. 导出联动 ===');
  const again = await api('POST', '/api/sessions', { ...createBody, sessionId: undefined });
  const exportRes = await api('POST', '/api/export', {});
  check('POST /api/export → 200', () => assert.equal(exportRes.status, 200));
  check('导出覆盖数与库一致', () => {
    const c = exportRes.body.index.coverage;
    assert.equal(c.sessions, baseSessions + 1);
    assert.equal(c.attempts, baseAttempts + 3);
    assert.equal(exportRes.body.content.sessions, baseSessions + 1);
  });

  const idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/test-index.json'), 'utf8'));
  const newSession = idx.sessions.find((s) => s.id === again.body.sessionId);
  check('导出的 index.json 含新场次且字段齐全', () => {
    assert.ok(newSession, '新场次没进导出物');
    assert.equal(newSession.date, TODAY);
    assert.equal(newSession.questionCount, 3);
    assert.equal(newSession.durationMin, 35);
    const a = idx.attempts.filter((x) => x.sessionId === again.body.sessionId);
    assert.equal(a.length, 3);
    assert.ok(a.every((x) => x.session === newSession.file), 'attempt.session 与场次文件不一致');
    assert.ok(a.every((x) => x.verified === true), '已判定的作答 verified 应为 true');
    assert.ok(a.some((x) => x.errorTags.length === 1 && x.errorTags[0] === '审题'), '错因未进导出物');
  });

  const content = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/test-content.json'), 'utf8'));
  check('导出的 content.json 含新场次原文', () => {
    const text = content.sessions[newSession.file];
    assert.ok(text, '新场次原文缺失');
    assert.ok(text.startsWith('---'), 'front matter 丢失');
    assert.ok(text.includes('本场用于写接口验收'), '正文丢失');
  });

  // 收尾：把这个测试场次删掉，测试库回到基线
  await api('DELETE', `/api/sessions/${again.body.sessionId}`);
} finally {
  stopServer();
  await new Promise((r) => setTimeout(r, 300));
}

// ---------------------------------------------------------------- 正式库保护

console.log('\n=== 9. 正式库保护 ===');
const after = { db: stat(FORMAL_DB), index: stat(FORMAL_INDEX) };
check('data/mem.db 未被触碰（sha256 + mtime 一致）', () => {
  assert.equal(after.db.hash, before.db.hash, '正式库内容变了');
  assert.equal(after.db.mtimeMs, before.db.mtimeMs, '正式库 mtime 变了');
});
check('data/index.json 未被触碰', () => {
  assert.equal(after.index.hash, before.index.hash, '正式导出物被覆盖了');
});

console.log('\n=== 10. 只读进程仍然拒绝写入 ===');
// 8137 可能已被 ./dev.sh 占着（只读配置），这时直接复用它，不再起第二个进程
async function healthAt(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
    return r.ok ? r.json() : null;
  } catch {
    return null;
  }
}
let roChild = null;
let roPort = 8137;
const existing = await healthAt(8137);
if (!existing) {
  roChild = spawn(process.execPath, ['server/dev.mjs'], {
    cwd: ROOT,
    env: { ...process.env, MEM_CONFIG: 'config.local.json', MEM_BUILD_SITE: '0', NODE_NO_WARNINGS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (let i = 0; i < 60; i += 1) {
    if (await healthAt(roPort)) break;
    await new Promise((r) => setTimeout(r, 200));
  }
} else {
  console.log('  复用已在运行的 8137（config.local.json）');
}
try {
  const ro = await fetch(`http://127.0.0.1:${roPort}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer anything-long-enough' },
    body: JSON.stringify({ paperSlug: '2024-exam', date: TODAY, attempts: [{ questionId: '2024-exam-q001' }] }),
    signal: AbortSignal.timeout(5000),
  });
  const roHealth = await (await fetch(`http://127.0.0.1:${roPort}/api/health`, { signal: AbortSignal.timeout(5000) })).json();
  const roMeta = await fetch(`http://127.0.0.1:${roPort}/api/meta`, {
    method: 'POST', signal: AbortSignal.timeout(5000),
  });
  check('正式配置下写路由不存在（404，不暴露能力）', () => assert.equal(ro.status, 404));
  check('非可写路径用错方法仍是 405', () => assert.equal(roMeta.status, 405));
  check('正式配置连接为只读', () => {
    assert.equal(roHealth.readOnly, true);
    assert.equal(roHealth.writeEnabled, false);
  });
} finally {
  if (roChild) {
    roChild.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
  }
}

// ---------------------------------------------------------------- 汇总

const passed = results.length - failed;
console.log(`\n写接口自测：${passed} PASS / ${failed} FAIL`);
if (failed) {
  console.log('\n服务端日志尾部：');
  console.log(serverLog.split('\n').slice(-25).join('\n'));
  process.exit(1);
}
