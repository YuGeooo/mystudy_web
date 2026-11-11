# 日常使用：mem 命令行

部署是低频动作，真正每天发生的是「查一下这题」「补一条判定」「记一场」「把这道标成重做」。
这些动作不该让人手写 `curl` + Bearer + URL 编码。`bin/mem` 就是这一层：拼 URL、带 token、
把 JSON 压成能一眼看懂的表；加 `--json` 又变回机器可读的原始响应。

接口契约本身在 [api-design.md](api-design.md)，这份文档只讲**怎么用**。

## 1. 装一次

```bash
cd ~/WorkBuddy/mem_web
chmod +x bin/mem
ln -sf "$PWD/bin/mem" /opt/homebrew/bin/mem     # 换成任意 PATH 里可写的目录即可
mem --help
```

本机已链接到 `/opt/homebrew/bin/mem`（`/usr/local/bin` 需要 sudo）。
不装也能用，把下面所有 `mem` 换成 `./bin/mem`。

## 2. 三个目标地址

默认打线上 `https://geyuqi.me`（只读不需要 token，写需要）。**这个默认值是有意的**：
日常最常查的就是线上那份真源，不需要每次敲一长串 URL。

| 目标 | 写法 | 用途 |
|---|---|---|
| 线上 | `mem ...`（默认） | 日常读写，线上是写入真源 |
| 本机只读 | `mem --local ...` | 快速看本机副本，**不能写**（只读进程不注册写路由，写会 404） |
| 测试库 | `mem --test ...` | 8138 + `data/test.db`，练手、验证命令 |

也可以用 `MEM_API=http://127.0.0.1:8137 mem ...`，或 `--base <url>` 临时指定。

本机 8137 **不常驻**（省一个后台进程）：要用 `--local` 先 `./dev.sh`，用完 Ctrl+C。
线上那份随时可查，日常查询不需要本机服务。

> `mem sql --local` 是例外：它不连 8137，而是直接读本机库文件 `data/mem.db`，
> 所以不需要起服务，但也**不看**服务是否在跑。详见 [§11](#11-预设命令不够直接写-sql)。

## 3. token

写操作要 token，三个来源，优先级从高到低：

1. `--token <t>`
2. 环境变量 `MEM_WRITE_TOKEN`
3. 文件 `~/.mem-api-token`

线上那把已经在本机 `~/.mem-api-token`（服务器上在 `/www/api/mem-api.env`）。建议收紧权限：

```bash
chmod 600 ~/.mem-api-token
```

只读命令不需要 token；token 缺失时 CLI **在本地就拦住**（退出码 2），不会发一个注定 401 的请求。

## 4. 查询

```bash
mem health                      # 服务、SQLite 版本、可写状态、页表版本与页数
mem meta                        # 覆盖 / 判定 / 计时口径
mem days                        # 学习日、连续天数、最近 14 天

mem p ls                        # 卷列表
mem p get 2024-exam             # 单卷 + 题号清单

mem q ls --paper 2024-exam --limit 5
mem q ls --topic 不定方程
mem q search 排列组合           # 题干全文检索
mem q get 2024-exam-q001        # 单题，默认带题干全文
mem q get 2024-exam-q001 --meta # 只要元数据，不要正文

mem s ls --limit 10
mem s ls --from 2026-11-01 --to 2026-11-11 --paper 2024-exam
mem s get 2024-exam-a12         # 场次 + 逐题判定
mem s get 2024-exam-a12 --process  # 连每题的推演全文

mem a ls --question 2024-exam-q001
mem a ls --redo 待重做
mem a get <attemptId> --process

mem redo                        # 待重做台账（未销账的）
mem backups                     # 写前快照列表
```

实际输出长这样（表格按中文字宽对齐，最后一列不补空格）：

```
$ mem p ls
slug           题数  标题
─────────────  ────  ─────────────────────────────────
2020-exam      57    2020 管综真题
2024-exam      57    2024 管综真题
2025-english   48    2025 英语二
...

$ mem s ls --limit 3
id                日期        卷             题数  时长
────────────────  ──────────  ─────────────  ────  ─────
reasoning-2-a2-4  2026-11-11  reasoning-2    2     56min
reasoning-2-a2-3  2026-11-10  reasoning-2    5     62min
redo-20261109-a3  2026-11-09  redo-20261109  10    61min
```

`mem s get` 会额外拉一次该卷的题目，把题号、正确答案拼进来：

```
$ mem s get reasoning-2-a2-4
reasoning-2-a2-4  2026-11-11  reasoning-2  2 题  56min  timing=session
题  判定  作答  答案  标签  重做  题干
──  ────  ────  ────  ────  ────  ────────────────────────
4   ✅    C     C                             某班有甲乙丙…
5   ❌    A     D     审题                    若甲不参加…
```

## 5. 写入

所有写操作都是**单事务**：请求里有一条不合法，整场都不写。每次写之前服务器自动留快照。

### 5.1 记一场（最常用）

准备一个 JSON（字段与 `POST /api/sessions` 一致）：

```json
{
  "paperSlug": "2024-exam",
  "date": "2026-11-11",
  "timingMode": "session",
  "durationMin": 35,
  "attempts": [
    { "questionId": "2024-exam-q001", "userAnswer": "E", "process": "代入验证，一次算对。" },
    { "questionId": "2024-exam-q002", "userAnswer": "C", "errorTag": "审题" },
    { "questionId": "2024-exam-q003", "userAnswer": "B", "correct": true, "substantiveCorrect": false,
      "process": "答案对，思路绕路。" }
  ]
}
```

```bash
mem s new session.json          # 从文件
mem s new - < session.json      # 从标准输入
cat session.json | mem s new -  # 管道也一样
```

返回：

```
✓ 2024-exam-a13 · 页表 v44（171 页，38ms）
```

可以省略的字段：

| 字段 | 省略时 |
|---|---|
| `sessionId` | 自动生成 `<卷>-a<N>`（该卷已有场次的最大序号 + 1） |
| `file` | 自动生成 `<卷>/answer<N>.md` |
| `fullText` | 按逐题结果自动生成整份正文；原文页仍可打开。想保留自己写的正文就显式传 |
| `correct` | 有 `answer` 的客观题按答案自动判；判不了留 `null`（未判） |
| `timingMode` | `none` |

`attempts[].userAnswer` / `process` / `errorTag` / `errorTags` / `correct` / `substantiveCorrect` /
`score` / `scoreMax` / `isRedo` 都是可选，按需给。

### 5.2 改

```bash
# 场次头：date / startedAt / durationMin / durationSource / timingMode /
#         questionCount / note / file / sourceFile / fullText
mem s set 2024-exam-a12 durationMin=35 timingMode=session

# 单条作答：userAnswer / correct / substantiveCorrect / score / scoreMax /
#           errorTag / errorTags / errorNote / redoStatus / resolvedAt / process / isRedo
mem a set 2026-11-11-2024-exam-a12-2024-exam-q003 correct=true errorTag=审题
```

`k=v` 的值按这个规则还原类型：

| 写法 | 变成 |
|---|---|
| `durationMin=35` | 数字 `35` |
| `correct=false` | 布尔 `false` |
| `note=null` | `null`（清空） |
| `errorTags=["审题","计算"]` | 数组 |
| `scoreRule={"objective":3}` | 对象 |
| `errorNote="选项看错，误选不存在的项"` | 字符串（含空格要引号） |

长文本（`contentMd`、`fullText`、`process`）别硬塞进命令行，用 `--file` 或整份 JSON 更稳：

```bash
mem q set 2024-exam-q001 --file patch.json
```

### 5.3 补一题 / 删

```bash
mem a add 2024-exam-a12 attempt.json     # 往已有场次追加一题
mem a rm <attemptId>                     # 删一条（该场最后一条不许删，服务端会 400 last_attempt）
mem s rm 2024-exam-a12                   # 删整场（连作答一起删）
```

### 5.4 重做销账

```bash
mem a set <attemptId> correct=true       # 先确保最近一次判定是「对」
mem a done <attemptId>                   # 销账，默认今天
mem a done <attemptId> --date 2026-11-11
```

判定不是「对」时服务端返回 `409 not_yet_correct`——这是有意的，防止没做对就销账。

### 5.5 题库

```bash
mem p new --file paper.json       # 必填 slug / title
mem p set 2024-exam title="2024 管综真题（修订版）"
mem p rm 2024-exam                # 卷里还有题或场次 → 409 paper_not_empty

mem q new --file question.json    # 必填 paperSlug / type / topicId / topic / contentMd
mem q set 2024-exam-q001 answer=E
mem q rm 2024-exam-q001           # 已有作答 → 409 question_in_use
```

`question.json` 示例：

```json
{
  "paperSlug": "2024-exam",
  "type": "problem",
  "topicId": "math.ratio",
  "topic": "问题求解",
  "contentMd": "某商店购进一批商品……",
  "answer": "E",
  "section": "一、问题求解"
}
```

`topicId` 必须是 `data/volumes.json` 知识树里真实存在的节点；`type` 取值
`problem / data-sufficiency / logic / cloze / reading / new-type / translation / writing / essay`。
题目不能换卷（要换就删了重建）。

### 5.6 导出与快照

```bash
mem export    # 重导 index.json / content.json 并重建页表
mem backup    # 立即打一份快照
```

正常情况下写完会自动做这两件事，手动执行只用于「绕过接口直接改了库」的补救。

## 6. `--dry-run` 与 `--json`

```bash
mem s new session.json --dry-run    # 只打印方法和请求体，不发请求
mem q ls --paper 2024-exam --json   # 原样输出服务端 JSON
```

`--dry-run` 在生成请求体之前就校验 token，所以也能用来确认「token 到底读到没有」。
`--json` 对错误同样生效：失败时 stdout 是一段可解析的 JSON，不是人话。

退出码是固定的，脚本可以直接判：

| 码 | 含义 |
|---|---|
| 0 | 成功 |
| 1 | 请求失败（4xx/5xx、连不上） |
| 2 | 用法错误（参数不对、缺 token、未知命令） |

## 7. 给 Agent 用

Agent 的难点不是不会调接口，而是**容易猜错 id、猜错字段**。所以约定四件事：

```text
1. 一律加 --json，直接解析 stdout，不要正则人话输出。
2. 只读可以打线上或 --local；写只用默认线上，绝不加 --local（只读进程写会 404）。
3. 写入前先查 id：mem q ls --paper <slug> --search <关键词> --json，
   从返回里取 questionId / sessionId，不要自己拼。
4. 4xx 不要重试；按 code 处理（见下表）。写完用 mem s get <id> --json 回读确认。
```

推荐的操作序列：

```bash
# 想补一道错题到已有场次
mem s ls --from 2026-11-11 --json                 # 找到今天的场次 id
mem q ls --paper 2024-exam --search 不定方程 --json # 拿到 questionId
mem a add <sessionId> attempt.json --json          # 追加
mem s get <sessionId> --json                       # 回读确认 attempts 里有它

# 想把一道题标成待重做
mem a set <attemptId> redoStatus="待重做" errorTag=计算 --json
```

错误码与处理方式：

| code | HTTP | 含义 | 怎么办 |
|---|---|---|---|
| `unauthorized` | 401 | token 缺失或不匹配 | 检查 `~/.mem-api-token` / `MEM_WRITE_TOKEN` |
| `not_found` | 404 | 资源不存在；或写到了只读进程 | 先查 id；确认没加 `--local` |
| `invalid_field` | 400 | 字段值不合法 | 按 `error` 文案改，不要重试原样请求 |
| `unknown_field` | 400 | 改了不该改的字段 | 对照 5.2 / 5.5 的白名单 |
| `duplicate_question` | 400 | 该场次已有这道题 | 改用 `a set` 修订，或先 `a rm` |
| `last_attempt` | 400 | 想删场次最后一条作答 | 删整场（`s rm`）或先补一条 |
| `paper_exists` | 409 | 卷 slug 已存在 | 改用 `p set` |
| `paper_not_empty` | 409 | 卷里还有题或场次 | 先清空再删 |
| `question_in_use` | 409 | 题目已有作答 | 先删相关场次 |
| `question_referenced` | 409 | 被重练题的 `origin` 引用 | 先清 `origin` |
| `not_yet_correct` | 409 | 销账时判定不是「对」 | 先 `a set correct=true`（真做对了再改） |
| `attempt_exists` | 409 | 作答 id 已存在 | 大概率重复提交，先 `a ls` 查 |

一次完整的 Agent 调用示例（含错误处理）：

```bash
out=$(mem a set <attemptId> correct=true --json) || {
  echo "$out" | jq -r '.code'      # 例如 not_found
  exit 1
}
```

## 8. 写坏了怎么退

CLI 的写操作都会在**服务器上**先留一份快照（`POST`/`PATCH`/`DELETE` 之前，`export` 与 `backups` 除外）。

```bash
mem backups                      # 看最近 20 份，含原因（POST-sessions / PATCH-attempts …）
```

恢复要停服务，所以不走 HTTP，用仓库里的脚本（在服务器上执行，或先 `pull-data.sh` 拉回来在本机恢复）：

```bash
./scripts/restore.sh /www/data/backups/20261111-193012-POST-sessions
```

恢复前会把当前库另存 `*-before-restore`，恢复本身也能反悔。详见 README「备份与恢复」。

线上是写入真源；想让本机副本跟上：

```bash
./scripts/pull-data.sh
```

## 9. 排错

| 现象 | 原因 | 处理 |
|---|---|---|
| `连不上 http://127.0.0.1:8137` | 本机服务没起 | `./dev.sh`；或去掉 `--local` 打线上 |
| 写操作 404，hint 说「只读模式运行」 | 打到了 8137 | 去掉 `--local` |
| `写操作需要 token`，退出码 2 | 三个来源都没有 | 写入 `~/.mem-api-token` |
| `401 unauthorized` | token 不对 | 线上 token 在服务器 `/www/api/mem-api.env` |
| `413` | 请求体超过 2 MB | 拆场次；`fullText` 太长就分段 |
| `429` | nginx 限流（5r/s，burst 20） | 批量写入之间停一下 |

## 10. 自测

CLI 本身有验收脚本，跑在 `data/test.db` 上，正式库的 sha256 前后比对：

```bash
node server/test-cli.mjs     # 27 项：查询 / token / dry-run / 建场 / 改判定 / 销账 / 删除 / 快照 / 导出 / SQL
node server/test-sql.mjs     # 27 项：只读闸门 + doc/sql.md 里每条 SQL 实际执行
npm test                     # 全量：预检 + 语法 + 导出等价 + SQL + 写接口 + CLI + 只读链路
```

## 11. 预设命令不够：直接写 SQL

要按知识点算正确率、找做错过两次还标着重做的题、看某题历次判定，写一条 SQL 比等一个新命令快。

```bash
mem sql "select topic, count(*) n from attempts join questions q on q.id=attempts.question_id group by topic"
mem sql -f q.sql                 # 长查询写文件
mem sql --csv "..." > out.csv
mem sql --json "..."             # {ok, columns, rows, count, truncated, ms}
mem sql --local "..."            # 打本机镜像，最快（先 mem pull）
mem schema [表]                  # 字段名不用猜
```

只读，且只有一条语句。SQLite 没有网络协议，所以 `mem sql` 实际是 SSH 到服务器上跑
`server/sqlrun.mjs`（连接复用，首次 ~0.5s、之后 ~0.17s）。写数据仍然走 `mem a set` 这一套，
否则会绕过快照和页表重建。

完整的表结构、12 个常用查询（趋势 / 薄弱点 / 重做转化 / 时长分布）和边界说明见
**[sql.md](sql.md)**。

