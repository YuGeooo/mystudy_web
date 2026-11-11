# 02 · 数据模型与 Schema

| 项 | 值 |
|---|---|
| 状态 | 设计稿，未实施 |
| 关联 | [01 架构](01-architecture.md) · [03 源文件规范](03-source-documents.md) · [04 一致性](04-consistency.md) |

## 1. 设计原则

1. **字符串 ID 沿用，绝不改自增主键**：`question_id`（`2024-exam-q001`）、`session_id`、`attempt_id` 全部照搬 `index.json`，否则所有回链、锚点、站点 URL 失效。
2. **只有 `documents` 注册表可由写入流程更新；其余业务表是只读派生层**。数据库层面用视图 / 权限 / 触发器限制直接写入，见 [04](04-consistency.md)。
3. **每条派生记录统一带四列**：`source_file_id`、`source_sha256`、`parser_version`、`source_anchor`。为节约篇幅，下方 DDL 中每张表都显式写出，不再重复说明。
4. **标准 SQL 方言**：数组一律用关联表或 JSON 文本，避免 SQLite / PostgreSQL 迁移成本。
5. **原始值与规范化值双列**：见 [03](03-source-documents.md) §7，不为「清洗」丢掉原文写法。
6. **按基数与查询模式拆表，不按概念名词拆表**：一对一 / 可空字段留主表；低频短文本并入已有表的 `kind`；现有数据里不存在的结构不预留字段。

### 1.1 表清单（以必要性为准）

| 分类 | 表 | 结论 |
|---|---|---|
| **必要 · 原型即建（7）** | `documents` `questions` `sessions` `attempts` `reasoning_blocks` `diagnoses` `snapshots` | 缺一不可，理由见 §1.2 |
| **视图（1）** | `redo_queue` | 不占表，`diagnoses` 的 12 行投影 |
| **条件必要 · 生产才建（2）** | `overrides` `validation_reports` | 原型可用 JSON 配置 / 日志替代；P2 后落表 |
| **非必要 · 建议不建（2）** | `volumes` `knowledge_nodes` | 7 行 + 34 行静态配置，启动时读 `volumes.json` 即可 |
| **非必要 · 建议删除（2）** | `change_log` `assets` | 职责已被覆盖 / 当前为空表，见 §1.2 |

> §2 的 DDL 是**完整参考模型**；实施以本表为准，标「不建 / 删除」的表不执行。审查前共 13 张表 + 1 视图，按本节结论实际落地 **7 张（原型）→ 9 张（生产）**。上一轮已按 §2.4 把 13 张业务表精简到 8 张，本轮再按必要性重审。

### 1.2 表必要性审查

**四条判据**

1. 能由现有文件或其他表在启动 / 查询时派生 → 不建表。
2. 有独立查询模式、且承载别处放不下的事实（多值、自关联、历史）→ 保留。
3. **来源文件 / 更新粒度不同的事实，即使 1:1 也要分表**（补充 §1 第 6 条）。
4. 只服务「将来可能」或当前为空 → 删除；生产必需的审计 / 覆写按阶段建，不进原型。

**逐张结论**

| 表 | 判断 | 理由 |
|---|---|---|
| `documents` | 必要 | `file_id` 与路径解耦的唯一载体、hash 链基准、增量更新输入；`content_sha256` 必须持久化才能绑定历史派生记录 |
| `questions` | 必要 | 328 题，全部外键与 `origin` 回指的锚点 |
| `sessions` | 必要 | `duration_min` 是**整场**用时、`timingMode` 是场次属性，下放到 `attempts` 会重复且歧义；站点按场次聚合 |
| `attempts` | 必要 | 317 条核心事实表 |
| `reasoning_blocks` | 必要 | 推演过程的查询入口：按 `kind` 检索、按 `source_anchor` 绑定 hash、与 attempt 关联；不建就退回「Markdown 不可查」 |
| `diagnoses` | 必要 | 见下方「关键发现」 |
| `snapshots` | 必要 | hash 链终点、发布闸门基准、重建事件记录；删了就没有可比对的状态出口 |
| `overrides` | 条件必要 | 人工判断不被自动重算覆盖的唯一保障；原型可用 JSON 配置，生产需 API 登记与审计 |
| `validation_reports` | 条件必要 | 发布闸门要查最近一次校验状态、L2 差异要留给人看；原型可先用日志 + `snapshots` 状态 |
| `volumes` | 非必要 | 7 行配置镜像；站点卷清单本来就从 `volumes.json` 派生，启动时读入做期望值校验即可 |
| `knowledge_nodes` | 非必要 | 34 行配置镜像；`questions.topic_path_json` 已冗余存了展示路径，别名解析在内存做即可 |
| `change_log` | **建议删除** | 文件变更看 git（diff / blame / 回滚），重建事件看 `snapshots`（`built_at` / `git_commit`），override 变更看 `overrides.created_at`，校验失败看 `validation_reports.created_at`；四者已覆盖全部审计需求，且服务端自动 commit 保证 git 历史不断 |
| `assets` | **建议删除** | 二进制上云尚未拍板，P4 前是一张空表；为未决定的需求预留违反 §1 第 6 条，真上云时加表是一次便宜的 migration |

> **关键发现：`diagnoses` 为什么不能并进 `attempts`**。按 §1 第 6 条「一对一 / 可空字段留主表」，它与 `attempts` 是 `1:0..1`，本应合并。但 [07](07-update-mechanism.md) §4.3 的增量重建是**按 `source_file_id` 删除并重建派生记录**：`attempts` 绑的是 `answer*.md`，而 `diagnoses` 的台账部分（`redo_status` / `redo_record`）来自 `待重做.md`。一旦合并，改台账会触发整条 `attempt` 重建，破坏更新粒度、甚至覆盖 answer 文件里的判定事实。因此分表的真实理由是**来源归属与更新粒度**，不是「概念不同」——判据 3 据此补充。

> 字段级清理见 §1.3。

### 1.3 字段冗余清理

**判据**：能由其他表 / 现有文件确定性派生且不改变语义 → 删列；同一事实两处存 → 留权威一处；为「将来可能」预留且当前全空 → 删列；**看似可派生但口径不同 → 必须保留**。

**删除 10 列**

| 表 | 列 | 依据 |
|---|---|---|
| `attempts` | `date` | 317 条全部等于 `sessions.date`（实测 0 不一致），且 `attempt.id` 前缀即日期；导出时 `JOIN sessions` 填回 |
| `diagnoses` | `question_id` `verified_by` | 前者由 `attempt_id` 派生；后者当前全空，用 `attempts.verified` |
| `reasoning_blocks` | `question_id` `label` `excerpt` | 统一用 `attempt_id` + `ref_question_ids`；后两列是可选摘要且当前全空，与 ADR-03「不复制全文」相悖 |
| `documents` | `git_commit` `first_seen_at` `updated_at` | `snapshots.git_commit` 已有；审计看 git；更新判据只认 `sha256` 不认时间戳（[07](07-update-mechanism.md) §2） |
| `validation_reports` | `issue_count` | 由 `issues_json` 数组长度得出 |

**保留，且说明理由**

- **`sessions.question_count` 不是冗余（实测推翻了上轮判断）**：40 场里有 4 场 `questionCount ≠ COUNT(attempts)` —— `2020-exam-a4` 0 vs 2、`2024-exam-a10` 0 vs 1、`2024-exam-a11` 0 vs 1、`2025-english-a5` 5 vs 8。它记录的是源文件里的场次题量口径（主观题、合并题号、未作答差异），删了导出 `index.json` 就还原不了。
- `diagnoses.error_tag`：语义是「这条诊断的主标签」，与 `attempts.error_tags_json` 的标签集合不完全等同；保留，但 L3 加一条校验——它必须属于对应 attempt 的标签集合，防止双写漂移。
- 一致性四列 `source_file_id` / `source_sha256` / `parser_version` / `source_anchor`：每条派生记录自证来源，L1 要逐条比对 hash，不能因「能 join 出来」就删。
- 原始值双列 `number_raw` / `answer_cell_raw` / `verdict_raw`：见 [03](03-source-documents.md) §7，防规范化过程洗掉人工判断。
- `questions.topic_path_json`：`knowledge_nodes` 降级为启动时读 JSON 后，它成为站点展示路径的必要缓存。
- `snapshots.file_count`：快照**时刻**的历史值，不是当前文件数。
- `documents.version` / `active`：版本与软删除标记，无替代。
- `questions.origin`：跨卷回指，站点按 `origin` 归并去重。

> **硬约束澄清**：§3「`index.json` 字段并集不得丢弃」约束的是**导出契约**，不是库表列名。删掉的列在导出时由 `JOIN` / 聚合 / 派生填回，逐字段 diff 仍须零差异。清理只针对新增设计字段，来自 `index.json` 的字段一个都不动。

### 1.4 分数与评语的落点（现状盘点后补充）

**原仓库现状**（2026-11-11 只读核实）：

| 内容 | 写在哪儿 | 是否进 `index.json` |
|---|---|---|
| 逐题判定表、逐题分析、订正、错因 | `answer*.md` 正文（判定表 → 逐题批改 → 错题与订正 → 速度/下一步） | 判定进 `attempts`；错因只抽 12 条 `errorNote` + 12 条 `errorTags`；**正文不进索引** |
| 场次卷面分（如「卷面 5/9」） | `answer*.md` 正文 | 否，站点由 `attempts.correct` 聚合 |
| 主观题估分（翻译 8/15、写作 18/30 等） | `answer*.md`（如「预估得分：8 / 15」） | **是**，7 条 `score` / `scoreMax` / `scoreBasis=estimated` |
| 卷级 / 全书汇总分（36/55、约 126/200、54/100、68/81） | `批改总结.md` / `试卷总结.md` / `全书总结.md` 的表格 | **否**；索引顶层只有 `meta/knowledgeTree/questions/sessions/attempts` |
| 估分口径（按首做、每题 3 分、写作按评分标准预估） | 上述总结 md 的引用块 | 否 |
| 整体评语 / 下一步建议（「当前主要问题不是基础完全不会…」「一句话诊断」） | 上述总结 md | **否**，索引零字段 |

**落点决策（不加表、不加字段）**：

| 内容 | 处理 |
|---|---|
| 7 条主观题估分 | 已在 `attempts.score` / `score_max` / `score_basis`，不动 |
| 场次卷面分、卷级 / 全书汇总分 | **不落库**：由 `attempts.correct` + `score` 聚合派生，站点本来就在算；存了就是第三份真源。导出时计算 |
| 估分口径与计分规则 | 留在总结 md；`documents(kind=summary)` 登记定位，不复制全文（ADR-03）。L3 增加一条：聚合分与总结 md 里写的数字不一致时标 `needs_review`，由人改文件 |
| 逐题评语 / 错因 | `reasoning_blocks` 定位 + `diagnoses.root_cause` / `correction_rule` 短字段 |
| **卷级 / 全书整体评语与「一句话诊断」** | `reasoning_blocks` 新增 `kind='summary_review'`，`attempt_id` 留空（本来就可空），`source_file_id` 指向总结 md，`ref_question_ids` 指向相关考点代表题；按考点查询时 `JOIN questions.topic_id`。不建新表、不存全文 |

> 这是上一版模型的缺口：`documents(kind=summary)` 原写「只登记不拆」，导致整体评语和「一句话诊断」这类高价值归纳无处可查。补一个 `kind` 枚举值即可，无需加表或加字段。

### 1.5 逐题作答记录里的分数与评语字段清单

`attempts` 中与分数 / 文字相关的列（实测 `index.json`）：

| 列 | 内容 | 实测 |
|---|---|---|
| `score` / `score_max` / `score_basis` | 主观题估分 | 7 条 `estimated`；客观题为 NULL |
| `correct` / `substantive_correct` | 卷面 / 实质双口径 | 217 对 / 89 错 / 11 未判定 |
| `verdict_raw` | 判定列附注原样（「❌ 假上界」） | 原始值双列，见 [03](03-source-documents.md) §7 |
| `error_tags_json` | 错因标签数组 | 12 条 |
| `note` | **状态说明，不是评语** | 17 条，全部是「未作答（按错计）」「主观题：无客观判定，估分见总结」 |

**客观题没有逐题分数字段**：得分 = 判定 × 卷配置分值（问题求解、条件充分性每题 3 分，写作 30 / 35），分值口径写在 `批改总结.md` / `试卷总结.md` 的引用块里，不入库（§1.4）；站点由 `attempts.correct` 聚合。`questions.notes` 的 25 条也全是重练卷「原题 XXX」回链，与评语无关。

**逐题评语没有长文本列，这是有意的**（ADR-03 不复制全文）。落点分三处：

| 评语形态 | 落点 |
|---|---|
| 逐题分析全文（**含答对题的解法说明**） | `reasoning_blocks` 只存 `source_anchor` + `kind`；splitter 按 `### <题号> <✅\|❌>` 标题切块，答对的题同样切块 |
| 错因短结论 / 一句话订正 | `diagnoses.root_cause` / `correction_rule`（仅错题） |
| 卷级整体评语、「一句话诊断」 | `reasoning_blocks(kind='summary_review')` |

**唯一未结构化的一类**：「答案正确但过程有瑕疵」（`批改总结.md` 的 Q5 / Q15、Q22 / Q24，`answer11.md` 的「虽然中途废了两版」）。它可由 `summary_review` 块 + `ref_question_ids` 定位，但**没有逐题布尔标记**，无法直接查询「所有答对但过程有问题的题」。全库仅 4 题，按 §1 第 6 条不为低频需求加字段；若这类判断成规模，再考虑在 `attempts` 加 `process_flawed`。

## 2. 完整 DDL（参考模型）

> 以 §1.1 的实施清单为准：`volumes` / `knowledge_nodes` 默认不建，`change_log` / `assets` 建议删除；DDL 保留供需要时参考。

### 2.1 源文件注册表（唯一身份层）

```sql
CREATE TABLE documents (
  file_id         TEXT PRIMARY KEY,   -- ULID，与路径解耦
  current_path    TEXT NOT NULL,      -- 相对 mem 根；改名/移动只更新这里
  kind            TEXT NOT NULL,      -- paper|answer|key|summary|redo|vocab
  volume_slug     TEXT,               -- 仅 paper：逻辑外键 → volumes.slug
  paper_no        INTEGER,            -- 仅 paper：多卷专项 1=卷一、2=卷二
  content_sha256  TEXT NOT NULL,
  version         INTEGER NOT NULL DEFAULT 1,
  active          INTEGER NOT NULL DEFAULT 1,  -- 0 = 已移除，保留历史不物理删除
  UNIQUE (current_path)
);
```

> 过渡期 `file_id` 由确定性规则从路径派生并只存在于本表；目标形态才写进文件 front-matter。见 ADR-10。

### 2.2 卷、知识树、题目（`volumes` / `knowledge_nodes` 默认不建）

```sql
CREATE TABLE volumes (
  slug               TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  subject            TEXT NOT NULL,
  total_questions    INTEGER NOT NULL,
  scorable_questions INTEGER NOT NULL,
  notes              TEXT
);

CREATE TABLE knowledge_nodes (
  id            TEXT PRIMARY KEY,     -- math.probability / logic.argument
  name          TEXT NOT NULL,
  parent        TEXT REFERENCES knowledge_nodes(id),
  granularity   TEXT NOT NULL,        -- subject|topic|type
  aliases_json  TEXT                  -- JSON 数组；PostgreSQL 可换 JSONB
);

CREATE TABLE questions (
  id               TEXT PRIMARY KEY,  -- 沿用 index.json 字符串 ID
  volume_slug      TEXT NOT NULL REFERENCES volumes(slug),
  paper_file_id    TEXT REFERENCES documents(file_id),
  number           INTEGER NOT NULL,
  number_raw       TEXT,              -- 「线规 1」「Q35 ~ 36」等原样
  section          TEXT,
  topic            TEXT NOT NULL,     -- 中文展示标签，原样保留
  type             TEXT NOT NULL,
  answer           TEXT,
  answer_cell_raw  TEXT,              -- 「**B**（最小值 2，无最大值）」
  answer_source    TEXT,
  answer_status    TEXT NOT NULL,     -- confirmed|estimated|missing
  scorable         INTEGER NOT NULL CHECK (scorable IN (0,1)),
  source_anchor    TEXT NOT NULL,     -- 文件#questionId
  topic_id         TEXT REFERENCES knowledge_nodes(id),
  topic_path_json  TEXT,
  granularity      TEXT,
  origin           TEXT REFERENCES questions(id),  -- 重练卷回指原题
  revision_json    TEXT,
  notes            TEXT,
  source_file_id   TEXT NOT NULL REFERENCES documents(file_id),
  source_sha256    TEXT NOT NULL,
  parser_version   TEXT NOT NULL
);
```

> **不设 `(volume, paper, number)` 唯一约束**：数学应用题卷的题号按考点重新从 1 编号，同一 `paper` 内 `number` 会重复。ID 唯一性由主键 + 校验层保证，唯一键口径见 `question-bank.md` §3.2「数学题 ID 带 topic、唯一键含 paper」。

### 2.3 场次与逐题作答

```sql
CREATE TABLE sessions (
  id              TEXT PRIMARY KEY,
  volume_slug     TEXT NOT NULL REFERENCES volumes(slug),
  source_file_id  TEXT NOT NULL REFERENCES documents(file_id),
  date            TEXT NOT NULL,
  question_count  INTEGER NOT NULL,   -- 场次题量口径，≠ COUNT(attempts)，见 §1.3
  timing_mode     TEXT NOT NULL,       -- session|per-question|mixed|none
  duration_min    REAL,                -- 可空；未记时长不估算
  duration_source TEXT,                -- draft|timer
  note            TEXT,
  source_sha256   TEXT NOT NULL,
  parser_version  TEXT NOT NULL
);

CREATE TABLE attempts (
  id                   TEXT PRIMARY KEY,
  session_id           TEXT NOT NULL REFERENCES sessions(id),
  question_id          TEXT NOT NULL REFERENCES questions(id),
  user_answer          TEXT,
  correct_answer       TEXT,
  correct              INTEGER CHECK (correct IN (0,1)),  -- NULL = 未判定，不猜
  substantive_correct  INTEGER CHECK (substantive_correct IN (0,1)),
  score                REAL,
  score_max            REAL,
  score_basis          TEXT,           -- estimated 时必填
  is_redo              INTEGER NOT NULL DEFAULT 0,
  duration_min         REAL,
  duration_source      TEXT,
  source_anchor        TEXT NOT NULL,
  verdict_raw          TEXT,           -- 「❌ 假上界」原样
  error_tags_json      TEXT,           -- JSON 数组；吸收 attempt_error_tags
  verified             INTEGER NOT NULL DEFAULT 0,
  note                 TEXT,
  source_file_id       TEXT NOT NULL REFERENCES documents(file_id),
  source_sha256        TEXT NOT NULL,
  parser_version       TEXT NOT NULL,
  UNIQUE (session_id, question_id)
);

```

> 同一题重做产生**新 attempt**（通常在新场次），不用「上次结果」覆盖旧记录。若未来出现同场次内同题多答，扩展 `attempt_no` 后再放宽唯一约束。

### 2.4 推演块与错因诊断（2 张表）

**为什么是 2 张而不是 1 张**：基数不同。一次批改对一道题产生多个块（我的推演 / 正确解法 / 对照 / 教训），但只有一条诊断结论；块的职责是「定位到原文」，诊断的职责是「存可查询的结论短字段」。合并会产生大量 NULL 与重复行。反过来也不能把块塞进 `attempts` 的一个 JSON 大字段——那等于把 Markdown 搬进库，并失去按 `kind` 检索、按 `source_anchor` 绑定 hash 的能力。

```sql
CREATE TABLE reasoning_blocks (
  id                TEXT PRIMARY KEY,
  attempt_id        TEXT REFERENCES attempts(id),
  source_file_id    TEXT NOT NULL REFERENCES documents(file_id),
  source_anchor     TEXT NOT NULL,      -- #锚点 或 L35-L44
  seq               INTEGER NOT NULL,
  kind              TEXT NOT NULL,      -- my_work|correct_solution|error_step|contrast|insight|correction_pair|summary_review
  ref_question_ids  TEXT,               -- JSON 数组；kind=contrast|insight 时指向关联的题
  source_sha256     TEXT NOT NULL,
  parser_version    TEXT NOT NULL,
  UNIQUE (source_file_id, source_anchor, seq)
);

CREATE TABLE diagnoses (
  id              TEXT PRIMARY KEY,
  attempt_id      TEXT NOT NULL REFERENCES attempts(id),
  error_tag       TEXT NOT NULL,       -- 诊断主标签；须属于该 attempt 的标签集合
  root_cause      TEXT,               -- 「模型选错（"最坏 +1"漏加）」
  correction_rule TEXT,               -- 「保证 = 最坏不成功 10 + 1 = 11」
  redo_status     TEXT,               -- NULL=未进台账；待重做 / 重做 1 次 ✅ / 重做 1 次 ❌
  redo_record     TEXT,               -- 「2026-11-09 ✅ C（连续两次才销账…）」原样
  resolved_at     TEXT,               -- 连续两次做对才销账
  source_file_id  TEXT NOT NULL REFERENCES documents(file_id),
  source_anchor   TEXT NOT NULL,
  source_sha256   TEXT NOT NULL,
  parser_version  TEXT NOT NULL
);

CREATE VIEW redo_queue AS
  SELECT * FROM diagnoses WHERE redo_status IS NOT NULL;
```

**四处合并，少 5 张表**：

| 原设计 | 现处理 | 原因 |
|---|---|---|
| `insights` + `insight_attempts` | 并入 `reasoning_blocks` 的 `kind=insight\|contrast` + `ref_question_ids` | 与 ADR-07 已定义的块类型重复；跨题归纳是低频短文本，为它建 N:M 关联表是典型过度设计。查 `WHERE kind='insight'` 即可 |
| `redo_items` | 并入 `diagnoses` 的 `redo_status` / `redo_record` / `resolved_at` + `redo_queue` 视图 | 12 行台账，与「错因 + 销账」同属一次作答的结论 |
| `attempt_error_tags` | 并入 `attempts.error_tags_json` | 复合标签极少；SQLite `json_each` / PG `JSONB` 都能查 |
| `volume_papers` | 并入 `documents.volume_slug` / `paper_no` | 只是「哪些 paper 属于哪卷」两个字段 |

**不预留臆造字段**：现有 Markdown 从未记录「错在第几步」（`error_step_no`），重做记录是「重做 1 次 ✅/❌ + 引用文件」而非显式诊断链（`recurrence_of`）。复发次数 `JOIN attempts` 按 `(question_id, date)` 排序即可算出，两者都不建。`ref_question_ids` 里若存短段落归纳，只放定位与摘要，遵守 ADR-03「不复制全文」。

### 2.5 覆写、审计、校验、快照、资产（运维层，P2 后建）

```sql
CREATE TABLE overrides (
  id          TEXT PRIMARY KEY,
  entity      TEXT NOT NULL,          -- questions|attempts|diagnoses
  entity_id   TEXT NOT NULL,
  field       TEXT NOT NULL,
  value_json  TEXT NOT NULL,
  reason      TEXT NOT NULL,
  verified_by TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE (entity, entity_id, field)
);

CREATE TABLE change_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  at             TEXT NOT NULL,
  actor          TEXT NOT NULL,        -- agent|api|user
  file_id        TEXT REFERENCES documents(file_id),
  git_commit     TEXT,
  action         TEXT NOT NULL,        -- create|update|rebuild|override|export
  before_sha256  TEXT,
  after_sha256   TEXT,
  detail         TEXT
);

CREATE TABLE validation_reports (
  id           TEXT PRIMARY KEY,
  snapshot_id  TEXT NOT NULL,
  level        TEXT NOT NULL,          -- L1|L2|L3
  status       TEXT NOT NULL,          -- pass|stale|fail
  issues_json  TEXT,
  created_at   TEXT NOT NULL
);

CREATE TABLE snapshots (
  snapshot_id         TEXT PRIMARY KEY,  -- sha256(sorted "file_id:hash")
  file_count          INTEGER NOT NULL,
  parser_version      TEXT NOT NULL,
  built_at            TEXT NOT NULL,
  git_commit          TEXT,
  export_index_sha256 TEXT
);

CREATE TABLE assets (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,        -- pdf|heic
  storage_key     TEXT,                 -- 对象存储 key 或本地相对路径
  sha256          TEXT NOT NULL,
  related_file_id TEXT REFERENCES documents(file_id),
  note            TEXT
);
```

> `change_log` 与 `assets` 经 §1.2 审查**建议不建**，DDL 仅作参考。审计职责由 git（文件变更）+ `snapshots`（重建事件）+ `overrides` / `validation_reports`（人工与校验事件）共同覆盖；服务端自动 commit 保证站点读到的 git 提交历史不断。二进制真上云时再以 migration 加回 `assets`。

### 2.6 索引

```sql
CREATE INDEX idx_q_topic    ON questions(topic_id);
CREATE INDEX idx_q_volume   ON questions(volume_slug, number);
CREATE INDEX idx_q_hash     ON questions(source_sha256);
CREATE INDEX idx_a_question ON attempts(question_id);
CREATE INDEX idx_a_session  ON attempts(session_id);
CREATE INDEX idx_a_hash     ON attempts(source_sha256);
CREATE INDEX idx_s_date     ON sessions(date);
CREATE INDEX idx_b_attempt  ON reasoning_blocks(attempt_id, seq);
CREATE INDEX idx_b_kind     ON reasoning_blocks(kind);
CREATE INDEX idx_d_tag      ON diagnoses(error_tag, redo_status);
CREATE INDEX idx_d_hash     ON diagnoses(source_sha256);
```

## 3. 字段口径映射（不得丢弃）

`index.json` 现有字段并集如下，迁移时逐一落表，一个都不能丢：

| 来源 | 字段 | 目标 |
|---|---|---|
| `questions[]`（18） | `id volume paper number section topic type answer answerSource answerStatus scorable source revision notes topicId topicPath granularity origin` | `questions` 同名列；`source` → `source_anchor` + `source_file_id`；`topicPath` → `topic_path_json` |
| `sessions[]`（9） | `id date file volume questionCount timingMode durationMin durationSource note` | `sessions`；`file` → `source_file_id` |
| `attempts[]`（20） | `id date sessionId session questionId userAnswer correctAnswer correct substantiveCorrect score scoreMax scoreBasis errorTags errorNote isRedo durationMin durationSource source verified note` | `attempts`（`errorTags` → `error_tags_json`；`date` 不落库、导出时 JOIN `sessions` 填回）；`errorNote` → `diagnoses.root_cause`；`session` / `source` → `source_file_id` + `source_anchor` |
| `knowledgeTree` | `subjects` / `nodes`（34） | 不入库：启动时读 `volumes.json` 校验；`questions.topic_path_json` 保留展示路径 |
| `volumes.json` | `volumes` / `questionTopics` / `topicAliases` / `mathTopics` / `answerOverrides` / `redoQuestions` | 不入库：启动时读 JSON 做期望值校验；`questions.topic_id` / 解析期别名表 / `overrides` / 重练卷 `origin` |

> `attempts.date` 不落库，导出 `index.json` 时 `JOIN sessions` 填回；`sessions.question_count` 保留原值（口径不同，见 §1.3）。「字段不丢」以**导出的 `index.json`** 为准，逐字段 diff 零差异。

## 4. 不可破坏的统计契约

迁移验收必须逐条验证，这些口径来自 `AGENTS.md` 与 `question-bank.md` §12.4，属于站点展示契约：

1. **卷面 / 实质双口径**：`correct` 与 `substantive_correct` 分开存。数学应用题全书实测 **68/81 与 69/81**，差额来自 `math-applied-profit-03`（算出 25% 却选了 12%）。只有一个 `correct` 会与 `全书总结.md` 对不上。
2. **`duration` 可空**：未记时长是合法状态，不估算、不追问补录、不计入累计轨迹。当前 40 场中 16 场 `timingMode=none`。
3. **计时不混算**：场次级（可能含订正、翻页）与按题计时（通常只含解题）不混算；按题计时上线后累计轨迹另起一条。当前 `per-question` 尚无样本。
4. **正确率口径**：区分卷面与实质；`correct=null` 的 11 条不猜、不进判定分母。
5. **主观题**：7 条 `answerStatus=estimated`，`score` / `scoreMax` / `scoreBasis` 必填；`scorable=0`。
6. **中文 `topic` 原样保留**，不改题干与判定表；`topicId` 是稳定主键，`granularity` 区分 `topic` / `type`。
7. **`origin` 继承原题考点**：重练卷题目 ID 独立，站点按 `origin` 归并去重，同一道题多次作答只算 1 题。
8. **掌握度口径**：首做 / 最近取判定端点；当前错题 = 最近一次判错的原题数；样本量阈值 `minSample`（默认 5）、雷达轴上限 `maxAxes`（默认 8）；学科分开画图；**「连续两次做对才销账」只适用于待重做台账，不推广为全题库掌握度判定**。
9. **旧判定表不回填**，新增 `ID` 列时保留题号列。

## 5. 枚举与字典

| 枚举 | 值 |
|---|---|
| `questions.type` | `problem` / `data-sufficiency` / `logic` / `cloze` / `reading` / `new-type` / `translation` / `writing` / `essay` |
| `questions.answer_status` | `confirmed` / `estimated` / `missing` |
| `sessions.timing_mode` | `session` / `per-question` / `mixed` / `none` |
| `duration_source` | `draft` / `timer` |
| `knowledge_nodes.granularity` | `subject` / `topic` / `type` |
| `documents.kind` | `paper` / `answer` / `key` / `summary` / `redo` / `vocab` |
| `reasoning_blocks.kind` | `my_work` / `correct_solution` / `error_step` / `contrast` / `insight` / `correction_pair` / `summary_review` |
| 错因标签（8 类） | 模型选错 / 约束遗漏 / 倍数搞错 / 移项·符号 / 算术笔误 / 书写跳步 / 方程设错 / 填涂失误 |

> `build_index.py` 的 `ERROR_TAGS` 含 8 类；其中「方程设错」「填涂失误」在原 `question-bank.md` §10 被标为「仓库实际使用、约定外」，迁移时**按真实标签入库**，同时在 `overrides` 或字典备注里注明来源，不擅自归并。当前库中标签频次合计 14 次。

## 6. PostgreSQL 差异（若未来切换）

- `aliases_json` / `topic_path_json` / `revision_json` / `value_json` / `issues_json` / `error_tags_json` / `ref_question_ids`：换 `JSONB`。
- `scorable` / `correct` / `substantive_correct` / `is_redo` / `verified`：换 `BOOLEAN`（当前用 0/1 + CHECK 兼容 SQLite）。
- 其余表结构、约束、索引可原样迁移。
