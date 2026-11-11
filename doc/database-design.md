# 数据库设计

| 项 | 值 |
|---|---|
| 状态 | 设计稿 |
| 日期 | 2026-11-11 |
| 真源 | SQL 数据库（SQLite + WAL） |
| 数据基线 | `mem` @ `ad4f3ff`，`data/index.json` 2026-11-11 版 |
| 导出物 | `index.json`、`volumes.json`、站点静态页 |

## 1. 表清单与关系

```text
papers (7) ──1:N──> sessions (40) ──1:N──> attempts (317)
    │                                          │
    └──1:N──> questions (328) <──N:1───────────┘
                   │
                   └── origin 自关联（25 条重练卷题目回指原题）
```

| 表 | 行数 | 列数 | 职责 |
|---|---|---|---|
| `papers` | 7 | 8 | 卷元数据、题目清单、卷配置分值 |
| `questions` | 328 | 13 | 题目全文与静态事实 |
| `sessions` | 40 | 11 | 场次时间、用时、题量口径 |
| `attempts` | 317 | 15 | 逐题判定、批改全文、错因、重做台账 |

- ID 为 `index.json` 的字符串 ID。
- `sessions.paper_slug` 是外键；7 卷对应 40 场。
- 布尔用 `0/1 + CHECK`；数组用 JSON 文本。
- 知识点树（4 学科 / 34 节点 / 140 条逐题映射）存 `volumes.json`，不入库。
- 二进制资产不入库。

## 2. DDL

### 2.1 `papers`

```sql
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
```

`question_count` 期望值：2020 57 / 2024 57 / 英语 48 / 逻辑 30 / 专项二 30 / 数学 81 / 重练 25。与 `json_array_length(question_ids)` 不等时报告，不自动修平。

### 2.2 `questions`

```sql
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
```

- `(paper_slug, number)` 不唯一：数学应用题卷题号按考点重编，同卷 `number` 可重复，顺序由 `seq` 决定。
- `topic_id` 无外键。
- 合并题号、答案单元格说明、题干修订前原文保留在 `content_md` / `notes`。

### 2.3 `sessions`

```sql
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
```

`duration_min` 与 `question_count` 不从 `attempts` 反推；表内不存得分。

### 2.4 `attempts`

```sql
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
```

- 未诊断行的 `error_tag` / `redo_status` / `resolved_at` 为 NULL。
- 逐题评语、错因说明、判定附注从 `process_md` 读取；检索走 `LIKE` / FTS。

## 3. 字段口径

| 字段 | 规则 |
|---|---|
| `correct` / `substantive_correct` | 分开存。数学应用题全书卷面 68/81、实质 69/81，差额为 `math-applied-profit-03` |
| `correct` | `NULL` 共 11 条，不进判定分母 |
| `is_redo` | 25 条，为新 attempt；站点按 `origin` 归并去重，同题多次作答只算 1 题 |
| `duration_min` | 40 场中 16 场为 `NULL`、`timing_mode='none'`；不估算、不进累计轨迹；场次级与按题计时不混算 |
| `sessions.question_count` | 源文件场次题量口径。4 场 ≠ `COUNT(attempts)`：`2020-exam-a4` 0 vs 2、`2024-exam-a10` 0 vs 1、`2024-exam-a11` 0 vs 1、`2025-english-a5` 5 vs 8 |
| `score` / `score_max` | 仅 7 条主观题有值，对应 `scorable=0`；导出补 `scoreBasis='estimated'` |
| `content_md` / `process_md` | 「线规 1」、`**B**（最小值 2，无最大值）`、`❌ 假上界`、重做记录原句原样保留 |
| `topic` | 中文标签原样，不改题干、不重排题号；`topic_id` 为稳定主键 |
| `error_tag` | 8 类：模型选错 / 约束遗漏 / 倍数搞错 / 移项·符号 / 算术笔误 / 书写跳步 / 方程设错 / 填涂失误；后两类为约定外标签，按真实值入库，`notes` 注明来源 |
| `resolved_at` | 仅「连续两次做对」时有值；只适用于 12 行待重做台账 |

站点掌握度按首做 / 最近取判定端点、`minSample=5`、`maxAxes=8`、学科分开画图。

## 4. 导出计算

| 输出 | 算法 |
|---|---|
| 做对 / 做错次数 | `SELECT question_id, SUM(correct=1), SUM(correct=0) FROM attempts GROUP BY question_id` |
| 客观题得分 | `correct` × `papers.score_rule_json` 的卷配置分值 |
| 场次得分 / 卷级汇总分 | 由 `attempts.correct` + `score` 聚合：36/55、126/200、54/100、68/81 |
| `knowledgeTree` | 由 `volumes.json` 还原 |
| 逐题评语 / 错因说明 | 读 `process_md` |
| `meta.activity` | 由 `sessions.date` 聚合为「日期 + 计数」；站点提交活动、连续天数、热力图读该字段 |

导出的 `index.json` 顶层为 `meta` / `knowledgeTree` / `questions` / `sessions` / `attempts`，字段名、类型、枚举与基线一致。

## 5. 写入约束

- 一次录入 = 一个数据库事务。
- `UNIQUE (session_id, question_id)` 防重复上传；外键不悬空；`CHECK` 限定枚举。
- 三条人工判断的数据值：

| 记录 | 值 |
|---|---|
| `math-applied-profit-03` | `substantive_correct=1`（卷面错、实质对） |
| `formal-logic-p2-q04` | `answer='C'`；原速查串 `E` 记入 `notes` |
| 2024 Q25 | `content_md` 为 `$S_9=26`，`answer='E'`；修订原因记入 `notes`；首做未作答仍计错，36/55 不变 |

## 6. 备份与版本

| 项 | 做法 |
|---|---|
| 原子性 | SQLite + WAL；每次写入单事务，失败整体回滚 |
| schema 版本 | `PRAGMA user_version` + 带版本号的前滚 migration 脚本 |
| 时间戳 | 每表一列 `updated_at`，新建时写入 |
| 备份 | 每次批量导入前 + 每日复制 `.db` 文件（含 WAL checkpoint） |
| 可读快照 | 导出的 `index.json` 带 `generated_at` |
| 恢复 | 还原 `.db` → 重新导出 → 重建站点静态页 |
| 站点回滚 | 沿用 `deploy.sh` 的 `ln -sfn` 原子切换与失败回滚 |

## 7. 导入映射

| 来源 | 落点 |
|---|---|
| `index.json` `questions[]` | `questions` 的 `id` / `number` / `type` / `topic` / `topic_id` / `origin` / `answer` / `scorable` / `notes` |
| `index.json` `sessions[]` | `sessions` 全部列 |
| `index.json` `attempts[]` | `attempts` 的判定 / 估分 / `is_redo`；`errorNote`、`errorTags` 随正文进 `process_md`，主标签进 `error_tag`；`date` 导出时 `JOIN sessions` 填回 |
| `answer*.md` 正文 | `process_md`：判定表之后的逐题分析、订正、推演、评语、整体判断 |
| `paper.md` / 应用题.md | `content_md`：题干，含 LaTeX 与合并题号标题 |
| `volumes.json` | `papers` 元数据 / `score_rule_json`；知识树与别名留在 JSON |
| `knowledgeTree` | 不入库，导出时由 `volumes.json` 还原 |

导入对原仓库只读；导入完成后原仓库归档。

## 8. 基准与验收

基准：`mem` @ `ad4f3ff`，`meta.generatedAt=2026-11-11T09:00:24+08:00`。

| 项 | 值 |
|---|---|
| 覆盖 | 328 题 / 40 场 / 317 作答 / 12 条待重做；`meta.errors=[]`；`sourceFiles=56` |
| 分卷题数 | 2020 57 / 2024 57 / 英语 48 / 逻辑 30 / 专项二 30 / 数学 81 / 重练 25 |
| 判定 | 217 对 / 89 错 / 11 未判定；`isRedo` 25 |
| 答案状态 | confirmed 321 / estimated 7 |
| 计时 | session 23 / per-question 0 / mixed 1 / none 16 |
| 知识点 | 4 学科 / 34 节点 / 140 条逐题映射 |
| 双口径 | 数学应用题卷面 68/81、实质 69/81 |

- [ ] 4 表行数 7 / 328 / 40 / 317；台账状态非空 12 行；每表列数 ≤ 15。
- [ ] 导出的 `index.json` 与基准逐字段 diff 零差异（仅 `meta.generatedAt` / `generator` 允许不同）。
- [ ] 判定 217/89/11、`isRedo` 25、答案状态 321/7、计时 23/0/1/16 一致；16 场 `duration_min IS NULL`。
- [ ] 7 卷题数与基准逐卷一致；`scorable` 总数一致；34 节点 `topicPath` 与知识树一致。
- [ ] 数学卷 68/81 与 69/81 可分别复算；卷级汇总分由 `attempts` 聚合得出。
- [ ] §9 特例逐条存在。
- [ ] `content_md` / `process_md` 中 LaTeX、`$$`、合并题号标题、`(1)(2)` 小问、判定列附注原样保留。
- [ ] 站点用 `meta.activity` 渲染热力图，构建 warnings 为 0。
- [ ] 原仓库 `git status --short` 为空、HEAD 仍为 `ad4f3ff`；线上站点未改动。

## 9. 特例清单

1. `math-applied-profit-03` 卷面错、实质对（算出 25% 却选 12%）。
2. `formal-logic-p2-q04` 答案为 `C`，原速查串 `E` 记在 `notes`。
3. 2024 卷 Q25 题干 `$S_9=26`、答案 `E`，原因记 `notes`；36/55 不变。
4. 数学应用题卷 11 道带 `(1)(2)` 两小问的条件充分性判断题；全库 `type='data-sufficiency'` 共 35 条。
5. 7 条 `scorable=0` 主观题，`score` / `score_max` 齐全，导出补 `estimated`。
6. 11 条 `correct IS NULL`，不进判定分母。
7. 字典外标签「方程设错」「填涂失误」按真实值入 `error_tag`，`notes` 注明来源。
8. 合并标题 `## Q35 ~ 36`、答案单元格说明、判定列附注、重做记录原句原样保留在 `content_md` / `process_md`。
9. 4 场 `question_count ≠ COUNT(attempts)` 按源文件口径保留。

## 10. 索引

```sql
CREATE INDEX idx_q_paper    ON questions(paper_slug, seq);
CREATE INDEX idx_q_topic    ON questions(topic_id);
CREATE INDEX idx_q_origin   ON questions(origin);
CREATE INDEX idx_s_paper    ON sessions(paper_slug, date);
CREATE INDEX idx_a_session  ON attempts(session_id);
CREATE INDEX idx_a_question ON attempts(question_id);
CREATE INDEX idx_a_tag      ON attempts(error_tag, redo_status);
```

## 11. 范围外

录入 UI / CMS、账号与权限、多端并发写、实时推送、对象存储与二进制上云、站点页面改动、原仓库文件改动。
