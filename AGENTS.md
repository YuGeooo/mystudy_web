# AGENTS.md

本仓库是 **MEM 学习记录系统的工程空间**（v2），不是学习内容仓库。
一句话分工：**代码与运维在这里，学习内容在线上 SQLite 里，内容侧的只读历史仓库是 `../mem`，人写总结在 `../mem_study`。**

给 agent 的三条总纲：

1. **数据只能经接口改**——`mem` 命令行或 `/api/*`，不要直接 `sqlite3` 写库。
2. **线上是唯一的生产真源**——动线上（部署 / 推数据 / 恢复）必须先得到用户明确同意。
3. **改完代码要过 `npm test`**——仓库没有 CI，这道关是手动的。

## 1. 这个仓库由什么组成

| 目录 | 是什么 | 能不能改 |
|---|---|---|
| `server/` | Node 22 服务：`dev.mjs` 入口 · `pages.mjs` 内存页表 · `routes.mjs` 分发 · `read-api.mjs` / `write.mjs` / `catalog.mjs` 数据 · `export.mjs` 导出 · `backup.mjs` 快照 · `sqlrun.mjs` / `sql.mjs` 只读 SQL | 可以，改完跑测试 |
| `web/render/` | 站点渲染器与 `assets/app.css`。来源是站点仓库 `~/Documents/aliyun/myWebsite/` 的副本；两处分叉：`renderSite()` 多一个 `emit` 参数、新增 `paper.mjs`（试卷页，KaTeX 在服务端出公式） | 谨慎：默认行为必须保持不变 |
| `scripts/` | 迁移 / 导出 / 核对（Python，**只在本机跑**）+ 启动、同步、备份、恢复、测试（sh） | 可以 |
| `deploy/` | systemd unit、nginx 之外的部署脚本、`config.server.json` | 可以，但生效需重新部署 |
| `bin/mem` | 日常命令行 | 可以 |
| `data/` | `mem.db` + 导出物 `index.json` / `content.json`（知识树与卷清单 2026-11-12 起在库里） | **只在 `data/test.db` 上自由折腾** |
| `archive/` | v1 设计文档原样归档（8 份） | **不改**，历史快照 |
| `doc/` | 数据模型、API 契约、CLI 手册、迁移报告 | 可以，改实现要同步改这里 |

两个必须知道的事实：

- **`data/mem.db` 与三份 JSON 全在 `.gitignore` 里。** clone 下来是空壳，新机器要先 `./scripts/pull-data.sh` 或 `./scripts/restore.sh <备份目录>`。
- **`../mem` 是内容侧的只读仓库**（基线 `ad4f3ff`，工作区干净）。它保存着迁移前的 Markdown 原文与 `data/index.json` 基线，`scripts/memdb.py` 的 `SRC` 指向它做逐字节比对。**不要在那里新增或修改内容**——会和线上真源分叉。
- **`../mem_study` 是学习空间**（总结、生词本、草稿），归用户自己用，本仓库不管它；要查它在写什么，直接读那个目录。

## 2. 硬边界

| 操作 | 结论 |
|---|---|
| `mem ...` 查询、`GET /api/*`、读代码、跑测试、改文档 | 允许，直接做 |
| 改 `server/` `web/` `scripts/` 代码并跑 `npm test` | 允许，直接做 |
| 通过 `mem` / 写接口改数据（本机 `--test`、线上默认目标） | 允许，先查 id 再写，写完回读 |
| 直接 `sqlite3 data/mem.db "UPDATE ..."` | 禁止：绕过事务、写前快照与页表重建，页面会与库脱节 |
| 手改 `data/index.json` / `content.json` | 禁止：派生物，下次导出就覆盖；要改就改库再导出 |
| 在 `../mem` 里写新内容 | 禁止：双源分叉，v2 的设计前提就是那边只读 |
| `./deploy/deploy-api.sh`、`./deploy/deploy.sh`、`./scripts/push-data.sh`、`./scripts/restore.sh` | 需用户明确同意：动线上或改数据方向 |
| `npm run site` | 允许：只写本地 `web/.build/`，离线预览与回滚兜底用 |
| 删 `data/mem.db` | 禁止：它是测试夹具的来源（`test.sh` 从这里 `sqlite3 .backup` 出 `test.db`） |
| 把 `MEM_WRITE_TOKEN` 写进配置文件或提交 | 禁止：token 只在 `~/.mem-api-token` 或环境变量里 |
| 删 `data/test.db`、`data/test-backups/`、`web/.build/` | 允许：测试产物，可随时删，下次自动重建 |

## 3. 学习类操作：只走 `mem` CLI

`bin/mem` 已软链到 `/opt/homebrew/bin/mem`；不装就把下文 `mem` 换成 `./bin/mem`。

| 目标 | 参数 | 说明 |
|---|---|---|
| 线上（默认） | 无 | `https://geyuqi.me`，**唯一可写的生产库** |
| 本机 | `--local` | `127.0.0.1:8137`，`config.local.json` 是 `readOnly: true`，写会 404 |
| 测试库 | `--test` | `127.0.0.1:8138`，指向 `data/test.db`，可写，随便试 |

**Agent 四条铁律**（违反任何一条都会出静默错误）：

1. 一律加 `--json`，解析 stdout，不要正则人话输出。
2. 写之前先查 id：`mem q ls --paper <slug> --search <关键词> --json`，从返回里取 `questionId` / `sessionId`，**不要自己拼 id**。
3. 只读可以 `--local`；**写只用默认线上，绝不加 `--local`**。
4. 4xx 不重试，按 `code` 处理；写完用 `mem s get <id> --json` 回读确认。

常用命令：

```bash
mem health                                     # 服务 + 页表版本
mem s ls --limit 5                             # 最近 5 场
mem q ls --paper 2024-exam --search 不定方程     # 查题
mem s get 2024-exam-a12 --process              # 场次 + 逐题判定 + 推演全文
mem redo                                       # 待重做台账
mem a set <attemptId> correct=true errorTag=审题  # 补判定 / 标错因
mem a done <attemptId>                         # 重做销账（判定必须是「对」）
```

**长文本别塞命令行。** 批改全文（推演、订正、评语）落在作答的 `process` 字段（库列 `process_md`），整场正文落在 `fullText`，都用 `--file` 传 JSON：

```bash
mem s new session.json        # 记一场：单事务，写前自动快照
mem q set 2024-exam-q001 --file patch.json
```

字段白名单（哪些字段可改、`k=v` 的类型还原规则）见 [doc/cli.md](doc/cli.md) §5；错误码表见同文档 §7。**不要在这里复述，也不要凭记忆猜字段名。**

### 统计与聚合：`mem sql`（只读）

要跨表、聚合、排序的看数，直接写 SQL，不要为一个统计去加命令，也不要自己起服务算：

```bash
mem sql "select q.topic, count(*) n from attempts a join questions q on q.id=a.question_id group by 1"
mem sql --http "..."        # 不 SSH，打 POST /api/sql（需 token，~35ms）
mem sql --json "..."        # {ok, columns, rows, count, truncated, ms}
mem schema                  # 字段名先查，不要猜
```

- 只读硬闸：单条语句、只读关键字、行数上限 1000、20s 超时（`server/sqlrun.mjs`）。
- 三条传输方式，同一个执行器：默认 SSH 到服务器；`--http` 打 `/api/sql`（换机器没配密钥时用这个）；
  `--local` 读本机库文件 `data/mem.db`（**不**连 8137，也不需要起服务）。
- `/api/sql` 也要 Bearer token（能一次导走整库），且语句在子进程里跑——同步驱动卡不住页面服务。
- 写完 `INSERT/UPDATE` 那条路仍然只有 `mem a set` / `mem s new`：直接改库会绕过快照和页表重建。
- 现成查询与口径（`correct` 三态、`topic` 在哪张表）见 [doc/sql.md](doc/sql.md)，那里每条 SQL 都由 `server/test-sql.mjs` 实际跑过。

> **批改口径不在本文件。** 判定表三段式、错因标签、文风这些内容规范仍在 [`../mem_study/AGENTS.md`](../mem_study/AGENTS.md)——那边管"写成什么样"，这边管"怎么落库"。做批改时先按那边的规范写出正文，再用 `process` / `fullText` 写进库，两边不要互相复制。

## 4. 改代码的流程

```bash
npm run dev        # 预检 → sync.sh 导出 JSON → 起 8137（只读）
npm test           # 预检 → 语法 → 导出等价 → SQL 32 → 写接口 122 → CLI 33 → 只读 20
npm run check      # 只查语法（36 个 .mjs + 15 个 .sh）
```

- `npm test` 全程跑在 `data/test.db` 上，跑前后比对 `data/mem.db` 与 `data/index.json` 的 sha256 + mtime，一致才算绿。
- 只读回归不依赖常驻服务：`test.sh` 发现 8137 没起会临时起一个，跑完自动停。8138 被占用则直接报错退出，先 `kill $(lsof -tiTCP:8138 -sTCP:LISTEN)`。
- 提交钩子：`./scripts/install-hooks.sh`（`core.hooksPath=scripts/hooks`）。pre-commit **刻意不跑测试**——进程里跑的是旧代码，绿是假绿。只要 `git commit --no-verify` 过，事后必须补跑 `npm test`。
- 改 `write.mjs` / `export.mjs` / `pages.mjs` 属于高危改动：`notes` / `note` 是 JSON 信封，导出器按键名取值；`content.json` 依赖 `FULLTEXT_MARK`（`===== 场次全文：`）复原原文页。改这几处必须同时验证站点页面与 `scripts/compare-export.mjs`。

## 5. 部署与数据运维（都要先问）

| 脚本 | 做什么 | 风险 |
|---|---|---|
| `./deploy/deploy-api.sh` | 只传 `server/*.mjs` 并重启 `mem-api.service` | 不碰数据与配置，低 |
| `./deploy/deploy.sh` | 完整部署 | 中 |
| `./scripts/pull-data.sh` | 线上 → 本机（先给本机现状打快照） | 低，安全方向 |
| `FORCE=1 ./scripts/push-data.sh` | 本机覆盖线上 | **高，会冲掉线上新记录** |
| `./scripts/backup.sh` / `./scripts/restore.sh <目录>` | 手动快照 / 恢复 | 恢复会先另存 `*-before-restore`；8137 在跑直接拒绝，加 `FORCE=1` 才继续 |
| `./scripts/sync.sh` | 库 → 三份 JSON 契约 | 低；刷新对外契约与备份。页面已直连库，不再依赖它 |

线上形态：nginx 反代 → `mem-api.service`（Node 22，`127.0.0.1:8137`）；页表在进程内，渲染输入直接从库构造（导出 JSON 只作对外契约与备份），写成功后重建（40~230 ms），无定时任务；`mem-backup.timer` 每天 03:30 备份 `mem.db` + 三份 JSON 到 `/www/backup/`，保留 14 天。运维细节见 [deploy/README.md](deploy/README.md)。

## 6. 想知道什么看哪里

| 问题 | 文档 |
|---|---|
| 项目现状、运行架构、工程化决策 | [README.md](README.md) |
| 4 张表怎么设计的、字段语义 | [doc/database-design.md](doc/database-design.md) |
| 接口契约、三道闸门、错误码 | [doc/api-design.md](doc/api-design.md) |
| 命令行怎么用、字段白名单 | [doc/cli.md](doc/cli.md) |
| 想直接写 SQL 统计、表结构速查 | [doc/sql.md](doc/sql.md) |
| 迁移做了什么、40 项核对结果 | [doc/migration-report.md](doc/migration-report.md) |
| 线上目录、回滚、退回旧架构 | [deploy/README.md](deploy/README.md) |
| v1 是怎么设计的（历史） | [archive/2026-11-11-v1/](archive/2026-11-11-v1/) |

## 7. 文风与提交

- 中文为主，中英文之间加空格；公式用 LaTeX。
- 直接说结论与错在哪一步，**不编造数据、判定或分数**，不空泛鼓励。
- 写进文档的每一条命令都要真跑过；没跑过的写"未验证"。
- 提交信息中文、动词开头（`添加…` / `修正…` / `重构…`），**一次提交只做一类事**。
- **push 由用户明确要求后再执行。** 本仓库目前没有 remote。

## 8. 常见坑

| 现象 | 原因 / 处理 |
|---|---|
| 改了库，页面没变 | 现在会自动跟上：下次请求比对库文件指纹即重建。sync.sh 只用于刷新导出契约 |
| 写接口 404 | 目标配错：`--local` 打到了只读进程；写只能打线上 |
| 写接口 401 | token 缺失或不匹配：检查 `~/.mem-api-token` / `MEM_WRITE_TOKEN`（≥16 字符） |
| 写入报 `invalid_field` | 字段值不合法，按 `error` 文案改，**不要原样重试** |
| 销账报 `not_yet_correct` | 先 `mem a set <id> correct=true`（真做对了再改） |
| 删最后一条作答报 `last_attempt` | 改删整场（`mem s rm`），或先补一条 |
| `npm test` 卡在 8138 | 有残留进程：`kill $(lsof -tiTCP:8138 -sTCP:LISTEN)` |
| `mem sql --http` 报 401 | token 缺失或不匹配：`~/.mem-api-token` / `MEM_WRITE_TOKEN` / `--token` |
| 页面文案还写着"提交"、`commits` 恒为 0 | 已知遗留口径（热力图改由 `sessions.date` 驱动），与站点保持一致，**不要单方面改文案** |
| 新机器起不来 `ERR_MODULE_NOT_FOUND` | 先 `npm ci`，再 `./scripts/preflight.sh` 看缺哪一步 |
| 试卷页公式变成乱码或双份 | 缺 `web/assets/katex/katex.min.css`（页面没引到样式）：确认 `npm ci` 过、`web/assets/katex` 在，重新部署 |
| 试卷页 500 / 页表少 8 页 | 缺 `node_modules/katex`：试卷页在渲染阶段就要用它，`npm ci` 后重启进程 |
