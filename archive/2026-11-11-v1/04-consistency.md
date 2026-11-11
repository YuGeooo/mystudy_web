# 04 · 一致性契约

| 项 | 值 |
|---|---|
| 状态 | 设计稿，未实施 |
| 关联 | [01 架构](01-architecture.md) · [02 数据模型](02-data-model.md) · [03 解析协议](03-source-documents.md) · [05 API](05-api.md) |

## 1. 四句话原则

> **只有一处能写，其余全是算出来的，算错了自己会报出来，任何时刻都能从 git 重放。**

1. **单一写入口**：Markdown 文件是唯一可写的真源；数据库派生表只读。
2. **单向派生**：文件 → 解析 → 派生记录 → 导出物，方向不可逆，不允许反向回写文件。
3. **hash 绑定**：每层都带上游哈希，不匹配即标 `stale`，**绝不静默覆盖**。
4. **可重放**：从任意 git commit checkout 出文件即可全量重建数据库；库损坏不构成数据丢失。

这条原则直接解决原 `AGENTS.md` 里靠人记住的约定：「改动任何被索引读取的 Markdown 后必须跑 `build_index.py` 并一起提交 `index.json`，否则原文页与统计脱节」。

## 2. 三层与 hash 链

| 层 | 可写 | 内容 | 一致性锚点 |
|---|---|---|---|
| ① 文件系统 | ✅ 唯一 | Markdown，带 `file_id`（过渡期在注册表） | `file_sha256 = sha256(文件字节)` |
| ② 数据库派生层 | ❌ 只读 | `questions` / `sessions` / `attempts` / `reasoning_blocks` / `diagnoses`（+ `redo_queue` 视图） | 每条带 `source_file_id` + `source_sha256` + `parser_version` |
| ③ 导出视图 | ❌ 可丢弃 | `index.json` / 只读 `.md` / 站点静态页 | `snapshot_id` |

```text
file_sha256          = sha256(文件原始字节)
source_sha256        = 生成该派生记录时的 file_sha256
snapshot_id          = sha256( concat( sort( "file_id:file_sha256" ) ) )
export_index_sha256  = sha256(导出的 index.json 字节)
```

`snapshot_id` 覆盖**全部**已注册文件，写进 `snapshots` 表、导出物 `meta` 与 HTTP 响应头。任一环比对失败即 `stale`，触发重建而不是覆盖。

## 3. 写入流程（跨系统，无单事务）

文件写入与数据库重建分属两个系统，做不到一个 ACID 事务；因此采用**最终一致 + 滞后可检测可重放**。

```text
[写入侧]
  提交 Markdown 内容 / 结构化录入
    → 写文件（服务端单点写）
    → git commit（保留提交历史）
    → 触发重建信号
        │
[重建侧，单个 DB 事务]
  ① 读全部注册文件，算 file_sha256，更新 documents
  ② 按 parser_version 解析，产出派生记录到内存 / 临时表
  ③ 应用 overrides（优先级最高）
  ④ 跑 L1 / L2 / L3 校验，写 validation_reports
  ⑤ 校验通过才 DELETE 旧派生 + INSERT 新派生 + 写 snapshots
  ⑥ 提交事务；任一步失败整体 ROLLBACK，库保持上一次一致状态
        │
[导出侧]
  生成 index.json（带 snapshot_id）+ 只读 .md → 站点构建
```

**关键**：DB 侧仍是一个完整事务，文件侧是 append-only 的 git commit，天然幂等。失败不会产生「半新半旧」的库。

## 4. 重建触发（已定，详见 [07](07-update-mechanism.md) §3）

**`post-commit` hook 秒级主路径 + 5 分钟定时扫描兜底 + 手动 `POST /api/rebuild`**，三路汇入同一个重建入口。webhook 等 P4 真要跨机多端时再加。

- 服务端写文件时 hook 本地同步、无公网依赖；本机 agent 直接提交时靠定时扫描（与现有 `deploy.sh` 节奏一致，零新增基础设施）。
- 重建只由 `file_sha256` 变化驱动：**hash 没变就跳过**，不认 mtime、不认提交次数。
- 61 份文件全量算哈希是毫秒级；三条路径靠 `(file_id, content_sha256)` 幂等去重。

增量 / 全量策略、影响集、事务原子替换与并发处理见 [07](07-update-mechanism.md) §4–§5。

## 5. 事务、幂等与并发

- **幂等键**：`(file_id, content_sha256)`；同一份内容重复提交直接返回既有 `snapshot_id`，不产生新场次或重复 attempt。
- **唯一约束**：`attempts(session_id, question_id)`、`documents(file_id)`、`documents(current_path)`、`reasoning_blocks(source_file_id, source_anchor, seq)`、`overrides(entity, entity_id, field)`。
- **并发**：同一时刻只允许一个重建任务，用文件锁或 `rebuilding` 状态位互斥；后来的请求排队或直接返回 `409 REBUILD_IN_PROGRESS`。
- **版本**：更正走「新版本 + 变更原因」，`documents.version + 1`，前后 `file_sha256` 记在 `snapshots` 的相邻两条记录里；不原地覆盖历史。
- **多端写入**：必须由服务端单点写文件 + 自动 commit；fast-forward 失败即拒绝并要求 rebase，不允许静默覆盖他人提交。

## 6. 三层校验

### L1 · 结构校验（继承现有 `validate()`）

原 `mem/scripts/build_index.py::validate()`（第 783–861 行）实际包含**约 26 项检查**，分 8 组，迁移后一项都不能少：

| 组 | 检查 |
|---|---|
| 解析期 | `parse_issues` 为空 |
| 源文件覆盖 | `check_source_numbers` 题号连续、`check_anchors` 锚点真实存在 |
| 唯一性与总数 | `questions.id` 唯一、总数 = `sum(totalQuestions)`、`scorable` 数一致、每卷题数一致、`attempt.id` 唯一 |
| 答案与来源 | 可评分题有 `answer`、有 `answerSource`、每题有 `source` 回指 |
| 知识树与标注 | `questionTopics` 的 `topicId` 在树内、2020/2024 覆盖 1–55、形式逻辑两卷覆盖 1–15、每题有 `topicId` 且有效、`topicPath` 一致 |
| `origin` | 不悬空、与原题考点一致 |
| attempt 一致性 | 不悬空引用、判定表答案 = 题库答案、判 ✅ 但用户答案不符、判 ❌ 但答案一致 |
| 台账与计时 | 待重做 12 行、`timingMode=none` 却有时长、有时长但缺 `durationSource` |

数据库新增的 L1 检查：

- 每条派生记录的 `source_sha256` 等于 `documents.content_sha256`；不等即 `stale`。
- 每条派生记录的 `parser_version` 等于当前版本；不等即需全量重建。
- 所有 `source_file_id` 能在 `documents` 找到且 `current_path` 对应的文件存在、hash 一致。
- 所有外键（含 `origin`、`attempt_id`、`question_id`）不悬空；`error_tags_json` / `ref_question_ids` 里的 ID 也须存在。

### L2 · 重解析 diff

拿当前文件**重新跑一遍 splitter**，与库中派生记录逐条比对（题目、场次、attempt、块定位、诊断、待重做）。有差异一律写入 `validation_reports.issues_json` 并标 `needs_review`，**不自动修平**——差异往往正是人工覆写或格式特例。

### L3 · 跨表与站点对账

- `diagnoses.error_tag` 必须能从对应 `reasoning_blocks` 的原文里解析出来，且属于该 attempt 的 `error_tags_json`；否则标 `needs_review`（防止两处标签漂移）。
- `redo_queue` 视图为 12 行；复发次数 `JOIN attempts` 按 `(question_id, date)` 可复算；`resolved_at` 只在连续两次做对时有值。
- 卷面 / 实质双口径分别可复算：数学全书 68/81 与 69/81；卷级汇总分（36/55、126/200、54/100）由 `attempts` 聚合复算，与 `批改总结.md` / `试卷总结.md` 里人工写的数字不一致时标 `needs_review`，由人改文件，数据库不反向回写。
- 导出的 `index.json` 与数据库聚合结果逐字段一致；`export_index_sha256` 记入 `snapshots`。
- 站点构建报告 `.build/build-report.json` 的解析覆盖率与 warnings 与 `validation_reports` 对得上。

## 7. 发布闸门

在 `myWebsite/scripts/deploy.sh` 的 `npm run build` 之前增加校验（本阶段只写设计，不改站点代码）：

```text
1. 读导出物的 snapshot_id 与 GET /api/status 返回的当前 snapshot_id
2. 两者不等 → 判定「数据滞后 N 个 commit」
   - 严格模式：中止发布，保留上一版 release
   - 宽松模式：允许发布，但页面显式标注滞后（默认不采用）
3. 相等但 validation_reports 有 fail → 中止发布
4. 通过 → 继续原有构建、原子切换、健康检查、失败回滚流程
```

这样把「人忘记重生成索引」变成「构建自己会拒绝」，且不影响现有 5 分钟部署与回滚机制。

## 8. 人工覆写隔离

`overrides` 优先级高于解析器：校验时先应用 overrides 再比对期望值，自动重算永不覆盖。当前已知需入表 3 条：`math-applied-profit-03` 实质正确、`formal-logic-p2-q04` 答案覆盖为 `C`、2024 Q25 题干与答案修订。每条必须有 `reason` 与 `verified_by`。

## 9. 失败与重放

| 场景 | 行为 |
|---|---|
| 文件已 commit、重建失败 | 库保持上一一致状态，`GET /api/status` 显示 `stale` + 失败原因；可手动 `POST /api/rebuild` 重试 |
| 数据库文件损坏 / 误删 | 从任意 git commit checkout 文件 → 全量重建；导出物与站点可一并恢复 |
| 解析协议升级 | 升 `parser_version` → 全量重建 → 与升级前导出的 `index.json` 双跑对账，零差异才切换 |
| 站点构建失败 | 沿用现有 `deploy.sh` 健康检查与 `ln -sfn` 回滚到上一 release |
| 需要回到历史状态 | `git checkout <commit>` → 重建 → 得到当时的完整派生层 |

## 10. 一致性验收清单（实施后逐条跑）

- [ ] 修改一份 answer 文件 → 提交 → 重建 → 该文件相关的 `sessions` / `attempts` / `blocks` / `diagnoses` 全部更新，其他文件派生记录 `source_sha256` 不变。
- [ ] 同一份内容重复提交两次 → 第二次返回相同 `snapshot_id`，`attempts` 行数不变。
- [ ] 手工把某条派生记录的 `source_sha256` 改坏 → L1 立即报 `stale`。
- [ ] 重命名一份 answer 文件 → 只更新 `current_path`，`file_id` 与所有回链不变，**不产生新场次**。
- [ ] 断开 `documents` 中一个文件路径 → L1 报文件缺失。
- [ ] 删除数据库 → 从 git 全量重建，导出的 `index.json` 与迁移基准逐字段一致。
- [ ] 导出物 `snapshot_id` 与 DB 不一致时，`deploy.sh` 拒绝发布。
- [ ] 三条 `overrides` 在全量重建后仍然存在且生效。
- [ ] 原仓库 `git status --short` 为空、HEAD 仍为 `ad4f3ff`。
