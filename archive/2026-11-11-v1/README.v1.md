# mem_new

MEM 项目「数据库 + API」重构的**设计工作区**。当前只有设计文档，没有实现代码。

## 边界（先读这一节）

- 原仓库 `/Users/geyuqi/WorkBuddy/mem/` **全程只读**。本工作区不写入、不移动、不删除其中任何文件；`data/index.json`、`data/volumes.json`、所有 `*.md` 保持原样。
- 原仓库基线：commit `ad4f3ff`，2026-11-11 复核时工作区干净（`git status --short` 无输出）。后续每个阶段结束都应复核该基线未变。
- 线上站点源码 `/Users/geyuqi/Documents/aliyun/myWebsite/`（`geyuqi.me`）同样只读参考，本阶段不改动。
- 允许把原仓库的少数样本**复制**到 `mem_new/fixtures/` 做原型验证；复制是只读操作，原件不动，且 fixture 不回写。
- 本文档集是**设计稿**，不是已实现的事实。文中「将 / 计划 / 建议」均未经代码验证。

## 一句话方案

Markdown 文件保留为**唯一可写的真源**，给每份文件一个与路径解耦的稳定 `file_id`；数据库只存 `file_id` + 内容哈希 + 派生出的结构化事实（题目、场次、逐题作答、推演块定位、错因诊断、复发链、跨题洞察），不复制全文；`index.json` 与站点静态页降级为可随时重建的导出物。

## 文档导航

| 文档 | 内容 | 适合什么时候读 |
|---|---|---|
| [01-architecture.md](doc/01-architecture.md) | 现状、目标架构、10 条关键决策（ADR）、非目标、风险 | 想了解「为什么这么改」 |
| [02-data-model.md](doc/02-data-model.md) | 完整 DDL、ID 规范、字段口径与不可破坏的统计契约 | 开始写 schema 或迁移脚本 |
| [03-source-documents.md](doc/03-source-documents.md) | `file_id` 规范、front-matter、块定位、splitter 解析协议、特例清单 | 实现解析器与录入端 |
| [04-consistency.md](doc/04-consistency.md) | 单向派生、hash 链、事务幂等、三层校验、发布闸门、重放 | 实现重建、校验与部署 |
| [05-api.md](doc/05-api.md) | 端点契约、两种录入入口、鉴权、幂等、状态码 | 实现服务端 |
| [06-migration-plan.md](doc/06-migration-plan.md) | 黄金基准、P0–P4 阶段、验收断言、回滚 | 排期与动手 |
| [07-update-mechanism.md](doc/07-update-mechanism.md) | 触发链路、增量与影响集、事务原子替换、并发可见性、典型场景 | 关心「改了 md 之后怎么同步」 |

阅读顺序建议：01 → 02 → 03 → 04 → 05 → 06 → 07。

## 现状事实（2026-11-11 只读盘点）

| 项 | 值 |
|---|---|
| 原仓库规模 | 61 份 `*.md`、89 次提交、`data/index.json` 约 452 KB / 15 201 行 |
| 索引覆盖 | 328 题 / 40 场次 / 317 条逐题作答 / 12 条待重做；`meta.errors` 为空 |
| 结构化配置 | `volumes.json`：7 个卷、34 个知识点节点、140 条逐题考点映射 |
| 计时分布 | `session` 23 / `mixed` 1 / `none` 16 / `per-question` 0 |
| 判定分布 | `true` 217 / `false` 89 / `null` 11；`isRedo` 25 条 |
| 二进制 | 约 100 MB 的 PDF / HEIC 被 `.gitignore` 排除，仅本地 |
| 线上链路 | 本地 git push → 服务器 `/www/mem` 每 5 分钟 pull → 构建纯静态站 → nginx 发布 `geyuqi.me/study/` |
| 站点依赖 | `volumes.json` 派生卷清单；`index.json` 做统计与知识雷达；**git 提交历史**算提交活动、连续天数、热力图 |

> `mem/doc/question-bank.md` §8 的「246 题 / 228 作答 / 31 场」是 v0.3 时点的验收记录，不是当前值。迁移基准一律以 `data/index.json` 的 `meta.coverage` 为准，见 [06-migration-plan.md](doc/06-migration-plan.md)。

## 待拍板

**更新机制已定稿**：触发链路、增量与影响集、事务原子替换、并发可见性、发布闸门见 [07-update-mechanism.md](doc/07-update-mechanism.md)，不再列为待定项。

1. **数据库选型**：SQLite + WAL 起步（建议），还是直接 PostgreSQL。
2. **多端录入**：若需要手机或网页随时录入，必须由服务端单点写文件并自动 commit，冲突策略要单独定；若只有本机 + agent，可延后。
3. **二进制上云**：约 100 MB 的真题 PDF / 草稿扫描是否进对象存储，还是继续只留本地。
4. **站点消费方式**：继续读导出的 `index.json`（建议），还是改为直连 API。
5. **切换授权**：给 Markdown 文件补 `id:` front-matter 属于写文件动作，是否允许、何时允许（当前设计默认不动原仓库，见 ADR-10）。
