import { buildWeeks } from './weeks.mjs';
import { buildKnowledge } from './topics.mjs';
import {
  addDays,
  localDate,
  timeZh,
  weekdayZh,
  round1,
  formatLocalDateTime
} from './util.mjs';

function sumKnown(values) {
  return values.reduce((acc, value) => (value == null ? acc : acc + value), 0);
}

function finalizeDay(entry) {
  const sessions = entry.sessions.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const commits = entry.commits.sort((a, b) => a.at.localeCompare(b.at));

  let minutes = 0;
  let questions = 0;
  let correct = 0;
  let minutesPartial = false;
  let questionsPartial = false;
  let correctPartial = false;
  let scoredQuestions = 0;
  let scoredCorrect = 0;

  for (const session of sessions) {
    if (session.minutes == null) minutesPartial = true;
    else minutes += session.minutes;

    if (session.questions == null) {
      questionsPartial = true;
      correctPartial = true;
    } else {
      questions += session.questions;
      if (session.correct == null) correctPartial = true;
      else {
        correct += session.correct;
        scoredQuestions += session.questions;
        scoredCorrect += session.correct;
      }
      if (session.accuracy == null) correctPartial = true;
    }
  }

  const accuracy =
    questions > 0 && !correctPartial ? Math.round((correct / questions) * 1000) / 1000 : null;

  return {
    date: entry.date,
    weekday: weekdayZh(entry.date),
    sessions,
    commits,
    hasSessions: sessions.length > 0,
    hasCommits: commits.length > 0,
    totals: {
      sessions: sessions.length,
      commits: commits.length,
      minutes,
      questions,
      correct,
      accuracy,
      scoredQuestions,
      scoredCorrect,
      scoredAccuracy:
        scoredQuestions > 0 ? Math.round((scoredCorrect / scoredQuestions) * 1000) / 1000 : null,
      partial: minutesPartial || questionsPartial || correctPartial
    }
  };
}

function buildCountdown(config, today) {
  const target = config.countdown?.date;
  if (!target) return null;

  const targetDate = String(target).slice(0, 10);
  const daysLeft = Math.round(
    (Date.parse(`${targetDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000
  );
  if (Number.isNaN(daysLeft)) return null;

  const days = Math.max(0, daysLeft);
  return {
    targetDate,
    label: config.countdown?.label || targetDate.slice(5).replace('-', '.'),
    days,
    weeks: Math.floor(days / 7),
    remainderDays: days % 7,
    isPast: daysLeft < 0
  };
}

function buildVolumes(sessions, config) {
  const configured = Object.keys(config.volumes || {});
  const seen = [...new Set(sessions.map((session) => session.volume))];
  const names = [...configured, ...seen.filter((name) => !configured.includes(name))];

  // 卷卡片按最近练习时间倒序：刚练过的卷在最上面，从未练过的排最后。
  // 同一天有多个卷时按场次开始时刻细分，避免只看日期时并列顺序随配置漂移。
  const lastStamp = (name) => {
    const own = sessions.filter((session) => session.volume === name);
    return own.length
      ? own
          .map((session) => session.startedAt || `${session.date}T00:00:00+08:00`)
          .sort()
          .at(-1)
      : '';
  };
  names.sort((a, b) => lastStamp(b).localeCompare(lastStamp(a)) || a.localeCompare(b));

  return names.map((name, index) => {
    const configEntry = config.volumes?.[name] || {};
    const own = sessions.filter((session) => session.volume === name);
    const questions = sumKnown(own.map((session) => session.questions));
    const correct = sumKnown(own.map((session) => session.correct));
    const minutes = sumKnown(own.map((session) => session.minutes));
    const totalQuestions = Number.isFinite(configEntry.totalQuestions)
      ? configEntry.totalQuestions
      : null;
    const scored = own.filter((session) => session.questions != null);
    const scorePartial = scored.some(
      (session) => session.correct == null || session.accuracy == null
    );
    // 练习日期区间：卷卡片要标出「什么时候做这套卷」，按场次日期去重后取首尾。
    const dates = [...new Set(own.map((session) => session.date))].sort();

    return {
      slug: configEntry.slug || `volume-${index + 1}`,
      name,
      subject: configEntry.subject || own[0]?.subject || '其他',
      totalQuestions,
      doneQuestions: questions,
      correctQuestions: correct,
      accuracy:
        questions > 0 && !scorePartial ? Math.round((correct / questions) * 1000) / 1000 : null,
      scorePartial,
      sessions: own.length,
      minutes,
      minutesPerQuestion: questions > 0 ? round1(minutes / questions) : null,
      firstActive: dates[0] || null,
      lastActive: dates.at(-1) || null,
      note: configEntry.note || null,
      progress:
        totalQuestions && totalQuestions > 0
          ? Math.min(questions / totalQuestions, 1)
          : null,
      status: !totalQuestions
        ? 'unknown'
        : questions >= totalQuestions
          ? 'closed'
          : own.length
            ? 'active'
            : 'untouched'
    };
  });
}


function applyJsonStats({ jsonIndex, sessions, volumes, config }) {
  if (!jsonIndex?.questions?.length || !jsonIndex?.attempts?.length) return null;

  const questionMap = new Map(jsonIndex.questions.map((question) => [question.id, question]));
  const jsonSessions = new Map((jsonIndex.sessions || []).map((session) => [session.file, session]));
  const jsonSessionById = new Map((jsonIndex.sessions || []).map((session) => [session.id, session]));
  const nameBySlug = new Map(
    Object.entries(config.volumes || {})
      .filter(([, value]) => value?.slug)
      .map(([name, value]) => [value.slug, name])
  );

  const scorableAttempts = (jsonIndex.attempts || []).filter(
    (attempt) => questionMap.get(attempt.questionId)?.scorable
  );
  const attemptsBySession = new Map();
  for (const attempt of scorableAttempts) {
    if (!attemptsBySession.has(attempt.sessionId)) attemptsBySession.set(attempt.sessionId, []);
    attemptsBySession.get(attempt.sessionId).push(attempt);
  }

  function firstAttempts(attempts) {
    const seen = new Map();
    for (const attempt of attempts) {
      if (!seen.has(attempt.questionId)) seen.set(attempt.questionId, attempt);
    }
    return [...seen.values()];
  }

  function counts(attempts) {
    const correct = attempts.filter((attempt) => attempt.correct === true).length;
    const wrong = attempts.filter((attempt) => attempt.correct === false).length;
    const unknown = attempts.length - correct - wrong;
    return {
      correct,
      wrong,
      unknown,
      questions: attempts.length,
      accuracy: correct + wrong > 0 ? correct / (correct + wrong) : null
    };
  }

  // 场次级：覆盖 Markdown 启发式解析出的题量与正确数
  for (const session of sessions) {
    const jsonSession = jsonSessions.get(session.path);
    if (!jsonSession) continue;
    const attempts = firstAttempts(attemptsBySession.get(jsonSession.id) || []);
    if (!attempts.length) continue;

    const result = counts(attempts);
    session.questions = result.questions;
    session.correct = result.correct;
    session.wrong = result.wrong;
    session.unknown = result.unknown;
    session.accuracy = result.accuracy;
    session.scoreComplete = result.unknown === 0;
    session.scoreSource = 'json';
    if (jsonSession.durationMin != null && session.minutes == null) {
      session.minutes = jsonSession.durationMin;
    }
  }

  // 卷级：按题号去重，用已知对错作为分母
  const volumeAttempts = new Map();
  for (const attempt of scorableAttempts) {
    const jsonSession = jsonSessionById.get(attempt.sessionId);
    const volumeName = jsonSession ? nameBySlug.get(jsonSession.volume) : null;
    if (!volumeName) continue;
    if (!volumeAttempts.has(volumeName)) volumeAttempts.set(volumeName, []);
    volumeAttempts.get(volumeName).push(attempt);
  }

  for (const volume of volumes) {
    const attempts = firstAttempts(volumeAttempts.get(volume.name) || []);
    if (!attempts.length) continue;

    const result = counts(attempts);
    volume.doneQuestions = result.questions;
    volume.correctQuestions = result.correct;
    volume.wrongQuestions = result.wrong;
    volume.unknownQuestions = result.unknown;
    volume.scorePartial = result.unknown > 0;
    volume.accuracy = result.accuracy;
    volume.progress =
      volume.totalQuestions && volume.totalQuestions > 0
        ? Math.min(result.questions / volume.totalQuestions, 1)
        : null;
    volume.status = !volume.totalQuestions
      ? 'unknown'
      : result.questions >= volume.totalQuestions
        ? 'closed'
        : result.questions > 0
          ? 'active'
          : 'untouched';
  }

  return counts(firstAttempts(scorableAttempts));
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

export function buildData({
  sessions,
  commits,
  config,
  memCommit,
  today,
  timeZone,
  warnings,
  jsonIndex = null
}) {
  const dayMap = new Map();

  function getDay(date) {
    if (!dayMap.has(date)) {
      dayMap.set(date, { date, sessions: [], commits: [] });
    }
    return dayMap.get(date);
  }

  for (const session of sessions) {
    getDay(session.date).sessions.push(session);
  }

  for (const commit of commits) {
    const date = localDate(commit.at, timeZone);
    getDay(date).commits.push({
      ...commit,
      date,
      time: timeZh(commit.at, timeZone)
    });
  }

  let days = [...dayMap.values()]
    .map(finalizeDay)
    .sort((a, b) => b.date.localeCompare(a.date));

  const sortedDates = days.map((day) => day.date).slice().reverse();
  const daySet = new Set(sortedDates);
  const { currentStreak, longestStreak } = buildStreaks(daySet, sortedDates, today);

  const scoredSessions = sessions.filter((session) => session.questions > 0);
  const knownQuestions = sumKnown(scoredSessions.map((session) => session.questions));
  const knownCorrect = sumKnown(scoredSessions.map((session) => session.correct));
  // 平台口径（只写文档/注释，不上页面）：用时只统计 front matter 有 duration 的场次；
  // 缺失显示为 —，不做估算。统计页/日页不再展示这条规则说明。
  const knownMinutes = sumKnown(sessions.map((session) => session.minutes));
  const scorePartial =
    scoredSessions.some((session) => session.accuracy == null) ||
    sessions.length > scoredSessions.length;

  const sessionsToday = sessions.filter((session) => session.date === today);

  const volumes = buildVolumes(sessions, config);
  const jsonTotals = applyJsonStats({ jsonIndex, sessions, volumes, config });
  const knowledge = buildKnowledge({ jsonIndex, config });

  // JSON 覆盖了场次题量/正确数，重新汇总天数据
  days = days
    .map((day) => finalizeDay({ date: day.date, sessions: day.sessions, commits: day.commits }))
    .sort((a, b) => b.date.localeCompare(a.date));

  const todayDay = days.find((day) => day.date === today) || null;
  const lastSessionDay = days.find((day) => day.hasSessions)?.date || null;
  const countdown = buildCountdown(config, today);
  const weeks = buildWeeks(days, today);
  const currentWeek = weeks.find((week) => week.isCurrent) || weeks[0];

  for (const volume of volumes) {
    if (!config.volumes?.[volume.name]) {
      warnings.push(`卷「${volume.name}」未在 site.config.json 中配置，subject/总题数按推断处理`);
    }
    if (volume.totalQuestions && volume.doneQuestions > volume.totalQuestions) {
      warnings.push(
        `卷「${volume.name}」已完成 ${volume.doneQuestions} 题，超过配置总题数 ${volume.totalQuestions}`
      );
    }
  }

  const meta = {
    memCommit,
    memCommitShort: memCommit.slice(0, 7),
    generatedAt: new Date().toISOString(),
    generatedAtLocal: formatLocalDateTime(new Date().toISOString(), timeZone),
    timeZone,
    today,
    firstDay: days.at(-1)?.date || null,
    lastDay: days[0]?.date || null
  };

  const statsCorrect = jsonTotals?.correct ?? knownCorrect;
  const statsQuestions = jsonTotals?.questions ?? knownQuestions;
  const statsAccuracy = jsonTotals?.accuracy ??
    (statsQuestions > 0 ? Math.round((statsCorrect / statsQuestions) * 1000) / 1000 : null);

  return {
    meta,
    stats: {
      studyDays: days.length,
      sessionDays: days.filter((day) => day.hasSessions).length,
      commitDays: days.filter((day) => day.hasCommits).length,
      sessions: sessions.length,
      commits: commits.length,
      knownMinutes,
      knownQuestions: statsQuestions,
      knownCorrect: statsCorrect,
      knownWrong: jsonTotals?.wrong ?? Math.max(0, statsQuestions - statsCorrect),
      unknownQuestions: jsonTotals?.unknown ?? 0,
      accuracy: statsAccuracy,
      scorePartial: jsonTotals ? jsonTotals.unknown > 0 : scorePartial,
      minutesCoverage: {
        known: sessions.filter((session) => session.minutes != null).length,
        total: sessions.length
      },
      currentStreak,
      longestStreak,
      lastSessionDay,
      lastStudyDay: days[0]?.date || null
    },
    today: todayDay
      ? {
          date: today,
          hasSessions: sessionsToday.length > 0,
          sessions: sessionsToday,
          totals: todayDay.totals
        }
      : {
          date: today,
          hasSessions: false,
          sessions: [],
          totals: { sessions: 0, commits: 0, minutes: 0, questions: 0, correct: 0, accuracy: null }
        },
    days,
    weeks,
    currentWeekKey: currentWeek?.key || null,
    countdown,
    volumes,
    knowledge,
    warnings
  };
}
