# 数据迁移核对报告

| 项 | 值 |
|---|---|
| 核对时间 | 2026-11-11T16:27:28+08:00 |
| 数据库 | `data/mem.db`（SQLite + WAL，user_version=1） |
| 基线 | `mem` @ `ad4f3ff`，`meta.generatedAt=2026-11-11T09:00:24+08:00` |
| 导出物 | `data/index.json`、`data/volumes.json` |
| 结果 | **40 PASS / 0 FAIL / 0 WARN** |

## 逐项结果

| 状态 | 检查项 | 明细 |
|---|---|---|
| PASS | 源仓库 HEAD / 工作区 / 文件哈希与导入前一致 | HEAD=ad4f3ff，git status 为空，67 个受版本控制文件 sha256 全量比对 |
| PASS | 源仓库 HEAD 仍为基线 | ad4f3ffc65584783631380889e63b068751961ec |
| PASS | 源仓库 git status --short 为空 | 无新增/修改/删除 |
| INFO | 线上站点源码 | /Users/geyuqi/Documents/aliyun/myWebsite 本次未做任何读写（范围外，仅记录路径） |
| PASS | 4 表行数 7 / 328 / 40 / 317 | {'papers': 7, 'questions': 328, 'sessions': 40, 'attempts': 317} |
| PASS | 每表列数 ≤ 15 | {'papers': 8, 'questions': 13, 'sessions': 11, 'attempts': 15} |
| PASS | PRAGMA integrity_check | ok |
| PASS | PRAGMA foreign_key_check | 无悬空外键 |
| PASS | PRAGMA user_version | 1 |
| PASS | §10 索引 7 个 | idx_a_question, idx_a_session, idx_a_tag, idx_q_origin, idx_q_paper, idx_q_topic, idx_s_paper |
| PASS | UNIQUE (session_id, question_id) 无冲突 | 冲突组 0 |
| PASS | 导出 index.json 与基线逐字段 diff 零差异 | 仅 meta.generatedAt / meta.generator 允许不同；差异 0 处 |
| PASS | 文本级 diff 仅 generatedAt / generator 两行 | 变更行 4 行（2 处 -/+） |
| PASS | 知识点 4 学科 / 34 节点 | 4 学科 / 34 节点 |
| PASS | 34 节点 topicPath 由 volumes.json 还原 | 全部有 path |
| PASS | 判定 217 对 / 89 错 / 11 未判定 | {'0': 89, '1': 217, 'null': 11} |
| PASS | isRedo 25 | 25 |
| PASS | 台账状态非空 12 行 | 12 |
| PASS | 答案状态 confirmed 321 / estimated 7 | scorable 1=321 0=7 |
| PASS | 计时 23 / 0 / 1 / 16 | {'mixed': 1, 'none': 16, 'session': 23} |
| PASS | 16 场 duration_min IS NULL | 16 |
| PASS | 7 卷题数与基准逐卷一致 | {'2020-exam': 57, '2024-exam': 57, '2025-english': 48, 'formal-logic': 30, 'math-applied': 81, 'reasoning-2': 30, 'redo-20261109': 25} |
| PASS | papers.question_count 与 question_ids 长度一致 | 不一致 0 卷 |
| PASS | 4 场 question_count ≠ COUNT(attempts) 按源文件口径保留 | 2020-exam-a4 0 vs 2; 2024-exam-a10 0 vs 1; 2024-exam-a11 0 vs 1; 2025-english-a5 5 vs 8 |
| PASS | 数学卷面 68/81 与实质 69/81 可分别复算 | correct=68 substantive=69 共 81 次作答 |
| INFO | 2024 卷判定复算 | 对 36 / 共 55 条客观题作答（基线汇总 36/55） |
| PASS | 特例 1：profit-03 卷面错、实质对 | correct=0, substantive_correct=1 |
| PASS | 特例 2：formal-logic-p2-q04 答案为 C | C |
| PASS | 特例 3：2024 Q25 题干 $S_9=26、答案 E、修订原因入 notes | answer=E, $S_9=26 命中=True, 修订原因=True |
| PASS | 特例 4：全库 data-sufficiency 共 35 条 | 35 |
| PASS | 特例 4：数学卷带 (1)(2) 两小问 | content_md 含全角（1）（2）的题 11 道 |
| PASS | 特例 5：7 条主观题 score / score_max 齐全 | 7 |
| PASS | 特例 6：11 条 correct IS NULL，不进判定分母 | 11 |
| PASS | 特例 7：约定外标签「方程设错」按真实值完整入库 | error_tag 主标签：倍数搞错, 模型选错, 移项·符号, 算术笔误, 约束遗漏；完整 errorTags 数组含 书写跳步、倍数搞错、方程设错、模型选错、移项·符号、算术笔误、约束遗漏（§7 规定主标签进 error_tag，完整数组存 notes 信封） |
| N/A | 约定外标签「填涂失误」 | 基线 index.json 中 0 条 attempt 使用该标签（设计字典预设，实际数据未出现），无可迁移数据 |
| PASS | 特例 8：合并题号标题 原样保留 | 已检出 |
| PASS | 特例 8：LaTeX $$ 原样保留 | 已检出 |
| PASS | 特例 8：❌ 假上界 原样保留 | 已检出 |
| PASS | 特例 8：线规 1 原样保留 | 已检出 |
| PASS | 特例 8：（1）（2）小问 原样保留 | 已检出 |
| PASS | 题目 number 全部入库 | 328 |
| PASS | content_md 逐字还原 paper 原文 | 8/8 份试卷字节级一致 |
| PASS | process_md 逐字覆盖场次批改全文 | 40/40 份场次文档正文（去 front matter）逐字可在 process_md 中检出 |
| N/A | 站点 meta.activity 热力图 | 本次迁移不含站点改动（设计 §5 / README 待确认项） |
| N/A | 线上站点未改动 | 未对站点目录做任何写操作 |
| INFO | 数据库文件 | /Users/geyuqi/WorkBuddy/mem_web/data/mem.db（3883008 字节，WAL 模式） |

## 说明

- **零差异口径**：导出器只读数据库与伴生 `volumes.json`，不读基线 `index.json`；比对时仅豁免 `meta.generatedAt` / `meta.generator`。
- **字段承载**：设计 DDL 的列数不足以表达基线全部字段，无法由列或确定性规则重建的余量字段以 JSON 信封存进既有 `notes` / `note` TEXT 列（见 `scripts/memdb.py`）；未新增表、未新增列。`content_md` / `process_md` 是数据库新增信息，不进入 `index.json`。
- **源文件保护**：导入前后对原仓库全部受版本控制文件做 sha256 快照比对，并校验 HEAD 与 `git status --short`；导入过程对原仓库仅执行读操作。
- **正文切分**：`content_md` 按 `<a id>` 锚点所在行的行首切块，8 份试卷均可逐字还原原文；章节标题（如 `## 三、逻辑推理`）会归入前一块，属连续原文片段。
  `process_md` 每条 attempt 都附带所属场次的完整正文，40 份场次文档逐字可检出；由此数据库约 3.9 MB，换取归档后零信息损失。

## 设计稿与基线数据的偏差

1. **§9 特例 7**：设计称约定外标签「方程设错」「填涂失误」按真实值入 `error_tag`。基线中「方程设错」只作为 `["算术笔误","方程设错"]` 的副标签出现 1 次，「填涂失误」0 次。按 §7「主标签进 error_tag」实现，完整数组保存在 notes 信封，数据无损。
2. **DDL 信息容量**：4 张表共 47 列，不足以表达基线 questions(18) / sessions(9) / attempts(20) 的全部字段。除可由列或确定性规则重建的字段外，余量以 JSON 信封存入既有备注列。
3. **站点 meta.activity**：设计 §5 要求由 `sessions.date` 聚合，但基线 `index.json` 没有该字段；为达成零差异，本次导出未新增它。站点热力图改造仍需单独实施。

## 复现命令

```bash
python3 scripts/migrate.py       # 建库 + 全量导入（原仓库只读）
python3 scripts/export_index.py  # 从数据库导出 index.json
python3 scripts/verify.py        # 核对并生成本报告
```
