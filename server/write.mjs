// 写业务层：校验 → 单事务 → 返回受影响的 id。
//
// 为什么这么啰嗦：
// 1. notes / note 是 JSON 信封，导出器按固定键名取值（file / frontMatter / source /
//    errorTags …），这里必须原样构造成导出器认识的结构，否则站点渲染直接断。
// 2. content.json 依赖 attempts.process_md 里的「场次全文」分隔标记，
//    新建场次时要把整份正文挂在第一条 attempt 的标记后面，否则原文页缺失。
// 3. 一次录入就是一个事务：场次头和逐题结果要么全进，要么全不进。
import config from './config.mjs';
import { get, all, run, withTransaction } from './db.mjs';
import { todayLocal } from './dates.mjs';

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const TIMING_MODES = new Set(['session', 'per-question', 'mixed', 'none']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// content.json 靠这行标记复原原文页，改场次文件路径时必须同步改它
const FULLTEXT_MARK = '===== 场次全文：';

// 与 Python 侧 jdump 等价：紧凑分隔符、不排序、保留中文。
const jdump = (obj) => JSON.stringify(obj);

export function envelope(text, baseline) {
  return jdump({ text: text ?? null, baseline });
}

export function unenvelope(raw) {
  if (!raw) return { text: null, baseline: {} };
  try {
    const obj = JSON.parse(raw);
    return { text: obj.text ?? null, baseline: obj.baseline || {} };
  } catch {
    return { text: raw, baseline: {} };
  }
}

export const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');

function mark(correct) {
  if (correct === 1) return '✅';
  if (correct === 0) return '❌';
  return '❔';
}

// ---------------------------------------------------------------- 校验工具

export function needString(v, field, { allowEmpty = false } = {}) {
  if (typeof v !== 'string') throw new ApiError(400, 'invalid_field', `${field} 必须是字符串`);
  const s = v.trim();
  if (!allowEmpty && !s) throw new ApiError(400, 'invalid_field', `${field} 不能为空`);
  return s;
}

export function asBoolInt(v, field) {
  if (v === undefined || v === null) return null;
  if (v === true || v === 1 || v === '1') return 1;
  if (v === false || v === 0 || v === '0') return 0;
  throw new ApiError(400, 'invalid_field', `${field} 只能是布尔 / 0 / 1`);
}

export function asNumberOrNull(v, field) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new ApiError(400, 'invalid_field', `${field} 必须是数字`);
  return n;
}

function getPaper(slug) {
  const row = get('SELECT * FROM papers WHERE slug = ?', slug);
  if (!row) throw new ApiError(400, 'unknown_paper', `卷不存在：${slug}`);
  return row;
}

function getQuestion(id) {
  const row = get('SELECT * FROM questions WHERE id = ?', id);
  if (!row) throw new ApiError(400, 'unknown_question', `题目不存在：${id}`);
  return row;
}

/** 同名题在别的卷里也算非法：题号必须属于该卷。 */
function assertQuestionInPaper(question, paperSlug) {
  if (question.paper_slug !== paperSlug) {
    throw new ApiError(
      400,
      'question_not_in_paper',
      `题目 ${question.id} 属于 ${question.paper_slug}，不在 ${paperSlug} 里`
    );
  }
}

function normalizeErrorTags(input, single) {
  const tags = [];
  if (Array.isArray(input)) {
    for (const t of input) {
      if (typeof t !== 'string' || !t.trim()) {
        throw new ApiError(400, 'invalid_field', 'errorTags 只能是非空字符串数组');
      }
      tags.push(t.trim());
    }
  } else if (input !== undefined && input !== null) {
    throw new ApiError(400, 'invalid_field', 'errorTags 必须是数组');
  }
  if (single !== undefined && single !== null && single !== '') {
    const s = String(single).trim();
    if (!tags.includes(s)) tags.unshift(s);
  }
  // error_tag 列放主标签，完整数组留在信封里（设计 §7）
  return { primary: tags[0] ?? null, tags };
}

// ---------------------------------------------------------------- 场次 id

function nextSessionId(paperSlug) {
  const rows = all('SELECT id FROM sessions WHERE paper_slug = ?', paperSlug);
  let max = 0;
  for (const r of rows) {
    const m = /-a(\d+)$/.exec(r.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  let n = max + 1;
  let candidate = `${paperSlug}-a${n}`;
  while (get('SELECT 1 AS x FROM sessions WHERE id = ?', candidate)) {
    n += 1;
    candidate = `${paperSlug}-a${n}`;
  }
  return candidate;
}

/** 场次文件路径：沿用「卷目录/answerN.md」的既有命名。 */
function defaultSessionFile(paper, sessionId) {
  const n = /-a(\d+)$/.exec(sessionId)?.[1] ?? '1';
  // 卷目录必须与渲染端的卷归属一致：parseSession 按 Markdown 顶层目录归卷，
  // 而卷清单来自注册试卷原文的顶层目录（build-site 的 config.volumes）。
  // 所以这里取注册原文的顶层目录，而不是 paper slug——slug 是 URL 标识，
  // 拿它当目录会生成渲染端不认识的「新卷」（subject 推断为其他、总题数丢失）。
  // 未登记原文的卷才兜底用 slug。
  const { baseline } = unenvelope(paper.notes);
  const firstPaper = Object.keys(baseline.paperPrefix || {})[0];
  const dir = firstPaper ? firstPaper.split('/')[0] : paper.slug;
  return `${dir}/answer${n}.md`;
}

// ---------------------------------------------------------------- 正文拼装

function renderAttemptBlock({ attemptId, question, ans, correct, process, fullText, file }) {
  const head = `<!-- attempt: ${attemptId} | question: ${question.id} -->`;
  const body = [
    head,
    '',
    `## Q${question.number} ${mark(correct)}`,
    '',
    (process && String(process).trim()) || '（本次未记录推演）',
    '',
    `### Answer : ${ans ?? '—'} ${mark(correct)}`,
  ].join('\n');

  if (!fullText) return body;

  const marker = `${FULLTEXT_MARK}${file} =====`;
  return `${body}\n\n${marker}\n\n\n${String(fullText).replace(/^\n+/, '')}`;
}

function autoSessionBody({ paper, sessionId, date, attempts }) {
  const lines = [`# ${paper.title} · ${sessionId}`, '', `> 通过 API 录入，日期 ${date}。`, ''];
  for (const a of attempts) {
    lines.push(`## 第 ${a.question.number} 题 ${mark(a.correct)}`);
    lines.push('');
    lines.push(`- 我的答案：${a.userAnswer ?? '—'}　正确答案：${a.question.answer ?? '—'}`);
    if (a.errorTag) lines.push(`- 错因：${a.errorTag}`);
    lines.push('');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- 逐题归一化

/**
 * 单条作答的校验与归一化。创建场次与「给已有场次补一题」共用，
 * 保证两条路径的判定口径、信封结构完全一致。
 * label 只用于错误文案（例如 attempts[2]）。
 */
function normalizeAttempt(a, label, paperSlug, seen) {
  if (!a || typeof a !== 'object') {
    throw new ApiError(400, 'invalid_field', `${label} 必须是对象`);
  }
  const questionId = needString(a.questionId, `${label}.questionId`);
  if (seen) {
    if (seen.has(questionId)) {
      throw new ApiError(400, 'duplicate_question', `同一场次里同一题出现两次：${questionId}`);
    }
    seen.add(questionId);
  }

  const question = getQuestion(questionId);
  assertQuestionInPaper(question, paperSlug);

  const userAnswer = a.userAnswer === undefined || a.userAnswer === null
    ? null
    : needString(a.userAnswer, `${label}.userAnswer`, { allowEmpty: true });

  let correct = asBoolInt(a.correct, `${label}.correct`);
  // 没显式判定时，客观题按答案自动比对；主观题保持未判定
  if (correct === null && userAnswer && question.answer && question.scorable === 1) {
    correct = userAnswer.trim().toUpperCase() === String(question.answer).trim().toUpperCase() ? 1 : 0;
  }

  let substantive = asBoolInt(a.substantiveCorrect, `${label}.substantiveCorrect`);
  if (substantive === null) substantive = correct;

  const score = asNumberOrNull(a.score, `${label}.score`);
  const scoreMax = asNumberOrNull(a.scoreMax, `${label}.scoreMax`);
  if (score !== null && scoreMax !== null && score > scoreMax) {
    throw new ApiError(400, 'invalid_field', `${label}.score 不能大于 scoreMax`);
  }

  const { primary, tags } = normalizeErrorTags(a.errorTags, a.errorTag);

  return {
    question,
    userAnswer,
    correct,
    substantive,
    score,
    scoreMax,
    isRedo: asBoolInt(a.isRedo, `${label}.isRedo`) ?? 0,
    errorTag: primary,
    errorTags: tags,
    errorNote: a.errorNote ?? null,
    process: a.process ?? a.processMd ?? null,
    durationMin: asNumberOrNull(a.durationMin, `${label}.durationMin`),
    durationSource: a.durationSource ?? null,
  };
}

// ---------------------------------------------------------------- 创建场次

/**
 * POST /api/sessions
 * 一次录入 = 一个事务：场次头 + 逐题作答一起落库。
 */
export function createSession(input) {
  if (!input || typeof input !== 'object') {
    throw new ApiError(400, 'invalid_body', '请求体必须是对象');
  }

  const paperSlug = needString(input.paperSlug ?? input.paper ?? input.volume, 'paperSlug');
  const paper = getPaper(paperSlug);

  const date = needString(input.date, 'date');
  if (!DATE_RE.test(date)) throw new ApiError(400, 'invalid_field', 'date 必须是 YYYY-MM-DD');

  const timingMode = input.timingMode === undefined ? 'none' : needString(input.timingMode, 'timingMode');
  if (!TIMING_MODES.has(timingMode)) {
    throw new ApiError(400, 'invalid_field', `timingMode 只能是 ${[...TIMING_MODES].join(' | ')}`);
  }

  const durationMin = asNumberOrNull(input.durationMin, 'durationMin');
  if (durationMin !== null && durationMin < 0) {
    throw new ApiError(400, 'invalid_field', 'durationMin 不能为负');
  }

  const rawAttempts = input.attempts;
  if (!Array.isArray(rawAttempts) || rawAttempts.length === 0) {
    throw new ApiError(400, 'invalid_field', 'attempts 必须是非空数组');
  }

  const sessionId = input.sessionId ? needString(input.sessionId, 'sessionId') : nextSessionId(paperSlug);
  if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) {
    throw new ApiError(400, 'invalid_field', 'sessionId 只能包含字母数字 . _ -');
  }

  // 逐题校验 + 归一化，全部在写库之前完成（错一条就整体不写）
  const seen = new Set();
  const prepared = rawAttempts.map((a, idx) => normalizeAttempt(a, `attempts[${idx}]`, paperSlug, seen));

  const questionCount = Number.isInteger(input.questionCount)
    ? input.questionCount
    : prepared.length;

  const file = input.file
    ? needString(input.file, 'file')
    : defaultSessionFile(paper, sessionId);
  const startedAt = input.startedAt === undefined
    ? (durationMin !== null ? `${date}T00:00:00+08:00` : null)
    : (input.startedAt === null ? null : needString(input.startedAt, 'startedAt'));
  const durationSource = input.durationSource ?? (durationMin !== null ? 'timer' : null);

  const frontMatter = [
    '---',
    `time: ${date}${startedAt && startedAt.length >= 16 ? ' ' + startedAt.slice(11, 16) : ''}`,
    `file: ${input.sourceFile ?? 'api'}`,
    durationMin !== null ? `duration: ${durationMin} min` : null,
    `timingMode: ${timingMode}`,
    '---',
    '',
  ].filter((x) => x !== null).join('\n');

  const fullText = input.fullText ? String(input.fullText) : autoSessionBody({
    paper, sessionId, date, attempts: prepared,
  });

  return withTransaction(() => {
    if (get('SELECT 1 AS x FROM sessions WHERE id = ?', sessionId)) {
      throw new ApiError(409, 'session_exists', `场次已存在：${sessionId}`);
    }
    // content.json 用场次文件路径做键，重名会互相覆盖，必须在写入前拦下
    const fileTaken = get(
      "SELECT id FROM sessions WHERE json_extract(note, '$.baseline.file') = ?", file
    );
    if (fileTaken) {
      throw new ApiError(
        409, 'file_exists',
        `场次文件 ${file} 已被 ${fileTaken.id} 占用，请显式指定 file`
      );
    }

    const ts = nowIso();
    run(
      `INSERT INTO sessions
         (id, paper_slug, date, started_at, duration_min, timing_mode, duration_source,
          question_ids, question_count, note, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      sessionId, paperSlug, date, startedAt, durationMin, timingMode, durationSource,
      jdump(prepared.map((p) => p.question.id)), questionCount,
      envelope(input.note ?? null, { file, frontMatter }), ts
    );

    const created = [];
    prepared.forEach((p, idx) => {
      const attemptId = `${date}-${sessionId}-${p.question.id}`;
      if (get('SELECT 1 AS x FROM attempts WHERE id = ?', attemptId)) {
        throw new ApiError(409, 'attempt_exists', `作答已存在：${attemptId}`);
      }
      const processMd = renderAttemptBlock({
        attemptId,
        question: p.question,
        ans: p.userAnswer,
        correct: p.correct,
        process: p.process,
        // 整份场次正文只挂在第一条，避免重复占用（导出按第一条取正文）
        fullText: idx === 0 ? fullText : null,
        file,
      });

      run(
        `INSERT INTO attempts
           (id, session_id, question_id, user_answer, correct, substantive_correct,
            score, score_max, is_redo, error_tag, redo_status, resolved_at, process_md,
            notes, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        attemptId, sessionId, p.question.id, p.userAnswer, p.correct, p.substantive,
        p.score, p.scoreMax, p.isRedo, p.errorTag, null, null, processMd,
        envelope(null, {
          source: `${file} ### Answer : ${p.userAnswer ?? '—'} ${mark(p.correct)}`,
          errorTags: p.errorTags,
          errorNote: p.errorNote,
          durationMin: p.durationMin,
          durationSource: p.durationSource,
        }), ts
      );
      created.push(attemptId);
    });

    return {
      sessionId,
      file,
      questionCount,
      attemptCount: created.length,
      attempts: created,
    };
  });
}

// ---------------------------------------------------------------- 订正判定

const PATCHABLE = new Set([
  'userAnswer', 'correct', 'substantiveCorrect', 'score', 'scoreMax',
  'errorTag', 'errorTags', 'errorNote', 'redoStatus', 'resolvedAt', 'process', 'isRedo',
]);

/** PATCH /api/attempts/:id —— 只改判定相关，不动 id 与外键。 */
export function patchAttempt(attemptId, patch) {
  if (!patch || typeof patch !== 'object' || Object.keys(patch).length === 0) {
    throw new ApiError(400, 'invalid_body', '请求体不能为空');
  }
  const unknown = Object.keys(patch).filter((k) => !PATCHABLE.has(k));
  if (unknown.length) {
    throw new ApiError(400, 'unknown_field', `不支持修改的字段：${unknown.join(', ')}`);
  }

  const row = get('SELECT * FROM attempts WHERE id = ?', attemptId);
  if (!row) throw new ApiError(404, 'not_found', `作答不存在：${attemptId}`);

  const { text, baseline } = unenvelope(row.notes);
  const sets = [];
  const params = [];

  if ('userAnswer' in patch) {
    sets.push('user_answer = ?');
    params.push(patch.userAnswer === null ? null : String(patch.userAnswer));
  }
  if ('correct' in patch) {
    const v = asBoolInt(patch.correct, 'correct');
    sets.push('correct = ?');
    params.push(v);
    // 判定变了，实质判定没显式给就跟着走
    if (!('substantiveCorrect' in patch)) {
      sets.push('substantive_correct = ?');
      params.push(v);
    }
  }
  if ('substantiveCorrect' in patch) {
    sets.push('substantive_correct = ?');
    params.push(asBoolInt(patch.substantiveCorrect, 'substantiveCorrect'));
  }
  if ('score' in patch) {
    sets.push('score = ?');
    params.push(asNumberOrNull(patch.score, 'score'));
  }
  if ('scoreMax' in patch) {
    sets.push('score_max = ?');
    params.push(asNumberOrNull(patch.scoreMax, 'scoreMax'));
  }
  if ('isRedo' in patch) {
    sets.push('is_redo = ?');
    params.push(asBoolInt(patch.isRedo, 'isRedo') ?? 0);
  }
  if ('errorTag' in patch || 'errorTags' in patch) {
    const { primary, tags } = normalizeErrorTags(patch.errorTags, patch.errorTag);
    sets.push('error_tag = ?');
    params.push(primary);
    baseline.errorTags = tags;
  }
  if ('errorNote' in patch) {
    baseline.errorNote = patch.errorNote;
  }
  if ('redoStatus' in patch) {
    sets.push('redo_status = ?');
    params.push(patch.redoStatus);
  }
  if ('resolvedAt' in patch) {
    sets.push('resolved_at = ?');
    params.push(patch.resolvedAt);
  }

  const ts = nowIso();
  return withTransaction(() => {
    if (patch.process !== undefined) {
      const q = get('SELECT number FROM questions WHERE id = ?', row.question_id);
      const nextMd = renderAttemptBlock({
        attemptId,
        question: { id: row.question_id, number: q.number },
        ans: 'userAnswer' in patch ? patch.userAnswer : row.user_answer,
        correct: 'correct' in patch ? asBoolInt(patch.correct, 'correct') : row.correct,
        process: patch.process,
        fullText: null,
        file: '',
      });
      // 改的是单题段落，整份场次正文要保住（在第一条 attempt 上）
      const keepFull = row.process_md.includes('===== 场次全文：')
        ? row.process_md.slice(row.process_md.indexOf('===== 场次全文：'))
        : null;
      sets.push('process_md = ?');
      params.push(keepFull ? `${nextMd}\n\n${keepFull}` : nextMd);
    }
    sets.push('notes = ?', 'updated_at = ?');
    params.push(envelope(text, baseline), ts);
    params.push(attemptId);
    run(`UPDATE attempts SET ${sets.join(', ')} WHERE id = ?`, ...params);
    return { attemptId, changed: sets.length / 2 };
  });
}

// ---------------------------------------------------------------- 台账销账

/**
 * POST /api/attempts/:id/resolve
 * 设计口径：连续两次做对才销账，销账记 resolved_at。
 */
export function resolveRedo(attemptId, { date, status = 'resolved' } = {}) {
  const row = get('SELECT * FROM attempts WHERE id = ?', attemptId);
  if (!row) throw new ApiError(404, 'not_found', `作答不存在：${attemptId}`);
  if (row.correct !== 1) {
    throw new ApiError(409, 'not_yet_correct', '该题最近一次判定不是「对」，不能销账');
  }
  const resolvedAt = date ? needString(date, 'date') : todayLocal(config.timeZone);
  if (!DATE_RE.test(resolvedAt)) throw new ApiError(400, 'invalid_field', 'date 必须是 YYYY-MM-DD');

  return withTransaction(() => {
    run(
      'UPDATE attempts SET redo_status = ?, resolved_at = ?, updated_at = ? WHERE id = ?',
      status, resolvedAt, nowIso(), attemptId
    );
    return { attemptId, redoStatus: status, resolvedAt };
  });
}

// ---------------------------------------------------------------- 撤销场次

/** DELETE /api/sessions/:id —— 误录入撤销，先删子表再删场次。 */
export function deleteSession(sessionId) {
  const row = get('SELECT * FROM sessions WHERE id = ?', sessionId);
  if (!row) throw new ApiError(404, 'not_found', `场次不存在：${sessionId}`);

  return withTransaction(() => {
    const n = get('SELECT COUNT(*) AS n FROM attempts WHERE session_id = ?', sessionId).n;
    run('DELETE FROM attempts WHERE session_id = ?', sessionId);
    run('DELETE FROM sessions WHERE id = ?', sessionId);
    return { sessionId, deletedAttempts: n };
  });
}

// ---------------------------------------------------------------- 订正场次

/** 场次头能改的字段；其余一律 400，防止误传 id / paper_slug 把外键改坏。 */
const PATCHABLE_SESSION = new Set([
  'date', 'startedAt', 'durationMin', 'durationSource', 'timingMode',
  'questionCount', 'note', 'file', 'sourceFile', 'fullText',
]);

/**
 * 只改 front matter 里指定的键，其它行原样保留。
 * 基线里 file 指的是原始试卷 pdf（不是场次 md 路径），所以默认不动它。
 */
function setFrontMatter(fm, updates) {
  const lines = (fm || '---\n---\n').split('\n');
  const out = [];
  const seen = new Set();
  for (const line of lines) {
    const m = /^([A-Za-z][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (m && Object.prototype.hasOwnProperty.call(updates, m[1])) {
      seen.add(m[1]);
      const v = updates[m[1]];
      if (v !== null && v !== undefined) out.push(`${m[1]}: ${v}`);
      continue;
    }
    out.push(line);
  }
  const missing = Object.keys(updates)
    .filter((k) => !seen.has(k) && updates[k] !== null && updates[k] !== undefined);
  if (missing.length) {
    const end = out.lastIndexOf('---');
    const at = end > 0 ? end : out.length;
    out.splice(at, 0, ...missing.map((k) => `${k}: ${updates[k]}`));
  }
  return out.join('\n');
}

/** 作答增删后按卷内顺序重算 question_ids 与 question_count，避免两处口径打架。 */
function syncSessionQuestions(sessionId, ts) {
  const ids = all(
    `SELECT a.question_id AS id
       FROM attempts a JOIN questions q ON q.id = a.question_id
      WHERE a.session_id = ? ORDER BY q.seq`,
    sessionId
  ).map((r) => r.id);
  run(
    'UPDATE sessions SET question_ids = ?, question_count = ?, updated_at = ? WHERE id = ?',
    jdump(ids), ids.length, ts, sessionId
  );
  return ids;
}

/**
 * PATCH /api/sessions/:id
 * 补的是「录错了只能删了重录」这个坑：日期、时长、计时方式、备注、场次文件路径、正文。
 * 改日期会连带把作答 id 的日期前缀与正文里的 <!-- attempt: ... --> 注释一起改掉，
 * 保持 id 与场次日期同源；改文件路径会同步改 process_md 里的全文分隔标记，
 * 否则导出的 content.json 找不到原文。
 */
export function patchSession(sessionId, patch) {
  if (!patch || typeof patch !== 'object' || Object.keys(patch).length === 0) {
    throw new ApiError(400, 'invalid_body', '请求体不能为空');
  }
  const unknown = Object.keys(patch).filter((k) => !PATCHABLE_SESSION.has(k));
  if (unknown.length) {
    throw new ApiError(400, 'unknown_field', `不支持修改的字段：${unknown.join(', ')}`);
  }

  const row = get('SELECT * FROM sessions WHERE id = ?', sessionId);
  if (!row) throw new ApiError(404, 'not_found', `场次不存在：${sessionId}`);
  const { text, baseline } = unenvelope(row.note);
  const oldFile = baseline.file ?? null;

  let date = row.date;
  if ('date' in patch) {
    date = needString(patch.date, 'date');
    if (!DATE_RE.test(date)) throw new ApiError(400, 'invalid_field', 'date 必须是 YYYY-MM-DD');
  }

  let timingMode = row.timing_mode;
  if ('timingMode' in patch) {
    timingMode = needString(patch.timingMode, 'timingMode');
    if (!TIMING_MODES.has(timingMode)) {
      throw new ApiError(400, 'invalid_field', `timingMode 只能是 ${[...TIMING_MODES].join(' | ')}`);
    }
  }

  let durationMin = row.duration_min;
  if ('durationMin' in patch) {
    durationMin = asNumberOrNull(patch.durationMin, 'durationMin');
    if (durationMin !== null && durationMin < 0) {
      throw new ApiError(400, 'invalid_field', 'durationMin 不能为负');
    }
  }

  let startedAt = row.started_at;
  if ('startedAt' in patch) {
    startedAt = patch.startedAt === null ? null : needString(patch.startedAt, 'startedAt');
  }

  // 与创建口径一致：给了时长却没给来源，按 timer 记；时长清空则来源一起清空
  let durationSource = row.duration_source;
  if ('durationSource' in patch) {
    durationSource = patch.durationSource === null ? null : String(patch.durationSource);
  } else if ('durationMin' in patch) {
    durationSource = durationMin !== null ? (durationSource ?? 'timer') : null;
  }

  let questionCount = row.question_count;
  if ('questionCount' in patch) {
    if (!Number.isInteger(patch.questionCount) || patch.questionCount < 0) {
      throw new ApiError(400, 'invalid_field', 'questionCount 必须是非负整数');
    }
    questionCount = patch.questionCount;
  }

  let file = oldFile;
  if ('file' in patch) file = needString(patch.file, 'file');

  const noteText = 'note' in patch
    ? (patch.note === null ? null : String(patch.note))
    : text;

  return withTransaction(() => {
    if (file !== oldFile) {
      const taken = get(
        "SELECT id FROM sessions WHERE json_extract(note, '$.baseline.file') = ? AND id <> ?",
        file, sessionId
      );
      if (taken) throw new ApiError(409, 'file_exists', `场次文件 ${file} 已被 ${taken.id} 占用`);
    }

    const ts = nowIso();
    const carrier = get(
      'SELECT id, process_md FROM attempts WHERE session_id = ? ORDER BY rowid LIMIT 1',
      sessionId
    );
    let carrierMd = carrier ? (carrier.process_md || '') : null;
    let carrierDirty = false;

    if (file !== oldFile) {
      if (!carrier) throw new ApiError(409, 'no_fulltext_carrier', `场次 ${sessionId} 没有作答，无法承载正文`);
      const oldMarker = `${FULLTEXT_MARK}${oldFile} =====`;
      const pos = carrierMd.indexOf(oldMarker);
      if (pos < 0) {
        throw new ApiError(
          409, 'fulltext_missing',
          `场次 ${sessionId} 的正文分隔标记里不是「${oldFile}」，无法只改路径`
        );
      }
      carrierMd = carrierMd.slice(0, pos) + `${FULLTEXT_MARK}${file} =====` + carrierMd.slice(pos + oldMarker.length);
      carrierDirty = true;
    }

    if ('fullText' in patch) {
      if (!carrier) throw new ApiError(409, 'no_fulltext_carrier', `场次 ${sessionId} 没有作答，无法承载正文`);
      const body = String(patch.fullText ?? '');
      const marker = `${FULLTEXT_MARK}${file} =====`;
      const pos = carrierMd.indexOf(marker);
      // 分隔标记之前是该题自己的推演段落，必须保留；标记之后整段换成新正文
      carrierMd = pos < 0
        ? `${carrierMd.trimEnd()}\n\n${marker}\n\n${body}`
        : `${carrierMd.slice(0, pos)}${marker}\n\n${body}`;
      carrierDirty = true;
    }

    if (carrierDirty) {
      run('UPDATE attempts SET process_md = ?, updated_at = ? WHERE id = ?', carrierMd, ts, carrier.id);
    }

    // front matter 只在相关字段变动时重写，避免动到基线的其它行
    let frontMatter = baseline.frontMatter ?? null;
    if (['date', 'startedAt', 'durationMin', 'timingMode', 'sourceFile'].some((k) => k in patch)) {
      const oldTime = /^time:\s*(.+)$/m.exec(frontMatter || '')?.[1] ?? null;
      const suffix = 'startedAt' in patch
        ? (startedAt && startedAt.length >= 16 ? ` ${startedAt.slice(11, 16)}` : '')
        : (/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/.exec(oldTime || '')?.[1] ?? '');
      frontMatter = setFrontMatter(frontMatter, {
        time: `${date}${suffix}`,
        timingMode,
        duration: durationMin === null ? null : `${durationMin} min`,
        ...('sourceFile' in patch
          ? { file: patch.sourceFile === null ? null : String(patch.sourceFile) }
          : {}),
      });
    }

    run(
      `UPDATE sessions
          SET date = ?, started_at = ?, duration_min = ?, timing_mode = ?,
              duration_source = ?, question_count = ?, note = ?, updated_at = ?
        WHERE id = ?`,
      date, startedAt, durationMin, timingMode, durationSource, questionCount,
      envelope(noteText, { ...baseline, file, frontMatter }), ts, sessionId
    );

    let renamed = 0;
    if (date !== row.date) {
      const rows = all(
        'SELECT id, question_id, process_md FROM attempts WHERE session_id = ? ORDER BY rowid',
        sessionId
      );
      for (const a of rows) {
        // 只改符合「<日期>-<场次>-<题号>」约定的 id；不符合的原样保留，避免乱改历史数据
        if (!a.id.startsWith(`${row.date}-${sessionId}-`)) continue;
        const newId = `${date}-${sessionId}-${a.question_id}`;
        if (newId === a.id) continue;
        if (get('SELECT 1 AS x FROM attempts WHERE id = ?', newId)) {
          throw new ApiError(409, 'attempt_exists', `改日期后作答 id 冲突：${newId}`);
        }
        const md = (a.process_md || '')
          .replace(/^<!-- attempt: [^|]*\|/, `<!-- attempt: ${newId} |`);
        run('UPDATE attempts SET id = ?, process_md = ?, updated_at = ? WHERE id = ?', newId, md, ts, a.id);
        renamed += 1;
      }
    }

    return {
      sessionId,
      date,
      file,
      timingMode,
      durationMin,
      durationSource,
      questionCount,
      changed: Object.keys(patch).length,
      renamedAttempts: renamed,
    };
  });
}

// ---------------------------------------------------------------- 补录单题

/**
 * POST /api/sessions/:id/attempts
 * 给已有场次补一题（漏录）。不入整份正文的标记 —— 标记在第一条作答上，这里只存本题段落。
 */
export function addAttempt(sessionId, input) {
  if (!input || typeof input !== 'object') {
    throw new ApiError(400, 'invalid_body', '请求体必须是对象');
  }
  const row = get('SELECT * FROM sessions WHERE id = ?', sessionId);
  if (!row) throw new ApiError(404, 'not_found', `场次不存在：${sessionId}`);

  const prepared = normalizeAttempt(input, 'attempt', row.paper_slug, null);
  const { baseline } = unenvelope(row.note);
  const file = baseline.file ?? '';
  const attemptId = `${row.date}-${sessionId}-${prepared.question.id}`;

  return withTransaction(() => {
    if (get('SELECT 1 AS x FROM attempts WHERE session_id = ? AND question_id = ?',
      sessionId, prepared.question.id)) {
      throw new ApiError(400, 'duplicate_question', `该场次已有这道题的作答：${prepared.question.id}`);
    }
    if (get('SELECT 1 AS x FROM attempts WHERE id = ?', attemptId)) {
      throw new ApiError(409, 'attempt_exists', `作答已存在：${attemptId}`);
    }

    const ts = nowIso();
    const processMd = renderAttemptBlock({
      attemptId,
      question: prepared.question,
      ans: prepared.userAnswer,
      correct: prepared.correct,
      process: prepared.process,
      fullText: null,
      file,
    });

    run(
      `INSERT INTO attempts
         (id, session_id, question_id, user_answer, correct, substantive_correct,
          score, score_max, is_redo, error_tag, redo_status, resolved_at, process_md,
          notes, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      attemptId, sessionId, prepared.question.id, prepared.userAnswer, prepared.correct,
      prepared.substantive, prepared.score, prepared.scoreMax, prepared.isRedo,
      prepared.errorTag, null, null, processMd,
      envelope(null, {
        source: `${file} ### Answer : ${prepared.userAnswer ?? '—'} ${mark(prepared.correct)}`,
        errorTags: prepared.errorTags,
        errorNote: prepared.errorNote,
        durationMin: prepared.durationMin,
        durationSource: prepared.durationSource,
      }), ts
    );

    const ids = syncSessionQuestions(sessionId, ts);
    return {
      sessionId,
      attemptId,
      questionId: prepared.question.id,
      questionCount: ids.length,
      attemptCount: ids.length,
    };
  });
}

// ---------------------------------------------------------------- 撤销单题

/**
 * DELETE /api/attempts/:id
 * 允许删单题，但两条红线：
 *   1. 最后一条不能删（场次会变成没有作答，导出直接报错）→ 用删整场
 *   2. 承载「场次全文」标记的那条被删时，标记段要搬给新的第一条，否则原文页丢失
 */
export function deleteAttempt(attemptId) {
  const row = get('SELECT * FROM attempts WHERE id = ?', attemptId);
  if (!row) throw new ApiError(404, 'not_found', `作答不存在：${attemptId}`);

  return withTransaction(() => {
    const rows = all(
      'SELECT id, question_id, process_md FROM attempts WHERE session_id = ? ORDER BY rowid',
      row.session_id
    );
    if (rows.length <= 1) {
      throw new ApiError(
        400, 'last_attempt',
        '这是该场次最后一条作答；要清空请删整场 DELETE /api/sessions/:id'
      );
    }

    const ts = nowIso();
    const md = rows.find((r) => r.id === attemptId)?.process_md || '';
    const pos = md.indexOf(FULLTEXT_MARK);
    if (pos >= 0) {
      const block = md.slice(pos);
      const target = rows.find((r) => r.id !== attemptId);
      const merged = `${(target.process_md || '').trimEnd()}\n\n${block}`;
      run('UPDATE attempts SET process_md = ?, updated_at = ? WHERE id = ?', merged, ts, target.id);
    }

    run('DELETE FROM attempts WHERE id = ?', attemptId);
    const ids = syncSessionQuestions(row.session_id, ts);

    return {
      attemptId,
      sessionId: row.session_id,
      questionId: row.question_id,
      remainingAttempts: rows.length - 1,
      questionCount: ids.length,
    };
  });
}
