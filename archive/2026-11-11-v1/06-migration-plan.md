# 06 · 迁移计划与验收

| 项 | 值 |
|---|---|
| 状态 | 设计稿，未实施 |
| 关联 | [01 架构](01-architecture.md)（ADR-10） · [02 数据模型](02-data-model.md) · [04 一致性](04-consistency.md) · [05 API](05-api.md) |

## 1. 黄金基准

迁移对账一律以 **2026-11-11 的 `mem/data/index.json`** 为准，不以 `question-bank.md` §8 的验收记录为准（那是 v0.3 时点的 246 题 / 228 作答 / 31 场）。

| 项 | 基准值 |
|---|---|
| 原仓库 HEAD | `ad4f3ff`，工作区干净 |
| `meta.generatedAt` | `2026-11-11T09:00:24+08:00` |
| `meta.sourceFiles` | 56 |
| `meta.coverage` | `questions` 328 / `attempts` 317 / `sessions` 40 / `redoRows` 12 |
| `meta.timing` | `session` 23 / `per-question` 0 / `mixed` 1 / `none` 16 |
| `meta.errors` | `[]` |
| 分卷题数 | 2020 57 / 2024 57 / 2025 英语 48 / 形式逻辑 30 / 专项二 30 / 数学应用题 81 / 重练卷 25 |
| 判定分布 | `true` 217 / `false` 89 / `null` 11；`isRedo` 25 |
| 答案状态 | `confirmed` 321 / `estimated` 7 |
| 知识点 | 4 学科 / 34 节点 / 140 条逐题考点映射 |
| 文本资产 | 61 份 `*.md`、89 次提交、`index.json` 约 452 KB |
| 双口径 | 数学应用题卷面 68/81、实质 69/81 |
| 站点 | 纯静态构建，读 `volumes.json` + `index.json` + git 提交历史 |

> 站点 README 里的「31 场 / 22 学习日 / 0 警告」是 2026-11-07 上线时点的记录，仅作参考，不作对账基准。

## 2. 只读边界

- P0–P3 **不写入原仓库任何文件**；所有读取都是只读。
- 需要样本时，从原仓库**复制**到 `mem_new/fixtures/`，原件不动，fixture 不回写。
- 每个阶段结束复核：`git -C /Users/geyuqi/WorkBuddy/mem status --short` 为空、`git rev-parse --short HEAD` 仍为 `ad4f3ff`。
- 线上站点与 `deploy.sh` 在 P4 之前不改动。
- 给 Markdown 补 `id:` front-matter 属于写文件动作，**只在 P4 且获得明确授权后，对新项目内的数据副本执行**（ADR-10）。

## 3. 阶段

| 阶段 | 内容 | 产出 | 退出条件 |
|---|---|---|---|
| **P0 设计冻结**（当前） | 本文档集；确认 [README](../README.md) 五项待拍板（更新机制已在 [07](07-update-mechanism.md) 定稿）；冻结解析协议与字段口径 | 7 份设计文档 | 决策签字；明确「原仓库只读」 |
| **P1 原型闭环** | 复制 3 份样本到 `fixtures/`（见 [03](03-source-documents.md) §10）；对副本跑 `add_ids.py`；建 SQLite schema；实现数学 / 英语两个 splitter 分支；实现 rebuild 事务（含影响集与 hook 触发）、L1 校验、子集导出 | 可运行的原型 + 对账脚本 | 对应记录与原 `index.json` **逐字段 diff 零差异**；[07](07-update-mechanism.md) §10 增量断言通过 |
| **P2 全量只读导入** | 只读扫描原仓库 61 份 md + `volumes.json` + `index.json`；全量灌库；导出完整 `index.json` 与 `volumes.json` | 全量库 + 两份导出物 | 与黄金基准逐条对账通过；**站点不切换** |
| **P3 双跑与部署预演** | 新链路与现有 `build_index.py` 并行产出；本地 `preview.sh` 跑站点；影子环境验证 `deploy.sh` 的 snapshot 闸门 | 双跑对比报告、构建报告、闸门验证记录 | 双跑零差异；站点 warnings 0；闸门能正确拒绝滞后发布 |
| **P4 切换**（需授权） | 确定数据副本归属并补 `id:`；API 上线并接入录入；站点改读导出快照或 API；原仓库归档只读 | 生产链路 | 用户确认；旧链路保留至少一次完整发布周期可回退 |

**P1 是硬前置**：先用 3 份样本把「文件 → 切块 → 校验 → 导出 → 对账」跑通，再铺全量。不要一上来写全量 importer。

## 4. 验收断言

### 4.1 计数与字段

- [ ] `questions` 328、`sessions` 40、`attempts` 317、`redo_queue` 视图 12 行；知识点 34 节点与 7 个卷由 `volumes.json` 启动时校验（不建表）。
- [ ] 7 个卷题数与基准表逐卷一致；`scorable` 总数一致。
- [ ] `questions` / `sessions` / `attempts` 的**全部字段并集**逐一映射，无字段丢失（见 [02](02-data-model.md) §3）。
- [ ] 导出的 `index.json` 与原文件做结构化 diff：零差异（`meta.generatedAt` / `generator` 与新增的 `snapshotId` / `parserVersion` / `sourceCommit` 除外）。
- [ ] 判定分布 217 / 89 / 11、`isRedo` 25、答案状态 321 / 7 全部一致。
- [ ] 计时分布 23 / 0 / 1 / 16 一致；16 场 `duration_min` 为 NULL，不估算。

### 4.2 口径

- [ ] 数学应用题卷面 68/81、实质 69/81 可分别复算；卷级汇总分聚合结果与 `批改总结.md` / `试卷总结.md` 一致（不一致列 `needs_review`）。
- [ ] 总结 md 的整体评语与「一句话诊断」在 `reasoning_blocks(kind='summary_review')` 中有定位，可回原文核验。
- [ ] 34 个知识点节点的 `topicPath` 与知识树一致；`origin` 不悬空且继承原题考点。
- [ ] 12 条待重做全部映射，复发链两端存在，`resolved_at` 只在连续两次做对时有值。
- [ ] 7 条主观题 `score` / `scoreMax` / `scoreBasis` 齐全。
- [ ] 站点知识雷达按 `origin` 归并去重、首做 / 最近两层叠加，图形与旧版一致。

### 4.3 特例（见 [03](03-source-documents.md) §8）

- [ ] `math-applied-profit-03` 实质正确标记保留。
- [ ] `formal-logic-p2-q04` 答案为 `C`，原答案速查串 `E` 保留供追溯。
- [ ] 2024 Q25 题干修订与 `revision_json` 留痕；36/55 统计不变。
- [ ] 11 道数学充判题、35 条 `data-sufficiency`、11 条 `correct=null` 全部保留。
- [ ] 「方程设错」「填涂失误」按真实标签入库，注明约定外来源。

### 4.4 一致性与边界（见 [04](04-consistency.md) §10）

- [ ] 重复提交同一内容不新增 attempt；改一份文件只重建该文件相关派生。
- [ ] 重命名 answer 文件不产生新场次，`file_id` 与回链不变。
- [ ] 删库后能从 git 全量重建，导出物与基准一致。
- [ ] 三条 `overrides` 在全量重建后仍生效。
- [ ] 导出物 `snapshot_id` 与库不一致时，发布闸门拒绝。
- [ ] **原仓库 `git status --short` 为空、HEAD 仍为 `ad4f3ff`；线上站点未被改动。**

## 5. 回滚

| 阶段 | 回滚动作 | 影响 |
|---|---|---|
| P1–P3 | 删除 `mem_new/*.db`、`fixtures/`、导出物；停掉原型服务 | 原仓库与线上**零影响** |
| P4 切换后 | 站点 `deploy.sh` 切回上一 release（`ln -sfn`）；恢复读原 `mem/data/index.json`；API 下线 | 沿用现有健康检查与回滚机制 |

任何阶段失败都**不修原仓库数据**：差异清单交人工裁决，不用脚本自动「修平」——差异往往正是 `answerOverrides`、合并题号、双口径这类真实的人工判断。

## 6. 决策与待拍板对阶段的影响

| 事项 | 影响阶段 | 未定时的默认做法 |
|---|---|---|
| 数据库选型 | P1 | SQLite + WAL；DDL 用标准方言 |
| 重建触发（**已定**，见 [07](07-update-mechanism.md)） | P1 | `post-commit` hook 秒级 + 5 分钟定时扫描兜底 + 手动入口 |
| 多端录入 | P3–P4 | 只做本机 + agent；服务端单点写留到 P4 |
| 二进制上云 | P4 | 继续只留本地；`assets` 表经审查不建，真上云时再加（见 [02](02-data-model.md) §1.2） |
| 站点消费方式 | P4 | 继续读导出的 `index.json` |
| 切换授权（补 `id:`） | P4 | 不改原仓库；`file_id` 只存在注册表 |

## 7. 实施前必须确认的一句话

> 本次重构的产出是**新的索引层**，不是新的数据仓库；`mem` 里的 Markdown 始终是唯一真源。任何让数据库变成可写真源、或让原仓库文件被自动改写的设计，都超出本计划范围，需重新评审。
