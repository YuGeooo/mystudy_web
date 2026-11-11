import { splitFrontMatter } from './frontmatter.mjs';
import { localDate } from './util.mjs';

export function isSessionPath(filePath) {
  const base = filePath.split('/').pop();
  return /^answer\d+(-\d+)?\.md$/i.test(base);
}

export function parseTimeValue(value) {
  if (!value) return null;
  const match = String(value).match(
    /(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/
  );
  if (!match) return null;
  const [, year, month, day, hour = '00', minute = '00'] = match;
  return {
    date: `${year}-${month}-${day}`,
    time: `${hour}:${minute}`,
    iso: `${year}-${month}-${day}T${hour}:${minute}:00+08:00`
  };
}

export function parseDurationValue(value) {
  if (!value) return null;
  const match = String(value).match(/^\s*(\d+)/);
  return match ? Number(match[1]) : null;
}

/** 优先显式「卷面 a/b」，其次判定表，其次逐题标记，最后题号标题只计题量。 */
export function parseScore(body) {
  const explicit = body.match(/卷面\s*(\d+)\s*[/／]\s*(\d+)/);
  if (explicit) {
    const correct = Number(explicit[1]);
    const questions = Number(explicit[2]);
    if (questions > 0 && correct <= questions) {
      return { correct, questions, complete: true, source: 'explicit' };
    }
  }

  const headings = countQuestionHeadings(body);

  const table = parseVerdictTables(body);
  if (table.questions > 0) {
    const questions = Math.max(table.questions, headings);
    const complete = table.questions >= headings;
    return {
      correct: table.correct,
      questions,
      complete,
      source: complete ? 'table' : 'table-partial'
    };
  }

  const lines = parseMarkedLines(body);
  if (lines.questions > 0) {
    const questions = Math.max(lines.questions, headings);
    const complete = lines.questions >= headings;
    return {
      correct: lines.correct,
      questions,
      complete,
      source: complete ? 'lines' : 'lines-partial'
    };
  }

  if (headings > 0) {
    return { correct: null, questions: headings, complete: false, source: 'headings' };
  }

  return { correct: null, questions: null, complete: false, source: 'none' };
}

/** 统计 Q 题号（含 Q35 ~ 36 这类区间），只用于补题量，不推断对错。 */
function countQuestionHeadings(body) {
  const numbers = new Set();

  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!/^#{1,6}\s+/.test(line)) continue;

    const range = line.match(/Q\s*(\d+)\s*[~～–—-]\s*(?:Q\s*)?(\d+)/i);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (to >= from && to - from <= 100) {
        for (let n = from; n <= to; n += 1) numbers.add(n);
      }
    }

    for (const match of line.matchAll(/Q\s*(\d+)/gi)) {
      numbers.add(Number(match[1]));
    }
  }

  return numbers.size;
}

const GOOD_MARK = /[✅✔✓]/;
const BAD_MARK = /[❌✘✗]/;

function parseVerdictTables(body) {
  const lines = body.split('\n');
  let inTable = false;
  let correct = 0;
  let questions = 0;
  const seenLabels = new Set();

  for (const raw of lines) {
    const line = raw.trim();

    if (!line.startsWith('|')) {
      inTable = false;
      continue;
    }

    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    const joined = cells.join('|');

    if (!inTable) {
      if (/判定|你的答案|正确答案/.test(joined)) {
        inTable = true;
      }
      continue;
    }

    // 分隔行 | --- | :---: | ...
    if (/^[\s:|-]+$/.test(line) && line.includes('-')) continue;

    const label = cells[0] || '';
    if (label && seenLabels.has(label)) continue;

    const last = [...cells].reverse().find((cell) => cell.length > 0) || '';
    if (GOOD_MARK.test(last)) {
      correct += 1;
      questions += 1;
      if (label) seenLabels.add(label);
    } else if (BAD_MARK.test(last)) {
      questions += 1;
      if (label) seenLabels.add(label);
    }
  }

  return { correct, questions };
}

function parseMarkedLines(body) {
  let correct = 0;
  let questions = 0;

  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('|')) continue;
    if (!GOOD_MARK.test(line) && !BAD_MARK.test(line)) continue;
    // 只认「题号开头」的行：## Q1 ✅ / ### Q41: A ❌ / 1. ... ✅
    if (!/^(?:#{1,6}\s*)?(?:Q\s*)?\d+\s*[.、:：)]?/i.test(line)) continue;

    questions += 1;
    if (GOOD_MARK.test(line)) correct += 1;
  }

  return { correct, questions };
}

export function extractTitle(body, fallback) {
  const lines = body.split('\n').map((line) => line.trim());

  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith('$$')) break;

    const heading = line.match(/^#{1,3}\s+(.+)$/);
    if (heading) {
      const title = heading[1].trim();
      // 「## Q26」这类是题目批改段，不是场次标题；用题号区间兜底。
      if (/^Q\s*\d+/i.test(title)) return questionRange(body) || fallback;
      // 「## 57. 论说文」去掉题号后仍可作标题。
      const withoutNumber = title.replace(/^\d+\s*[.、]\s*/, '');
      const cleaned = cleanTitle(withoutNumber);
      if (cleaned) return cleaned;
      continue;
    }

    if (/^[|>$]/.test(line) || line === '---') continue;
    if (/^\d+[.、]/.test(line)) continue;
    if (line.length >= 8) {
      const cleaned = cleanTitle(line);
      if (cleaned) return cleaned;
    }
  }

  return questionRange(body) || fallback;
}

function questionRange(body) {
  const numbers = new Set();

  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!/^#{1,6}\s+/.test(line)) continue;

    const range = line.match(/Q\s*(\d+)\s*[~～–—-]\s*(?:Q\s*)?(\d+)/i);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (to >= from && to - from <= 100) {
        for (let n = from; n <= to; n += 1) numbers.add(n);
      }
    }
    for (const match of line.matchAll(/Q\s*(\d+)/gi)) {
      numbers.add(Number(match[1]));
    }
  }

  if (!numbers.size) return null;
  const sorted = [...numbers].sort((a, b) => a - b);
  return `第 ${sorted[0]}–${sorted[sorted.length - 1]} 题`;
}

function cleanTitle(value) {
  return value
    .replace(/\*\*/g, '')
    .replace(/[*`]/g, '')
    .replace(/^\d+\s*[.、]\s*/, '')
    .replace(/(?:[，,。；;]\s*)?手写原稿见[\s\S]*$/, '')
    .replace(/(?:[，,。；;]\s*)?作答见[\s\S]*$/, '')
    .replace(/\s+/g, ' ')
    .replace(/[，,；;。]\s*$/, '')
    .trim()
    .slice(0, 72);
}

function inferSubject(volume) {
  if (/英语|english/i.test(volume)) return '英语';
  if (/管综|逻辑|数学|写作|推理|真题/.test(volume)) return '管综';
  return '其他';
}

export function parseSession({ filePath, content, config, firstCommitAt, timeZone }) {
  const { data, body } = splitFrontMatter(content);
  const volume = filePath.split('/')[0];
  const volumeConfig = config.volumes?.[volume] || {};
  const batch = filePath.split('/').pop().replace(/\.md$/i, '');
  const warnings = [];

  let time = parseTimeValue(data.time);
  let timeSource = 'explicit';

  if (!time && firstCommitAt) {
    const date = localDate(firstCommitAt, timeZone);
    time = { date, time: null, iso: `${date}T00:00:00+08:00` };
    timeSource = 'commit';
    warnings.push(`${filePath}：缺 time，按首次提交 ${date} 推断`);
  }

  if (!time) {
    warnings.push(`${filePath}：缺 time 且无提交记录，已跳过该场次`);
    return { session: null, warnings };
  }

  const minutes = parseDurationValue(data.duration);
  const score = parseScore(body);
  const questions = score.questions;
  const correct = score.correct;
  const accuracy =
    questions > 0 && correct != null && score.complete ? correct / questions : null;

  const session = {
    id: filePath,
    path: filePath,
    volume,
    volumeSlug: volumeConfig.slug || null,
    subject: volumeConfig.subject || inferSubject(volume),
    batch,
    title: extractTitle(body, `${volume} · ${batch}`),
    startedAt: time.iso,
    date: time.date,
    time: time.time,
    minutes,
    questions,
    correct,
    accuracy,
    minutesPerQuestion:
      minutes != null && questions ? Math.round((minutes / questions) * 10) / 10 : null,
    scoreSource: score.source,
    scoreComplete: score.complete,
    timeSource
  };

  return { session, warnings };
}
