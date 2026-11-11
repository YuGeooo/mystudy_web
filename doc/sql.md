# 直接用 SQL 查数据

预设命令（`mem q ls`、`mem redo`）只覆盖固定几种看法。要算「条件充分性判断这半年正确率怎么走的」「哪些题错了两次以上还标着重做」，写 SQL 比加命令快得多。

## 1. 三条路，都没有数据库地址

SQLite 是嵌入式库，**没有网络协议**——不存在「填个 host/port 就能连」的连接串。文件在服务器上，客户端只能：

| 方式 | 读的是 | 延迟 | 数据新鲜度 |
|---|---|---|---|
| `mem sql --http "..."` | 服务器（`POST /api/sql`） | ~35ms | 实时 |
| `mem sql "..."`（默认） | 服务器 `/www/data/mem.db` | 首次 ~0.5s，之后 ~0.17s | 实时 |
| `mem sql --local` | 本机 `data/mem.db` | ~40ms | 取决于上次 `mem pull` |
| 直接 `sqlite3 data/mem.db` | 本机镜像 | 最快 | 同上 |
| HTTP `/api/*` | 服务器 | ~200ms | 实时，但只有固定几种切面 |

`--http` 是**给 SQLite 补上一层 HTTP 传输**：服务端把语句交给 `server/sqlrun.mjs` 执行，
所以读的仍然是那个 `.db` 文件，只是不再需要 SSH。默认那条 SSH 路保留——免密没配好、
或者 API 进程挂了，它还能进。`mem sql` 用 `ControlMaster` 复用连接，连着查十条不会每次重新握手。

### 1.1 HTTP 入口（`/api/sql`）

```
GET  /api/sql?sql=select+1+as+x&format=json|csv&maxRows=100
POST /api/sql   {"sql":"select 1 as x","maxRows":100,"format":"csv"}
Authorization: Bearer <token>
```

- **要 token**。是读操作，但一条 `select * from attempts` 就能把整库导走，和写一样属于「只有本人能做」。
- **闸门与 SSH 那条路完全一致**：同一个 `server/sqlrun.mjs`，只读连接 + 单条语句 + 只读关键字 + 行数上限 1000（硬顶 5000）。
- **在子进程里执行**：`node:sqlite` 是同步驱动，一条不收敛的递归 CTE 会把页面服务一起卡住。
  所以每次查询起一个一次性子进程，20s 超时直接 SIGKILL，返回 `408 / code=timeout`。
- `format=csv` 直接给 Excel / pandas 用，不需要先落一个 `.csv` 再传。

```bash
mem sql --http "select count(*) from attempts"
mem sql --http --csv "select topic, count(*) n from questions group by 1" > topics.csv
curl -sG https://geyuqi.me/api/sql -H "Authorization: Bearer $TOKEN" \
     --data-urlencode "sql=select count(*) from attempts"
```

**写操作仍然走 API**（`mem s new`、`mem a set` ……）：写要过校验、要留快照、要重建页表，绕过这些直接 `UPDATE` 会留下不一致的页面和无法追溯的改动。执行器是只读的，`delete`、`pragma journal_mode=...` 都会被拒——换成别的数据库也一样，这是设计而不是限制。

## 2. 上手

```bash
mem sql "select count(*) from attempts"
mem sql --http "select count(*) from attempts"   # 不 SSH，走 /api/sql（需 token）
mem sql -f q.sql
echo "select 1" | mem sql
mem sql --csv "..." > out.csv
mem sql --local "..."          # 打本机镜像
mem schema                     # 4 张表全字段
mem schema attempts            # 单表
mem pull                       # 拉线上库覆到本机（先自动备份）
```

想用系统 `sqlite3` 的 `.tables`、`.schema`、`EXPLAIN`，拉一份镜像后直接开：

```bash
mem pull
sqlite3 "file:data/mem.db?immutable=1" "select count(*) from attempts"   # 纯只读
sqlite3 data/mem.db                                                       # 交互式
```

> 别用 `sqlite3 -readonly data/mem.db`：库是 WAL 模式，这个开关会要求写 `-shm`，
> 结果是 `unable to open database file (14)`。用 `immutable=1` 或干脆不加 `-readonly`（只跑 SELECT 不会改数据）。

服务器上真正的执行文件是 `/www/api/server/sqlrun.mjs`，由 `deploy/deploy-api.sh` 一起发布；本机和服务器跑**同一份代码**，所以 `--local` 与线上行为一致。

## 3. 表结构速查

```
papers(slug, title, subject, question_ids JSON, question_count, score_rule_json, notes, updated_at)
questions(id, paper_slug, number, seq, type, topic_id, topic, origin, content_md, answer, scorable, notes, updated_at)
sessions(id, paper_slug, date, started_at, duration_min, timing_mode, duration_source, question_ids JSON, question_count, note, updated_at)
attempts(id, session_id, question_id, user_answer, correct, substantive_correct, score, score_max,
         is_redo, error_tag, redo_status, resolved_at, process_md, notes, updated_at)
```

几个容易踩的点：

- `correct` 三态：`1` 对、`0` 错、`NULL` **未判定**。算正确率要 `where correct is not null`，否则分母偏大。
- `topic` 在 `questions` 上，是中文展示名；`topic_id` 才是知识树里的 id。
- `attempts` 与 `sessions` 是 `session_id` 关联，日期在 `sessions.date`（`YYYY-MM-DD`）。
- `redo_status` 是自由文本（`待重做`、`重做 1 次 ✅`），不是枚举；`resolved_at` 才是销账时间。
- `content_md` 是 Markdown + LaTeX，聚合时别 `select *`。

## 4. 常用查询

### 总览

```sql
select (select count(*) from papers) 卷,
       (select count(*) from questions) 题,
       (select count(*) from sessions) 场,
       (select count(*) from attempts) 作答,
       (select count(*) from attempts where correct is null) 未判定
```

### 按知识点正确率

```sql
select q.topic 知识点, count(*) 题次,
       round(100.0*sum(a.correct)/count(*),1) 正确率
from attempts a join questions q on q.id = a.question_id
where a.correct is not null
group by q.topic
having count(*) >= 10
order by 正确率
```

### 各卷掌握度

```sql
select p.slug 卷, count(*) 作答, sum(a.correct) 对,
       round(100.0*sum(a.correct)/count(*),1) 正确率
from attempts a
join questions q on q.id = a.question_id
join papers p on p.slug = q.paper_slug
where a.correct is not null
group by p.slug order by 正确率 desc
```

### 逐日趋势（最近 14 天有记录的日子）

```sql
select s.date 日期, count(*) 题数, sum(a.correct) 对,
       round(avg(s.duration_min),0) 均时长分钟
from attempts a join sessions s on s.id = a.session_id
group by s.date order by s.date desc limit 14
```

### 最长连续学习日（窗口函数）

```sql
with d as (select distinct date from sessions),
     g as (select date, julianday(date) - row_number() over (order by date) grp from d)
select min(date) 起, max(date) 止, count(*) 天数
from g group by grp order by 天数 desc limit 3
```

### 待重做清单（带原题和错误标签）

```sql
select q.id 题, q.topic 知识点, a.error_tag 标签, s.date 首次日期,
       a.redo_status 状态, substr(replace(q.content_md, char(10), ' '), 1, 40) 题干
from attempts a
join questions q on q.id = a.question_id
join sessions s on s.id = a.session_id
where a.redo_status is not null
  and a.redo_status not like '%✅%'
order by s.date
```

### 错误标签分布

```sql
select coalesce(error_tag, '（未标）') 标签, count(*) 次数
from attempts where correct = 0
group by error_tag order by 次数 desc
```

### 同一题做过几次

```sql
select q.id 题, count(*) 次数, sum(a.correct) 对, max(s.date) 最近
from attempts a join questions q on q.id = a.question_id
join sessions s on s.id = a.session_id
group by a.question_id having count(*) >= 2
order by 次数 desc, 最近 desc
```

### 某题的历次作答

```sql
select s.date 日期, a.user_answer 作答, a.correct 对, a.error_tag 标签, a.redo_status 重做
from attempts a join sessions s on s.id = a.session_id
where a.question_id = '2024-exam-q003'
order by s.date
```

### 还没做过的题

```sql
select p.slug 卷, count(*) 未作答
from questions q
join papers p on p.slug = q.paper_slug
left join attempts a on a.question_id = q.id
where a.id is null
group by p.slug order by 未作答 desc
```

### 时长分布（哪些场次超时）

```sql
select s.date 日期, p.slug 卷, s.duration_min 时长, s.question_count 题数,
       round(s.duration_min / s.question_count, 1) 每题分钟
from sessions s join papers p on p.slug = s.paper_slug
where s.duration_min is not null
order by 每题分钟 desc limit 10
```

### 页面口径的聚合（不想自己算就用这个）

页面的统计有既定口径：学习天数按 `sessions.date`、进度按题号去重、卷掌握度还带 `scorePartial`
标记。自己写 SQL 照抄容易漏条件，直接取渲染页表时**已经算好的那一份**：

```bash
```

`section` 可选 `meta` / `stats` / `today` / `days` / `weeks` / `currentWeekKey` / `countdown` /
`volumes` / `knowledge` / `warnings`；不带 `section` 返回全集（约 96 KB）。它是页面数据的原样对象，
与页面同一时刻、同一口径——**写库后两者一起变，不存在第二个统计口径**。

要用 SQL 自己算也可以，但那些口径差异（`correct` 三态、`distinct` 去重、`duration_min` 为空不估算）
得自己对齐；能取现成的就别重算。

### 本月 vs 上月

```sql
select substr(s.date,1,7) 月份, count(*) 题次,
       round(100.0*sum(a.correct)/count(*),1) 正确率
from attempts a join sessions s on s.id = a.session_id
where a.correct is not null
group by 月份 order by 月份 desc
```

## 5. 边界

| 限制 | 值 | 说明 |
|---|---|---|
| 只读 | 强制 | 连接 `readOnly` + `PRAGMA query_only`，双保险 |
| 语句数 | 1 条 | 分号后还有内容直接拒 |
| 首关键字 | `select` / `with` / `explain` / `values` / `pragma` | 写关键字（insert/update/drop…）即使藏在子查询也被拒 |
| PRAGMA | 白名单 | 只放行 `table_info`、`index_list` 这类只读的 |
| SQL 长度 | 8000 字节 | 长查询写成 `.sql` 文件更省事 |
| 结果行数 | 默认 1000，硬顶 5000 | `--max-rows` 调；超了会标 `truncated` |
| 执行时间 | SSH：服务器端 `timeout 20s`；HTTP：子进程 20s 后 SIGKILL | 递归 CTE 写错不会拖死进程，也不会卡住页面服务 |
| HTTP 鉴权 | Bearer token | `/api/sql` 与写接口共用同一把 token；缺了返回 401 |

写不进去是设计如此。要改数据用 `mem a set ...`，走 `/api/attempts/:id`，那边会做快照和页面重建。

## 6. 给 Agent 用

```bash
# 要解析就加 --json，结构固定：{ok, columns, rows, count, truncated, ms, db}
mem sql --json "select ..." | jq '.rows'

# 换机器了 / 本机没有 SSH 密钥：走 HTTPS 接口，输出结构与 SSH 那条完全一致
mem sql --http --json "select ..." | jq '.rows'

# 长查询写文件，避免 shell 引号
mem sql -f /tmp/q.sql --json
```

`--http` 的 `db` 字段是接口地址（`https://geyuqi.me/api/sql`），不是文件路径——
判断「这份结果来自真源还是本机镜像」看这一行就够了。

约定：

1. **先用 `mem schema` 确认字段**，别猜（`topic` 不是 `topic_id`，`date` 在 `sessions` 上）。
2. 只读查询随便跑；要改数据一律回到 `mem a set` / `mem s new`。
3. 聚合一律带 `where correct is not null`，否则未判定的会被算成错。
4. 结果超过 1000 行说明查询没收敛，加 `group by` 或 `limit`，别调大 `--max-rows`。

## 7. 排错

| 现象 | 原因 |
|---|---|
| `连不上 root@...（SSH 免密没配好？）` | 换机器了：`mem sql --http` 走 HTTPS，或 `--ssh user@host`、配 `~/.ssh/config` |
| `401 unauthorized`（`--http`） | token 缺失或不匹配：`~/.mem-api-token`、`MEM_WRITE_TOKEN`，或 `--token` |
| `408 timeout`（`--http`） | 查询没收敛，20s 被掐断：加 `limit` 或收窄 `where` |
| `no such column: topic` on attempts | 字段在 `questions` 上，要 join |
| `只允许单条语句` | 分号后面还有第二条，拆开跑 |
| `PRAGMA x 不在只读白名单里` | 只读执行器不开放带副作用的 pragma |
| 本机结果和线上不一致 | 镜像旧了，`mem pull`；输出末尾会提示镜像多少小时没更新 |
| 执行超时 | 查询太贵，加 `limit` 或收窄 `where` |
