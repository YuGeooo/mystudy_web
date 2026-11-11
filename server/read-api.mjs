// 只读查询：把数据库行整理成录入界面需要的形状。
// 信封解析规则与导出器一致：notes 里的 text 还原为 note，baseline 展开成业务字段。
import { get, all } from './db.mjs';
import { SQL } from './queries.mjs';

function unenvelope(raw) {
  if (!raw) return { text: null, baseline: {} };
  try {
    const obj = JSON.parse(raw);
    return { text: obj.text ?? null, baseline: obj.baseline || {} };
  } catch {
    return { text: raw, baseline: {} };
  }
}

const bool = (v) => (v === null || v === undefined ? null : Boolean(v));

function shapeQuestion(r, { content = false } = {}) {
  const { text, baseline } = unenvelope(r.notes);
  const out = {
    id: r.id,
    paperSlug: r.paper_slug ?? r.paperSlug,
    number: r.number,
    seq: r.seq,
    type: r.type,
    topicId: r.topic_id ?? r.topicId,
    topic: r.topic,
    origin: r.origin,
    answer: r.answer,
    scorable: Boolean(r.scorable),
    answerSource: baseline.answerSource ?? null,
    section: baseline.section ?? null,
    revision: baseline.revision ?? null,
    note: text,
    updatedAt: r.updated_at ?? r.updatedAt,
  };
  if (content) out.contentMd = r.content_md;
  return out;
}

function shapeSession(r) {
  const { text, baseline } = unenvelope(r.note);
  return {
    id: r.id,
    paperSlug: r.paper_slug ?? r.paperSlug,
    date: r.date,
    startedAt: r.started_at ?? r.startedAt ?? null,
    durationMin: r.duration_min ?? r.durationMin ?? null,
    timingMode: r.timing_mode ?? r.timingMode,
    durationSource: r.duration_source ?? r.durationSource ?? null,
    questionCount: r.question_count ?? r.questionCount,
    file: baseline.file ?? null,
    note: text,
    attempts: r.attempts ?? undefined,
    updatedAt: r.updated_at ?? r.updatedAt,
  };
}

function shapeAttempt(r, { process = false } = {}) {
  const { text, baseline } = unenvelope(r.notes);
  const out = {
    id: r.id,
    sessionId: r.session_id ?? r.sessionId,
    questionId: r.question_id ?? r.questionId,
    userAnswer: r.user_answer ?? r.userAnswer ?? null,
    correct: bool(r.correct),
    substantiveCorrect: bool(r.substantive_correct ?? r.substantiveCorrect),
    score: r.score,
    scoreMax: r.score_max ?? r.scoreMax,
    isRedo: Boolean(r.is_redo ?? r.isRedo),
    errorTag: r.error_tag ?? r.errorTag ?? null,
    errorTags: baseline.errorTags ?? [],
    errorNote: baseline.errorNote ?? null,
    redoStatus: r.redo_status ?? r.redoStatus ?? null,
    resolvedAt: r.resolved_at ?? r.resolvedAt ?? null,
    source: baseline.source ?? null,
    note: text,
    updatedAt: r.updated_at ?? r.updatedAt,
  };
  if (process) out.processMd = r.process_md;
  return out;
}

const int = (v, def, max) => {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n < 0) return def;
  return Math.min(n, max);
};

export function listPapers() {
  return all(SQL.paperList);
}

export function getPaper(slug) {
  const r = get(SQL.paperOne, slug);
  if (!r) return null;
  const { text, baseline } = unenvelope(r.notes);
  return {
    slug: r.slug,
    title: r.title,
    subject: r.subject,
    questionCount: r.question_count,
    questionIds: JSON.parse(r.question_ids),
    scoreRule: r.score_rule_json ? JSON.parse(r.score_rule_json) : null,
    sourceFiles: baseline.sourceFiles ?? [],
    note: text,
    updatedAt: r.updated_at,
    questions: all(SQL.questionsByPaper, slug).map((q) => shapeQuestion(q)),
  };
}

export function listQuestions({ paper, topic, q, limit, offset, content }) {
  const rows = all(
    SQL.questionList,
    paper ?? null,
    topic ?? null,
    q ?? null,
    int(limit, 50, 500),
    int(offset, 0, 1e6)
  );
  return rows.map((r) => shapeQuestion(r, { content: Boolean(content) }));
}

export function getQuestion(id, { content }) {
  const r = get(SQL.questionOne, id);
  if (!r) return null;
  return shapeQuestion(r, { content: content !== false });
}

export function listSessions({ from, to, paper, limit, offset }) {
  const rows = all(
    SQL.sessionList,
    from ?? null,
    to ?? null,
    paper ?? null,
    int(limit, 50, 500),
    int(offset, 0, 1e6)
  );
  return rows.map(shapeSession);
}

export function getSession(id, { process } = {}) {
  const r = get(SQL.sessionOne, id);
  if (!r) return null;
  const session = shapeSession(r);
  const rows = all('SELECT * FROM attempts WHERE session_id = ?', id);
  // 场次全文在第一题的 process_md 里，列表默认不带，避免响应过大
  session.attempts = rows.map((a) => shapeAttempt(a, { process: Boolean(process) }));
  return session;
}

export function listAttempts({ questionId, redoStatus, limit, offset, process }) {
  const clauses = [];
  const params = [];
  if (questionId) {
    clauses.push('a.question_id = ?');
    params.push(questionId);
  }
  if (redoStatus) {
    clauses.push('a.redo_status = ?');
    params.push(redoStatus);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = all(
    `SELECT a.* FROM attempts a ${where} ORDER BY a.id LIMIT ? OFFSET ?`,
    ...params,
    int(limit, 50, 500),
    int(offset, 0, 1e6)
  );
  return rows.map((r) => shapeAttempt(r, { process: Boolean(process) }));
}

export function getAttempt(id, { process } = {}) {
  const r = get('SELECT * FROM attempts WHERE id = ?', id);
  if (!r) return null;
  return shapeAttempt(r, { process: Boolean(process) });
}

/** 待重做台账：redo_status 非空但还没销账的那批。 */
export function listRedo() {
  const rows = all(`
    SELECT a.*, q.number AS questionNumber, q.topic AS questionTopic,
           s.date AS sessionDate, s.paper_slug AS paperSlug
    FROM attempts a
    JOIN questions q ON q.id = a.question_id
    JOIN sessions  s ON s.id = a.session_id
    WHERE a.redo_status IS NOT NULL
    ORDER BY a.session_id, q.seq`);
  return rows.map((r) => ({
    ...shapeAttempt(r),
    questionNumber: r.questionNumber,
    questionTopic: r.questionTopic,
    paperSlug: r.paperSlug,
    sessionDate: r.sessionDate,
    resolved: r.redo_status === 'resolved',
  }));
}
