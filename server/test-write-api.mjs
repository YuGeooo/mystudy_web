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

// 每次从空目录开始数快照，避免上一轮的残留影响 keep 断言
fs.rmSync(path.join(ROOT, 'data/test-backups'), { recursive: true, force: true });

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

  // ---- 场次订正 / 补录单题 / 撤销单题 ----
  console.log('\n=== 8. 场次订正与单题增删 ===');
  const TARGET = '2024-exam-a900';
  const FILE0 = '2024-exam/answer900.md';
  const FILE1 = '2024-exam/answer900-fix.md';
  const mk = await api('POST', '/api/sessions', {
    paperSlug: '2024-exam', date: TODAY, sessionId: TARGET, file: FILE0,
    durationMin: 30, timingMode: 'session',
    fullText: '# 订正测试场次\n\n原始正文。\n',
    attempts: [
      { questionId: q1.id, userAnswer: q1.answer, process: '原样保留。' },
      { questionId: q2.id, userAnswer: 'ZZZ', errorTag: '审题' },
    ],
  });
  check('准备：显式 sessionId 建场 → 201', () => assert.equal(mk.status, 201));

  const ps = await api('PATCH', `/api/sessions/${TARGET}`, {
    durationMin: 50, timingMode: 'per-question', note: '补记：分段计时',
  });
  check('PATCH 场次头 → 200', () => assert.equal(ps.status, 200));
  let s8 = (await api('GET', `/api/sessions/${TARGET}`, undefined, { token: null })).body;
  check('时长 / 计时方式 / 备注已更新', () => {
    assert.equal(s8.durationMin, 50);
    assert.equal(s8.timingMode, 'per-question');
    assert.equal(s8.note, '补记：分段计时');
  });

  const pd = await api('PATCH', `/api/sessions/${TARGET}`, { date: '2026-11-10' });
  check('改日期 → 200 且作答 id 前缀同步', () => {
    assert.equal(pd.status, 200);
    assert.equal(pd.body.renamedAttempts, 2);
  });
  s8 = (await api('GET', `/api/sessions/${TARGET}`, undefined, { token: null })).body;
  check('场次日期与作答 id 都换成新日期', () => {
    assert.equal(s8.date, '2026-11-10');
    assert.ok(s8.attempts.every((a) => a.id.startsWith(`2026-11-10-${TARGET}-`)), '作答 id 没跟着改');
  });
  const s8p = (await api('GET', `/api/sessions/${TARGET}?include=process`, undefined, { token: null })).body;
  check('正文里的 attempt 注释同步改名', () => {
    assert.ok(s8p.attempts.some((a) => a.processMd.startsWith(`<!-- attempt: 2026-11-10-`)));
  });

  await api('POST', '/api/export', {});
  const idxP = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/test-index.json'), 'utf8'));
  const contentP = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/test-content.json'), 'utf8'));
  check('改日期后导出物仍然自洽', () => {
    const s = idxP.sessions.find((x) => x.id === TARGET);
    assert.equal(s.date, '2026-11-10');
    const a = idxP.attempts.filter((x) => x.sessionId === TARGET);
    assert.equal(a.length, 2);
    assert.ok(a.every((x) => x.date === '2026-11-10' && x.id.startsWith('2026-11-10-')));
    assert.ok(contentP.sessions[FILE0].includes('原始正文'));
  });

  const pf = await api('PATCH', `/api/sessions/${TARGET}`, { file: FILE1 });
  check('改场次文件路径 → 200', () => assert.equal(pf.status, 200));
  const s8f = (await api('GET', `/api/sessions/${TARGET}?include=process`, undefined, { token: null })).body;
  check('正文分隔标记跟着改文件路径', () => {
    assert.equal(s8f.file, FILE1);
    const carrier = s8f.attempts.find((a) => a.processMd.includes('===== 场次全文：'));
    assert.ok(carrier, '找不到承载正文的作答');
    assert.ok(carrier.processMd.includes(`===== 场次全文：${FILE1} =====`), '标记没改成新路径');
  });

  await api('POST', '/api/export', {});
  const contentF = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/test-content.json'), 'utf8'));
  check('导出内容键跟着换，旧键消失', () => {
    assert.ok(contentF.sessions[FILE1], '新键缺原文');
    assert.equal(contentF.sessions[FILE0], undefined, '旧键还在');
  });

  const pft = await api('PATCH', `/api/sessions/${TARGET}`, { fullText: '# 订正测试场次\n\n订正后的正文。\n' });
  check('改整份正文 → 200', () => assert.equal(pft.status, 200));
  const s8t = (await api('GET', `/api/sessions/${TARGET}?include=process`, undefined, { token: null })).body;
  check('正文已替换且该题推演段落保留', () => {
    const carrier = s8t.attempts.find((a) => a.processMd.includes('===== 场次全文：'));
    assert.ok(carrier.processMd.includes('订正后的正文'), '新正文没写进去');
    assert.ok(!carrier.processMd.includes('原始正文'), '旧正文还在');
    assert.ok(carrier.processMd.includes('原样保留'), '本题推演被覆盖了');
  });

  const pDate = await api('PATCH', `/api/sessions/${TARGET}`, { date: '2026/11/10' });
  check('场次日期格式错 → 400', () => assert.equal(pDate.status, 400));
  const pField = await api('PATCH', `/api/sessions/${TARGET}`, { paperSlug: '2020-exam' });
  check('场次改不可改字段 → 400', () => {
    assert.equal(pField.status, 400);
    assert.equal(pField.body.code, 'unknown_field');
  });
  const pEmpty = await api('PATCH', `/api/sessions/${TARGET}`, {});
  check('场次空 body → 400', () => assert.equal(pEmpty.status, 400));
  const pMissing = await api('PATCH', '/api/sessions/not-exist', { note: 'x' });
  check('改不存在场次 → 404', () => assert.equal(pMissing.status, 404));
  const others = (await api('GET', '/api/sessions?limit=5', undefined, { token: null })).body.sessions;
  const occupied = others.find((s) => s.id !== TARGET)?.file;
  const pFileDup = await api('PATCH', `/api/sessions/${TARGET}`, { file: occupied });
  check('文件路径与别的场次撞车 → 409', () => {
    assert.equal(pFileDup.status, 409);
    assert.equal(pFileDup.body.code, 'file_exists');
  });

  // 补录单题
  const q4 = (await api('GET', '/api/questions/2024-exam-q004', undefined, { token: null })).body;
  const added = await api('POST', `/api/sessions/${TARGET}/attempts`, {
    questionId: q4.id, userAnswer: q4.answer, process: '补录：漏了这一题。',
  });
  check('补录单题 → 201 且题量 +1', () => {
    assert.equal(added.status, 201);
    assert.equal(added.body.questionCount, 3);
  });
  const s8add = (await api('GET', `/api/sessions/${TARGET}`, undefined, { token: null })).body;
  check('补录后场次含 3 条作答，日期沿用新日期', () => {
    assert.equal(s8add.attempts.length, 3);
    assert.ok(s8add.attempts.some((a) => a.id === `2026-11-10-${TARGET}-${q4.id}`));
  });

  const dupAdd = await api('POST', `/api/sessions/${TARGET}/attempts`, { questionId: q1.id });
  check('补录已存在的题 → 400 duplicate_question', () => {
    assert.equal(dupAdd.status, 400);
    assert.equal(dupAdd.body.code, 'duplicate_question');
  });
  const crossAdd = await api('POST', `/api/sessions/${TARGET}/attempts`, { questionId: '2020-exam-q001' });
  check('补录别卷的题 → 400 question_not_in_paper', () => {
    assert.equal(crossAdd.status, 400);
    assert.equal(crossAdd.body.code, 'question_not_in_paper');
  });
  const addMissing = await api('POST', '/api/sessions/not-exist/attempts', { questionId: q1.id });
  check('给不存在的场次补题 → 404', () => assert.equal(addMissing.status, 404));

  // 单条作答查询
  const oneAttempt = await api('GET', `/api/attempts/${added.body.attemptId}`, undefined, { token: null });
  check('GET /api/attempts/:id → 200', () => {
    assert.equal(oneAttempt.status, 200);
    assert.equal(oneAttempt.body.id, added.body.attemptId);
    assert.equal(oneAttempt.body.questionId, q4.id);
  });
  const noAttempt = await api('GET', '/api/attempts/not-exist', undefined, { token: null });
  check('GET 不存在的作答 → 404', () => assert.equal(noAttempt.status, 404));

  // 删单题：先删承载正文的那条，正文要搬给新的第一条
  const s8del = (await api('GET', `/api/sessions/${TARGET}?include=process`, undefined, { token: null })).body;
  const carrier8 = s8del.attempts.find((a) => a.processMd.includes('===== 场次全文：'));
  const delCarrier = await api('DELETE', `/api/attempts/${carrier8.id}`);
  check('删掉承载正文的作答 → 200', () => {
    assert.equal(delCarrier.status, 200);
    assert.equal(delCarrier.body.remainingAttempts, 2);
  });
  const s8after = (await api('GET', `/api/sessions/${TARGET}?include=process`, undefined, { token: null })).body;
  check('正文搬到新的第一条，没丢', () => {
    assert.equal(s8after.attempts.length, 2);
    const newCarrier = s8after.attempts.find((a) => a.processMd.includes('===== 场次全文：'));
    assert.ok(newCarrier, '正文标记丢了');
    assert.ok(newCarrier.processMd.includes('订正后的正文'), '正文内容丢了');
    assert.equal(newCarrier.id, s8after.attempts[0].id, '正文不该挂在非第一条上');
  });
  await api('POST', '/api/export', {});
  const contentDel = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/test-content.json'), 'utf8'));
  check('删单题后仍能完整导出原文', () => {
    assert.ok(contentDel.sessions[FILE1].includes('订正后的正文'));
  });

  const left1 = (await api('GET', `/api/sessions/${TARGET}`, undefined, { token: null })).body.attempts;
  await api('DELETE', `/api/attempts/${left1[0].id}`);
  const delLast = await api('DELETE', `/api/attempts/${left1[1].id}`);
  check('删到只剩一条 → 400 last_attempt', () => {
    assert.equal(delLast.status, 400);
    assert.equal(delLast.body.code, 'last_attempt');
  });

  const cleanup = await api('DELETE', `/api/sessions/${TARGET}`);
  check('清理测试场次 → 200', () => assert.equal(cleanup.status, 200));
  const afterCleanup = (await api('GET', '/api/meta', undefined, { token: null })).body;
  check('订正用例跑完后回到基线', () => {
    assert.equal(afterCleanup.coverage.sessions, baseSessions);
    assert.equal(afterCleanup.coverage.attempts, baseAttempts);
  });

  // ---- 题库写入（卷 / 题）与备份 ----
  console.log('\n=== 9. 题库写入与备份 ===');
  const NEW_SLUG = 'test-paper-2026';
  const NEW_FILE = 'TEST2026/paper.md';

  const mkPaper = await api('POST', '/api/papers', {
    slug: NEW_SLUG, title: '2026 测试卷', subject: '管综',
    scoreRule: { objective: 3 },
    paperFile: NEW_FILE, paperPrefix: '# 2026 测试卷\n\n## 一、问题求解\n\n',
    note: '接口验收用，跑完即删',
  });
  check('POST /api/papers → 201', () => assert.equal(mkPaper.status, 201));

  const papers9 = (await api('GET', '/api/papers', undefined, { token: null })).body.papers;
  check('新卷出现在卷列表且题量为 0', () => {
    const p = papers9.find((x) => x.slug === NEW_SLUG);
    assert.ok(p, '新卷没进列表');
    assert.equal(p.questionCount, 0);
  });

  const mkQ = await api('POST', '/api/questions', {
    paperSlug: NEW_SLUG, type: 'problem', topicId: 'math.profit', topic: '问题求解',
    contentMd: '**1.** 某商品进价 100 元，售价 150 元，利润率是多少？\n\nA. 30%　B. 50%　C. 60%　D. 80%　E. 100%\n',
    answer: 'B',
  });
  check('POST /api/questions → 201 且自动生成 id', () => {
    assert.equal(mkQ.status, 201);
    assert.equal(mkQ.body.id, `${NEW_SLUG}-q001`);
    assert.equal(mkQ.body.seq, 1);
  });

  const q9 = (await api('GET', `/api/questions/${mkQ.body.id}`, undefined, { token: null })).body;
  check('题干自动补锚点，知识点解析成中文路径', () => {
    assert.ok(q9.contentMd.includes(`id="${mkQ.body.id}"`), '缺少锚点');
    assert.equal(q9.topicId, 'math.profit');
    assert.equal(q9.answer, 'B');
    assert.equal(q9.scorable, true);
  });

  const paper9 = (await api('GET', `/api/papers/${NEW_SLUG}`, undefined, { token: null })).body;
  check('卷的题目清单与题量同步', () => {
    assert.equal(paper9.questionCount, 1);
    assert.deepEqual(paper9.questionIds, [mkQ.body.id]);
    assert.equal(paper9.questions.length, 1);
  });

  const mkQ2 = await api('POST', '/api/questions', {
    paperSlug: NEW_SLUG, type: 'problem', topicId: 'math.ratio', topic: '问题求解',
    contentMd: '**2.** 甲乙速度比 3:2，同时出发，甲到时乙还剩 30 公里，全程多少？\n\nA. 60　B. 75　C. 90　D. 100　E. 120\n',
    answer: 'C',
  });
  check('第二题顺序号自动接上', () => assert.equal(mkQ2.body.seq, 2));

  await api('POST', '/api/export', {});
  const idx9 = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/test-index.json'), 'utf8'));
  const content9 = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/test-content.json'), 'utf8'));
  check('新题进了 index.json，带知识点路径', () => {
    const q = idx9.questions.find((x) => x.id === mkQ.body.id);
    assert.ok(q, '新题没进导出物');
    assert.deepEqual(q.topicPath, ['管综数学', '商品利润']);
    assert.equal(q.volume, NEW_SLUG);
  });
  check('新题题干拼进原文页', () => {
    assert.ok(content9.papers[NEW_FILE], '原文页缺失');
    assert.ok(content9.papers[NEW_FILE].includes('利润率'), '题干没进原文页');
    assert.ok(content9.papers[NEW_FILE].startsWith('# 2026 测试卷'), '原文页头丢失');
  });

  const pq = await api('PATCH', `/api/questions/${mkQ.body.id}`, { answer: 'C', section: '一、问题求解' });
  check('PATCH 题目 → 200', () => {
    assert.equal(pq.status, 200);
    assert.deepEqual(pq.body.warnings, []);
  });
  const q9b = (await api('GET', `/api/questions/${mkQ.body.id}`, undefined, { token: null })).body;
  check('答案与小节已更新', () => {
    assert.equal(q9b.answer, 'C');
    assert.equal(q9b.section, '一、问题求解');
  });

  const badTopic = await api('PATCH', `/api/questions/${mkQ.body.id}`, { topicId: 'math.nope' });
  check('改不存在的知识点 → 400 unknown_topic', () => {
    assert.equal(badTopic.status, 400);
    assert.equal(badTopic.body.code, 'unknown_topic');
  });
  const badTopicNew = await api('POST', '/api/questions', {
    paperSlug: NEW_SLUG, type: 'problem', topicId: 'math.nope', topic: '问题求解', contentMd: 'x',
  });
  check('新建时知识点不存在 → 400 unknown_topic', () => assert.equal(badTopicNew.status, 400));
  const badFile = await api('POST', '/api/questions', {
    paperSlug: NEW_SLUG, type: 'problem', topicId: 'math.profit', topic: '问题求解',
    contentMd: 'x', paperFile: '不存在/paper.md',
  });
  check('原文页不属于该卷 → 400 unknown_paper_file', () => {
    assert.equal(badFile.status, 400);
    assert.equal(badFile.body.code, 'unknown_paper_file');
  });
  const badPaper2 = await api('POST', '/api/questions', {
    paperSlug: 'not-a-paper', type: 'problem', topicId: 'math.profit', topic: '问题求解', contentMd: 'x',
  });
  check('往不存在的卷加题 → 400 unknown_paper', () => assert.equal(badPaper2.body.code, 'unknown_paper'));
  const patchQBad = await api('PATCH', `/api/questions/${mkQ.body.id}`, { paperSlug: '2020-exam' });
  check('题目换卷 → 400 unknown_field', () => {
    assert.equal(patchQBad.status, 400);
    assert.equal(patchQBad.body.code, 'unknown_field');
  });

  const delInUse = await api('DELETE', '/api/questions/2024-exam-q001');
  check('删有作答的题 → 409 question_in_use', () => {
    assert.equal(delInUse.status, 409);
    assert.equal(delInUse.body.code, 'question_in_use');
  });
  const delPaperFull = await api('DELETE', '/api/papers/2024-exam');
  check('删非空卷 → 409 paper_not_empty', () => {
    assert.equal(delPaperFull.status, 409);
    assert.equal(delPaperFull.body.code, 'paper_not_empty');
  });

  const pp = await api('PATCH', `/api/papers/${NEW_SLUG}`, { title: '2026 测试卷（改）', note: '改过了' });
  check('PATCH 试卷 → 200', () => assert.equal(pp.status, 200));
  const paper9b = (await api('GET', `/api/papers/${NEW_SLUG}`, undefined, { token: null })).body;
  check('卷标题已更新', () => assert.equal(paper9b.title, '2026 测试卷（改）'));
  const ppBad = await api('PATCH', `/api/papers/${NEW_SLUG}`, { slug: 'x' });
  check('改卷 slug → 400 unknown_field', () => assert.equal(ppBad.body.code, 'unknown_field'));

  const dq1 = await api('DELETE', `/api/questions/${mkQ2.body.id}`);
  const dq2 = await api('DELETE', `/api/questions/${mkQ.body.id}`);
  check('删无引用的题 → 200 且题量递减', () => {
    assert.equal(dq1.status, 200);
    assert.equal(dq1.body.questionCount, 1);
    assert.equal(dq2.body.questionCount, 0);
  });
  const dp = await api('DELETE', `/api/papers/${NEW_SLUG}`);
  check('删空卷 → 200', () => assert.equal(dp.status, 200));
  const dpAgain = await api('DELETE', `/api/papers/${NEW_SLUG}`);
  check('重复删卷 → 404', () => assert.equal(dpAgain.status, 404));

  // 备份
  const bl = await api('GET', '/api/backups', undefined, { token: null });
  check('GET /api/backups → 200 且有写前快照', () => {
    assert.equal(bl.status, 200);
    assert.ok(bl.body.backups.length > 0, '没有任何快照');
    assert.ok(
      bl.body.backups.some((b) => String(b.reason || '').includes('questions')),
      '没有写前自动快照'
    );
  });
  check('快照数量受 keep 限制（5）', () => assert.ok(bl.body.backups.length <= 5));

  const manual = await api('POST', '/api/backups', {});
  check('POST /api/backups → 201 且记录行数', () => {
    assert.equal(manual.status, 201);
    assert.ok(manual.body.rows.questions > 300);
    assert.ok(fs.existsSync(path.join(ROOT, manual.body.dir, 'mem.db')), '快照文件没落盘');
  });
  const backupCheck = await sh('sqlite3', [
    path.join(ROOT, manual.body.dir, 'mem.db'), 'PRAGMA integrity_check;',
  ]);
  check('快照可打开且完整性检查通过', () => assert.equal(backupCheck.trim(), 'ok'));

  const afterLib = (await api('GET', '/api/meta', undefined, { token: null })).body;
  check('题库用例跑完题目数回到基线', () => assert.equal(afterLib.coverage.questions, 328));

  // ---- 导出联动 ----
  console.log('\n=== 10. 导出联动 ===');
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

console.log('\n=== 11. 正式库保护 ===');
const after = { db: stat(FORMAL_DB), index: stat(FORMAL_INDEX) };
check('data/mem.db 未被触碰（sha256 + mtime 一致）', () => {
  assert.equal(after.db.hash, before.db.hash, '正式库内容变了');
  assert.equal(after.db.mtimeMs, before.db.mtimeMs, '正式库 mtime 变了');
});
check('data/index.json 未被触碰', () => {
  assert.equal(after.index.hash, before.index.hash, '正式导出物被覆盖了');
});

console.log('\n=== 12. 只读进程仍然拒绝写入 ===');
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
