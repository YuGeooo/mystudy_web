import { addDays } from './util.mjs';

const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'];

function sundayIndex(date) {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

// 色阶口径：已知用时每 30 分钟一档（与「本周七日」的 30 min 块一致）。
// 用时未知的日期不编造分钟数，改按已知题量每 10 题一档着色，页面数字仍显示「用时未知」。
const MINUTES_PER_LEVEL = 30;
const QUESTIONS_PER_LEVEL = 10;
const MAX_LEVEL = 10;

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

/**
 * 生成近 N 周的日历热力图（周日为每列第一格，周六为最后一格）。
 * level: 0 无活动，1–MAX_LEVEL 强度递增（30 min / 10 题一档）。
 */
export function buildHeatmap({ days, today, weeks = 53 }) {
  const byDate = new Map(days.map((day) => [day.date, day]));
  const endWeekStart = addDays(today, -sundayIndex(today));
  const maxStart = addDays(endWeekStart, -(weeks - 1) * 7);
  const firstDay = days.length
    ? days.reduce((earliest, day) => (day.date < earliest ? day.date : earliest), days[0].date)
    : null;
  const naturalStart = firstDay ? addDays(firstDay, -sundayIndex(firstDay)) : maxStart;
  const start = naturalStart > maxStart ? naturalStart : maxStart;
  const actualWeeks = Math.floor(
    (new Date(`${endWeekStart}T00:00:00Z`) - new Date(`${start}T00:00:00Z`)) / 86400000 / 7
  ) + 1;

  const columns = [];
  let previousMonth = null;

  for (let week = 0; week < actualWeeks; week += 1) {
    const weekStart = addDays(start, week * 7);
    const month = weekStart.slice(0, 7);
    const monthLabel =
      month !== previousMonth ? `${Number(month.slice(5, 7))}月` : null;
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
        commits: day?.totals.commits || 0
      });
    }

    columns.push({ monthLabel, cells });
  }

  const activeDays = columns
    .flatMap((column) => column.cells)
    .filter((cell) => !cell.future && (cell.sessions > 0 || cell.commits > 0)).length;

  return {
    start,
    end: today,
    firstDay,
    weeks: columns,
    weekdayLabels: WEEKDAY_LABELS,
    activeDays
  };
}
