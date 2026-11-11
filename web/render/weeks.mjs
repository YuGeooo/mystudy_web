import { addDays, weekdayZh } from './util.mjs';

const DAY_MS = 86400000;

/** 周日为一周第一天。 */
export function sundayOf(date) {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return addDays(date, -day);
}

function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/**
 * 周号按“包含 1 月 1 日的那一周为第 1 周”计算，周从周日开始。
 * 只用于展示，不宣称 ISO 8601。
 */
export function weekNumber(start) {
  const year = Number(start.slice(0, 4));
  const firstSunday = sundayOf(`${year}-01-01`);
  return Math.floor(daysBetween(firstSunday, start) / 7) + 1;
}

function weekTotals(days) {
  let minutes = 0;
  let questions = 0;
  let correct = 0;
  let partial = false;

  for (const day of days) {
    const totals = day.totals;
    if (totals.minutesPartial) partial = true;
    else minutes += totals.minutes;
    if (totals.questionsPartial) partial = true;
    else questions += totals.questions;
    if (totals.correctPartial) partial = true;
    else correct += totals.correct;
  }

  return {
    minutes,
    questions,
    correct,
    accuracy: questions > 0 && !partial ? Math.round((correct / questions) * 1000) / 1000 : null,
    partial
  };
}

/**
 * 从第一条记录所在周生成到当前周，包含没有记录的周。
 * 返回按时间倒序的周数组；每周包含周日到周六 7 个 day cell。
 */
export function buildWeeks(days, today) {
  const byDate = new Map(days.map((day) => [day.date, day]));
  const firstDay = days.length
    ? days.reduce((earliest, day) => (day.date < earliest ? day.date : earliest), days[0].date)
    : today;
  const firstSunday = sundayOf(firstDay);
  const currentSunday = sundayOf(today);

  const weeks = [];
  for (let start = firstSunday; start <= currentSunday; start = addDays(start, 7)) {
    const end = addDays(start, 6);
    const number = weekNumber(start);
    const year = Number(start.slice(0, 4));
    const cells = [];
    const activeDays = [];

    for (let offset = 0; offset < 7; offset += 1) {
      const date = addDays(start, offset);
      const day = byDate.get(date) || null;
      if (day) activeDays.push(day);
      cells.push({
        date,
        weekday: weekdayZh(date),
        isToday: date === today,
        isFuture: date > today,
        totals: day?.totals || null,
        hasSessions: Boolean(day?.hasSessions),
        hasCommits: Boolean(day?.hasCommits)
      });
    }

    const totals = weekTotals(activeDays);
    const sessions = activeDays.reduce((sum, day) => sum + day.sessions.length, 0);
    const volumes = [
      ...new Set(activeDays.flatMap((day) => day.sessions.map((session) => session.volume)))
    ];

    weeks.push({
      key: `${year}-W${String(number).padStart(2, '0')}`,
      year,
      number,
      start,
      end,
      label: `${start.slice(5).replace('-', '.')}–${end.slice(5).replace('-', '.')}`,
      cells,
      days: activeDays.map((day) => day.date),
      sessions,
      studyDays: activeDays.filter((day) => day.hasSessions).length,
      commitDays: activeDays.filter((day) => day.hasCommits).length,
      volumes,
      totals,
      hasActivity: activeDays.length > 0,
      isCurrent: start === currentSunday
    });
  }

  return weeks.sort((a, b) => b.start.localeCompare(a.start));
}
