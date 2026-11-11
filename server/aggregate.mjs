// 统计聚合。days / streaks / heatmap 的输出形状刻意对齐 myWebsite 的
// aggregate.mjs + heatmap.mjs，P2 接渲染器时可以直接消费，不必改结构。
import { all, get } from './db.mjs';
import { SQL } from './queries.mjs';
import { todayLocal, addDays, weekdayZh, sundayIndex, WEEKDAY_LABELS } from './dates.mjs';

const TIMING_MODES = ['session', 'per-question', 'mixed', 'none'];
const MINUTES_PER_LEVEL = 30;
const QUESTIONS_PER_LEVEL = 10;
const MAX_LEVEL = 10;

const num = (v) => (v == null ? 0 : Number(v));
const ratio = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 1000 : null);

export function buildMeta({ timeZone = 'Asia/Shanghai' } = {}) {
  const coverage = get(SQL.coverage);
  const verdict = get(SQL.verdict);
  const timingRows = all(SQL.timing);
  const timing = Object.fromEntries(
    TIMING_MODES.map((m) => [m, num(timingRows.find((r) => r.mode === m)?.n)])
  );
  const answerRows = all(SQL.answers);
  const integrity = get(SQL.integrity);
  const warnings = Object.entries(integrity)
    .filter(([, v]) => num(v) > 0)
    .map(([k, v]) => `${k}=${v}`);

  return {
    source: 'sqlite',
    generatedAt: new Date().toISOString(),
    timeZone,
    today: todayLocal(timeZone),
    coverage: {
      papers: num(coverage.papers),
      questions: num(coverage.questions),
      sessions: num(coverage.sessions),
      attempts: num(coverage.attempts),
      redoRows: num(coverage.redoRows),
    },
    verdict: {
      correct: num(verdict.correct),
      wrong: num(verdict.wrong),
      unjudged: num(verdict.unjudged),
      substantiveCorrect: num(verdict.substantiveCorrect),
      isRedo: num(verdict.isRedo),
    },
    answers: {
      confirmed: num(answerRows.find((r) => r.scorable === 1)?.n),
      estimated: num(answerRows.find((r) => r.scorable === 0)?.n),
    },
    timing,
    durationUnknownSessions: num(get(SQL.durationNulls).n),
    volumes: all(SQL.volumes),
    integrity,
    warnings,
  };
}

function finalizeDay(date, list) {
  const minutes = list.reduce((a, s) => a + num(s.minutes), 0);
  const questions = list.reduce((a, s) => a + num(s.questions), 0);
  const correct = list.reduce((a, s) => a + num(s.correct), 0);
  const wrong = list.reduce((a, s) => a + num(s.wrong), 0);
  const unjudged = list.reduce((a, s) => a + num(s.unjudged), 0);
  const judged = correct + wrong;
  const partial = list.some((s) => s.minutes == null) || unjudged > 0;

  return {
    date,
    weekday: weekdayZh(date),
    sessions: list.map((s) => ({
      id: s.id,
      date: s.date,
      volume: s.volume,
      file: s.file,
      startedAt: s.startedAt,
      minutes: s.minutes,
      timingMode: s.timingMode,
      durationSource: s.durationSource,
      questionCount: s.questionCount,
      questions: num(s.questions),
      correct: num(s.correct),
    })),
    commits: [], // 不再有 git 提交数据，保留字段让渲染器无需改结构
    hasSessions: list.length > 0,
    hasCommits: false,
    totals: {
      sessions: list.length,
      commits: 0,
      minutes,
      questions,
      correct,
      wrong,
      unjudged,
      judged,
      accuracy: ratio(correct, judged),
      scoredQuestions: judged,
      scoredCorrect: correct,
      scoredAccuracy: ratio(correct, judged),
      partial,
    },
  };
}

function buildStreaks(daySet, sortedDates, today) {
  const cursorStart = daySet.has(today) ? today : addDays(today, -1);
  let currentStreak = 0;
  if (daySet.has(cursorStart)) {
    let cursor = cursorStart;
    while (daySet.has(cursor)) {
      currentStreak += 1;
      cursor = addDays(cursor, -1);
    }
  }
  let longestStreak = 0;
  let run = 0;
  let previous = null;
  for (const date of sortedDates) {
    run = previous && addDays(previous, 1) === date ? run + 1 : 1;
    longestStreak = Math.max(longestStreak, run);
    previous = date;
  }
  return { currentStreak, longestStreak };
}

function levelForDay(day) {
  if (!day) return 0;
  const { minutes = 0, questions = 0, sessions = 0, commits = 0 } = day.totals || {};
  if (!sessions && !commits) return 0;
  const steps =
    minutes > 0
      ? Math.floor(minutes / MINUTES_PER_LEVEL) + 1
      : Math.floor(questions / QUESTIONS_PER_LEVEL) + 1;
  return Math.max(1, Math.min(MAX_LEVEL, steps));
}

function buildHeatmap({ days, today, weeks = 53 }) {
  const byDate = new Map(days.map((d) => [d.date, d]));
  const endWeekStart = addDays(today, -sundayIndex(today));
  const maxStart = addDays(endWeekStart, -(weeks - 1) * 7);
  const firstDay = days.length
    ? days.reduce((earliest, d) => (d.date < earliest ? d.date : earliest), days[0].date)
    : null;
  const naturalStart = firstDay ? addDays(firstDay, -sundayIndex(firstDay)) : maxStart;
  const start = naturalStart > maxStart ? naturalStart : maxStart;
  const actualWeeks =
    Math.floor(
      (new Date(`${endWeekStart}T00:00:00Z`) - new Date(`${start}T00:00:00Z`)) / 86400000 / 7
    ) + 1;

  const columns = [];
  let previousMonth = null;
  for (let week = 0; week < actualWeeks; week += 1) {
    const weekStart = addDays(start, week * 7);
    const month = weekStart.slice(0, 7);
    const monthLabel = month !== previousMonth ? `${Number(month.slice(5, 7))}月` : null;
    previousMonth = month;

    const cells = [];
    for (let offset = 0; offset < 7; offset += 1) {
      const date = addDays(weekStart, offset);
      if (date > today) {
        cells.push({ date, future: true, level: 0, minutes: 0, questions: 0, sessions: 0, commits: 0 });
        continue;
      }
      const day = byDate.get(date);
      cells.push({
        date,
        future: false,
        level: levelForDay(day),
        minutes: day?.totals.minutes || 0,
        questions: day?.totals.questions || 0,
        sessions: day?.totals.sessions || 0,
        commits: day?.totals.commits || 0,
      });
    }
    columns.push({ monthLabel, cells });
  }

  const activeDays = columns
    .flatMap((c) => c.cells)
    .filter((cell) => !cell.future && (cell.sessions > 0 || cell.commits > 0)).length;

  return { start, end: today, firstDay, weeks: columns, weekdayLabels: WEEKDAY_LABELS, activeDays };
}

export function buildDays({ timeZone = 'Asia/Shanghai', today = todayLocal(timeZone), weeks = 53 } = {}) {
  const rawSessions = all(SQL.sessions);
  const perSession = new Map(all(SQL.attemptsBySession).map((r) => [r.sessionId, r]));

  const byDate = new Map();
  for (const s of rawSessions) {
    const a = perSession.get(s.id) || { questions: 0, correct: 0, wrong: 0, unjudged: 0 };
    if (!byDate.has(s.date)) byDate.set(s.date, []);
    byDate.get(s.date).push({ ...s, ...a });
  }

  const days = [...byDate.entries()]
    .map(([date, list]) => finalizeDay(date, list))
    .sort((a, b) => b.date.localeCompare(a.date));
  const sortedDates = days.map((d) => d.date).slice().reverse();
  const streaks = buildStreaks(new Set(sortedDates), sortedDates, today);
  const heatmap = buildHeatmap({ days, today, weeks });

  const total = (key) => days.reduce((acc, d) => acc + d.totals[key], 0);
  const lastDay = sortedDates.at(-1) || null;

  return {
    source: 'sqlite',
    today,
    timeZone,
    summary: {
      learningDays: days.length,
      sessions: rawSessions.length,
      attempts: total('questions'),
      correct: total('correct'),
      wrong: total('wrong'),
      unjudged: total('unjudged'),
      minutes: total('minutes'),
      activeDays: heatmap.activeDays,
      firstDay: sortedDates[0] || null,
      lastDay,
    },
    streaks,
    days,
    heatmap,
    notes: [
      'commits 恒为 0：活动日、连续天数与热力图只由 sessions.date 聚合，替代原 git log',
      '16 场未记时长不计入 minutes，对应日期 totals.partial=true',
      '11 条 correct IS NULL 不进 accuracy 分母',
      `currentStreak 仅由学习日计算；最后学习日为 ${lastDay}，若早于今天则当前连续天数为 0`,
    ],
  };
}
