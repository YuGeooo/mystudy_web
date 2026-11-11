-- mem_new 数据库设计 v2，逐字对应 doc/database-design.md §2 / §10
-- 真源：SQLite + WAL。一次录入 = 一个事务。

PRAGMA user_version = 1;

CREATE TABLE papers (
  slug             TEXT PRIMARY KEY,
  title            TEXT NOT NULL,
  subject          TEXT,
  question_ids     TEXT NOT NULL,      -- JSON 数组，按卷内顺序
  question_count   INTEGER NOT NULL,
  score_rule_json  TEXT,               -- 客观题 3 分 / 写作 30、35
  notes            TEXT,
  updated_at       TEXT NOT NULL
);

CREATE TABLE questions (
  id           TEXT PRIMARY KEY,
  paper_slug   TEXT NOT NULL REFERENCES papers(slug),
  number       INTEGER NOT NULL,
  seq          INTEGER NOT NULL,      -- 卷内顺序
  type         TEXT NOT NULL,         -- problem|data-sufficiency|logic|cloze|reading|
                                     -- new-type|translation|writing|essay
  topic_id     TEXT,
  topic        TEXT NOT NULL,         -- 中文展示标签，原样
  origin       TEXT REFERENCES questions(id),
  content_md   TEXT NOT NULL,         -- 题干全文，含题号标题与 LaTeX
  answer       TEXT,                  -- NULL = 未定 / 主观题
  scorable     INTEGER NOT NULL CHECK (scorable IN (0,1)),
  notes        TEXT,                  -- 修订原因、答案冲突追溯、约定外标签说明
  updated_at   TEXT NOT NULL
);

CREATE TABLE sessions (
  id               TEXT PRIMARY KEY,
  paper_slug       TEXT NOT NULL REFERENCES papers(slug),
  date             TEXT NOT NULL,
  started_at       TEXT,
  duration_min     REAL,               -- NULL = 未记时长
  timing_mode      TEXT NOT NULL,      -- session|per-question|mixed|none
  duration_source  TEXT,               -- draft|timer
  question_ids     TEXT,               -- JSON 数组，场次包含的题目 id
  question_count   INTEGER NOT NULL,
  note             TEXT,
  updated_at       TEXT NOT NULL
);

CREATE TABLE attempts (
  id                   TEXT PRIMARY KEY,
  session_id           TEXT NOT NULL REFERENCES sessions(id),
  question_id          TEXT NOT NULL REFERENCES questions(id),
  user_answer          TEXT,
  correct              INTEGER CHECK (correct IN (0,1)),             -- NULL = 未判定
  substantive_correct  INTEGER CHECK (substantive_correct IN (0,1)),
  score                REAL,
  score_max            REAL,
  is_redo              INTEGER NOT NULL DEFAULT 0,
  error_tag            TEXT,
  redo_status          TEXT,
  resolved_at          TEXT,           -- 连续两次做对才销账
  process_md           TEXT,           -- 作答过程 + 批改全文：推演、订正、评语、判定附注
  notes                TEXT,
  updated_at           TEXT NOT NULL,
  UNIQUE (session_id, question_id)
);

CREATE INDEX idx_q_paper    ON questions(paper_slug, seq);
CREATE INDEX idx_q_topic    ON questions(topic_id);
CREATE INDEX idx_q_origin   ON questions(origin);
CREATE INDEX idx_s_paper    ON sessions(paper_slug, date);
CREATE INDEX idx_a_session  ON attempts(session_id);
CREATE INDEX idx_a_question ON attempts(question_id);
CREATE INDEX idx_a_tag      ON attempts(error_tag, redo_status);
