// 日期口径取自 myWebsite/scripts/build/lib/util.mjs 与 heatmap.mjs（只读复制）。
// 保持完全一致，P2 把渲染器接过来时不需要改日期算法。

const DATE_FMT_CACHE = new Map();
export const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'];

function dateFormatter(timeZone) {
  let fmt = DATE_FMT_CACHE.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    DATE_FMT_CACHE.set(timeZone, fmt);
  }
  return fmt;
}

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
    weekday: 'short',
  }).format(new Date(`${dateStr}T12:00:00+08:00`));
}

export function sundayIndex(dateStr) {
  return new Date(`${dateStr}T00:00:00Z`).getUTCDay();
}
