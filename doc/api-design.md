# 写接口设计（API v1）

> 依据：`doc/database-design.md` §5「一次录入 = 一个事务」、§9 数据特例。
> 实现：`server/write.mjs`（场次/作答）、`server/catalog.mjs`（试卷/题目）、
> `server/backup.mjs`（写前快照）、`server/routes.mjs`（分发）、`server/read-api.mjs`（只读上下文）。

## 1. 为什么要有写接口

P4 上线后，改数据只有一条路：本机 sqlite3 改 `mem.db` → `push-data.sh` 推服务器。
这条路要求本机在场，手机上、临时想补一条记录时走不通。

写接口解决的是这个场景。**开启之后线上的定位变了**：写在服务器上发生，线上那份
`mem.db` 就是被写入的真源，本机改成副本（`scripts/pull-data.sh` 拉回来）。
每次写成功后接口立即重建进程内的页表（渲染输入直接从库构造，不再经过导出物）——
响应返回时页面已经是新的（线上实测 40~230 ms），没有任何等待窗口。
`index.json` / `content.json` 仍会重导，但只作对外契约与备份，页面不读它们。

## 2. 三道闸门（缺一不可）

| 闸门 | 检查点 | 不满足时 |
|---|---|---|
| 配置开启 | `config.*.json` 里 `write.enabled = true` | 写路由不注册，返回 404 |
| 持有 token | `Authorization: Bearer <token>` | 401 |
| 连接可写 | `openDb()` 以读写模式打开 | 进程直接拒绝启动 |

token 从环境变量 `MEM_WRITE_TOKEN` 读取（≥16 字符），不写进配置文件、不进版本库。
线上配置 `deploy/config.server.json` 是**开启**的，token 在服务器 `/www/api/mem-api.env`
（600 root:root），本机副本 `~/.mem-api-token`；本机 `config.local.json` 仍是关闭的（8137 只读）；
`config.test.json` 开启，端口 8138、指向 `data/test.db`。

另外：`write.enabled=true` 与 `readOnly=true` 同时出现会**拒绝启动**，不留半开状态。

## 3. 只读接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 含 `readOnly` / `writeEnabled` / `database` / `config` |
| GET | `/api/meta` | 覆盖、判定、计时、答案状态 |
| GET | `/api/days` | 日历 / 热力图 / 连续天数（`commits` 恒空） |
| GET | `/api/study` | **页面数据的全集**：渲染页表时算好的那份 `buildData()`，原样返回。`?section=` 只取一节 |
| GET | `/api/papers` | 卷列表 |
| GET | `/api/papers/:slug` | 单卷含题号清单 |
| GET | `/api/questions` | 支持 `paper` / `topic` / `q`（题干全文检索）/ `limit` / `offset` / `include=content` |
| GET | `/api/questions/:id` | 单题，默认含 `contentMd`；`include=meta` 只要元数据 |
| GET | `/api/sessions` | 支持 `from` / `to` / `paper` / `limit` / `offset` |
| GET | `/api/sessions/:id` | 场次 + 逐题作答；`include=process` 带上批改全文 |
| GET | `/api/attempts` | 支持 `questionId` / `redoStatus` / `include=process` |
| GET | `/api/attempts/:id` | 单条作答；`include=process` 带上该题推演 |
| GET | `/api/redo` | 待重做台账（`redo_status` 非空），带 `resolved` 标记 |
| GET | `/api/backups` | 快照列表（时间、原因、行数、sha256、体积） |
| GET/POST | `/api/sql` | 只读 SQL，**需 token**；`format=csv` 直接出 CSV，`maxRows` 调上限。见 [sql.md §1.1](sql.md) |

只读接口不需要 token，也不需要写模式——**`/api/sql` 是唯一例外**。

`/api/meta` 与 `/api/study` 容易混：

| | 数据来源 | 口径 | 用途 |
|---|---|---|---|
| `/api/meta` | 直接查库（`buildMeta`） | 库行数、判定三态、计时分布 | 数据自检、脚本核对 |
| `/api/study` | **页表渲染时算好的那份 `buildData()`** | 页面口径：学习天数、连续天数、卷掌握度、知识点树、周聚合 | 要与页面显示一致时用这个 |

`/api/study` 不重新查库、不重新聚合，直接把 `pages.mjs` 里存着的那份对象返回，
所以它和页面必然同源：写完库 → 重建页表 → 两者的数字一起变，不存在两个口径。
加 `?section=stats|volumes|knowledge|days|weeks|countdown|meta|today|warnings` 只取一节（整份约 96 KB）。

`/api/sql` 之所以也要 token：一条 `select * from attempts` 就能把整库导走，敏感度和写一样。
它的语句由子进程里的 `server/sqlrun.mjs` 执行（与 SSH 那条路同一份代码），
所以闸门完全一致：只读连接、单条语句、只读关键字、行数上限；跑超 20s 直接 SIGKILL 并返回 `408`。
放在子进程里而不是请求里跑，是因为 `node:sqlite` 是同步驱动——一条不收敛的查询会把页面服务一起卡住。

## 4. 写接口

### 4.1 录入一场（核心）

```
POST /api/sessions
```

一次提交「场次头 + 逐题结果 + 整份正文」，**单事务落库**：任何一条校验失败，整场都不写。

```json
{
  "paperSlug": "2024-exam",
  "date": "2026-11-11",
  "timingMode": "session",
  "durationMin": 35,
  "sessionId": "2024-exam-a12",
  "file": "2024-exam/answer12.md",
  "fullText": "# 2024 管综真题 · 第 12 场\n\n...整份 Markdown 正文...",
  "note": null,
  "attempts": [
    { "questionId": "2024-exam-q001", "userAnswer": "D", "process": "直接代入。" },
    { "questionId": "2024-exam-q002", "userAnswer": "ZZZ", "errorTag": "审题" },
    { "questionId": "2024-exam-q003", "userAnswer": "B", "correct": true,
      "substantiveCorrect": false, "process": "答案对，思路绕路。" }
  ]
}
```

字段说明：

| 字段 | 必填 | 默认 / 规则 |
|---|---|---|
| `paperSlug` | 是 | 必须在 `papers` 里存在 |
| `date` | 是 | `YYYY-MM-DD` |
| `attempts` | 是 | 非空；同一题不能出现两次；每题必须属于该卷 |
| `sessionId` | 否 | 自动取该卷下一个 `-a{n}`（挑未占用的） |
| `file` | 否 | 默认 `<卷>/answer<n>.md`；**不能与已有场次重名**（`content.json` 用它做键） |
| `timingMode` | 否 | 默认 `none`，只能是 `session` / `per-question` / `mixed` / `none` |
| `durationMin` | 否 | 必须 ≥ 0；给了才会写入 front matter 的 `duration` |
| `fullText` | 否 | 整份场次正文（front matter 之后的部分）。不给则按逐题结果自动生成一份摘要 |
| `questionCount` | 否 | 默认等于 `attempts.length`（保留设计文档里「场次题量与作答数不等」的口径） |

逐题字段：

| 字段 | 说明 |
|---|---|
| `userAnswer` | 我的答案 |
| `correct` | 布尔 / 0 / 1；**不传时按 `userAnswer` 与标准答案自动判定**，主观题保持未判定 |
| `substantiveCorrect` | 不传则跟随 `correct`（用于「答案对但思路不对」的区分） |
| `score` / `scoreMax` | 主观题得分，`score ≤ scoreMax` |
| `isRedo` | 是否重做 |
| `errorTag` / `errorTags` | 主标签进 `error_tag` 列，完整数组进信封（设计 §7 口径） |
| `errorNote` | 错因补充 |
| `process` | 该题推演与订正，写进 `process_md` |
| `durationMin` / `durationSource` | 单题计时 |

响应 `201`：

```json
{ "ok": true, "sessionId": "2024-exam-a12", "file": "2024-exam/answer12.md",
  "questionCount": 3, "attemptCount": 3, "attempts": ["2026-11-11-2024-exam-a12-2024-exam-q001", "..."] }
```

### 4.2 订正一场里的某题

```
PATCH /api/attempts/:id
```

可改：`userAnswer`、`correct`、`substantiveCorrect`、`score`、`scoreMax`、`isRedo`、
`errorTag`、`errorTags`、`errorNote`、`redoStatus`、`resolvedAt`、`process`。
其它字段一律 400（`unknown_field`），防止误传 `id` / `session_id` 之类把外键改坏。

改 `correct` 时会连带把 `substantiveCorrect` 一起改（可用显式传值覆盖）。
改 `process` 只替换该题段落，第一条作答上的整份场次正文会保留。

### 4.3 台账销账

```
POST /api/attempts/:id/resolve   { "date": "2026-11-11" }
```

要求该题最近一次判定是「对」，否则 409 `not_yet_correct`。写 `redo_status='resolved'` 与
`resolved_at`，重复调用幂等。

### 4.4 撤销一场

```
DELETE /api/sessions/:id
```

先删子表再删场次，返回 `deletedAttempts`。用于整场录错时的回退。

### 4.5 订正场次头

```
PATCH /api/sessions/:id
```

可改：`date`、`startedAt`、`durationMin`、`durationSource`、`timingMode`、`questionCount`、
`note`、`file`（场次 md 路径，`content.json` 的键）、`sourceFile`（front matter 里的原始试卷名）、
`fullText`（整份正文）。其它字段一律 400。

三条连带规则，都是为了让导出物仍然自洽：

| 改动 | 连带动作 |
|---|---|
| `date` | 作答 id 的日期前缀与 `process_md` 里的 `<!-- attempt: … -->` 一起改，`frontMatter.time` 同步 |
| `file` | `process_md` 里的 `===== 场次全文：<file> =====` 标记同步改，否则 `content.json` 找不到原文 |
| `fullText` | 只替换标记之后的正文，该题自己的推演段落保留 |

`file` 与其它场次重名 → 409 `file_exists`。

### 4.6 补录单题

```
POST /api/sessions/:id/attempts
```

给已存在的场次补一题（漏录）。题必须属于该场次的卷，且同场不能重复 → 400
`duplicate_question` / `question_not_in_paper`。写入后 `question_ids` 与 `question_count`
按卷内顺序重算。新作答不带「场次全文」标记 —— 标记固定在第一条上。

### 4.7 撤销单题

```
DELETE /api/attempts/:id
```

删一条作答，`question_count` 同步减一。两条红线：

- 最后一条不能删 → 400 `last_attempt`（场次没有作答会让导出直接报错，要清空请删整场）
- 被删的那条若承载「场次全文」标记，标记段整体搬给新的第一条，原文页不丢

### 4.8 重新导出

```
POST /api/export
```

把库重新导出成 `index.json` + `content.json`（路径由配置决定），并重建页面。返回覆盖数与页表版本。

用于「绕过写接口直接改了库」之后的补救，例如运维手工替换了 `mem.db`、
或本机用 `sqlite3` 改完再推上来。正常写入不需要调它——每个写接口内部都会自动做这两步。

另外：进程每次处理页面请求时会比对三份 JSON 的大小与 mtime，发现变化就自动重建，
所以连这个接口都不一定要调——文件变了，下一次请求页面就跟上了。

### 4.9 试卷

```
POST /api/papers
PATCH /api/papers/:slug
DELETE /api/papers/:slug
```

新建只建「空卷」，题目用 `/api/questions` 一道道加：

```json
{ "slug": "2026-exam", "title": "2026 管综真题", "subject": "管综",
  "scoreRule": { "objective": 3, "subjective": { "essay1": 30, "essay2": 35 } },
  "paperFile": "2026年管综真题/paper.md",
  "paperPrefix": "# 2026 年全国硕士研究生招生考试\n\n## 一、问题求解…" }
```

| 字段 | 说明 |
|---|---|
| `slug` | 必填，小写字母/数字/连字符；创建后不可改（被题与场次引用） |
| `title` / `subject` | 标题、科目 |
| `scoreRule` | 分值规则对象，原样存 `score_rule_json` |
| `paperFile` / `paperPrefix` | 可选：原文页路径与页头。`content.json` 的「原文」页由这两者决定 |
| `sourceFiles` | 可选：该卷涉及的原始文件清单 |

`PATCH` 可改 `title` / `subject` / `scoreRule` / `note` / `questionCount` /
`paperFile`+`paperPrefix`（加或改一页原文）/ `removePaperFile`（删原文页，页下还有题则 409）/
`sourceFiles`。

`DELETE` 只允许删**空卷**：卷里还有题或场次 → 409 `paper_not_empty` 并返回各自数量。

### 4.10 题目

```
POST /api/questions
PATCH /api/questions/:id
DELETE /api/questions/:id
```

```json
{ "paperSlug": "2026-exam", "type": "problem", "topicId": "math.profit",
  "topic": "问题求解",
  "contentMd": "**1.** 某商品进价 100 元…\n\nA. 30%　B. 50%　C. 60%　D. 80%　E. 100%\n",
  "answer": "B" }
```

| 字段 | 必填 | 默认 / 规则 |
|---|---|---|
| `paperSlug` | 是 | 卷必须存在 |
| `type` | 是 | `problem` / `data-sufficiency` / `logic` / `cloze` / `reading` / `new-type` / `translation` / `writing` / `essay` |
| `topicId` | 是 | **必须在 `volumes.json` 知识树里**，否则 400 `unknown_topic` |
| `topic` | 是 | 展示用中文标签（如「问题求解」），与知识点名不是一回事 |
| `contentMd` | 是 | 题干 Markdown；不含 `<a id="<id>"></a>` 会自动补在末尾 |
| `answer` | 否 | 不传 = 未定；`scorable` 默认「有答案才是 1」 |
| `scorable` | 否 | 0 / 1 / 布尔 |
| `number` | 否 | 默认卷内最大题号 + 1（同一题号可重复，顺序看 `seq`） |
| `seq` | 否 | 默认卷尾 + 1；显式指定时把后面同卷的题整体后移 |
| `id` | 否 | 默认 `<slug>-q001` 形式，重名自动顺延；也可显式给 |
| `paperFile` | 否 | 默认继承卷内最后一题；该卷有 `paperPrefix` 时必须命中其中一个键，否则 400 `unknown_paper_file` |
| `section` / `answerSource` / `revision` / `origin` / `note` | 否 | 前三个默认继承卷内最后一题 |

`PATCH` 可改上述除 `id`、`paperSlug` 外的一切。改 `answer` 时如果该题已有作答，
响应里带 `warnings`：**历史判定不会自动重判**，要重判得逐条 `PATCH /api/attempts/:id`。

`DELETE` 有保护：题被作答引用 → 409 `question_in_use`（返回条数）；被重练题 `origin` 引用 →
409 `question_referenced`。删成功后按库内实际值重算卷的 `question_ids` / `question_count`。

### 4.11 备份

```
GET  /api/backups    列出快照（只读，不需要 token）
POST /api/backups    手动打一份快照（需写模式 + token）
```

写模式进程在**每次写库之前**自动打一份快照（`backup.beforeWrite`，默认开），
所以「改坏了」永远有上一版可退。快照目录：

```
backups/<YYYYMMDD-HHMMSS>-<原因>/
  mem.db          VACUUM INTO 出来的一致性副本
  volumes.json    知识树（不在库里，单独留一份）
  meta.json       时间、行数、sha256
```

保留份数由 `backup.keep` 决定（默认 20）。**恢复不提供 HTTP 接口**——要停服务换文件，
用命令行 `./scripts/restore.sh <备份目录>`。

## 5. 数据契约：写接口必须守的两条

### 5.1 `notes` 是 JSON 信封

三张表都有备注列，里面是 `{"text": ..., "baseline": {...}}`。导出器按固定键名取值，
所以写接口必须构造出同样的结构：

| 表 | baseline 必备键 |
|---|---|
| `sessions.note` | `file`、`frontMatter` |
| `attempts.notes` | `source`、`errorTags`、`errorNote`、`durationMin`、`durationSource` |
| `questions.notes` | `paper`、`section`、`revision`、`answerSource` |
| `papers.notes` | `sourceFiles`、`paperPrefix`（键为原文页路径，值为页头） |

### 5.2 `process_md` 要带「场次全文」标记

`content.json` 恢复原文页靠这条标记：

```
===== 场次全文：<file> =====

<整份正文>
```

写接口只把整份正文挂在**第一条作答**上，其余作答只存本题段落，避免同一份正文重复 20 次。

## 6. 错误码

| HTTP | code | 场景 |
|---|---|---|
| 400 | `invalid_field` / `invalid_body` / `invalid_json` | 字段类型、枚举、日期、空数组 |
| 400 | `unknown_paper` / `unknown_question` | 卷 / 题不存在 |
| 400 | `question_not_in_paper` | 题存在但不属于该卷 |
| 400 | `duplicate_question` | 同一场次同一题出现两次 |
| 400 | `unknown_field` | PATCH 传了不可改字段 |
| 401 | `unauthorized` | 缺 token / token 不匹配 |
| 404 | `not_found` | 场次 / 作答不存在；只读进程下的写路径 |
| 405 | — | 非可写路径用错方法 |
| 409 | `session_exists` / `file_exists` / `attempt_exists` | 唯一性冲突 |
| 409 | `not_yet_correct` | 未做对却要销账 |
| 409 | `no_fulltext_carrier` / `fulltext_missing` | 场次没有作答承载正文 / 正文标记对不上 |
| 400 | `last_attempt` | 要删场次最后一条作答 |
| 400 | `unknown_topic` / `unknown_paper_file` | 知识点不在知识树 / 原文页不属于该卷 |
| 409 | `paper_exists` / `question_exists` | 卷 / 题 id 已存在 |
| 409 | `question_in_use` / `question_referenced` | 题被作答引用 / 被重练题 origin 引用 |
| 409 | `paper_not_empty` / `paper_file_in_use` | 卷里还有题或场次 / 原文页下还有题 |
| 413 | `body_too_large` | 超过 2 MB |
| 400 | `bad_request` / `bad_sql` / `exec_failed` | `/api/sql`：写语句或多语句被拒 / 语法或表名错 / 执行失败 |
| 408 | `timeout` | `/api/sql`：查询 20s 未收敛，子进程已被终止 |
| 500 | `internal` | 其它 |

## 7. 验证方式

```bash
node server/test-write-api.mjs     # 118 项：鉴权、创建、校验、事务性、订正、销账、撤销、
                                   #         场次订正、补录/撤销单题、题库读写、备份、导出、只读 SQL、正式库保护
node scripts/compare-export.mjs    # Node 导出器与 Python 导出器逐字段 + 键顺序比对
node server/smoke-test.mjs         # 只读链路 19 项回归（需 8137 在跑）
```

`test-write-api.mjs` 自带测试库：用 `sqlite3 .backup` 从 `mem.db` 只读复制出 `data/test.db`，
跑前记录 `data/mem.db` 与 `data/index.json` 的 sha256 + mtime，跑完复查，**证明正式库没被碰**。

## 8. 明确没做

| 没做 | 原因 |
|---|---|
| 改卷内题的归属（`paperSlug`） | 换卷会让原文页、卷题量、场次外键同时错位；要换就删了重建 |
| 知识点树写入 | 知识树在 `volumes.json`（文件），改它要连带调整 `topicAliases` / `mathTopics`，不适合走 HTTP |
| 删除有引用的题 / 非空卷 | 会连带毁掉历史场次；宁可让人先清场次，也不做级联删 |
| 恢复接口 | 恢复要停服务换文件，只能命令行 `scripts/restore.sh` |
| 审计日志（谁在何时改了什么） | 单用户场景价值低；写前快照已能回答「改坏了怎么退」 |
| 乐观锁 / 版本号 | 单人使用，后写覆盖先写即可接受 |
| 批量导入 | 一次性迁移已由 `migrate.py` 完成；批量建档请直接写脚本调本接口 |
| 写接口的限流 | 只监听回环 + nginx 反代 + token，暂不加 |
