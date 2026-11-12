import fs from 'node:fs';
import path from 'node:path';
import { marked } from 'marked';
import { buildHeatmap } from './heatmap.mjs';
import { radarSvg } from './radar.mjs';
import { splitFrontMatter } from './frontmatter.mjs';
import {
  escapeHtml as e,
  formatMinutes,
  formatRatio,
  weekdayZh
} from './util.mjs';

function canonical(config, relPath) {
  return new URL(relPath, config.site.url).href;
}

// 顶栏栏目顺序（品牌即首页）；左右滑动按这个顺序切换。
const NAV_SECTIONS = [
  { key: 'home', label: '学习记录', path: '' },
  { key: 'weeks', label: '周', path: 'weeks/' },
  { key: 'volumes', label: '卷', path: 'volumes/' },
  { key: 'papers', label: '试卷', path: 'papers/' },
  { key: 'stats', label: '统计', path: 'stats/' },
  { key: 'knowledge', label: '知识', path: 'knowledge/' },
  { key: 'about', label: '关于', path: 'about/' }
];

function sectionOf(relPath) {
  for (const item of NAV_SECTIONS.slice(1)) {
    if (relPath.startsWith(item.path)) return item.key;
  }
  return 'home';
}

function navHref(root, item) {
  return `${root}${item.path}` || './';
}

// 入场动画：上一页离场前把方向记在 sessionStorage，新页从反方向滑入。
// 放在 head 里，首帧就带上初始 transform，避免闪一下再动。
const ENTER_SCRIPT = `<script>
(function () {
  var dir = null;
  try {
    dir = sessionStorage.getItem('study-swipe-dir');
    sessionStorage.removeItem('study-swipe-dir');
  } catch (err) {}
  if (!dir) return;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  var h = document.documentElement;
  h.style.setProperty('--swipe-enter', dir === 'next' ? '7%' : '-7%');
  h.classList.add('is-entering');
  document.addEventListener('DOMContentLoaded', function () {
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        h.classList.add('is-entered');
        setTimeout(function () { h.classList.remove('is-entering', 'is-entered'); }, 300);
      });
    });
  });
})();
</script>`;

// 左右滑切换栏目：拖动跟手 → 松手回弹或滑出 → 新页滑入。
// 渐进增强：禁用 JS 时导航链接与全部页面内容照常可读。
// 排除需要横向滚动的区域（热力图、表格、代码块），避免误触。
const SWIPE_SCRIPT = `<script>
(function () {
  var b = document.body;
  var prev = b.getAttribute('data-prev');
  var next = b.getAttribute('data-next');
  if (!prev && !next) return;
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var locked = false;
  var EXCLUDE = 'pre, table, .heatmap-scroll, .heatmap-grid, .week-grid, .no-swipe';

  function blocked(node) {
    return !!(node && node.closest && node.closest(EXCLUDE));
  }
  function shift(px) {
    b.style.setProperty('--swipe-dx', px + 'px');
    b.style.setProperty('--swipe-opacity', String(Math.max(0.75, 1 - Math.abs(px) / 700)));
  }
  function springBack() {
    b.classList.remove('is-swiping', 'is-nudging');
    b.classList.add('is-settling');
    shift(0);
    setTimeout(function () { b.classList.remove('is-settling'); }, 300);
  }
  function leave(href, isNext) {
    if (!href || locked) { springBack(); return; }
    locked = true;
    try { sessionStorage.setItem('study-swipe-dir', isNext ? 'next' : 'prev'); } catch (err) {}
    b.classList.remove('is-swiping', 'is-settling', 'is-nudging');
    b.style.setProperty('--swipe-exit', isNext ? '-7%' : '7%');
    b.classList.add('is-leaving');
    setTimeout(function () { window.location.href = href; }, reduce ? 0 : 160);
  }

  var drag = null, wheelTimer = null;
  function begin(x, y, target, kind) {
    if (locked || blocked(target)) return;
    clearTimeout(wheelTimer);
    drag = { x: x, y: y, t: Date.now(), kind: kind };
    shift(0);
    b.classList.remove('is-settling', 'is-nudging');
    b.classList.add('is-swiping');
  }
  function move(x) {
    if (!drag) return;
    shift(Math.max(-110, Math.min(110, (x - drag.x) * 0.35)));
  }
  function end(x, y, target) {
    if (!drag) return;
    var d = drag;
    drag = null;
    var dx = x - d.x, dy = y - d.y, ms = Date.now() - d.t;
    var min = d.kind === 'mouse' ? 110 : 60;
    var ok = ms <= 800 && Math.abs(dx) >= min && Math.abs(dx) > Math.abs(dy) * 1.6 && !blocked(target);
    if (ok) leave(dx < 0 ? next : prev, dx < 0);
    else springBack();
  }
  function cancel() {
    if (!drag) return;
    drag = null;
    springBack();
  }

  document.addEventListener('touchstart', function (e) {
    if (e.touches.length !== 1) { cancel(); return; }
    var t = e.touches[0];
    begin(t.clientX, t.clientY, e.target, 'touch');
  }, { passive: true });
  document.addEventListener('touchmove', function (e) {
    if (drag && e.touches.length === 1) move(e.touches[0].clientX);
  }, { passive: true });
  document.addEventListener('touchend', function (e) {
    var t = e.changedTouches[0];
    end(t.clientX, t.clientY, e.target);
  }, { passive: true });
  document.addEventListener('touchcancel', cancel, { passive: true });

  document.addEventListener('pointerdown', function (e) {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    if (e.target.closest && e.target.closest('a, button, summary, input, textarea, select')) return;
    begin(e.clientX, e.clientY, e.target, 'mouse');
  }, { passive: true });
  document.addEventListener('pointermove', function (e) {
    if (drag && drag.kind === 'mouse') move(e.clientX);
  }, { passive: true });
  document.addEventListener('pointerup', function (e) {
    if (drag && drag.kind === 'mouse') end(e.clientX, e.clientY, e.target);
  }, { passive: true });
  document.addEventListener('pointercancel', cancel, { passive: true });

  // 触控板横滑：连续横滑才触发，过程中给一点跟手位移，避免毫无预兆地跳页。
  var acc = 0, lastWheel = 0;
  document.addEventListener('wheel', function (e) {
    if (locked || blocked(e.target) || Math.abs(e.deltaX) <= Math.abs(e.deltaY) * 2) return;
    e.preventDefault();
    var now = Date.now();
    if (now - lastWheel > 350) acc = 0;
    lastWheel = now;
    acc = Math.max(-320, Math.min(320, acc + e.deltaX));
    clearTimeout(wheelTimer);
    if (Math.abs(acc) >= 140) {
      leave(acc > 0 ? next : prev, acc > 0);
      acc = 0;
      return;
    }
    b.classList.remove('is-swiping', 'is-settling');
    b.classList.add('is-nudging');
    shift(Math.max(-34, Math.min(34, acc * 0.12)));
    wheelTimer = setTimeout(function () { springBack(); acc = 0; }, 220);
  }, { passive: false });
})();
</script>`;

function compactMinutes(minutes) {
  if (minutes == null || minutes === 0) return '—';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!hours) return `${rest}m`;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

function layout({ config, data, root, title, description, body, relPath, styles = [] }) {
  const site = config.site;
  const section = sectionOf(relPath);
  const index = Math.max(0, NAV_SECTIONS.findIndex((item) => item.key === section));
  const prevItem = index > 0 ? NAV_SECTIONS[index - 1] : null;
  const nextItem = index < NAV_SECTIONS.length - 1 ? NAV_SECTIONS[index + 1] : null;
  const navLinks = NAV_SECTIONS.slice(1)
    .map((item, i) => {
      const current = i + 1 === index;
      return `<a href="${e(navHref(root, item))}"${
        current ? ' class="is-current" aria-current="page"' : ''
      }>${e(item.label)}</a>`;
    })
    .join('\n      ');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(title)}</title>
<meta name="description" content="${e(description)}">
<link rel="canonical" href="${e(canonical(config, relPath))}">
<link rel="stylesheet" href="${root}assets/app.css">
${styles.length ? `${styles.map((href) => `<link rel="stylesheet" href="${root}${href}">`).join('\n')}\n` : ''}${ENTER_SCRIPT}
</head>
<body data-prev="${prevItem ? e(navHref(root, prevItem)) : ''}" data-next="${
    nextItem ? e(navHref(root, nextItem)) : ''
  }">
<header class="masthead">
  <p class="kicker">geyuqi.me · study log</p>
  <div class="masthead-row">
    <a class="brand" href="${root || './'}"${
      index === 0 && relPath === '' ? ' aria-current="page"' : ''
    }>学习记录</a>
    <nav aria-label="栏目">
      ${navLinks}
    </nav>
  </div>
</header>
<main>
${body}
</main>
<footer class="site-foot">
  <p>数据来自 <code>mem</code> @ <code>${e(data.meta.memCommitShort)}</code> · 构建于 ${e(
    data.meta.generatedAtLocal
  )}</p>
  <p>
    <a href="${e(site.icp.href)}" target="_blank" rel="noopener noreferrer">${e(site.icp.text)}</a>
    <span class="sep">·</span>
    <a href="${e(site.police.href)}" target="_blank" rel="noreferrer">${e(site.police.text)}</a>
  </p>
</footer>
${SWIPE_SCRIPT}
</body>
</html>`;
}

function totalsLine(totals) {
  const bits = [];
  if (totals.sessions) bits.push(`${totals.sessions} 场`);
  if (totals.minutes) bits.push(formatMinutes(totals.minutes));
  if (totals.questions) bits.push(`${totals.questions} 题`);
  if (totals.questions && totals.accuracy != null) {
    bits.push(`卷面 ${formatRatio(totals.correct, totals.questions)}`);
  } else if (totals.scoredQuestions > 0) {
    bits.push(`卷面 ${formatRatio(totals.scoredCorrect, totals.scoredQuestions)}`);
  }
  return bits.join(' · ') || '暂无数据';
}

function entryRow(day, root, withCommits = false, showMonth = true) {
  const dayNumber = day.date.slice(8);
  const month = Number(day.date.slice(5, 7));
  let main;
  let sub;
  let score;
  let scoreLabel;

  if (day.hasSessions) {
    const bits = [`${day.totals.sessions} 场`];
    if (day.totals.minutes) bits.push(formatMinutes(day.totals.minutes));
    if (day.totals.questions) bits.push(`${day.totals.questions} 题`);
    main = bits.join(' · ');

    const volumes = [...new Set(day.sessions.map((session) => session.volume))];
    sub = volumes.join(' · ');
    if (withCommits && day.hasCommits) sub += ` · ${day.totals.commits} 次提交`;

    if (day.totals.accuracy != null) {
      score = formatRatio(day.totals.correct, day.totals.questions);
      scoreLabel = '卷面';
    } else if (day.totals.scoredQuestions > 0) {
      score = formatRatio(day.totals.scoredCorrect, day.totals.scoredQuestions);
      scoreLabel = '卷面';
    } else {
      score = '—';
      scoreLabel = day.totals.questions ? '部分判定' : '无判定';
    }
  } else {
    main = '无作答';
    sub = withCommits ? `${day.totals.commits} 次提交` : '仅提交';
    score = '—';
    scoreLabel = '';
  }

  return `<a class="entry" href="${root}day/${day.date}/">
  <span class="entry-date"><b>${e(dayNumber)}</b><i>${e(`${showMonth ? `${month}月 · ` : ""}${day.weekday}`)}</i></span>
  <span class="entry-body"><span class="entry-main">${e(main)}</span><span class="entry-sub">${e(sub)}</span></span>
  <span class="entry-score"><b>${e(score)}</b><i>${e(scoreLabel)}</i></span>
</a>`;
}

function statusText(status) {
  return (
    { closed: '已闭环', active: '进行中', untouched: '未开始', unknown: '' }[status] || ''
  );
}


/**
 * 卷的练习日期区间：单日叫「练习日期」，跨多日叫「练习区间」。
 * 同年时首端带年份、末端省略年份（2026.09.13–10.27），跨年则两端都写全。
 */
function volumeDateRange(volume) {
  const { firstActive, lastActive } = volume;
  if (!firstActive || !lastActive) return null;
  const full = (date) => date.replace(/-/g, '.');
  const short = (date) => date.slice(5).replace('-', '.');
  if (firstActive === lastActive) {
    return { label: '练习日期', text: full(firstActive) };
  }
  const sameYear = firstActive.slice(0, 4) === lastActive.slice(0, 4);
  return {
    label: '练习区间',
    text: `${full(firstActive)}–${sameYear ? short(lastActive) : full(lastActive)}`
  };
}

function volumeBar(volume, className = 'volume-bar') {
  if (!volume.totalQuestions) return '';
  const total = volume.totalQuestions;
  const done = Math.min(volume.doneQuestions, total);

  if (volume.accuracy != null) {
    const correct = Math.max(0, Math.min(volume.correctQuestions, done));
    const wrong = Math.max(
      0,
      Math.min(volume.wrongQuestions ?? done - correct, done - correct)
    );
    return `<div class="${className}"><i class="volume-seg is-correct" style="width:${
      (correct / total) * 100
    }%"></i><i class="volume-seg is-wrong" style="width:${
      (wrong / total) * 100
    }%"></i></div>`;
  }

  return `<div class="${className}"><i class="volume-seg is-done" style="width:${
    (done / total) * 100
  }%"></i></div>`;
}

function volumeLegend() {
  return `<p class="volume-legend"><span><i class="is-correct"></i>对</span><span><i class="is-wrong"></i>错</span><span><i class="is-done"></i>未做 / 未判定</span></p>`;
}

function volumeCard(volume, hrefPrefix = '') {
  const count =
    volume.totalQuestions == null
      ? `${volume.doneQuestions} 题`
      : `${volume.doneQuestions}/${volume.totalQuestions}`;
  const outcome =
    volume.accuracy != null
      ? `${volume.correctQuestions} 对 · ${Math.max(
          volume.wrongQuestions ?? volume.doneQuestions - volume.correctQuestions,
          0
        )} 错`
      : '判定不完整';
  const meta = [
    volume.subject,
    `${volume.sessions} 场`,
    volume.minutes ? formatMinutes(volume.minutes) : null,
    outcome,
    statusText(volume.status)
  ]
    .filter(Boolean)
    .join(' · ');
  const range = volumeDateRange(volume);

  return `<a class="volume" href="${hrefPrefix}${volume.slug}/">
  <div class="volume-row"><span class="volume-name">${e(volume.name)}</span><span class="volume-dots"></span><span class="volume-count">${e(count)}</span></div>
  ${volumeBar(volume)}
  ${range ? `<p class="volume-dates">${e(range.label)} <span>${e(range.text)}</span></p>` : ''}
  <p class="volume-meta">${e(meta)}</p>
  ${volume.note ? `<p class="volume-note">${e(volume.note)}</p>` : ''}
</a>`;
}

function heatmapMarkup(heatmap, today) {
  // 与 heatmap.mjs 的 MAX_LEVEL 对齐：0 为无活动，1–10 每 30 min（或 10 题）一档。
  const levels = [
    'bg-ink/5',
    'bg-moss/12',
    'bg-moss/20',
    'bg-moss/29',
    'bg-moss/38',
    'bg-moss/47',
    'bg-moss/57',
    'bg-moss/67',
    'bg-moss/77',
    'bg-moss/88',
    'bg-moss'
  ];
  const cell = heatmap.weeks.length <= 10 ? 24 : heatmap.weeks.length <= 26 ? 14 : 10;
  const gap = cell >= 20 ? 4 : 3;
  const monthCells = heatmap.weeks
    .map((week, index) => {
      if (!week.monthLabel) return '';
      const last = index === heatmap.weeks.length - 1;
      const style = last
        ? `grid-column:${index + 1} / span 1;justify-self:end`
        : `grid-column:${index + 1} / span ${Math.min(3, heatmap.weeks.length - index)}`;
      return `<span style="${style}">${e(week.monthLabel)}</span>`;
    })
    .join('');
  const weekdayCells = heatmap.weekdayLabels
    .map((label) => `<span>${e(label)}</span>`)
    .join('');
  const cells = heatmap.weeks
    .flatMap((week) => week.cells)
    .map((cell) => {
      if (cell.future) {
        return '<span class="heatmap-cell is-future" aria-hidden="true"></span>';
      }
      const classes = [
        'heatmap-cell',
        levels[cell.level] || levels[0],
        cell.date === today ? 'is-today' : ''
      ]
        .filter(Boolean)
        .join(' ');
      const title = `${cell.date} · ${cell.sessions} 场 · ${
        cell.minutes ? formatMinutes(cell.minutes) : '用时未知'
      }${cell.questions ? ` · ${cell.questions} 题` : ''}${
        cell.commits ? ` · ${cell.commits} 次提交` : ''
      }`;
      return `<span class="${classes}" title="${e(title)}" aria-label="${e(title)}"></span>`;
    })
    .join('');

  const style = `--heat-cell:${cell}px;--heat-gap:${gap}px;`;
  return `<div class="heatmap" style="${style}">
  <div class="heatmap-months" style="--heat-weeks:${heatmap.weeks.length}">${monthCells}</div>
  <div class="heatmap-body">
    <div class="heatmap-weekdays">${weekdayCells}</div>
    <div class="heatmap-scroll"><div class="heatmap-grid" role="img" aria-label="学习热力图，共 ${heatmap.activeDays} 个学习日">${cells}</div></div>
  </div>
  <div class="heatmap-caption"><span>${heatmap.weeks.length} 周 · ${heatmap.activeDays} 天</span></div>
  ${heatmap.weeks.length > 12 ? '<p class="heatmap-hint">左右滑动查看完整热力图</p>' : ''}
</div>`;
}

function heatmapLayout(heatmap, today) {
  const first = heatmap.firstDay
    ? `${Number(heatmap.firstDay.slice(5, 7))} 月 ${Number(heatmap.firstDay.slice(8, 10))} 日`
    : null;
  return `<div class="heatmap-layout">
  ${heatmapMarkup(heatmap, today)}
  <aside class="heatmap-aside">
    <p>颜色越深表示当天学习投入越多；描边格是今天。</p>
    ${first ? `<p>自 ${e(first)} 开始记录，共 ${e(heatmap.activeDays)} 个学习日。</p>` : ''}
  </aside>
</div>`;
}

function volumeSessions(data, volume) {
  return data.days
    .flatMap((day) =>
      day.sessions
        .filter((session) => session.volume === volume.name)
        .map((session) => ({ ...session, date: day.date }))
    )
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

function sessionStatsText(session) {
  if (session.questions == null) return '主观题 · 无判定';
  if (session.accuracy != null) {
    return `${session.questions} 题 · 卷面 ${formatRatio(session.correct, session.questions)}`;
  }
  return `${session.questions} 题 · 判定不完整`;
}


function weekGrid(week, root) {
  return `<div class="week-grid">${week.cells
    .map((cell) => {
      const active = cell.hasSessions || cell.hasCommits;
      const minutes = cell.totals?.minutes || 0;
      const fullBlocks = Math.floor(minutes / 30);
      const rest = minutes % 30;
      const blockMarkup = Array.from({ length: fullBlocks }, () => '<i class="week-block"></i>').join('');
      const partialMarkup = rest
        ? `<i class="week-block is-partial" style="height:${Math.max(2, Math.round((rest / 30) * 5))}px"></i>`
        : '';
      const bar = minutes
        ? `<span class="week-day-bar" title="${e(
            `${formatMinutes(minutes)} · ${fullBlocks} 块${rest ? ' + 不足 30 min' : ''}`
          )}">${blockMarkup}${partialMarkup}</span>`
        : '<span class="week-day-bar is-empty"></span>';
      const meta = cell.hasSessions
        ? `${cell.totals.sessions} 场`
        : cell.hasCommits
          ? '提交'
          : cell.isFuture
            ? ''
            : '—';
      const inner = `<span class="week-day-label">${e(cell.weekday)}</span>
  <span class="week-day-num">${e(cell.date.slice(8))}</span>
  ${bar}
  <span class="week-day-meta">${e(meta)}</span>`;
      const cls = `week-day${cell.isToday ? ' is-today' : ''}${active ? '' : ' is-empty'}${
        cell.isFuture ? ' is-future' : ''
      }`;
      return active
        ? `<a class="${cls}" href="${root}day/${cell.date}/">${inner}</a>`
        : `<span class="${cls}">${inner}</span>`;
    })
    .join('')}</div>
<p class="week-note">每块 = 30 min；顶部的矮块为不足 30 min。</p>`;
}

function weekPager(week, weeks) {
  const index = weeks.findIndex((item) => item.key === week.key);
  const older = weeks[index + 1];
  const newer = weeks[index - 1];
  const left = older
    ? `<a href="../${older.key.toLowerCase()}/">← 上一周 W${older.number}</a>`
    : '<span></span>';
  const right = newer
    ? `<a href="../${newer.key.toLowerCase()}/">下一周 W${newer.number} →</a>`
    : '<span></span>';
  return `<nav class="week-pager">${left}${right}</nav>`;
}

function renderIndex({ data, config }) {
  const stats = data.stats;
  const current = data.weeks.find((week) => week.isCurrent) || data.weeks[0];
  const latest = data.weeks.find((week) => week.hasActivity) || current;
  const entryWeek = current.hasActivity ? current : latest;
  const dayMap = new Map(data.days.map((day) => [day.date, day]));

  const today = data.today;
  const todayBits = [];
  if (today.hasSessions) {
    todayBits.push(`今天 ${today.totals.sessions} 场`);
    if (today.totals.minutes) todayBits.push(compactMinutes(today.totals.minutes));
    if (today.totals.questions) todayBits.push(`${today.totals.questions} 题`);
  }

  const goal = config.dailyGoal || { questions: 10, minutes: 120 };
  const goalQuestions = Number(goal.questions) || 0;
  const goalMinutes = Number(goal.minutes) || 0;
  const goalAchieved =
    (today.totals.questions || 0) >= goalQuestions &&
    (today.totals.minutes || 0) >= goalMinutes;

  const heading = goalAchieved ? '今日已达成学习目标' : '今日未达成学习目标';
  const goalText = `目标 ${goalQuestions} 题 / ${compactMinutes(goalMinutes)}`;
  const todayText = today.hasSessions
    ? todayBits.join(' · ')
    : today.totals.commits > 0
      ? '今天有提交，还没有作答'
      : '今天还没有记录';
  const deck = `${todayText} · ${goalText}`;

  // 条目按日期倒序：新的一天排在最上面（week.days 原本是周日→周六升序）。
  const entryRows = [...entryWeek.days]
    .sort((a, b) => b.localeCompare(a))
    .map((date) => dayMap.get(date))
    .filter(Boolean)
    .map((day) => entryRow(day, '', true))
    .join('\n');

  const volumeRows = data.volumes.map((volume) => volumeCard(volume, 'volumes/')).join('\n');
  const heatmap = buildHeatmap({ days: data.days, today: data.meta.today });


  const countdown = data.countdown;
  const showCountdown = countdown && !countdown.isPast;
  const coverLabel = showCountdown ? `距 ${countdown.label}` : 'WEEK';
  const coverNumber = showCountdown ? countdown.days : current.number;
  const coverUnit = showCountdown
    ? `天 · ${countdown.weeks} 周${countdown.remainderDays ? ` ${countdown.remainderDays} 天` : ''}`
    : '';

  const body = `<section class="cover">
  <div class="cover-week">
    <span>${e(coverLabel)}</span>
    <b>${e(coverNumber)}</b>
    ${coverUnit ? `<small>${e(coverUnit)}</small>` : ''}
  </div>
  <div class="cover-copy">
    <p class="cover-meta">${e(current.year)} · 第 ${e(current.number)} 周 · ${e(current.label)}</p>
    <h1>${e(heading)}</h1>
    ${deck ? `<p class="deck">${e(deck)}</p>` : ''}
  </div>
</section>

<div class="ledger">
  <div class="ledger-item"><b>${e(current.studyDays)}/7</b><span>本周学习日</span></div>
  <div class="ledger-item"><b>${e(current.sessions)}</b><span>本周场次</span></div>
  <div class="ledger-item"><b>${e(compactMinutes(current.totals.minutes))}</b><span>本周用时</span></div>
  <div class="ledger-item"><b>${e(current.totals.questions)}</b><span>本周题量</span></div>
</div>

<section class="section">
  <div class="section-head"><h2>本周七日</h2><a href="weeks/">全部周 →</a></div>
  ${weekGrid(current, '')}
</section>

<section class="section">
  <div class="section-head"><h2>学习热力</h2><span class="section-count">${e(
    heatmap.firstDay
      ? `自 ${Number(heatmap.firstDay.slice(5, 7))} 月 ${Number(heatmap.firstDay.slice(8, 10))} 日 · ${heatmap.activeDays} 天`
      : `近 12 个月 ${heatmap.activeDays} 天`
  )}</span></div>
  ${heatmapLayout(heatmap, data.meta.today)}
</section>

<section class="section">
  <div class="section-head"><h2>${e(
    current.hasActivity ? '本周条目' : `最近一周（${latest.label}）`
  )}</h2><a href="weeks/${current.key.toLowerCase()}/">周报 →</a></div>
  ${current.hasActivity ? '' : '<p class="note">本周还没有记录，下面是最近一周。</p>'}
  <div class="entries">
    ${entryRows || '<p class="empty">还没有学习记录。</p>'}
  </div>
</section>

<section class="section">
  <div class="section-head"><h2>卷进度</h2></div>
  <div class="volumes">
    ${volumeRows}
  </div>
  ${volumeLegend()}
</section>`;

  return layout({
    config,
    data,
    root: '',
    title: config.site.name,
    description: config.site.description,
    body,
    relPath: ''
  });
}

function renderDays({ data, config }) {
  const groups = new Map();
  for (const day of data.days) {
    const month = day.date.slice(0, 7);
    if (!groups.has(month)) groups.set(month, []);
    groups.get(month).push(day);
  }

  const sections = [...groups.entries()]
    .map(([month, days]) => {
      const [year, mm] = month.split('-');
      const rows = days.map((day) => entryRow(day, '../', true, false)).join('\n');
      return `<section class="month-block">
  <h2><span>${e(year)}</span> · ${e(String(Number(mm)))}月</h2>
  <div class="entries">${rows}</div>
</section>`;
    })
    .join('\n');

  const body = `<section class="hero">
  <div class="hero-meta"><span>archive</span><span>${e(
    `${data.stats.studyDays} 天 · ${data.stats.sessions} 场`
  )}</span></div>
  <h1>全部学习日</h1>
  <p class="deck">共 ${e(data.stats.studyDays)} 个学习日、${e(
    data.stats.sessions
  )} 场练习、${e(data.stats.commits)} 次提交。</p>
</section>
${sections}`;

  return layout({
    config,
    data,
    root: '../',
    title: `全部学习日 · ${config.site.shortName}`,
    description: '按月份浏览全部学习日。',
    body,
    relPath: 'days/'
  });
}


function renderWeeks({ data, config }) {
  const groups = new Map();
  for (const week of data.weeks) {
    if (!groups.has(week.year)) groups.set(week.year, []);
    groups.get(week.year).push(week);
  }

  const sections = [...groups.entries()]
    .map(([year, weeks]) => {
      const rows = weeks
        .map((week) => {
          const score = week.totals.accuracy != null
            ? formatRatio(week.totals.correct, week.totals.questions)
            : week.totals.questions
              ? '部分判定'
              : '—';
          return `<a class="week-row${week.hasActivity ? '' : ' is-empty'}" href="${week.key.toLowerCase()}/">
  <span class="week-row-no">W${e(week.number)}</span>
  <span class="week-row-range">${e(week.label)}</span>
  <span class="week-row-main">${e(
    week.hasActivity
      ? week.totals.minutes
        ? `${week.sessions} 场 · ${compactMinutes(week.totals.minutes)}`
        : `${week.sessions} 场`
      : '—'
  )}</span>
  <span class="week-row-score">${e(score)}</span>
</a>`;
        })
        .join('\n');
      return `<section class="month-block">
  <h2><span>${e(year)}</span></h2>
  <div>${rows}</div>
</section>`;
    })
    .join('\n');

  const body = `<section class="hero">
  <div class="hero-meta"><span>archive · weekly</span><span>${e(data.weeks.length)} 周</span></div>
  <h1>全部周</h1>
  <p class="deck">从第一周开始，按周回看学习节奏。</p>
</section>
${sections}`;

  return layout({
    config,
    data,
    root: '../',
    title: `全部周 · ${config.site.shortName}`,
    description: '按周浏览学习记录。',
    body,
    relPath: 'weeks/'
  });
}

function renderWeek({ week, data, config }) {
  const dayMap = new Map(data.days.map((day) => [day.date, day]));
  const weekPrefix = week.isCurrent ? '本周' : '该周';
  // 周报页同样按日期倒序，与首页「本周条目」保持一致。
  const dayRows = [...week.days]
    .sort((a, b) => b.localeCompare(a))
    .map((date) => dayMap.get(date))
    .filter(Boolean)
    .map((day) => entryRow(day, '../../', true))
    .join('\n');

  const volumeCounts = new Map();
  for (const date of week.days) {
    const day = dayMap.get(date);
    for (const session of day?.sessions || []) {
      volumeCounts.set(session.volume, (volumeCounts.get(session.volume) || 0) + 1);
    }
  }
  const volumeRows = [...volumeCounts.entries()]
    .map(
      ([name, count]) => `<div class="subject-row"><span>${e(name)}</span><span>${e(
        `${count} 场`
      )}</span></div>`
    )
    .join('\n');

  const body = `<p class="back"><a href="../../weeks/">← 全部周</a></p>

<section class="cover">
  <div class="cover-week"><span>WEEK</span><b>${e(week.number)}</b></div>
  <div class="cover-copy">
    <p class="cover-meta">${e(week.year)} · ${e(week.label)}</p>
    <h1>第 ${e(week.number)} 周</h1>
  </div>
</section>

<div class="ledger">
  <div class="ledger-item"><b>${e(week.studyDays)}/7</b><span>${e(weekPrefix)}学习日</span></div>
  <div class="ledger-item"><b>${e(week.sessions)}</b><span>${e(weekPrefix)}场次</span></div>
  <div class="ledger-item"><b>${e(compactMinutes(week.totals.minutes))}</b><span>${e(weekPrefix)}已知用时</span></div>
  <div class="ledger-item"><b>${e(week.totals.questions)}</b><span>${e(weekPrefix)}已知题量</span></div>
</div>

<section class="section">
  <div class="section-head"><h2>七日</h2><span class="section-count">${e(week.label)}</span></div>
  ${weekGrid(week, '../../')}
</section>

<section class="section">
  <div class="section-head"><h2>条目</h2><span class="section-count">${e(
    `${week.days.length} 天`
  )}</span></div>
  <div class="entries">${dayRows || '<p class="empty">本周没有条目。</p>'}</div>
</section>

${
  volumeRows
    ? `<section class="section">
  <div class="section-head"><h2>本周卷</h2></div>
  <div class="metric-list">${volumeRows}</div>
</section>`
    : ''
}

${weekPager(week, data.weeks)}`;

  return layout({
    config,
    data,
    root: '../../',
    title: `${week.year} W${week.number} · ${config.site.shortName}`,
    description: `${week.label} 的学习记录。`,
    body,
    relPath: `weeks/${week.key.toLowerCase()}/`
  });
}

function sourceRel(session) {
  return `source/${session.id.replace(/\.md$/i, '')}`;
}

function sourceHref(session, root = '') {
  const encoded = session.id
    .replace(/\.md$/i, '')
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
  return `${root}source/${encoded}/`;
}

function renderSource({ source, data, config }) {
  const { session, content } = source;
  const relDir = sourceRel(session);
  const root = '../'.repeat(relDir.split('/').filter(Boolean).length);
  const dayHref = `${root}day/${session.date}/`;
  const { body } = splitFrontMatter(content);
  const html = marked.parse(body, { gfm: true, breaks: false });
  const when = `${session.date}${session.time ? ` ${session.time}` : ''}`;

  const bodyHtml = `<p class="back"><a href="${dayHref}">← ${e(session.date)}</a></p>

<article class="prose-editorial source-doc">
  <p class="kicker">source · ${e(session.volume)}</p>
  <h1>${e(session.title)}</h1>
  <p class="standfirst">${e(`${when} · ${session.volume} · ${session.batch}`)}</p>
  <p class="source-raw"><a href="raw.txt">原始 Markdown ↗</a> · <a href="raw.md" download>下载 .md</a></p>
  ${html}
</article>`;

  return layout({
    config,
    data,
    root,
    title: `${session.title} · 原文`,
    description: `${session.date} ${session.volume} ${session.batch} 的 Markdown 原文与批改。`,
    body: bodyHtml,
    relPath: `${relDir}/`
  });
}

function renderDay({ day, data, config }) {
  const [year, month, dayNumber] = day.date.split('-');

  const sessions = day.sessions
    .map((session) => {
      const stats = [];
      if (session.questions != null) stats.push(`${session.questions} 题`);
      if (session.questions) {
        stats.push(
          session.accuracy != null
            ? `卷面 ${formatRatio(session.correct, session.questions)}`
            : '判定不完整'
        );
      } else {
        stats.push('主观题 · 无判定');
      }
      return `<li class="session">
  <span class="session-time"><b>${e(session.time || '—')}</b><i>${e(
    compactMinutes(session.minutes)
  )}</i></span>
  <div class="session-body">
    <div class="session-title">${e(session.title)}</div>
    <div class="session-meta">${e(`${session.volume} · ${session.batch}`)}${
      session.timeSource === 'commit' ? ' · 时间按提交推断' : ''
    }${
      config.publish?.fullText
        ? ` · <a class="source-link" href="${sourceHref(session, '../../')}">原文 →</a>`
        : ''
    }</div>
    <div class="session-stats">${e(stats.join(' · '))}</div>
  </div>
</li>`;
    })
    .join('\n');

  const commits = day.commits
    .map((commit) => {
      const files = commit.files
        .map(
          (file) =>
            `<li>${e(file.path)} <span>${file.additions == null ? '±?' : `+${file.additions}/−${file.deletions}`}</span></li>`
        )
        .join('');
      return `<li class="commit">
  <span class="commit-time">${e(commit.time)}</span>
  <div class="commit-body">
    <div class="commit-subject">${e(commit.subject)}</div>
    <div class="commit-meta"><code>${e(commit.short)}</code> · ${e(
      `${commit.files.length} 个文件 · +${commit.additions} / −${commit.deletions}`
    )}</div>
    <details>
      <summary>查看文件</summary>
      <ul>${files}</ul>
    </details>
  </div>
</li>`;
    })
    .join('\n');

  const body = `<p class="back"><a href="../../days/">← 全部学习日</a></p>

<section class="day-hero">
  <div class="hero-meta"><span>${e(year)} · ${e(day.weekday)}</span><span>${e(
    `${day.totals.sessions} 场 · ${day.totals.commits} 次提交`
  )}</span></div>
  <h1 class="day-date">${e(month)}.${e(dayNumber)}</h1>
  <p class="deck">${e(totalsLine(day.totals))}${day.totals.partial ? ' · 部分数据缺失' : ''}</p>
</section>

<section class="section">
  <div class="section-head"><h2>学习</h2><span class="section-count">${e(
    `${day.totals.sessions} 场`
  )}</span></div>
  ${sessions ? `<ul class="sessions">${sessions}</ul>` : '<p class="empty">当天没有作答记录。</p>'}
</section>

<section class="section">
  <div class="section-head"><h2>提交</h2><span class="section-count">${e(
    `${day.totals.commits} 次`
  )}</span></div>
  ${commits ? `<ol class="commits">${commits}</ol>` : '<p class="empty">当天没有提交。</p>'}
</section>`;

  return layout({
    config,
    data,
    root: '../../',
    title: `${day.date} · ${config.site.shortName}`,
    description: `${day.date} 的学习记录：${totalsLine(day.totals)}。`,
    body,
    relPath: `day/${day.date}/`
  });
}


function renderVolumes({ data, config }) {
  const cards = data.volumes.map((volume) => volumeCard(volume, '')).join('\n');
  const body = `<section class="hero">
  <div class="hero-meta"><span>index</span><span>${e(data.volumes.length)} 卷</span></div>
  <h1>全部卷</h1>
  <p class="deck">按卷回看做过的题、速度与正确率。</p>
</section>

<div class="volumes">${cards}</div>
${volumeLegend()}`;

  return layout({
    config,
    data,
    root: '../',
    title: `全部卷 · ${config.site.shortName}`,
    description: '按卷浏览进度、用时与正确率。',
    body,
    relPath: 'volumes/'
  });
}

function renderVolume({ volume, data, config, papers = [] }) {
  const sessions = volumeSessions(data, volume);
  const doneText =
    volume.totalQuestions == null
      ? `${volume.doneQuestions} 题`
      : `${volume.doneQuestions}/${volume.totalQuestions}`;
  const accuracy =
    volume.accuracy == null ? '—' : `${Math.round(volume.accuracy * 100)}%`;
  const last = volume.lastActive ? volume.lastActive.slice(5) : '—';
  const range = volumeDateRange(volume);
  const rangeLine = range ? `${range.label} ${range.text}` : null;

  const rows = sessions
    .map(
      (session) => `<li class="session">
  <span class="session-time"><b>${e(session.date.slice(5).replace('-', '.'))}</b><i>${e(
        session.time || '—'
      )}</i></span>
  <div class="session-body">
    <div class="session-title"><a href="../../day/${session.date}/">${e(session.title)}</a></div>
    <div class="session-meta">${e(`${session.batch} · ${formatMinutes(session.minutes)}`)}${
      config.publish?.fullText
        ? ` · <a class="source-link" href="${sourceHref(session, '../../')}">原文 →</a>`
        : ''
    }</div>
    <div class="session-stats">${e(sessionStatsText(session))}</div>
  </div>
</li>`
    )
    .join('\n');

  // 卷页给一个去试卷页的入口：一份卷直接进，多份卷（形式逻辑一/二）列出来
  const volumePapers = papers.filter((paper) => paper.volumeSlug === volume.slug);
  const paperLine = !volumePapers.length
    ? ''
    : volumePapers.length === 1
      ? `<p class="note"><a class="paper-link" href="../../papers/${e(volumePapers[0].slug)}/">查看试卷原文 →</a></p>`
      : `<p class="note">试卷原文：${volumePapers
          .map(
            (paper) =>
              `<a class="paper-link" href="../../papers/${e(paper.slug)}/">${e(paper.title)}</a>`
          )
          .join(' · ')}</p>`;

  const body = `<p class="back"><a href="../">← 全部卷</a></p>

<section class="day-hero">
  <div class="hero-meta"><span>volume · ${e(volume.subject)}</span><span>${e(
    statusText(volume.status)
  )}</span></div>
  <h1>${e(volume.name)}</h1>
  <p class="deck">${e(
    volume.note || `共 ${sessions.length} 场，最近一次 ${last}。`
  )}</p>
  ${rangeLine ? `<p class="note">${e(rangeLine)}</p>` : ''}
</section>

<div class="ledger">
  <div class="ledger-item"><b>${e(doneText)}</b><span>已完成</span></div>
  <div class="ledger-item"><b>${e(sessions.length)}</b><span>场次</span></div>
  <div class="ledger-item"><b>${e(volume.minutes ? formatMinutes(volume.minutes) : '—')}</b><span>用时</span></div>
  <div class="ledger-item"><b>${e(accuracy)}</b><span>卷面正确率</span></div>
</div>
${volumeBar(volume, 'volume-progress')}
${volumeLegend()}
${paperLine}

<section class="section">
  <div class="section-head"><h2>场次</h2><span class="section-count">${e(
    sessions.length
  )} 场</span></div>
  ${rows ? `<ul class="sessions">${rows}</ul>` : '<p class="empty">还没有场次。</p>'}
</section>`;

  return layout({
    config,
    data,
    root: '../../',
    title: `${volume.name} · ${config.site.shortName}`,
    description: `${volume.name} 的场次、用时与正确率。`,
    body,
    relPath: `volumes/${volume.slug}/`
  });
}


/**
 * 试卷页。原文由 web/render/paper.mjs 转好（公式已在服务端用 KaTeX 渲染），
 * 这里只负责版式：卷名、题号导航、正文。答案刻意不放——看了答案就不叫看卷了。
 */
function paperHref(paper) {
  // 列表页本身在 /study/papers/，卡片与各试卷页是同级目录，直接用 <slug>/。
  // 写成 papers/<slug>/ 会从列表页解析成 /study/papers/papers/…（线上 404 过）。
  return `${paper.slug}/`;
}

function paperCard(paper) {
  const meta = [
    paper.subject,
    `${paper.questions.length} 题`,
    paper.sections.length ? `${paper.sections.length} 节` : null,
    paper.mathCount ? `${paper.mathCount} 处公式` : null
  ]
    .filter(Boolean)
    .join(' · ');
  // 卷名只在标题里没出现时才当副标题写：形式逻辑那两份的标题本身就含卷名，重复一遍是噪音
  const note = paper.volumeName && !paper.title.includes(paper.volumeName) ? paper.volumeName : '';
  return `<a class="volume" href="${paperHref(paper)}">
  <div class="volume-row"><span class="volume-name">${e(paper.title)}</span><span class="volume-dots"></span><span class="volume-count">${e(
    `${paper.questions.length} 题`
  )}</span></div>
  <p class="volume-meta">${e(meta)}</p>
  ${note ? `<p class="volume-note">${e(note)}</p>` : ''}
</a>`;
}

function renderPapers({ papers, data, config }) {
  const cards = papers.map((paper) => paperCard(paper)).join('\n');
  const body = `<section class="hero">
  <div class="hero-meta"><span>index</span><span>${e(`${papers.length} 份`)}</span></div>
  <h1>试卷</h1>
  <p class="deck">直接看题干与选项。答案、作答与批改都不在这几页。</p>
</section>

<div class="volumes">${cards}</div>`;

  return layout({
    config,
    data,
    root: '../',
    title: `试卷 · ${config.site.shortName}`,
    description: '按卷查看试卷原文：题干、选项与材料。',
    body,
    relPath: 'papers/'
  });
}

function paperNav(paper) {
  const chipsBySection = new Map();
  for (const question of paper.questions) {
    const key = question.section || '';
    if (!chipsBySection.has(key)) chipsBySection.set(key, []);
    chipsBySection.get(key).push(question);
  }

  const groups = [];
  for (const section of paper.sections) {
    const chips = chipsBySection.get(section.id) || [];
    if (!chips.length) continue; // 只有标题、没有题目的过渡节（如「管理类专业学位联考综合能力」）不进导航
    groups.push({ id: section.id, title: section.title, full: section.full, chips });
  }
  const loose = chipsBySection.get('') || [];
  if (loose.length) groups.unshift({ id: null, title: null, chips: loose });
  if (!groups.length) return '';

  const rows = groups
    .map((group) => {
      const heading = group.id
        ? `<a class="paper-nav-title" href="#${e(group.id)}" title="${e(group.full)}">${e(group.title)}</a>`
        : `<span class="paper-nav-title">试题</span>`;
      const chips = group.chips
        .map((question) => {
          const tip = /^\d+$/.test(question.label) ? `第 ${question.label} 题` : question.label;
          return `<a class="paper-chip" href="#${e(question.id)}" title="${e(tip)}">${e(
            question.label
          )}</a>`;
        })
        .join('');
      return `<div class="paper-nav-group">
    ${heading}
    <span class="paper-nav-chips">${chips}</span>
  </div>`;
    })
    .join('\n  ');

  // 只数有题目的节：卷首那种纯标题的过渡节（「管理类专业学位联考综合能力」）不算一节
  const sectionCount = groups.filter((group) => group.id).length;
  return `<nav class="paper-nav" aria-label="卷面题目导航">
  <p class="paper-nav-head"><span>题目</span><span>${e(
    `${paper.questions.length} 题${sectionCount ? ` · ${sectionCount} 节` : ''}`
  )}</span></p>
  ${rows}
</nav>`;
}

function renderPaper({ paper, data, config }) {
  const total = paper.questions.length;
  const volume = data.volumes.find((item) => item.slug === paper.volumeSlug);
  // 有原文导语就优先用导语（来源、页数、题量），没有就退回卷自己的说明
  const deck = [paper.volumeName, paper.intro || volume?.note].filter(Boolean).join(' · ');
  const facts = [
    `${Math.max(1, Math.round(paper.bytes / 1024))} KB 原文`,
    paper.mathCount ? `${paper.mathCount} 处公式` : null
  ]
    .filter(Boolean)
    .join(' · ');
  const dropped = paper.dropped
    ? `<p class="paper-note">原文中「${e(paper.dropped)}」一节是答案附录，为避免剧透已略去。</p>`
    : '';

  // 答案速查：原生 <details>，默认收起，点开才显示——不用 JS，也不会被截图/打印误带出去
  const answered = (paper.answers || []).filter((a) => a.answer);
  const answersBlock = answered.length
    ? `<details class="paper-answers">
  <summary>答案速查<span class="paper-answers-meta">${e(
    `${answered.length} / ${total} 题有标准答案`
  )}</span></summary>
  <div class="paper-answers-grid">
    ${paper.answers
      .map(
        (a) =>
          `<span class="paper-answer${a.answer ? '' : ' is-none'}"><i>${e(a.label)}</i>${e(
            a.answer || '—'
          )}</span>`
      )
      .join('\n    ')}
  </div>
</details>`
    : '';

  const body = `<p class="back"><a href="../">← 全部试卷</a></p>

<section class="day-hero">
  <div class="hero-meta"><span>paper · ${e(paper.subject)}</span><span>${e(
    `${total} 题`
  )}</span></div>
  <h1>${e(paper.title)}</h1>
  <p class="deck">${e(deck)}</p>
  <p class="note">${e(facts)}</p>
</section>

${paperNav(paper)}

<article class="prose-editorial paper-doc">
${paper.html}
</article>

${dropped}
${answersBlock}
<p class="paper-foot">本页只有题干与选项；你的作答与批改记录不在试卷页里。答案在页底「答案速查」，默认收起，点开才显示。</p>
<p class="source-raw"><a href="raw.txt">原始 Markdown ↗</a> · <a href="raw.md" download>下载 .md</a></p>`;

  return layout({
    config,
    data,
    root: '../../',
    title: `${paper.title} · ${config.site.shortName}`,
    description: `${paper.volumeName} 试卷原文：${total} 题，题干与选项。`,
    // 有公式才引 KaTeX 样式：英语、逻辑卷不必为 20 多 KB 的字体规则买单
    styles: paper.mathCount ? ['assets/katex/katex.min.css'] : [],
    body,
    relPath: `papers/${paper.slug}/`
  });
}


function renderStats({ data, config }) {
  const stats = data.stats;
  const weeks = data.weeks.slice(0, 8).reverse();
  const maxSessions = Math.max(...weeks.map((week) => week.sessions), 1);

  const barRows = weeks
    .map((week) => {
      const height = week.sessions
        ? Math.max(Math.round((week.sessions / maxSessions) * 100), 6)
        : 0;
      return `<div class="bar-col" title="${e(
        `${week.start} · ${week.sessions} 场 · ${week.totals.minutes ? compactMinutes(week.totals.minutes) : '用时未知'}`
      )}">
  <span class="bar-value">${e(week.sessions ? `${week.sessions} 场` : '—')}</span>
  <div class="bar-track"><i style="height:${height}%"></i></div>
  <span class="bar-label">${e(`W${week.number}`)}</span>
</div>`;
    })
    .join('\n');

  const accuracyRows = data.volumes
    .map((volume) => {
      const percent = volume.accuracy == null ? 0 : Math.round(volume.accuracy * 100);
      const value = volume.accuracy == null ? '—' : `${percent}%`;
      return `<div class="metric-row">
  <span class="metric-name">${e(volume.name)}</span>
  <span class="metric-bar"><i style="width:${percent}%"></i></span>
  <span class="metric-value">${e(value)}</span>
</div>`;
    })
    .join('\n');

  const paceRows = data.volumes
    .map(
      (volume) => `<div class="subject-row">
  <span>${e(volume.name)}</span>
  <span>${e(volume.minutesPerQuestion == null ? '—' : `${volume.minutesPerQuestion} min/题`)}</span>
</div>`
    )
    .join('\n');

  const bySubject = new Map();
  for (const day of data.days) {
    for (const session of day.sessions) {
      if (!bySubject.has(session.subject)) {
        bySubject.set(session.subject, { sessions: 0, questions: 0 });
      }
      const entry = bySubject.get(session.subject);
      entry.sessions += 1;
      entry.questions += session.questions || 0;
    }
  }
  const subjectRows = [...bySubject.entries()]
    .map(
      ([subject, entry]) => `<div class="subject-row">
  <span>${e(subject)}</span>
  <span>${e(`${entry.sessions} 场 · ${entry.questions} 题`)}</span>
</div>`
    )
    .join('\n');

  const body = `<section class="hero">
  <div class="hero-meta"><span>statistics</span><span>截至 ${e(data.meta.today)}</span></div>
  <h1>统计</h1>
  <p class="deck">从 ${e(stats.sessions)} 场练习里能看到的节奏、正确率与速度。</p>
</section>

<div class="ledger">
  <div class="ledger-item"><b>${e(stats.studyDays)}</b><span>累计学习日</span></div>
  <div class="ledger-item"><b>${e(stats.sessions)}</b><span>累计场次</span></div>
  <div class="ledger-item"><b>${e(compactMinutes(stats.knownMinutes))}</b><span>总用时</span></div>
  <div class="ledger-item"><b>${e(stats.knownQuestions)}</b><span>总题量</span></div>
</div>

<section class="section">
  <div class="section-head"><h2>周节奏</h2><span class="section-count">近 8 周 · 按场次</span></div>
  <div class="bars">${barRows}</div>
</section>

<section class="section">
  <div class="section-head"><h2>卷面正确率</h2><span class="section-count">按卷</span></div>
  <div class="metric-list">${accuracyRows}</div>
</section>

<section class="section">
  <div class="section-head"><h2>速度</h2><span class="section-count">min/题</span></div>
  <div class="metric-list">${paceRows}</div>
</section>

<section class="section">
  <div class="section-head"><h2>科目分布</h2><span class="section-count">按场次</span></div>
  <div class="metric-list">${subjectRows}</div>
</section>`;

  return layout({
    config,
    data,
    root: '../',
    title: `统计 · ${config.site.shortName}`,
    description: '周节奏、卷面正确率、速度与科目分布。',
    body,
    relPath: 'stats/'
  });
}

function pctText(value) {
  return value == null ? '—' : `${Math.round(value * 100)}%`;
}

function knowledgeRows(nodes, minSample) {
  return nodes
    .map((node) => {
      const thin = node.sampleOk ? '' : ' class="is-thin"';
      const tooltip = node.redoQuestions
        ? ` title="其中 ${node.redoQuestions} 题有重做记录"`
        : '';
      return `<tr${thin}>
  <td>${e(node.name)}</td>
  <td${tooltip}>${node.questions}</td>
  <td>${pctText(node.firstAccuracy)}</td>
  <td>${pctText(node.latestAccuracy)}</td>
  <td>${node.wrongQuestions}</td>
  <td>${node.sampleOk ? '够' : `少于 ${minSample}`}</td>
</tr>`;
    })
    .join('\n');
}

function knowledgeLegend() {
  return `<div class="radar-legend">
  <span><i class="legend-line is-latest"></i>最近一次判定</span>
  <span><i class="legend-line is-first"></i>首做</span>
  <span>外环 100% · 每格 25% · 灰字为样本不足</span>
</div>`;
}

function renderKnowledge({ data, config }) {
  const knowledge = data.knowledge;
  const root = '../';
  if (!knowledge) {
    const body = `<section class="hero">
  <div class="hero-meta"><span>knowledge</span><span>截至 ${e(data.meta.today)}</span></div>
  <h1>知识点掌握</h1>
  <p class="deck">mem 仓库尚未输出知识点索引，本页暂无数据。</p>
</section>`;
    return layout({
      config, data, root,
      title: `知识点 · ${config.site.shortName}`,
      description: '按考点看首做与最近一次正确率。',
      body, relPath: 'knowledge/'
    });
  }

  const sections = knowledge.subjects
    .map((subject) => {
      const svg = radarSvg({ nodes: subject.axes, subjectName: subject.name });
      const chart = svg
        ? `<div class="radar-block">${svg}${knowledgeLegend()}</div>`
        : '<p class="note">有作答记录的考点不足 3 个，暂不画雷达图。</p>';
      const omitted = subject.omitted
        ? `<p class="note">另有 ${subject.omitted} 个考点未入图，已列在表中。</p>`
        : '';
      const typeBased = subject.nodes.every((node) => node.granularity === 'type')
        ? '<p class="note">本学科按题型分组，尚未细分到知识点。</p>'
        : '';
      return `<section class="section">
  <div class="section-head"><h2>${e(subject.name)}</h2><span class="section-count">${subject.nodes.length} 个考点 · ${subject.totals.questions} 道去重题 · ${subject.totals.wrong} 道当前错题</span></div>
  ${chart}
  ${typeBased}
  ${omitted}
  <div class="table-wrap"><table class="topic-table">
  <thead><tr><th>考点</th><th>题量</th><th>首做</th><th>最近</th><th title="最近一次判定为错的原题数">当前错题</th><th title="少于 ${knowledge.minSample} 题标为样本少">样本</th></tr></thead>
  <tbody>${knowledgeRows(subject.nodes, knowledge.minSample)}</tbody>
  </table></div>
</section>`;
    })
    .join('\n');

  const body = `<section class="hero">
  <div class="hero-meta"><span>knowledge</span><span>截至 ${e(data.meta.today)}</span></div>
  <h1>知识点掌握</h1>
  <p class="deck">${knowledge.totals.topics} 个考点 · ${knowledge.totals.questions} 道去重后的原题 · 首做与最近一次对照。</p>
  <p class="note">虚线为首做，灰字为样本不足。</p>
</section>
${sections}`;

  return layout({
    config, data, root,
    title: `知识点 · ${config.site.shortName}`,
    description: '按考点看首做与最近一次正确率、当前错题与样本量。',
    body, relPath: 'knowledge/'
  });
}

function renderAbout({ data, config }) {
  const site = config.site;
  const body = `<article class="prose-editorial">
  <p class="kicker">colophon</p>
  <h1>关于这个站</h1>
  <p class="standfirst">这是 ${e(
    site.author
  )} 的个人学习记录站。数据来自私有仓库 <code>mem</code> 的 git 提交与 Markdown 文件，由构建脚本自动汇总；除正常的 commit / push 外，没有额外录入。</p>

  <h2>公开范围</h2>
  <p>当前公开展示结构化动态、提交信息、摘要，以及每场练习的 Markdown 原文与批改全文。真题与题目版权归原作者，本站仅作个人学习记录。</p>

  <h2>隐私</h2>
  <p>本站不加载第三方统计脚本、不写 Cookie、不收集访客信息。页面由静态文件直接提供。</p>

  <h2>更新方式</h2>
  <p><code>mem</code> 仓库收到新提交后，服务器在数分钟内拉取并重新构建静态页面。本页数据版本：<code>${e(
    data.meta.memCommitShort
  )}</code>。</p>
</article>`;

  return layout({
    config,
    data,
    root: '../',
    title: `关于 · ${site.shortName}`,
    description: '数据来源、口径与隐私说明。',
    body,
    relPath: 'about/'
  });
}

function render404({ data, config }) {
  const basePath = new URL(config.site.url).pathname;
  const body = `<article class="prose-editorial">
  <p class="kicker">404</p>
  <h1>页面不存在</h1>
  <p class="standfirst">链接可能已经变化，或者这个日期还没有记录。</p>
  <p><a href="${basePath}">回到首页</a> · <a href="${basePath}days/">全部学习日</a></p>
</article>`;

  return layout({
    config,
    data,
    root: basePath,
    title: `404 · ${config.site.shortName}`,
    description: '页面不存在。',
    body,
    relPath: '404.html'
  });
}

function renderSitemap({ data, config, papers = [] }) {
  const volumeUrls = data.volumes.map((volume) => `volumes/${volume.slug}/`);
  const paperUrls = papers.map((paper) => `papers/${paper.slug}/`);
  const weekUrls = data.weeks.map((week) => `weeks/${week.key.toLowerCase()}/`);
  const sourceUrls = config.publish?.fullText
    ? data.days.flatMap((day) => day.sessions.map((session) => encodeURI(`${sourceRel(session)}/`)))
    : [];
  const urls = [
    '',
    'days/',
    'weeks/',
    'volumes/',
    'papers/',
    'stats/',
    'knowledge/',
    'about/',
    ...weekUrls,
    ...sourceUrls,
    ...volumeUrls,
    ...paperUrls,
    ...data.days.map((day) => `day/${day.date}/`)
  ];
  const entries = urls
    .map(
      (rel) =>
        `  <url><loc>${e(canonical(config, rel))}</loc><lastmod>${e(
          data.meta.generatedAt.slice(0, 10)
        )}</lastmod></url>`
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries}
</urlset>
`;
}

export function renderSite({ data, config, report, outDir, sources = [], papers = [], emit = null }) {
  // emit 给了就只产出内容、不落盘：运行时按请求出页面走这条路径，
  // 省掉「写 172 个文件、再逐个读回来」的一次往返。
  if (!emit) fs.mkdirSync(outDir, { recursive: true });
  const written = [];

  function write(relPath, content) {
    if (emit) {
      emit(relPath, content);
      written.push(relPath);
      return;
    }
    const target = path.join(outDir, relPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    written.push(relPath);
  }

  write('index.html', renderIndex({ data, config }));
  write('days/index.html', renderDays({ data, config }));
  write('weeks/index.html', renderWeeks({ data, config }));
  for (const week of data.weeks) {
    write(`weeks/${week.key.toLowerCase()}/index.html`, renderWeek({ week, data, config }));
  }
  write('volumes/index.html', renderVolumes({ data, config }));
  write('papers/index.html', renderPapers({ papers, data, config }));
  write('stats/index.html', renderStats({ data, config }));
  write('knowledge/index.html', renderKnowledge({ data, config }));
  for (const volume of data.volumes) {
    write(`volumes/${volume.slug}/index.html`, renderVolume({ volume, data, config, papers }));
  }
  for (const paper of papers) {
    write(`papers/${paper.slug}/index.html`, renderPaper({ paper, data, config }));
    write(`papers/${paper.slug}/raw.md`, paper.source);
    write(`papers/${paper.slug}/raw.txt`, paper.source);
  }
  for (const day of data.days) {
    write(`day/${day.date}/index.html`, renderDay({ day, data, config }));
  }
  if (config.publish?.fullText) {
    for (const source of sources) {
      const relDir = sourceRel(source.session);
      write(`${relDir}/index.html`, renderSource({ source, data, config }));
      write(`${relDir}/raw.md`, source.content);
      write(`${relDir}/raw.txt`, source.content);
    }
  }
  write('about/index.html', renderAbout({ data, config }));
  write('404.html', render404({ data, config }));
  write('sitemap.xml', renderSitemap({ data, config, papers }));
  write('data.json', `${JSON.stringify(data, null, 2)}\n`);
  write('build-report.json', `${JSON.stringify(report, null, 2)}\n`);

  return written;
}
