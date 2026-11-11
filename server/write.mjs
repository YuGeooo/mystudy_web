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

// 与 Python 侧 jdump 等价：紧凑分隔符、不排序、保留中文。
const jdump = (obj) => JSON.stringify(obj);

function envelope(text, baseline) {
  return jdump({ text: text ?? null, baseline });
}

function unenvelope(raw) {
  if (!raw) return { text: null, baseline: {} };
  try {
    const obj = JSON.parse(raw);
    return { text: obj.text ?? null, baseline: obj.baseline || {} };
  } catch {
    return { text: raw, baseline: {} };
  }
}

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');

function mark(correct) {
  if (correct === 1) return '✅';
  if (correct === 0) return '❌';
  return '❔';
}

// ---------------------------------------------------------------- 校验工具

function needString(v, field, { allowEmpty = false } = {}) {
  if (typeof v !== 'string') throw new ApiError(400, 'invalid_field', `${field} 必须是字符串`);
  const s = v.trim();
  if (!allowEmpty && !s) throw new ApiError(400, 'invalid_field', `${field} 不能为空`);
  return s;
}

function asBoolInt(v, field) {
  if (v === undefined || v === null) return null;
  if (v === true || v === 1 || v === '1') return 1;
  if (v === false || v === 0 || v === '0') return 0;
  throw new ApiError(400, 'invalid_field', `${field} 只能是布尔 / 0 / 1`);
}

function asNumberOrNull(v, field) {
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
function defaultSessionFile(paperSlug, sessionId) {
  const n = /-a(\d+)$/.exec(sessionId)?.[1] ?? '1';
  return `${paperSlug}/answer${n}.md`;
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

  const marker = `===== 场次全文：${file} =====`;
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
  const prepared = rawAttempts.map((a, idx) => {
    if (!a || typeof a !== 'object') {
      throw new ApiError(400, 'invalid_field', `attempts[${idx}] 必须是对象`);
    }
    const questionId = needString(a.questionId, `attempts[${idx}].questionId`);
    if (seen.has(questionId)) {
      throw new ApiError(400, 'duplicate_question', `同一场次里同一题出现两次：${questionId}`);
    }
    seen.add(questionId);

    const question = getQuestion(questionId);
    assertQuestionInPaper(question, paperSlug);

    const userAnswer = a.userAnswer === undefined || a.userAnswer === null
      ? null
      : needString(a.userAnswer, `attempts[${idx}].userAnswer`, { allowEmpty: true });

    let correct = asBoolInt(a.correct, `attempts[${idx}].correct`);
    // 没显式判定时，客观题按答案自动比对；主观题保持未判定
    if (correct === null && userAnswer && question.answer && question.scorable === 1) {
      correct = userAnswer.trim().toUpperCase() === String(question.answer).trim().toUpperCase() ? 1 : 0;
    }

    let substantive = asBoolInt(a.substantiveCorrect, `attempts[${idx}].substantiveCorrect`);
    if (substantive === null) substantive = correct;

    const score = asNumberOrNull(a.score, `attempts[${idx}].score`);
    const scoreMax = asNumberOrNull(a.scoreMax, `attempts[${idx}].scoreMax`);
    if (score !== null && scoreMax !== null && score > scoreMax) {
      throw new ApiError(400, 'invalid_field', `attempts[${idx}].score 不能大于 scoreMax`);
    }

    const { primary, tags } = normalizeErrorTags(a.errorTags, a.errorTag);

    return {
      question,
      userAnswer,
      correct,
      substantive,
      score,
      scoreMax,
      isRedo: asBoolInt(a.isRedo, `attempts[${idx}].isRedo`) ?? 0,
      errorTag: primary,
      errorTags: tags,
      errorNote: a.errorNote ?? null,
      process: a.process ?? a.processMd ?? null,
      durationMin: asNumberOrNull(a.durationMin, `attempts[${idx}].durationMin`),
      durationSource: a.durationSource ?? null,
    };
  });

  const questionCount = Number.isInteger(input.questionCount)
    ? input.questionCount
    : prepared.length;

  const file = input.file
    ? needString(input.file, 'file')
    : defaultSessionFile(paperSlug, sessionId);
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
