// P1 + P2 验收：黑盒验证 API 端点、站点页面，口径以 data/mem.db 为准（动态推导，不硬编码行数）。
// 用法：node server/smoke-test.mjs [BASE_URL]
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.argv[2] || process.env.BASE_URL || 'http://127.0.0.1:8137';
const results = [];

// 口径基准：直接只读本地库。测试断言全部从这份快照推导，数据正常增长不会让冒烟变红。
const db = new DatabaseSync(path.join(ROOT, 'data', 'mem.db'), { readOnly: true });
const dbCount = (sql) => db.prepare(sql).get().n;
const dbCounts = {
  papers: dbCount('SELECT COUNT(*) AS n FROM papers'),
  questions: dbCount('SELECT COUNT(*) AS n FROM questions'),
  sessions: dbCount('SELECT COUNT(*) AS n FROM sessions'),
  attempts: dbCount('SELECT COUNT(*) AS n FROM attempts'),
  redoRows: dbCount('SELECT COUNT(*) AS n FROM attempts WHERE redo_status IS NOT NULL'),
};
const dbVerdict = {
  correct: dbCount('SELECT COUNT(*) AS n FROM attempts WHERE correct = 1'),
  wrong: dbCount('SELECT COUNT(*) AS n FROM attempts WHERE correct = 0'),
  unjudged: dbCount('SELECT COUNT(*) AS n FROM attempts WHERE correct IS NULL'),
  substantiveCorrect: dbCount('SELECT COUNT(*) AS n FROM attempts WHERE substantive_correct = 1'),
  isRedo: dbCount('SELECT COUNT(*) AS n FROM attempts WHERE is_redo = 1'),
};

function check(name, fn) {
  try {
    fn();
    results.push(['PASS', name, '']);
  } catch (err) {
    results.push(['FAIL', name, err.message.split('\n')[0]]);
  }
}

async function json(path, init) {
  const res = await fetch(BASE + path, init);
  return { status: res.status, body: await res.json() };
}

async function page(path) {
  const res = await fetch(BASE + path);
  return { status: res.status, text: await res.text() };
}

// 服务启动时会先重建站点，给几秒钟就绪窗口。
for (let i = 0; i < 40; i += 1) {
  try {
    if ((await fetch(BASE + '/api/health')).ok) break;
  } catch {
    /* 端口尚未监听 */
  }
  if (i === 39) throw new Error(`服务未就绪：${BASE}`);
  await new Promise((r) => setTimeout(r, 100));
}

const health = await json('/api/health');
const meta = await json('/api/meta');
const days = await json('/api/days');
const notFound = await json('/api/nope');
const badMethod = await json('/api/meta', { method: 'POST' });

check('服务可达且只读', () => {
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);
  assert.equal(health.body.readOnly, true);
});

check('4 表行数与库一致', () => {
  assert.deepEqual(meta.body.coverage, dbCounts);
});

check('判定口径与库一致', () => {
  assert.deepEqual(meta.body.verdict, dbVerdict);
});

check('答案状态合计等于题数', () => {
  assert.equal(meta.body.answers.confirmed + meta.body.answers.estimated, dbCounts.questions);
});

check('计时口径合计等于场次数', () => {
  const sum = Object.values(meta.body.timing).reduce((a, b) => a + b, 0);
  assert.equal(sum, dbCounts.sessions);
  assert.ok(meta.body.durationUnknownSessions <= dbCounts.sessions);
});

check('外键与题数自检全零', () => {
  assert.deepEqual(meta.body.warnings, []);
  assert.ok(Object.values(meta.body.integrity).every((v) => v === 0));
});

check('卷元数据齐全', () => {
  assert.equal(meta.body.volumes.length, dbCounts.papers);
  assert.ok(meta.body.volumes.every((v) => v.questionCount === v.actualQuestions));
});

check('学习日 / 场次 / 作答与库一致', () => {
  assert.equal(days.body.summary.learningDays, days.body.days.length);
  assert.equal(days.body.summary.sessions, dbCounts.sessions);
  assert.equal(days.body.summary.attempts, dbCounts.attempts);
});

check('日历逐题判定合计与 attempts 表一致', () => {
  const s = days.body.summary;
  assert.equal(s.correct, dbVerdict.correct);
  assert.equal(s.wrong, dbVerdict.wrong);
  assert.equal(s.unjudged, dbVerdict.unjudged);
  assert.equal(s.correct + s.wrong + s.unjudged, s.attempts);
});

check('days[] 形状兼容现有渲染器（commits 恒空）', () => {
  assert.equal(days.body.days.length, days.body.summary.learningDays);
  assert.ok(days.body.days.every((d) => Array.isArray(d.commits) && d.commits.length === 0));
  assert.ok(days.body.days.every((d) => d.totals.commits === 0 && d.hasCommits === false));
  assert.ok(days.body.days.every((d) => d.weekday && d.sessions.length > 0));
});

check('热力图 53 周口径与连续天数存在', () => {
  assert.ok(days.body.heatmap.weeks.length > 0);
  assert.equal(days.body.heatmap.weekdayLabels.length, 7);
  assert.equal(typeof days.body.heatmap.activeDays, 'number');
  assert.equal(typeof days.body.streaks.currentStreak, 'number');
  assert.equal(typeof days.body.streaks.longestStreak, 'number');
});

check('未知路径 404、非 GET 405', () => {
  assert.equal(notFound.status, 404);
  assert.equal(badMethod.status, 405);
});

// ---------------- P2：站点页面 ----------------
const root = await fetch(BASE + '/', { redirect: 'manual' });
const home = await page('/study/');
const sections = await Promise.all(
  ['weeks/', 'volumes/', 'papers/', 'stats/', 'knowledge/', 'about/', 'days/'].map((p) => page('/study/' + p))
);
const css = await fetch(BASE + '/study/assets/app.css');
const siteData = await json('/study/data.json');
const buildReport = await json('/study/build-report.json');
const sourcePage = await page(encodeURI('/study/source/2025年英语二/answer1/'));
const apiSessionPage = await page(
  encodeURI('/study/source/专项训练二-五大条件类推理题/answer2/answer2-5/')
);
const paperPage = await page('/study/papers/2024-exam/');
const paperNoSlash = await fetch(BASE + '/study/papers/2024-exam');
const katexCss = await fetch(BASE + '/study/assets/katex/katex.min.css');
const traversal = await fetch(BASE + '/study/%2e%2e%2f%2e%2e%2fetc%2fpasswd');

check('根路径重定向到 /study/', () => {
  assert.equal(root.status, 302);
  assert.equal(root.headers.get('location'), '/study/');
});

check('首页可访问且标题正确', () => {
  assert.equal(home.status, 200);
  assert.match(home.text, /<title>[^<]*学习记录<\/title>/);
});

check('7 个栏目页全部 200', () => {
  assert.ok(sections.every((r) => r.status === 200));
});

check('样式与原文页可访问', () => {
  assert.equal(css.status, 200);
  assert.equal(sourcePage.status, 200);
  assert.match(sourcePage.text, /<html/);
});

check('原文页：全文块是自动答案汇总时，改用逐题作答区块渲染', () => {
  assert.equal(apiSessionPage.status, 200);
  assert.match(apiSessionPage.text, /session-attempts-head/); // 结构化区块
  assert.match(apiSessionPage.text, /11 题 · 对 11/); // 场次统计来自库
  assert.match(apiSessionPage.text, /甲乙丙丁/); // 批改推演正文在页面里
  assert.match(apiSessionPage.text, /papers\/reasoning-2\/#reasoning-2-q20/); // 题号链到试卷锚点
  assert.doesNotMatch(apiSessionPage.text, /通过 API 录入/); // 答案汇总块不再渲染
  assert.equal(apiSessionPage.text.match(/我的答案/g).length, 11); // 无重复
});

check('试卷页：锚点与公式都在，KaTeX 样式可访问', () => {
  assert.equal(paperPage.status, 200);
  assert.match(paperPage.text, /id="2024-exam-q001"/);
  assert.match(paperPage.text, /class="katex"/); // 公式由服务端渲染，不是原始 $...$
  assert.doesNotMatch(paperPage.text, /\$[A-Za-z\\]/); // 没有漏渲染的行内公式
  assert.equal(katexCss.status, 200);
  assert.match(katexCss.headers.get('content-type') || '', /text\/css/);
});

check('试卷页答案速查：默认收起，展开后有答案格子', () => {
  assert.match(paperPage.text, /<details class="paper-answers">/); // 没有 open 属性 = 默认收起
  assert.doesNotMatch(paperPage.text, /<details class="paper-answers" open/);
  assert.match(paperPage.text, /paper-answers-meta">55 \/ 57/); // 55 客观题 + 2 作文
  assert.match(paperPage.text, /<i>1<\/i>E</); // 第 1 题答案与库一致
});

check('目录页不带尾斜杠也能访问（客户端会吃掉斜杠）', () => {
  assert.equal(paperNoSlash.status, 200);
  assert.match(paperNoSlash.headers.get('content-type') || '', /text\/html/);
});

check('试卷列表页的每张卡片点进去都是 200（防止相对路径少一级）', async () => {
  const listBase = BASE + '/study/papers/';
  const hrefs = [...paperPage.text.matchAll(/<a class="volume" href="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(hrefs.length >= 8, `列表页应有 8 张卡片，实际 ${hrefs.length}`);
  for (const href of hrefs) {
    const res = await fetch(new URL(href, listBase));
    assert.equal(res.status, 200, `卡片链接 404: ${href}`);
  }
});

check('站点 data.json 与数据库口径一致', () => {
  assert.equal(siteData.status, 200);
  assert.equal(siteData.body.days.length, days.body.summary.learningDays);
  assert.equal(siteData.body.volumes.length, meta.body.volumes.length);
  assert.equal(siteData.body.warnings.length, 0);
  assert.equal(siteData.body.meta.today, meta.body.today);
  assert.equal(siteData.body.meta.firstDay, days.body.summary.firstDay);
});

check('构建报告：场次 / 作答与库一致，无提交无警告', () => {
  assert.equal(buildReport.body.counts.sessions, dbCounts.sessions);
  assert.equal(buildReport.body.counts.commits, 0);
  assert.equal(buildReport.body.warnings.length, 0);
  assert.equal(buildReport.body.jsonIndex.attempts, dbCounts.attempts);
});

check('目录穿越被拦截', () => {
  assert.ok([403, 404].includes(traversal.status));
});

for (const [status, name, detail] of results) {
  console.log(`${status}  ${name}${detail ? '  → ' + detail : ''}`);
}
const failed = results.filter(([s]) => s === 'FAIL').length;
console.log(`\nP1+P2 自测：${results.length - failed} PASS / ${failed} FAIL`);
console.log('摘要:', JSON.stringify({
  learningDays: days.body.summary.learningDays,
  activeDays: days.body.heatmap.activeDays,
  streaks: days.body.streaks,
  lastDay: days.body.summary.lastDay,
}));
process.exit(failed ? 1 : 0);
