# mem_web

MEM 项目重构工作区（原名 `mem_new`，2026-11-11 改为 `mem_web`）。**SQL 数据库是唯一真源**；Markdown 完成一次性导入后归档只读。数据迁移（P0）、本地服务（P1）、本地站点（P2）、改库闭环（P3）、线上部署（P4）与写接口（P5）均已跑通，写接口已在线上开启（Bearer token + 限流 + 写前自动快照）。**页面由常驻 Node 进程实时渲染**，写完立刻可见。线上：<https://geyuqi.me/study/>。

协作约定（agent 必读）：[AGENTS.md](AGENTS.md)——边界、`mem` CLI 铁律、测试与部署门槛。

## 当前状态

- 数据模型：[doc/database-design.md](doc/database-design.md)（v2，4 张表，设计稿）
- **已迁移**：[data/mem.db](data/mem.db)（SQLite + WAL，4 表 7 / 328 / 40 / 317 行）。
  [核对报告](doc/migration-report.md)：40 项全通过，导出的 [data/index.json](data/index.json)
  与 `ad4f3ff` 基线逐字段零差异（仅 `meta.generatedAt` / `generator` 两行不同）。
- 实现：`scripts/schema.sql`（DDL + 索引）、`migrate.py`（一次性只读导入）、
  `export_index.py` / `export_content.py`（数据库 → JSON 契约）、`verify.py`（核对 + 生成报告）、
  `sync.sh`（串联导出）、`verify-loopback.mjs`（闭环验证）。
  服务端：`server/dev.mjs`（入口）、`pages.mjs`（内存页表 + 请求处理）、
  `build-site.mjs`（渲染）、`routes.mjs`（分发）、`read-api.mjs` / `write.mjs` / `catalog.mjs`（数据）、
  `export.mjs`（Node 版导出器）、`backup.mjs`（写前快照）。
- **P1 本地服务**：`./dev.sh` 起 `http://127.0.0.1:8137`。零框架，第三方依赖只有一个 `marked`，
  其余全是 Node 22 标准库（`node:http` + `node:sqlite`），数据库只读。
  端点 `/api/health` / `/api/meta` / `/api/days`；`node server/smoke-test.mjs` 自测 19 项全通过。
  代码在 `server/`，配置在 `config.local.json`。
- **P2 本地站点**：`http://127.0.0.1:8137/study/`。三份数据契约：`index.json`、
  `content.json`（`scripts/export_content.py` 从库里还原 48 份 Markdown 全文）、`volumes.json`。
  渲染器与样式是 `web/` 下的副本。**页面按请求在进程内渲染**（171 页常驻内存，首次 74ms）。
  与原构建器同时间点对比：共同 171 个文件，`data.json` 顶层字段一致，0 警告；
  唯一差异是 3 个「纯 git 提交日」页面消失（学习日 27 → 24），符合 `sessions.date` 口径。
- **P3 闭环**：不实现录入界面（设计 §11 范围外）。已打通「改库 → 同步 JSON → 重建站点」：
  `scripts/sync.sh` 串联两个导出器，`./dev.sh` 启动前自动执行。
  `node scripts/verify-loopback.mjs` 用临时判定改动验证站点统计跟着变，再完整恢复；
  恢复后 `verify.py` 40 项、`smoke-test.mjs` 19 项仍全过。
- v1 设计文档（Markdown 真源方案）已**原样归档**：[archive/2026-11-11-v1/](archive/2026-11-11-v1/)，含 `01`–`07` 七份文档与旧 README 副本。归档是历史快照，未改动内容；其中的相对链接请以归档目录内文件为准。
- 原仓库 `/Users/geyuqi/WorkBuddy/mem/` 全程只读，基线 commit `ad4f3ff`，工作区干净。
  学习空间另开在 `../mem_study/`（只放总结、生词本、草稿；数据仍走 `mem` 命令行与线上库）。
- **P4 已上线**：<https://geyuqi.me/study/>（页面）与 `/api/*`（读写接口）。
  线上细节见 [deploy/README.md](deploy/README.md)；服务器脚本副本在 [deploy/](deploy/)。
- **P5 已开启**：线上 `mem-api.service` 以写模式运行，写接口需 `Authorization: Bearer <token>`
  （token 存在服务器 `/www/api/mem-api.env`，本机副本 `~/.mem-api-token`）。
  写成功后自动重导 `index.json` / `content.json`，并在同一进程内重建页表——
  **响应返回时页面已经是新的**，没有定时任务、没有等待窗口。
  **线上是可写入的那一份真源**，本机用 `./scripts/pull-data.sh` 拉回做副本。
  站点仓库 `/Users/geyuqi/Documents/aliyun/myWebsite/` **一行未改**；`web/render/` 是它的副本，
  唯一的分叉是 `renderSite()` 多了一个 `emit` 参数（支持渲染到内存），默认行为不变。
- **加固**：本仓库已纳入 git（`data/mem.db` 与导出 JSON 不入库，见 `.gitignore`）；
  线上 `mem-backup.timer` 每天 03:30 备份 `mem.db` 与三份 JSON 到 `/www/backup/`，保留 14 天，备份后自动校验。
- **日常入口**：`bin/mem` 命令行（查询 / 录入 / 订正 / 销账 / 题库 / 快照），
  说明见 [doc/cli.md](doc/cli.md)；`node server/test-cli.mjs` 21 项验收。

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
3. **录入方式**：不做 Web 表单（设计 §11 范围外），但提供受控写接口（P5，线上已开启、需 token）。不在电脑前用 `curl` 直接写线上；在电脑前也可以改完本机库再 `FORCE=1 ./scripts/push-data.sh` 覆盖线上（应急手段）。
4. **写接口的安全边界**：三道闸门（配置开启 + Bearer token + 连接可写），任一缺失则不注册或拒绝启动；线上三道全开，另加 nginx 限流 5r/s、请求体 2 MB 上限。

## 运行架构（已定）

**一个常驻 Node 进程同时提供页面与接口**，nginx 只做反向代理，不再有静态构建产物这一层。

```
浏览器 ──▶ nginx ──▶ mem-api.service (Node 22, 127.0.0.1:8137)
                       ├─ /study/*  → 页表（内存中的 171 个页面）
                       └─ /api/*    → 读写 SQLite
                                    写成功 → 重导 JSON → 重建页表 → 下一次请求就是新页面
```

- **一个语言**：Node 22。服务器不引入 Python；第三方依赖只有一个 `marked`（版本锁在
  `package-lock.json`），其余全是标准库（`node:sqlite` 直读 `mem.db`）。
- **页面渲染**：`server/pages.mjs` 在进程内维护一张 `Map<路径, HTML>`。启动渲染一次；
  每次写库成功后重建一次（线上实测 40~162ms）；跨天自动重算「今天/倒计时」。
  请求命中内存直接返回，带 ETag，条件请求走 304。
- **为什么不再用静态产物**：静态 HTML 只能在「构建那一刻」反映数据，写完必须再跑一次构建，
  而构建由 systemd timer 轮询触发，最坏要等一个周期。改成运行时渲染后，
  写接口的响应返回时页面已经是新的，没有等待窗口、没有定时任务。
- **代价**：页面可用性绑在这个进程上（以前 Node 挂了静态文件还能看）。
  缓解：`Restart=on-failure`；重建失败保留上一版页表，宁可发旧页面也不白屏。
- **数据链路**：`mem.db`（真源） → `export.mjs` → 三份 JSON → 渲染器 → 内存页表。
  JSON 契约仍然保留：它是渲染的输入，也是外部工具与离线查看的出口。
- **静态构建仍可用**：`node server/build-site.mjs` 写盘到 `web/.build/`（服务器上由
  `/www/builder/build-release.sh` 产出 `/www/releases/<TS>`），仅作回滚兜底，线上不再读取。
- **Python 只做离线工具**：`scripts/*.py` 仅在本机跑迁移 / 导出 / 核对，不进服务器运行时；
  `dev.sh` 启动时会调用 `sync.sh`，这是开发便利而非运行时依赖（`SKIP_SYNC=1` 可跳过）。
- **安全边界**：服务只监听 `127.0.0.1`，公网暴露由 nginx 承担；写接口三道闸门 + 限流。

## 工程化

### 依赖政策：零框架 + 一个三方依赖

| 框架通常负责的事 | 这里的替代 |
|---|---|
| 前端框架（React/Vue/Svelte） | 不用。页面是模板字符串拼出的 HTML，浏览器端 **0 个 JS 文件** |
| 后端框架（Express/Koa/Fastify） | 不用。`node:http` + `server/routes.mjs` 手写路由分发 |
| 模板引擎（EJS/Pug） | 不用。模板字面量 + helper 函数 |
| ORM | 不用。`node:sqlite` + 手写 SQL |
| 打包器（Vite/Webpack） | 不用。CSS 是预编译好的 `web/assets/app.css` |
| 唯一三方依赖 | `marked` 18.1.3（92 KB，零子依赖）——试卷 Markdown 转 HTML |

**判断标准**：只有当「客户端交互状态」「多用户认证」「多人同时改前端」三者之一真实出现时，
才值得引入框架。目前三者都没有，加框架是净负担（省约 500 行、重写 3000 行）。

### 首次安装

```bash
npm ci                   # 按 package-lock.json 精确安装（只有 marked）
./scripts/preflight.sh   # 环境自检：Node 版本 / 依赖 / 渲染器能否加载 / 数据文件
```

`data/mem.db` 是二进制、不入版本库，新机器上要 `./scripts/pull-data.sh` 从线上取回
（或 `./scripts/restore.sh <备份目录>`）。预检会明确告诉你缺哪一步，而不是让 Node 抛
`ERR_MODULE_NOT_FOUND`。

### 命令

| 命令 | 作用 |
|---|---|
| `npm run dev` | 预检 → 同步 JSON → 起服务（等价 `./dev.sh`） |
| `npm test` | 全量：预检 → 语法 → 导出等价 → SQL 27 → 写接口 108 → CLI 27 → 只读 19 |
| `npm run check` | 只做语法检查（34 个 `.mjs` + 15 个 `.sh`，含 `bin/mem`） |
| `npm run site` | 静态构建到 `web/.build/`（离线预览与回滚兜底） |

写接口测试全程跑在 `data/test.db` 上，跑前后比对 `data/mem.db` 与 `data/index.json` 的
sha256 + mtime，一致才通过。只读回归**不依赖常驻服务**：`test.sh` 发现 8137 没起会临时起一个，
跑完自动停（`SKIP_SMOKE=1` 可整段跳过）。

`data/test.db` 与 `data/test-backups/` 都是测试产物，可随时删（约 24 MB），下次跑测试会重建。
本机 `data/mem.db` 是测试夹具的来源，不能删。

### 提交钩子

```bash
./scripts/install-hooks.sh   # 设置 core.hooksPath = scripts/hooks
```

`pre-commit` 只做三件几秒内能完成的事：改动文件的语法检查、`package.json` 与锁文件是否同步、
动了写库/渲染代码时提醒跑完整测试。

**刻意不自动跑测试**：pre-commit 里跑的测试用的是已在运行的进程（旧代码），绿是假绿。
紧急情况 `git commit --no-verify` 可跳过，但请随后补跑。

### 版本约束

`.nvmrc` 写 22；`package.json` 声明 `engines.node >= 22.5`（`node:sqlite` 的门槛）。
`scripts/preflight.sh` 做硬检查——不满足就拒绝启动，避免"起来了但某些接口莫名报错"。

### 暂不接 CI（原因）

代码托管还没有远程仓库，更重要的是：测试依赖 `data/mem.db`（二进制、不入版本库），
CI 上没有这份数据就跑不了写接口测试。真要接，得先造一份可以提交的夹具库
（几十行假数据 + 对应 JSON 契约），让 `test.sh` 能在一台干净机器上自洽运行。
在那之前，`npm test` 是一道手动关卡，pre-commit 只兜语法与锁文件。

## 改数据后怎么让站点更新

**不需要做任何事。** 写完就是最新的：写接口在同一个请求里重导 JSON、重建页表，
响应返回时页面已经变了。线上实测从发请求到 `curl` 到新页面约 80ms。

跨天也不用管：页面里的「今天」「倒计时天数」按请求时的日期判断，日期一变自动重渲染。

只有一种情况要手动介入——你直接改了库（绕过写接口）：

```bash
# 本机
./scripts/sync.sh          # 导出 JSON；进程下次请求会发现契约变了并重建页表
# 线上
mem export
```

`POST /api/export` 会把库重新导成 JSON 并重建页表。

本机开发：

```bash
./scripts/sync.sh      # 库 → index.json / content.json（本机离线工具）
Ctrl+C && ./dev.sh     # 自动同步 + 渲染 171 个页面到内存 + 起服务
```

`./dev.sh` 启动前已默认执行同步。就算忘了重启，`sync.sh` 写完 JSON 后进程会在下一次
页面请求时自己发现文件变了并重建（`reason: contracts-changed`）。
闭环验证用 `node scripts/verify-loopback.mjs`（需先停服务，会临时改一条判定并完整恢复）。

## 写接口（P5）

设计文档 §11 把「录入 UI」列在范围外，但「不在电脑前想补一条记录」是真实需求，所以提供受控 API 而不是表单页面。

| 项 | 说明 |
|---|---|
| 契约 | [doc/api-design.md](doc/api-design.md) |
| 写入 | 增 `POST /api/sessions`（场次+逐题，单事务）· 改 `PATCH /api/sessions/:id`（日期/时长/备注/文件路径/正文）· 补 `POST /api/sessions/:id/attempts` · 删 `DELETE /api/sessions/:id` / `DELETE /api/attempts/:id`（最后一条不许删） |
| 判定 | `PATCH /api/attempts/:id` · `POST /api/attempts/:id/resolve` |
| 题库 | `POST/PATCH/DELETE /api/papers[/:slug]` · `POST/PATCH/DELETE /api/questions[/:id]`（知识点、原文页、删除引用都有校验） |
| 备份 | 写库前自动快照 · `GET /api/backups` 列快照 · `POST /api/backups` 手动打一份 |
| 导出 | `POST /api/export`（Node 版导出器，服务器不需要 Python） |
| 只读补充 | `/api/papers` · `/api/questions`（含题干全文检索）· `/api/sessions` · `/api/attempts` · `/api/attempts/:id` · `/api/redo` |
| 开关 | `write.enabled=true` + `MEM_WRITE_TOKEN`（≥16 字符）+ 连接可写，缺一不可 |
| 线上 | 已开启（`deploy/config.server.json`，token 在 `/www/api/mem-api.env`） |
| 本机 | `config.local.json` 关闭（8137 只读）；`config.test.json` 开启（8138，指向 `data/test.db`） |

验证（不碰正式库）：

```bash
node server/test-write-api.mjs    # 108 项：鉴权/创建/校验/事务性/订正/销账/场次订正/单题增删/题库读写/备份/导出/正式库保护
node scripts/compare-export.mjs   # Node 导出器 vs Python 导出器，字段值与键顺序逐项比对
```

`test-write-api.mjs` 用 `sqlite3 .backup` 从 `mem.db` 只读复制出 `data/test.db`，
跑前记录正式库与 `data/index.json` 的 sha256 + mtime，跑完复查一致才通过。

## 日常使用（mem 命令行）

部署是低频动作；每天发生的是查题、补判定、记一场、标重做。这些用 `bin/mem`，不手写 `curl`。
完整说明与字段表见 **[doc/cli.md](doc/cli.md)**，这里只放最常用的。

```bash
ln -sf "$PWD/bin/mem" /opt/homebrew/bin/mem  # 装一次（任意 PATH 里可写的目录）

mem health                                    # 服务 + 页表状态
mem s ls --limit 5                            # 最近 5 场
mem q ls --paper 2024-exam --search 不定方程   # 查题（题干全文检索）
mem s get 2024-exam-a12                       # 场次 + 逐题判定
mem redo                                      # 待重做台账

mem s new session.json                        # 记一场（单事务，写前自动快照）
mem a set <attemptId> correct=true errorTag=审题
mem a done <attemptId>                        # 重做销账
mem q set 2024-exam-q001 answer=E
```

默认打线上（`https://geyuqi.me`）；`--local` 打本机只读实例，`--test` 打 8138 测试库。
写操作要 token（`~/.mem-api-token` 或 `MEM_WRITE_TOKEN`），缺失时 CLI 在本地就拦住。
`--json` 给脚本与 Agent 用，`--dry-run` 只打印请求不发送；退出码固定为 0 成功 / 1 请求失败 / 2 用法错误。
Agent 的操作约定与错误码表在 [doc/cli.md §7](doc/cli.md)。

### 预设命令不够就用 SQL

按知识点算正确率、看某题历次判定、找错了两次还标着重做的题——这些写一条 SQL 比加一个命令快。
完整查询集与边界说明见 **[doc/sql.md](doc/sql.md)**（那里的每条 SQL 都由 `server/test-sql.mjs` 实际执行校验）。

```bash
mem sql "select topic, count(*) n, round(100.0*sum(correct)/count(*),1) rate
         from attempts join questions q on q.id=attempts.question_id
         where correct is not null group by topic order by n desc"
mem sql --csv "..." > out.csv     # 导出 CSV；--json 给 Agent
mem schema                        # 4 张表全字段
mem pull                          # 拉线上库到本机，之后可直接 sqlite3 data/mem.db
```

SQLite 没有网络协议，所以「直连」= SSH 到数据所在的机器上执行 `server/sqlrun.mjs`
（`ControlMaster` 复用连接，首次 ~0.5s、之后 ~0.17s）。执行器**只读**：单条语句、只读关键字、
行数上限、服务器端 20s 超时。写数据仍走 API，否则会绕过快照和页表重建。

验证：`node server/test-cli.mjs`（27 项，跑在 `data/test.db` 上，正式库 sha256 前后比对）、
`node server/test-sql.mjs`（27 项，只读闸门 + 文档里的 SQL 全跑一遍）。

## 备份与恢复

改数据有退路，分四层，越往下越保命：

| 层 | 触发 | 位置 | 保留 |
|---|---|---|---|
| 线上写前快照 | 每次调写接口之前**自动** | 服务器 `/www/data/backups/<TS>-<方法>-<资源>/` | 最近 20 份（`backup.keep`） |
| 本机写前快照 | 本机测试库写接口之前自动 | 本机 `data/test-backups/` | 5 份 |
| 本机手动备份 | `./scripts/backup.sh` | 本机 `backups/<TS>-manual/` | 最近 30 份（`KEEP=30` 可改） |
| 线上每日备份 | 每天 03:30（`mem-backup.timer`） | 服务器 `/www/backup/<YYYYMMDD>/` | 14 天 |
| 线上页面版本 | 每次构建 | `/www/releases/<TS>` | 最近 5 份 |

一份快照就是一个目录：`mem.db`（SQLite `VACUUM INTO` 出来的一致性副本，WAL 也带上）+
`volumes.json`（知识树不在库里，单独留）+ `meta.json`（时间、四表行数、sha256）。

```bash
./scripts/backup.sh                                  # 手动备一份
mem backups                                          # 看线上有哪些快照
./scripts/restore.sh backups/20261111-193012-post-questions
./scripts/restore.sh <目录> --volumes                # 连知识树一起退回
```

恢复有三道保险：先校验备份完整性；当前库先另存 `*-before-restore`（恢复也能反悔）；
8137 有服务在跑时直接拒绝（进程握着旧文件句柄，换文件等于白换），确认无妨加 `FORCE=1`。
恢复完自动跑 `sync.sh` 重建 JSON 契约。

## 日常操作

线上是写入真源，本机是副本。把线上最新状态同步回本机：

```bash
./scripts/pull-data.sh        # 线上 → 本机（先自动给本机现状打一份快照）
```

反过来用本机覆盖线上是应急手段（会把线上新记录冲掉），必须显式确认：

```bash
FORCE=1 ./scripts/push-data.sh
```

改线上代码后重新部署 API：`./deploy/deploy-api.sh`（只传 `server/*.mjs`，不碰数据与配置）。

本地开发：`./dev.sh`（自动同步 + 构建 + 起服务，只读），`node server/smoke-test.mjs` 自测。
线上运维、回滚、整体退回旧架构：见 [deploy/README.md](deploy/README.md)。

## 待办

1. 页面文案里「提交」相关字样（热力图 tooltip / 说明）仍是旧口径（`commits=0` 后应改成「学习」）；当前为保持与站点一致未改。
2. `/www/mem` 旧数据仓库线上已不再拉取，可在确认无回滚需求后归档。
3. `export_content.py` 现在支持 `--db` / `--out` / `--no-verify-src`：原仓库归档后加 `--no-verify-src` 即可跳过逐字节比对。
4. 核对报告「设计稿与基线数据的偏差」三节，仍需确认口径。
5. 线上写接口没有录入界面，现在用 `bin/mem`（见 [doc/cli.md](doc/cli.md)）。要更顺手可以做一个只读页面级的「快速记一场」表单，直连 `/api/sessions`（token 存在浏览器本地）。
