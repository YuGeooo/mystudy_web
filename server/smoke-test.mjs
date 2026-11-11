// P1 + P2 验收：黑盒验证 API 端点、站点页面与 §8 基线口径一致。
// 用法：node server/smoke-test.mjs [BASE_URL]
import assert from 'node:assert/strict';

const BASE = process.argv[2] || process.env.BASE_URL || 'http://127.0.0.1:8137';
const results = [];

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

check('4 表行数 7 / 328 / 40 / 317，台账 12', () => {
  assert.deepEqual(meta.body.coverage, {
    papers: 7, questions: 328, sessions: 40, attempts: 317, redoRows: 12,
  });
});

check('判定 217 / 89 / 11，实质 218，重做 25', () => {
  assert.deepEqual(meta.body.verdict, {
    correct: 217, wrong: 89, unjudged: 11, substantiveCorrect: 218, isRedo: 25,
  });
});

check('答案状态 321 / 7', () => {
  assert.deepEqual(meta.body.answers, { confirmed: 321, estimated: 7 });
});

check('计时 23 / 0 / 1 / 16，未记时长 16 场', () => {
  assert.deepEqual(meta.body.timing, {
    session: 23, 'per-question': 0, mixed: 1, none: 16,
  });
  assert.equal(meta.body.durationUnknownSessions, 16);
});

check('外键与题数自检全零', () => {
  assert.deepEqual(meta.body.warnings, []);
  assert.ok(Object.values(meta.body.integrity).every((v) => v === 0));
});

check('7 卷元数据齐全', () => {
  assert.equal(meta.body.volumes.length, 7);
  assert.ok(meta.body.volumes.every((v) => v.questionCount === v.actualQuestions));
});

check('学习日 24 天，场次 40，作答 317', () => {
  assert.equal(days.body.summary.learningDays, 24);
  assert.equal(days.body.summary.sessions, 40);
  assert.equal(days.body.summary.attempts, 317);
});

check('日历逐题判定合计与 attempts 表一致', () => {
  const s = days.body.summary;
  assert.equal(s.correct, 217);
  assert.equal(s.wrong, 89);
  assert.equal(s.unjudged, 11);
  assert.equal(s.correct + s.wrong + s.unjudged, s.attempts);
});

check('days[] 形状兼容现有渲染器（commits 恒空）', () => {
  assert.equal(days.body.days.length, 24);
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
const paperPage = await page('/study/papers/2024-exam/');
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

check('试卷页：锚点与公式都在，KaTeX 样式可访问', () => {
  assert.equal(paperPage.status, 200);
  assert.match(paperPage.text, /id="2024-exam-q001"/);
  assert.match(paperPage.text, /class="katex"/); // 公式由服务端渲染，不是原始 $...$
  assert.doesNotMatch(paperPage.text, /\$[A-Za-z\\]/); // 没有漏渲染的行内公式
  assert.equal(katexCss.status, 200);
  assert.match(katexCss.headers.get('content-type') || '', /text\/css/);
});

check('站点 data.json 与数据库口径一致', () => {
  assert.equal(siteData.status, 200);
  assert.equal(siteData.body.days.length, 24);
  assert.equal(siteData.body.volumes.length, 7);
  assert.equal(siteData.body.warnings.length, 0);
  assert.equal(siteData.body.meta.today, meta.body.today);
  assert.equal(siteData.body.meta.firstDay, days.body.summary.firstDay);
});

check('构建报告：40 场、0 提交、0 警告', () => {
  assert.equal(buildReport.body.counts.sessions, 40);
  assert.equal(buildReport.body.counts.commits, 0);
  assert.equal(buildReport.body.warnings.length, 0);
  assert.equal(buildReport.body.jsonIndex.attempts, 317);
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
