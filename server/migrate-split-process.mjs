// 数据治理：老场次 process_md 去重 + 逐题切分回填。
//
// 迁移来的老场次有两种形态（实测 2026-11-12）：
//   A 类（18 场）：每条 attempt 已有自己的逐题批改，但整卷文档（场次全文）
//                  又重复附在**每一条**后面 —— 只需把非首条的文档拷贝删掉；
//   B 类（11 场）：每条 attempt 都是纯文档拷贝，批改只存在于文档里 ——
//                  按题切分文档回填到各 attempt；
//   其余（单题场次、题号重复且段落不齐、已是新形态）：跳过。
//
// 目标形态（与 API 录入场次一致）：每条 attempt = 注释头 + 自己的批改；
// 仅首条额外保留「场次全文」标记段，content.json 导出契约不变，页面渲染不变。
//
// 用法：
//   node server/migrate-split-process.mjs           # dry-run：出方案、打印审计、存 /tmp/split-plan.json
//   node server/migrate-split-process.mjs --apply   # 按方案 PATCH 线上 /api/attempts/:id
//   node server/migrate-split-process.mjs --repair  # 二次修复：首轮 PATCH 后每条被
//      renderAttemptBlock 重新包了脚手架（注释头 + ## QN + 批改 + ### Answer + 全文尾巴），
//      本轮把非首条还原为纯批改正文再 PATCH——配合 write.mjs 的新语义（非首条
//      不保留全文尾巴），文档拷贝被清掉且脚手架不会重复
//
// 安全性：只改 process_md，不碰判定/答案/notes；A 类不改任何批改正文，只删冗余尾巴。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { all, get } from './db.mjs';
import { FULLTEXT_MARK } from './export.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APPLY = process.argv.includes('--apply') || process.argv.includes('--repair');
const REPAIR = process.argv.includes('--repair');
const BASE = 'https://geyuqi.me';
const MIN_OWN_BATCH = 40; // 少于这个数视为「没有自己的批改」（残行/空行）

// ---- B 类切分策略：每种卷型一种，命中题数最多者胜出 -------------------------
// 每条策略的 re 需带捕获组 1 = 题号，且只在「题块开头」处命中。

const STRATEGIES = [
  { name: 'h2-Q', re: /^##\s+Q\s*(\d+)[^\n]*$/gm }, // ## Q1 ✅ ——管综客观题
  { name: 'h2-第N题', re: /^##\s+第\s*(\d+)\s*题[^\n]*$/gm }, // ## 第 56 题 ——写作
  { name: 'h3-第N题', re: /^###\s+第\s*(\d+)\s*题[^\n]*$/gm }, // ### 第 1 题 ——数学/错题重练
  { name: 'h3-考点第N题', re: /^###\s+\S{1,6}\s+第\s*(\d{1,2})\s*题[^\n]*$/gm }, // ### 利润 第 7 题 ——数学混考点
  { name: 'h3-缩写N', re: /^###\s+\S{1,8}\s+(\d{1,2})(?!\d)[^\n]*$/gm }, // ### 线规 1 ——数学缩写考点
  { name: '逐题分析', re: /^\*\*(\d+)\.[^\n]*$/gm }, // **1. ✅** …——形式逻辑/专项训练二
  { name: '订正bullet', re: /^-\s+\*\*(\d+)\.\s*正确答案[^\n]*$/gm }, // - **1. 正确答案 D…——英语
];

function splitByPattern(doc, pattern) {
  const re = new RegExp(pattern.re.source, 'gm');
  const points = [];
  let m;
  while ((m = re.exec(doc)) !== null) {
    points.push({ num: Number(m[1]), start: m.index, end: m.index + m[0].length });
    re.lastIndex = m.index + 1;
  }
  if (points.length < 2) return null; // 至少两段才叫「按题切分」
  const sections = [];
  for (let i = 0; i < points.length; i++) {
    // 块终点：下一个块起点，或中间出现的非块标题（如 ## 三、错因归纳）
    let end = i + 1 < points.length ? points[i + 1].start : doc.length;
    const rest = doc.slice(points[i].end, end);
    const stop = rest.search(/^#{1,3}\s+/m);
    if (stop >= 0) {
      const headText = rest.slice(stop).split('\n')[0];
      const isNextBlock = new RegExp(pattern.re.source, 'm').test(headText) && /\d/.test(headText);
      if (!isNextBlock && points[i].end + stop < end) end = points[i].end + stop;
    }
    const text = doc.slice(points[i].start, end).trim();
    if (text) sections.push({ num: points[i].num, text });
  }
  return sections;
}

// ---- 构造方案 ---------------------------------------------------------------

function buildPlan() {
  const plan = [];
  const skip = [];
  const sessions = all(
    "SELECT id, json_extract(note,'$.baseline.file') AS file FROM sessions ORDER BY rowid"
  );

  for (const s of sessions) {
    const rows = all(
      `SELECT a.id, a.rowid, a.process_md, q.number
       FROM attempts a JOIN questions q ON q.id = a.question_id
       WHERE a.session_id = ? ORDER BY a.rowid`,
      s.id
    );
    if (!s.file) { skip.push(['(无 baseline.file)', '跳过']); continue; }
    if (rows.length <= 1) { skip.push([s.file, `单题场次（${rows.length} 题）`]); continue; }

    const first = rows[0];
    const marker = `${FULLTEXT_MARK}${s.file} =====`;
    const markerPos = first.process_md.indexOf(marker);
    if (markerPos < 0) { skip.push([s.file, '首条作答没有场次全文标记']); continue; }
    const markerTail = first.process_md.slice(markerPos); // 标记行 + 文档，原样保留
    const firstOwn = first.process_md.slice(0, markerPos)
      .replace(/^<!--\s*attempt:[^>]*-->\s*\n?/, '').trim();

    const commentOf = (md) => (md.match(/^<!--\s*attempt:[^>]*-->/) || [''])[0];

    // ---- repair：非首条去尾巴 + 还原纯批改（脚手架由服务端重新包） ----
    if (REPAIR) {
      const updates = [];
      for (const r of rows.slice(1)) {
        const pos = r.process_md.indexOf(FULLTEXT_MARK);
        if (pos < 0) continue; // 没有尾巴，无需修
        let body = r.process_md.slice(0, pos)
          .replace(/^<!--\s*attempt:[^>]*-->\s*\n?/gm, '') // 多轮修复可能叠了多层注释头
          .replace(/^##\s+Q\s*\d+[^\n]*\n?/gm, '')
          .replace(/^###\s+Answer[^\n]*\n?/gm, '')
          .trim();
        updates.push({
          attemptId: r.id, questionNumber: r.number,
          hasBatch: Boolean(body), before: r.process_md.length,
          after: body.length, process: body,
        });
      }
      if (!updates.length) { skip.push([s.file, '非首条没有全文尾巴']); continue; }
      plan.push({
        file: s.file, sessionId: s.id, kind: 'repair', strategy: '-', attempts: rows.length,
        sectionsFound: '-', updates,
      });
      continue;
    }

    // ---- A 类：每条都已有自己的批改，只删非首条的文档拷贝 ----
    if (firstOwn.length >= MIN_OWN_BATCH) {
      const updates = [];
      for (const r of rows.slice(1)) {
        const pos = r.process_md.indexOf(FULLTEXT_MARK);
        if (pos < 0) continue; // 本来就没有拷贝尾巴，不动
        const own = r.process_md.slice(0, pos).replace(/\n+$/, '');
        updates.push({
          attemptId: r.id, questionNumber: r.number,
          before: r.process_md.length, after: own.length, process: own,
        });
      }
      if (!updates.length) { skip.push([s.file, '非首条没有文档拷贝']); continue; }
      plan.push({ file: s.file, sessionId: s.id, kind: 'A·去重', strategy: '-', attempts: rows.length, sectionsFound: '-', updates });
      continue;
    }

    // ---- B 类：纯文档拷贝，按题切分回填 ----
    const doc = markerTail.slice(markerTail.indexOf('\n') + 1).trim(); // 标记行之后的文档
    let best = null;
    for (const strategy of STRATEGIES) {
      const sections = splitByPattern(doc, strategy);
      if (!sections) continue;
      const score = sections.length;
      if (!best || score > best.score) best = { name: strategy.name, sections, score };
    }
    if (!best) { skip.push([s.file, '没有策略能切出 ≥2 个题目段落']); continue; }

    // 段 → 作答分配：题号唯一就按号配；题号有重复则要求「段序列与作答题号序列
    // 完全一致」按顺序配（文档写作顺序与作答顺序一致才安全），否则跳过。
    const numbers = rows.map((r) => r.number);
    const numbersUnique = new Set(numbers).size === numbers.length;
    const updates = [];
    if (numbersUnique) {
      const byNumber = new Map(best.sections.map((sec) => [sec.num, sec.text]));
      for (const r of rows) {
        const section = byNumber.get(r.number) || '';
        updates.push({ r, section });
      }
    } else {
      const seq = best.sections.map((sec) => sec.num);
      const seqOk =
        seq.length === numbers.length && seq.every((n, i) => n === numbers[i]);
      if (!seqOk) {
        skip.push([s.file, `题号有重复且段落序列不齐（${seq.length} 段 vs ${numbers.length} 题）`]);
        continue;
      }
      best.sections.forEach((sec, i) => updates.push({ r: rows[i], section: sec.text }));
    }

    const finalUpdates = updates.map(({ r, section }) => {
      const comment = commentOf(r.process_md);
      const process =
        r === first
          ? [comment, section, markerTail].filter(Boolean).join('\n\n')
          : [comment, section].filter(Boolean).join('\n\n');
      return {
        attemptId: r.id, questionNumber: r.number,
        hasBatch: Boolean(section),
        before: r.process_md.length, after: process.length, process,
      };
    });
    plan.push({
      file: s.file, sessionId: s.id, kind: 'B·切分', strategy: best.name,
      attempts: rows.length, sectionsFound: best.sections.length,
      attemptsWithBatch: finalUpdates.filter((u) => u.hasBatch).length,
      updates: finalUpdates,
    });
  }
  return { plan, skip };
}

// ---- 执行 -------------------------------------------------------------------

async function apply(plan) {
  let ok = 0;
  const failures = [];
  for (const session of plan) {
    for (const u of session.updates) {
      const res = await fetch(`${BASE}/api/attempts/${encodeURIComponent(u.attemptId)}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ process: u.process }),
      });
      if (res.ok) {
        ok += 1;
      } else {
        failures.push(`${u.attemptId} → HTTP ${res.status} ${(await res.text()).slice(0, 150)}`);
        if (failures.length > 8) throw new Error('失败过多，中止');
      }
    }
    process.stdout.write(`  ✓ ${session.file.slice(0, 32)}（${session.updates.length} 条）\n`);
  }
  return { ok, failures };
}

// ---- 入口 -------------------------------------------------------------------

const token = APPLY ? fs.readFileSync(path.join(process.env.HOME, '.mem-api-token'), 'utf8').trim() : null;
const { plan, skip } = buildPlan();
const allUpdates = plan.flatMap((s) => s.updates);
const beforeChars = allUpdates.reduce((a, u) => a + u.before, 0);
const afterChars = allUpdates.reduce((a, u) => a + u.after, 0);

console.log(`方案：${plan.length} 场 / ${allUpdates.length} 条作答要写；跳过 ${skip.length} 场\n`);
for (const s of plan) {
  const extra =
    s.kind === 'B·切分'
      ? `切出 ${s.sectionsFound} 段 · 有批改 ${s.attemptsWithBatch}`
      : s.kind === 'repair'
        ? '去尾巴 + 还原纯批改'
        : '仅去重';
  console.log(`  [${s.kind}] ${s.file.slice(0, 42).padEnd(44)} ${s.attempts} 题 · ${s.strategy} · ${extra}`);
}
for (const [file, reason] of skip) console.log(`  [跳过] ${file} —— ${reason}`);
console.log(
  `\n体积：${beforeChars} → ${afterChars} 字符（省 ${Math.round((1 - afterChars / beforeChars) * 100)}%）` +
  `；空批改（该卷型本来就没有逐题批改，如英语做对的题）：${allUpdates.filter((u) => !u.hasBatch).length} 条`
);

if (!APPLY) {
  fs.writeFileSync('/tmp/split-plan.json', JSON.stringify(plan, null, 1));
  console.log('\ndry-run 完成，方案已存 /tmp/split-plan.json（未发任何写请求）');
} else {
  const { ok, failures } = await apply(plan);
  console.log(`\napply 完成：成功 ${ok} / 失败 ${failures.length}`);
  for (const f of failures) console.error('  ', f);
  if (failures.length) process.exit(1);
}
