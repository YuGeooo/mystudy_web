// 所有 SQL 集中在这里，其它模块不写裸 SQL。
// 备注列里的 JSON 信封用 json_extract 取基线余量字段。

export const SQL = {
  coverage: `
    SELECT (SELECT COUNT(*) FROM papers)    AS papers,
           (SELECT COUNT(*) FROM questions) AS questions,
           (SELECT COUNT(*) FROM sessions)  AS sessions,
           (SELECT COUNT(*) FROM attempts)  AS attempts,
           (SELECT COUNT(*) FROM attempts WHERE redo_status IS NOT NULL) AS redoRows`,

  verdict: `
    SELECT SUM(correct = 1)              AS correct,
           SUM(correct = 0)              AS wrong,
           SUM(correct IS NULL)          AS unjudged,
           SUM(substantive_correct = 1)  AS substantiveCorrect,
           SUM(is_redo = 1)              AS isRedo
    FROM attempts`,

  timing: `SELECT timing_mode AS mode, COUNT(*) AS n FROM sessions GROUP BY timing_mode`,

  answers: `SELECT scorable, COUNT(*) AS n FROM questions GROUP BY scorable`,

  volumes: `
    SELECT p.slug,
           p.title,
           p.subject,
           p.question_count AS questionCount,
           (SELECT COUNT(*) FROM questions q WHERE q.paper_slug = p.slug) AS actualQuestions,
           (SELECT COUNT(*) FROM questions q WHERE q.paper_slug = p.slug AND q.scorable = 1) AS scorableQuestions,
           (SELECT COUNT(*) FROM sessions s WHERE s.paper_slug = p.slug) AS sessions
    FROM papers p ORDER BY p.rowid`,

  durationNulls: `SELECT COUNT(*) AS n FROM sessions WHERE duration_min IS NULL`,

  integrity: `
    SELECT (SELECT COUNT(*) FROM attempts a
              LEFT JOIN sessions s ON s.id = a.session_id WHERE s.id IS NULL) AS orphanAttemptSessions,
           (SELECT COUNT(*) FROM attempts a
              LEFT JOIN questions q ON q.id = a.question_id WHERE q.id IS NULL) AS orphanAttemptQuestions,
           (SELECT COUNT(*) FROM questions q
              LEFT JOIN papers p ON p.slug = q.paper_slug WHERE p.slug IS NULL) AS orphanQuestions,
           (SELECT COUNT(*) FROM questions q
              LEFT JOIN questions o ON o.id = q.origin
             WHERE q.origin IS NOT NULL AND o.id IS NULL) AS orphanOrigins,
           (SELECT COUNT(*) FROM papers
             WHERE question_count != json_array_length(question_ids)) AS paperCountMismatch`,

  sessions: `
    SELECT s.id,
           s.paper_slug                              AS volume,
           s.date,
           s.started_at                              AS startedAt,
           s.duration_min                            AS minutes,
           s.timing_mode                             AS timingMode,
           s.duration_source                         AS durationSource,
           s.question_count                          AS questionCount,
           json_extract(s.note, '$.baseline.file')   AS file
    FROM sessions s ORDER BY s.date, s.id`,

  attemptsBySession: `
    SELECT a.session_id     AS sessionId,
           COUNT(*)         AS questions,
           SUM(a.correct = 1)     AS correct,
           SUM(a.correct = 0)     AS wrong,
           SUM(a.correct IS NULL) AS unjudged
    FROM attempts a GROUP BY a.session_id`,

  // ---------------- 录入前需要看的上下文（只读） ----------------

  paperList: `
    SELECT p.slug, p.title, p.subject, p.question_count AS questionCount,
           (SELECT COUNT(*) FROM questions q WHERE q.paper_slug = p.slug) AS actualQuestions,
           (SELECT COUNT(*) FROM sessions s WHERE s.paper_slug = p.slug) AS sessions,
           json_extract(p.notes, '$.text') AS note
    FROM papers p ORDER BY p.rowid`,

  paperOne: `SELECT * FROM papers WHERE slug = ?`,

  questionsByPaper: `
    SELECT q.id, q.paper_slug AS paperSlug, q.number, q.seq, q.type,
           q.topic_id AS topicId, q.topic, q.origin, q.answer, q.scorable,
           q.notes, q.updated_at AS updatedAt
    FROM questions q WHERE q.paper_slug = ? ORDER BY q.seq`,

  questionOne: `SELECT * FROM questions WHERE id = ?`,

  questionList: `
    SELECT q.id, q.paper_slug AS paperSlug, q.number, q.seq, q.type,
           q.topic_id AS topicId, q.topic, q.origin, q.answer, q.scorable,
           q.content_md, q.notes, q.updated_at AS updatedAt
    FROM questions q
    WHERE (?1 IS NULL OR q.paper_slug = ?1)
      AND (?2 IS NULL OR q.topic_id = ?2)
      AND (?3 IS NULL OR q.id LIKE '%' || ?3 || '%' OR q.topic LIKE '%' || ?3 || '%'
           OR q.content_md LIKE '%' || ?3 || '%')
    ORDER BY q.paper_slug, q.seq
    LIMIT ?4 OFFSET ?5`,

  sessionList: `
    SELECT s.id, s.paper_slug AS paperSlug, s.date, s.started_at AS startedAt,
           s.duration_min AS durationMin, s.timing_mode AS timingMode,
           s.duration_source AS durationSource, s.question_count AS questionCount,
           s.note, s.updated_at AS updatedAt,
           json_extract(s.note, '$.baseline.file') AS file,
           (SELECT COUNT(*) FROM attempts a WHERE a.session_id = s.id) AS attempts
    FROM sessions s
    WHERE (?1 IS NULL OR s.date >= ?1)
      AND (?2 IS NULL OR s.date <= ?2)
      AND (?3 IS NULL OR s.paper_slug = ?3)
    ORDER BY s.date DESC, s.id DESC
    LIMIT ?4 OFFSET ?5`,

  sessionOne: `SELECT * FROM sessions WHERE id = ?`,

  attemptsBySessionId: `
    SELECT a.id, a.question_id AS questionId, a.user_answer AS userAnswer,
           a.correct, a.substantive_correct AS substantiveCorrect,
           a.score, a.score_max AS scoreMax, a.is_redo AS isRedo,
           a.error_tag AS errorTag, a.redo_status AS redoStatus,
           a.resolved_at AS resolvedAt, a.notes, a.updated_at AS updatedAt
    FROM attempts a WHERE a.session_id = ?
    ORDER BY (SELECT seq FROM questions q WHERE q.id = a.question_id)`,
};
