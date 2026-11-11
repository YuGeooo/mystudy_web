# mem_new

MEM 项目重构工作区。**SQL 数据库是唯一真源**；Markdown 完成一次性导入后归档只读。数据迁移（P0）、本地服务（P1）、本地站点（P2）、改库闭环（P3）与线上部署（P4）均已跑通。线上：<https://geyuqi.me/study/>。

## 当前状态

- 数据模型：[doc/database-design.md](doc/database-design.md)（v2，4 张表，设计稿）
- **已迁移**：[data/mem.db](data/mem.db)（SQLite + WAL，4 表 7 / 328 / 40 / 317 行）。
  [核对报告](doc/migration-report.md)：40 项全通过，导出的 [data/index.json](data/index.json)
  与 `ad4f3ff` 基线逐字段零差异（仅 `meta.generatedAt` / `generator` 两行不同）。
- 实现：`scripts/schema.sql`（DDL + 索引）、`migrate.py`（一次性只读导入）、
  `export_index.py` / `export_content.py`（数据库 → JSON 契约）、`verify.py`（核对 + 生成报告）、
  `sync.sh`（串联导出）、`verify-loopback.mjs`（闭环验证）。
- **P1 本地服务**：`./dev.sh` 起 `http://127.0.0.1:8137`，零 npm 依赖
  （Node 22 自带 `node:http` + `node:sqlite`），数据库只读。
  端点 `/api/health` / `/api/meta` / `/api/days`；`node server/smoke-test.mjs` 自测 19 项全通过。
  代码在 `server/`，配置在 `config.local.json`。
- **P2 本地站点**：`http://127.0.0.1:8137/study/`。三份数据契约：`index.json`、
  `content.json`（`scripts/export_content.py` 从库里还原 48 份 Markdown 全文）、`volumes.json`。
  渲染器与样式是 `web/` 下的只读副本，未改站点仓库。启动时自动重建 171 个页面。
  与原构建器同时间点对比：共同 171 个文件，`data.json` 顶层字段一致，0 警告；
  唯一差异是 3 个「纯 git 提交日」页面消失（学习日 27 → 24），符合 `sessions.date` 口径。
- **P3 闭环**：不实现录入界面（设计 §11 范围外）。已打通「改库 → 同步 JSON → 重建站点」：
  `scripts/sync.sh` 串联两个导出器，`./dev.sh` 启动前自动执行。
  `node scripts/verify-loopback.mjs` 用临时判定改动验证站点统计跟着变，再完整恢复；
  恢复后 `verify.py` 40 项、`smoke-test.mjs` 19 项仍全过。
- v1 设计文档（Markdown 真源方案）已**原样归档**：[archive/2026-11-11-v1/](archive/2026-11-11-v1/)，含 `01`–`07` 七份文档与旧 README 副本。归档是历史快照，未改动内容；其中的相对链接请以归档目录内文件为准。
- 原仓库 `/Users/geyuqi/WorkBuddy/mem/` 全程只读，基线 commit `ad4f3ff`，工作区干净。
- **P4 已上线**：<https://geyuqi.me/study/>（页面）与 `/api/*`（只读接口）。
  线上细节见 [deploy/README.md](deploy/README.md)；服务器脚本副本在 [deploy/](deploy/)。
  站点仓库 `/Users/geyuqi/Documents/aliyun/myWebsite/` **一行未改**，线上仍用它的渲染器与样式。

## v1 → v2 的关键变化

| 项 | v1 | v2 |
|---|---|---|
| 真源 | Markdown 文件 | SQL 数据库 |
| 表数 | 7~9 张 + 运维层 | 4 张：`papers` / `questions` / `sessions` / `attempts` |
| 一致性 | hash 链 / snapshot / 三层校验 / 发布闸门 | 事务 + 外键 + CHECK + 唯一约束 + 导出前对账 |
| 录入 | 写 md → git commit → 重建 | 直接写库 |
| 站点 | 读导出的 `index.json` | 不变，仍读导出的 `index.json` |
| 文档量 | 7 份约 1400 行 | 1 份数据模型文档 |

## 口径决定（已定）

1. **站点数据源**：三份契约 `index.json` / `content.json`（题干与批改全文）/ `volumes.json` 已取代 `git show HEAD:` 与 `git log`。学习日与热力图改由 `sessions.date` 驱动，`commits` 恒为 0。
2. **数据库选型**：SQLite + WAL（`data/mem.db`）；多用户并发写时再评估 PostgreSQL。
3. **录入界面**：按设计 §11 保持范围外，不实现 Web 表单与写接口；日常写库用脚本 / sqlite3 CLI，改完 `./scripts/push-data.sh` 推到线上。

## 本地开发架构（已定）

- **一个语言**：Node 22。服务器不引入 Python，也不新增 npm 包（本机实测 `node:sqlite` 可直读 `mem.db`）。
- **两种运行模式**：本地 `./dev.sh` 一个进程同时提供 `/api/*` 与 `/study/` 页面；
  线上把两者拆开——页面是静态产物（nginx 直接发文件），`/api/*` 由常驻的 `mem-api.service` 反代，
  两者共用同一份渲染器代码（服务器上 `/www/builder/web/render` 软链到站点仓库）。
- **数据链路**：`mem.db`（真源） → `sync.sh` → 三份 JSON → `build-site.mjs` → `web/.build/`。
- **Python 只做离线工具**：`scripts/*.py` 仅在本机跑迁移 / 导出 / 核对，不进服务器运行时；
  `dev.sh` 启动时会调用 `sync.sh`，这是开发便利而非运行时依赖（`SKIP_SYNC=1` 可跳过）。
- **范围**：P4 之前不改 `myWebsite` 仓库、不部署、不 push、服务只监听 `127.0.0.1`。

## 改数据后怎么让站点更新

数据库是真源，页面读的是三份导出 JSON。直接改库后：

```bash
./scripts/sync.sh      # 库 → index.json / content.json（本机离线工具）
Ctrl+C && ./dev.sh     # 自动同步 + 重建 171 个页面 + 起服务
```

`./dev.sh` 启动前已默认执行同步。闭环验证用 `node scripts/verify-loopback.mjs`
（需先停服务，会临时改一条判定并完整恢复）。服务器走静态产物，不需要 Python、不需要 `sync.sh`。

## 日常操作

改完数据 → 推到线上（一条命令）：

```bash
./scripts/push-data.sh
```

本地开发：`./dev.sh`（自动同步 + 构建 + 起服务），`node server/smoke-test.mjs` 自测。
线上运维、回滚、整体退回旧架构：见 [deploy/README.md](deploy/README.md)。

## 待办

1. 页面文案里「提交」相关字样（热力图 tooltip / 说明）仍是旧口径（`commits=0` 后应改成「学习」）；当前为保持与站点一致未改。
2. `/www/mem` 旧数据仓库线上已不再拉取，可在确认无回滚需求后归档。
3. `export_content.py` 会读原 `mem` 仓库逐字节校验还原结果；若原仓库移走，需把该校验改为可选。
4. 核对报告「设计稿与基线数据的偏差」三节，仍需确认口径。
