const DATE_FMT_CACHE = new Map();

function dateFormatter(timeZone) {
  let fmt = DATE_FMT_CACHE.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
    DATE_FMT_CACHE.set(timeZone, fmt);
  }
  return fmt;
}

/** 把带时区的 ISO 时间转换为指定时区的 YYYY-MM-DD。 */
export function localDate(iso, timeZone = 'Asia/Shanghai') {
  const parts = dateFormatter(timeZone).formatToParts(new Date(iso));
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function todayLocal(timeZone = 'Asia/Shanghai') {
  return localDate(new Date().toISOString(), timeZone);
}

export function addDays(dateStr, delta) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

export function weekdayZh(dateStr) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    weekday: 'short'
  }).format(new Date(`${dateStr}T12:00:00+08:00`));
}

export function timeZh(iso, timeZone = 'Asia/Shanghai') {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(new Date(iso));
}

export function formatLocalDateTime(iso, timeZone = 'Asia/Shanghai') {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(new Date(iso));
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function formatMinutes(minutes) {
  if (minutes == null) return '—';
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export function formatRatio(correct, questions) {
  if (correct == null || questions == null) return '—';
  return `${correct}/${questions}`;
}

export function round1(n) {
  return Math.round(n * 10) / 10;
}
