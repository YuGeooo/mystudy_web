# 07 · 更新机制

| 项 | 值 |
|---|---|
| 状态 | 设计稿，未实施 |
| 关联 | [04 一致性](04-consistency.md) · [05 API](05-api.md) · [06 迁移计划](06-migration-plan.md) |
| 取代 | [04](04-consistency.md) §4 的「重建触发三选一」待定表述；README 原「重建触发」待拍板项 |

## 1. 结论

> 以**文件哈希变化**为唯一更新事实；服务端单点写 + `post-commit` hook 秒级重建，5 分钟定时扫描兜底，手动 `POST /api/rebuild` 兜底之兜底；默认**文件级增量 + 影响集**，四类情况退化为全量；重建在单事务内「先算后换」，失败回滚、站点全程读上一版。

| 维度 | 决策 |
|---|---|
| 触发 | hook 主路径 + 定时扫描兜底 + 手动入口，三路汇入**同一个** rebuild |
| 粒度 | 文件级增量（直接集 ∪ 依赖集）；配置 / 协议 / 链路变化时全量 |
| 原子性 | 单事务先算后换；校验不过整体 ROLLBACK |
| 并发 | SQLite WAL + 单写者互斥 + `(file_id, sha256)` 幂等 |
| 可见性 | 每次更新产出 `snapshot_id`，`GET /api/status` 暴露状态，发布闸门校验 |
| 方向 | **数据库永远不反向写 Markdown**，单向派生 |

一句话区分两个时钟：**数据库重建是秒级，站点发布仍是 5 分钟**（沿用 `deploy.sh` 节奏）。重建快意味着「提交后马上能查」，不代表页面立刻变；站点下一次构建会拿到最新 `snapshot_id`。

## 2. 什么算一次更新

| 类别 | 信号 | 判据 |
|---|---|---|
| 内容更新 | 改了判定表、补了一段逐题分析、订正错因 | `file_sha256` 变化。**只认字节哈希，不认 mtime、不认提交次数** |
| 结构更新 | 新增 / 重命名 / 删除文件 | `documents` 注册表变化 |
| 口径更新 | `parser_version` 升级、`volumes.json` / 知识树 / `questionTopics` / `topicAliases` 变化、`overrides` 变更 | 配置层或协议层版本变化 |
| 服务更新 | 代码发布、DB schema migration | 与数据内容无关，见 §8 |

编辑器保存但内容未变、touch 文件、`git commit --allow-empty` 都**不触发**重建。

## 3. 触发链路（已定，不再是三选一）

```text
[写入]  服务端单点写 Markdown → git commit
            │
            ├─ post-commit hook ──→ POST /api/rebuild {commit}        ← 主路径，秒级
            │
[本机]  agent 直接改文件并提交 ──→ 5 分钟定时扫描 / 本机 hook 调同一 API  ← 兜底
            │
[人工]  POST /api/rebuild {force?, dry_run?}                          ← 手动
            ▼
        同一个 rebuild 入口：算 hash → 比对 → 有变化才重建
```

**为什么这样定**

- 服务端写文件时 `post-commit` hook 是本地、同步、无公网依赖，比 webhook 简单可靠；webhook 需要接收端、签名校验、重试与防重放，等 P4 真要跨机多端时再加。
- 本机 agent 直接提交时 hook 可能不在服务端，所以保留 5 分钟扫描；现有 `deploy.sh` 本来就是这个节奏，**零新增基础设施**。
- 扫描成本可忽略：61 份文件、约 600 KB 文本，全量算 sha256 是毫秒级；hash 没变直接跳过。
- 三条路径幂等：同一 `(file_id, content_sha256)` 重复触发直接返回既有 `snapshot_id`，不写库、不产生新场次。

## 4. 增量策略与影响集（核心）

### 4.1 直接集与依赖集

```text
D（直接集）= 本次 file_sha256 变化的文件
R（依赖集）= 受 D 影响、但自身 hash 未变的其他派生记录：
             · 被 origin 指向的原题（重练卷题目）
             · `reasoning_blocks.ref_question_ids` 指向的跨题 attempt
             · 同题的历史 `diagnoses`（JOIN attempts 按 question_id + date 计算）
             · 该文件答案源被其他卷引用（如答案速查 / answerOverrides）
             · 同一 session 内被合并题号（Q35 ~ 36）牵连的记录
重建范围 = D ∪ R；其余文件派生记录完全不动，source_sha256 保持不变
```

**为什么不能纯增量**：`origin` 回指、块内跨题归纳、待重做复发链、`answerOverrides` 都是跨文件依赖。只重解析 D 会让「原题考点改了、重练卷仍继承旧考点」这类不一致悄悄留下。

**保守规则**：`R` 无法精确计算、依赖链超过 1 跳、或发现悬空引用 → **退化为全量重建**。宁可多算，不可漏算。

### 4.2 四类必须全量

1. `parser_version` 升级（新老规则产物不能混在一个库里）。
2. `volumes.json` / `knowledgeTree` / `questionTopics` / `topicAliases` 变化（影响所有题的 `topic_id`、卷归属与站点雷达）。
3. 删除文件、或 `origin` 回指链可能断裂的结构变化。
4. `overrides` 变化影响跨卷统计口径（例如卷面 / 实质双口径规则）。

> 例外：**纯重命名**（内容不变）不触发全量，甚至不触发重新解析，见 §7 场景 4。

### 4.3 重建事务：先算后换

```text
BEGIN IMMEDIATE
  ① 读 D ∪ R 的文件，按当前 parser_version 解析到 staging（临时表 / 内存）
  ② 应用 overrides（优先级最高）
  ③ 校验：L1 全库（便宜，约 26 项 + hash 比对）
          L2 仅对 D ∪ R 重解析 diff
          L3 受影响的跨表关系（origin / 待重做台账 / 跨题块引用 / 双口径）
  ④ 任一校验失败 → ROLLBACK；status=stale，写 validation_reports，库保持上一 snapshot
  ⑤ 通过 → DELETE 旧派生 WHERE source_file_id IN (D ∪ R)
           → INSERT staging
           → 更新 documents / snapshots / validation_reports
COMMIT
  ⑥ 提交后才生成导出物（临时文件 + rename 原子替换）
```

**失败不产生半新半旧的库**，这是把「跨系统无单事务」的代价关在 DB 内部的关键。

## 5. 并发与可见性

- **SQLite WAL**：重建事务写入期间，查询仍读到上一个已提交快照，不会看到中间态。
- **单写者互斥**：`rebuilding` 状态位 + `409 REBUILD_IN_PROGRESS`；后续请求排队或返回同一结果，不并发重建。
- **幂等**：`(file_id, content_sha256)` + `client_request_id` 双重去重。
- **导出原子性**：`index.json` / `volumes.json` / 只读 md 都是「写临时文件 → `rename`」，站点不会读到写了一半的 JSON。
- **状态出口**：`GET /api/status` 是唯一状态来源，站点发布闸门与运维都读它，不各自判断。状态机见 [05](05-api.md) §6。
- **线上不中断**：更新过程中站点继续服务上一版静态产物；静态站天然没有「正在更新」的中间态。

## 6. 更新状态与发布闸门

```text
consistent ──文件变化──→ pending ──→ rebuilding ──校验通过──→ consistent（新 snapshot_id）
                                        │
                                        └──校验失败──→ stale（库保持旧 snapshot，写 report）
```

`deploy.sh` 在 `npm run build` 前比对导出物 `snapshot_id` 与 `GET /api/status` 当前值：不等即判定「数据滞后 N 个 commit」，严格模式中止发布、保留上一 release；`validation_reports` 有 `fail` 同样中止。详见 [04](04-consistency.md) §7。

## 7. 典型场景逐条

| # | 场景 | 触发 | 重建范围 | 结果 |
|---|---|---|---|---|
| 1 | 把某场判定表一个 `❌` 改成 `✅` | 内容 | `D` = 该 answer 文件 | 该场 `attempts` / `blocks` / `diagnoses` 重算，其他场次 `source_sha256` 不变；若该题在台账里，L3 报 `needs_review` 提示人工核对 `待重做.md` |
| 2 | 补一段逐题分析 / 一句话教训 | 内容 | `D` | 只新增 `reasoning_blocks`（含 `kind='insight'`），判定结果不变 |
| 3 | 新增一场 `answer12.md` | 结构 | `D` = 新文件 + sessions 聚合 | 只新增一个场次，旧场次不受影响（现有「新增 answer 文件才是新场次」的约定保留） |
| 4 | 重命名 / 移动 answer 文件 | 结构，hash 不变 | **零重建** | 只 `UPDATE documents.current_path`；`file_id` 与所有回链不变，不产生新场次 |
| 5 | 新增卷 / 改 `questionTopics` | 口径 | 全量 | 双跑对账，站点雷达与卷清单同步 |
| 6 | splitter 规则升级 | 口径 | 全量 | 升 `parser_version`，与升级前导出物 diff，零差异才切换 |
| 7 | 更正历史结论（如 Q25 题干修订） | 内容 | `D` + 依赖集 | 改文件 → `version + 1` + `revision_json` 留痕，旧 `attempt` 不覆盖 |
| 8 | `overrides` 变更 | 口径 | 受影响 attempt 或全量 | 重算 + 新 `snapshot`，人工判断永不被自动重算盖掉 |
| 9 | 代码发布 / schema migration | 服务 | 见 §8 | 与数据更新解耦 |

> 场景 1 的 `needs_review` 要特别强调：**数据库不能反向修改 `待重做.md`**。校验发现台账与判定不一致时只报告，由人或 agent 去改文件，再走一次正常更新。这也是 ADR-01「单向派生」的实际含义。

## 8. 服务 / 代码更新（与数据更新解耦）

| | 数据更新 | 服务更新 |
|---|---|---|
| 触发 | 文件 hash 变化 | git push / `deploy.sh` timer |
| 产物 | 新 `snapshot_id` + 派生记录 | 新 release 目录 + `ln -sfn` 原子切换 |
| 回滚 | ROLLBACK / 从 git 全量重建 | 健康检查失败切回上一 release |
| 是否重启服务 | 否 | 是 |

- 站点沿用现有 `deploy.sh`：pull → 构建 → 原子切换 → 健康检查 → 失败回滚，本设计只在其前面加一道 snapshot 闸门。
- **DB schema migration** 用带版本号的前滚脚本；migration 不改数据内容，但可能要求 `parser_version` 对齐，此时主动触发一次全量重建。
- 改代码不需要重建数据，改数据不需要重启服务。文件变更看 git，重建 / 导出事件看 `snapshots`，两者不需第三张审计表。
- 服务端写文件后**自动 commit**，git 提交历史继续产生，站点首页的提交活动 / 连续天数 / 热力图数据源不受影响；`snapshots` 只记录重建事件，不替代 git。

## 9. 硬约束

1. 数据库永远不反向写 Markdown；发现文件需要改，只报 `needs_review`。
2. 只以 `sha256` 判断更新，不用 mtime、不用提交次数。
3. 不静默覆盖 `overrides` 与人工判断。
4. 校验未通过不发布；发布前必须比对 `snapshot_id`。
5. 重复触发不产生新场次、不重复 attempt。
6. P0–P3 不修改原仓库文件、不改动线上站点代码。

## 10. 验收断言

- [ ] 改 1 份 answer → 只有该文件相关派生变化，其他文件 `source_sha256` 不变。
- [ ] 同一内容连续触发 3 次（hook + 扫描 + 手动）→ `snapshot_id` 不变，`attempts` 行数不变。
- [ ] 重建过程中并发第二个请求 → `409` 或返回同一结果，库无中间态。
- [ ] 故意造一条校验错误 → 库保持上一 snapshot，`status=stale`，发布闸门拒绝。
- [ ] 重命名 answer 文件 → 零重建、场次数量不变、回链不断。
- [ ] 改 `questionTopics` → 触发全量重建，所有题 `topic_id` 更新。
- [ ] `parser_version` 升级 → 全量重建且与升级前导出物 diff 零差异。
- [ ] 判定表改动导致台账不一致 → 报 `needs_review`，**文件未被自动修改**。
- [ ] 重建秒级完成，站点仍按 5 分钟节奏发布，构建拿到最新 `snapshot_id`。
- [ ] 原仓库 `git status --short` 为空、HEAD 仍为 `ad4f3ff`。

## 11. 本文件对既有文档的修订

| 位置 | 原表述 | 现表述 |
|---|---|---|
| [04](04-consistency.md) §4 | 重建触发「三选一，待拍板」 | 已定：hook 主 + 定时兜底 + 手动，详见本文件 §3 |
| [README](../README.md) 待拍板 | 6 项，含「重建触发」 | 5 项；更新机制已定，见本文件 |
| [01](01-architecture.md) §7 | 待定事项含「重建触发」 | 移除，改为引用本文件 |
| [06](06-migration-plan.md) §6 | 触发方式默认「保留 5 分钟定时扫描」 | 改为「hook 秒级 + 扫描兜底」，P1 起验证 |
