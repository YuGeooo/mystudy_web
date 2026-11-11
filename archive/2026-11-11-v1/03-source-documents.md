# 03 · 源文件规范与解析协议

| 项 | 值 |
|---|---|
| 状态 | 设计稿，未实施 |
| 关联 | [01 架构](01-architecture.md)（ADR-02 / ADR-07 / ADR-10） · [02 数据模型](02-data-model.md) · [04 一致性](04-consistency.md) |

## 1. 两种形态：目标与过渡

| | 目标形态 | 过渡形态（**当前采用**） |
|---|---|---|
| `file_id` 载体 | 每份 Markdown 的 front-matter `id:` | 只存在于 `documents` 注册表，由确定性规则派生 |
| 原仓库文件 | 新项目的数据副本带 id | **一个字节不改** |
| 回链解析 | 读文件内 `id:` 与注册表双向核对 | 只用注册表 `file_id → current_path` |
| 触发条件 | 用户明确授权切换（见 [06](06-migration-plan.md) P4） | 设计阶段与 P1–P3 原型 |

`file_id` 与路径解耦是硬要求：站点现在按路径判定场次，重命名 `answer` 文件就会被当成新场次；用路径当身份会让所有回链随目录调整断裂。

## 2. `file_id` 规范

- 格式：**ULID**（26 字符、按时间有序、大小写不敏感），例如 `01J8Z3QK7P9X2M`。不用自增整数，避免多端生成冲突。
- 生成：过渡期由 `derive_file_id(normalized_path)` 确定性产出（对路径做规范化后取摘要再映射为 ULID 形式），**同一路径永远得到同一 ID**；切换后从文件 front-matter 读取，缺失则回退派生并记 warning。
- 唯一性：`documents.file_id` 主键；注册表内 `current_path` 唯一。
- 改名 / 移动：只 `UPDATE documents SET current_path = ?, version = version + 1`；`file_id` 不变，所有派生记录与回链保持有效。
- 删除：不物理删除记录，标 `documents.active = 0` 并保留历史版本，避免旧 attempt 悬空。

## 3. front-matter 规范

现有 `answer*.md` 已有 YAML 头，例如 `数学应用题/answer11/answer11.md`：

```yaml
---
time: 2026-11-04 07:35
file: 应用题.md
duration: 76min
---
```

目标形态只**追加一行**，其余字段、顺序、口径全部不动：

```yaml
---
id: 01J8Z3QK7P9X2M
time: 2026-11-04 07:35
file: 应用题.md
duration: 76min
---
```

`add_ids.py` 规范（照 `mem/scripts/add_anchors.py` 的幂等模式）：

1. 只对**新项目内的副本 / fixture** 执行，绝不指向原仓库路径（脚本应显式拒绝 `mem/` 根路径）。
2. 已有 `id:` 的文件跳过；无 front-matter 的文件补一段最小 YAML，不改正文第一个字符。
3. `timingMode`、`duration` 等可选字段保持「未记就整行省略」，不估算、不补录。
4. 重复运行结果一致（`--check` 模式只报告不写入）。
5. 新增 `id:` 是一次独立的、可回滚的提交，不与内容修改混在一起。

无 front-matter 的文件（`paper.md`、`答案速查.md`、`待重做.md`、各类总结）同样按此规则处理。

## 4. 文件分类（`documents.kind`）

| kind | 典型文件 | 解析产物 |
|---|---|---|
| `paper` | `2024年管综真题/paper.md`、`数学应用题/应用题.md`、两份形式逻辑卷 | `questions`（题干不入库，只登记锚点与定位） |
| `key` | `答案速查.md`、`试卷总结.md`（英语答案来源） | `questions.answer` / `answer_source` |
| `answer` | 40 份 `answer*.md` | `sessions` / `attempts` / `reasoning_blocks` / `diagnoses` |
| `redo` | `数学应用题/待重做.md` | `diagnoses.redo_status` / `redo_record` / `resolved_at`（经 `redo_queue` 视图） |
| `summary` | `批改总结.md`、`试卷总结.md`、`全书总结.md` | `documents` 登记 + `reasoning_blocks(kind='summary_review')` 挂整体评语锚点；汇总分由 `attempts` 聚合、不落库 |
| `vocab` | `生词本.md` | 只登记不拆 |

## 5. 块定位规则

- **题目锚点**：沿用现有 `<a id="2024-exam-q001"></a>`，写在题号行末，不改题意与题号。`questions.source_anchor = "<file_id>#2024-exam-q001"`。
- **推演块锚点**：优先用章节内已存在的标题（如 `### 线规 1 ❌ ...`）；标题不稳定时用行号区间 `L35-L44`。
- **组合形式**：`source_anchor` 统一为 `"<file_id>#<anchor>"` 或 `"<file_id>#L<a>-L<b>"`，解析时先查 `documents.current_path` 再读文件。
- 行号区间会随文件编辑漂移，因此**块记录必须绑定 `source_sha256`**：hash 一变即触发该文件的重新切块，不复用旧行号。

## 6. 解析协议（splitter）

**核心原则：不要求人填表单**。现有 Markdown 的标题与表格约定已经足够规整，直接当解析协议；agent 写 md、编辑器写 md、历史文件批量导入，走同一个 splitter。

### 6.1 按卷分派，不用一个全局正则

`mem/scripts/build_index.py` 每卷一个 `answers_xxx()` / `attempts_xxx()` 函数是有原因的：题号口径各不相同。新 splitter 继承这个分派结构：

| 卷 | 题号形态 | 映射到 `question_id` 的依据 |
|---|---|---|
| 2020 / 2024 真题 | 纯数字 1–55；合并标题 `## Q35 ~ 36` | `<slug>-q%03d` |
| 2025 英语二 | 按 Part 分段（完形 1–20、Part A 21–40、Part B 41–45） | `ENGLISH_TOPIC_BY_TYPE` |
| 形式逻辑两卷 | 各卷 1–15，需带 `p1` / `p2` | `formal-logic-p{1,2}-q%02d` |
| 专项训练二 | 全局 1–30 | `reasoning-2-q%02d` |
| 数学应用题 | 中文简称 + 数字（「线规 1」「至少至多 2」） | `topicAliases` / `mathTopics`，ID 带 topic slug |
| 错题重练卷 | 本卷重编 1–25 | `redo-20261109-q%02d` + `origin` 回指原题 |

### 6.2 判定表 → `attempts`

识别表头 `| 题号 | 你的答案 | 正确答案 | 判定 |`，逐行解析。真实样例（`数学应用题/answer11/answer11.md`）：

```text
| 线规 1 | E | **B**（最小值 2，无最大值） | ❌ 假上界 |
| 至少至多 2 | D | **E**（11 根） | ❌ 少 +1 |
| 线规 3 | D | D（2300 元） | ✅ |
```

- 题号列：保留 `number_raw`，再按卷规则解析成 `question_id`。
- 答案单元格：`**B**（...）` 取首字母填入 `correct_answer`，整串原样存入 `answer_cell_raw`；`?（未落定）` 视为未作答，`user_answer=NULL`。
- 判定列：`✅` / `❌` → `correct`；附加说明（「假上界」「少 +1」）存 `verdict_raw`，不丢。
- 主观题、未判定行：`correct=NULL`，不猜；`substantive_correct` 由 `overrides` 单独给出。

### 6.3 逐题批改正文 → `reasoning_blocks`

识别标题 `### <题号> <✅|❌> <用户答案> → 正确 <答案>（<说明>）`，把标题下直到下一个同级标题之间的内容切成块。**`✅` 与 `❌` 标题都切块**，答对题的解法说明（如 `answer11.md` 的「至少至多 4 ✅ A」段落）同样保留定位，不因为判对就跳过。切分依据（按优先级）：

| 引导词 / 结构 | `kind` |
|---|---|
| 「你的推演链条」「你的…」「你写的」 | `my_work` |
| 「正确解法」「正确做法」「顶点法」「夹逼」 | `correct_solution` |
| 「但…只是」「坏在」「错在」「丢系数」 | `error_step` |
| 「对照第 N 题」「同一方法，一场之内」 | `contrast` |
| 「教训一句话」「口诀」「钉死」 | `insight`；跨题归纳用 `kind='contrast'` + `ref_question_ids` |
| `**原文：**` / `**你的译文：**` / `**问题：**` / `**建议：**` 四段（英语） | `correction_pair` |
| 总结里的「整体判断」「当前主要失分点」「一句话诊断」 | `summary_review`（`attempt_id` 留空，`ref_question_ids` 指向相关考点代表题） |

- 块内 LaTeX（`$...$`、`$$...$$`、`\begin{cases}`）**原样保留**，不转义、不转纯文本、不转图片；渲染交给前端 KaTeX。
- 「如图 1」等图注保留为占位文本，不试图结构化图形；二进制真上云时再以 migration 加 `assets` 表登记（当前不建）。
- 数学卷与英语卷结构差异大，**各写一个 splitter**，共用一个输出契约。

### 6.4 错题订正表 → `diagnoses`

识别 `## 三、错题与订正（已进 ...）` 下的表格 `| 题号 | 错因标签 | 一句话订正 |`：

```text
| 至少至多 2 | 模型选错（"最坏 +1"漏加） | 保证 = 最坏不成功 10 + 1 = 11 |
```

- 括号内说明 → `root_cause`；标签主词 → `error_tag`（须在 8 类字典内，且属于该 attempt 的 `error_tags_json`，否则记 warning 不静默改）。
- 一句话订正 → `correction_rule`。
- 通过题号定位到本场 `attempt_id`。

### 6.5 待重做表 → `diagnoses` 的台账字段

识别 `待重做.md` 的 `| 来源 | 题目 | 错因标签 | 状态 | 重做记录 |`，共 12 行。重做记录形如：

```text
2026-11-09 ✅ C（第 1 次做对，连续两次才销账；见 错题重练-2026-11-09/answer3.md）
```

- 解析出日期、结果、次数、引用文件 → `redo_record` 原样 + 结构化字段。
- 同题再次判错 → 新增一条 `diagnoses`；复发次数 `JOIN attempts` 按 `(question_id, date)` 排序计算，不建自关联链。
- 只有「连续两次做对」才写 `resolved_at`；**该规则不推广为全题库掌握度判定**（§12.4）。

### 6.6 答案速查表 → `questions.answer`

`| 1~5 | E C D B B |` 这类区间行展开为逐题答案；`56~57 | 略（写作，估分见 批改总结.md）` 标 `scorable=0`。答案冲突时以 `volumes.json` 的 `answerOverrides` 为准并留痕，不改写原文串。

### 6.7 `parser_version`

- 格式 `YYYYMMDD.N`（如 `20261111.1`），记录在每条派生记录上。
- **任何解析规则变更必须升版本并全量重建**，不允许新老规则产出的记录混在一个库里。
- 重建前先导出当前 `index.json` 作为对照，见 [06](06-migration-plan.md)。

## 7. 原始值 / 规范化值双列

规范化最容易洗掉历史里的人工判断。以下必须成对保存：

| 原文写法 | 原始列 | 规范化列 |
|---|---|---|
| `线规 1` / `Q35 ~ 36` | `questions.number_raw` / `verdict_raw` | `questions.number` / `attempts.question_id` |
| `**B**（最小值 2，无最大值）` | `answer_cell_raw` | `answer` |
| `❌ 假上界` / `❌ 少 +1` | `verdict_raw` | `correct` |
| 中文简称「线规」「路程」 | 保留在原文与 `topic` | `topic_id`（`math.linear-programming`） |
| 重做记录整句 | `redo_record` | `status` / `resolved_at` |

## 8. 特例清单（必须原样保留）

迁移与重建时逐条断言这些记录存在，它们是独立复算后的人的判断，不是解析噪声：

1. `SUBSTANTIVE_OK = {"math-applied-profit-03": True}` —— 算出 25% 却选 12%，卷面错、实质对。
2. `volumes.json` 的 `answerOverrides: {"formal-logic-p2-q04": "C"}` —— 答案速查串第 4 位 `E` 与判定表、逐题分析冲突，独立复算应为 `C`；**原文串保留供追溯**。
3. 2024 卷 Q25 题干转录修订 `$S_6=26` → `$S_9=26`，正确答案 `C` → `E`，`revision_json` 留痕；首做未作答仍计错，36/55 不变。
4. 数学应用题卷 11 道带 `(1)(2)` 两小问的条件充分性判断题；全库 `type=data-sufficiency` 共 35 条。
5. 7 条 `answerStatus=estimated` 主观题，`score` / `scoreMax` / `scoreBasis` 齐全。
6. 11 条 `correct=null`（空白或主观题），不猜、不进判定分母。
7. 错因标签字典外的「方程设错」「填涂失误」按真实标签入库并注明来源，不擅自归并。
8. 合并标题 `## Q35 ~ 36`、答案单元格带说明文字、判定列带附注——全部保留原始串。

## 9. 明确不做

- 不改写题干、不重排题号、不重新编号已有题目（原 `question-bank.md` §1.3）。
- 不把 LaTeX 转成纯文本或图片。
- 不把推演拆成「步骤 / 变量 / 公式」细粒度关系表。
- 不要求录入者在表单里填写结构化字段；结构化由解析层产出。
- 不在过渡期给原仓库任何文件写入 `id:`。

## 10. 原型验证样本

P1 阶段从原仓库**只读复制**以下三份到 `mem_new/fixtures/`，原件不动：

| 样本 | 覆盖 |
|---|---|
| `数学应用题/answer11/answer11.md` | 判定表（中文简称 + 答案带说明）、逐题推演块、错题订正表、速度段落 |
| `数学应用题/待重做.md` | 12 行台账、重做记录、连续两次销账规则 |
| `2025年英语二/answer5.md` | `correction_pair` 四段式逐句订正、主观题估分 |

验收断言见 [06-migration-plan.md](06-migration-plan.md) §4。
