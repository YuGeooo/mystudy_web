# 线上部署说明

线上地址：<https://geyuqi.me/study/>（API 在 `/api/*`）

服务器：阿里云 ECS `121.89.87.48`（Alibaba Cloud Linux 3，x86_64），登录 `root`。

## 目录布局

```
/opt/node22                 Node 22.23.4（独立安装，不替换系统 /usr/bin/node 20）
/www/app                    站点仓库（样式与构建链）。页面已不从这里渲染，仅 Tailwind 构建时用
/www/mem                    旧数据仓库，v2 起不再被拉取，仅作存档
/www/data                   ★ 线上数据（mem.db + 三份 JSON），读写都在这里
  incoming/                 推数据时的落地目录，替换后清空
  backups/                  写接口每次写库前的自动快照，保留最近 20 份
/www/api                    ★ 常驻 Node 服务（systemd: mem-api.service）
  config.local.json         线上配置（write.enabled=true）
  mem-api.env               写接口 token（600 root:root，不进版本库）
  server/                   API + 页面服务，由 ./deploy/deploy-api.sh 同步
  web/render/               页面渲染器（新架构下归本仓库管，不再软链站点仓库）
  web/assets/               Tailwind 预编译样式 app.css + KaTeX 的样式与字体（试卷页公式）
  node_modules/             第三方依赖（marked + katex，约 4.4 MB），随代码打包过来，服务器不跑 npm
  .rollback/                每次部署前的代码备份，保留 10 份
  data -> /www/data         软链
/www/builder                静态构建器与部署脚本
  server/build-site.mjs     SQLite → 静态站点（现在只用于手动兜底构建）
  web/render -> /www/app/scripts/build/lib    渲染器软链，代码只有一份
  build-release.sh          构建到指定目录
  deploy.sh                 部署 v2（git pull + 构建 + 软链切换）
  apply-data.sh             原子替换数据 + 重启 API
/www/releases/<TS>/         每次静态构建一份，保留最近 5 份
/www/site -> /www/releases/<TS>   ★ 最近一次静态构建，现在只是回滚兜底，线上不再读
/www/backup/<YYYYMMDD>/     每日备份（mem.db + 三份 JSON），保留 14 天
```

## 请求怎么被服务

```
浏览器 → nginx → 127.0.0.1:8137（mem-api.service）
                  ├─ /study/*  → 内存页表，196 个页面，命中即返回（带 ETag，可 304）
                  └─ /api/*    → SQLite 读写
```

页面**不再**是 `/www/site` 里的静态文件。`mem-api` 启动时把库渲染成一张
`Map<路径, HTML>` 存在内存里，每次写库成功后重建（线上 40~230ms），
所以写完立刻可见，没有构建产物、没有定时任务、没有等待窗口。

代价是页面可用性绑在这个进程上：进程挂了 nginx 会返回 502（以前静态文件还在）。
缓解手段：`Restart=on-failure` 自动拉起；重建失败时保留上一版页表，宁可发旧页面也不白屏；
真出事可以临时把 nginx 的 `/study/` 切回 `alias /www/site/`（见文末回滚）。

## 数据流

线上是**可写入的那一份真源**。改数据有两条路，日常走第一条：

```
① 写接口（日常）── 不在电脑前也能用
   curl -X POST https://geyuqi.me/api/sessions -H "Authorization: Bearer $TOKEN" ...
     ├─ 写库前 VACUUM INTO 快照 → /www/data/backups/
     ├─ 单事务落库
     ├─ 重导 index.json / content.json
     └─ 重建内存页表 → 响应返回时页面已经是新的

② 本机改库 → 覆盖线上（应急，FORCE=1）
   本机 mem.db → FORCE=1 ./scripts/push-data.sh
     ├─ WAL checkpoint + sync.sh 导出
     ├─ 先触发 mem-backup 备份现网
     ├─ scp 到 /www/data/incoming/
     └─ ssh 执行 apply-data.sh → integrity_check → 停/换/起 → 页面自动跟上
```

反向同步（线上 → 本机副本）：`./scripts/pull-data.sh`。线上被写入后，本机这份会落后，
拉一次即可；拉取前脚本自动给本机现状打一份 `backups/<TS>-manual/`。

**注意**：`apply-data.sh` 会把线上整体替换成本机数据，**线上新建的场次会消失**。
只在确认线上被改坏时使用。

## 写接口

| 项 | 值 |
|---|---|
| 状态 | 已开启（`config.local.json` 的 `write.enabled=true`） |
| 鉴权 | `Authorization: Bearer <token>`，token 在 `/www/api/mem-api.env`（`MEM_WRITE_TOKEN`，64 位 hex） |
| 本机副本 | `~/.mem-api-token`（600），脚本里用 `TOKEN=$(cat ~/.mem-api-token)` |
| 反向代理 | nginx `/api/` → `127.0.0.1:8137`，`client_max_body_size 2m` |
| 限流 | `limit_req zone=mem_api rate=5r/s burst=20 nodelay`，超限 429 |
| 接口清单 | [doc/api-design.md](../doc/api-design.md) |

```bash
# 健康检查（能看到 writeEnabled 是否为 true）
curl -s https://geyuqi.me/api/health

# 记一场
TOKEN=$(cat ~/.mem-api-token)
curl -X POST https://geyuqi.me/api/sessions \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"paperSlug":"2024-exam","date":"2026-11-11","timingMode":"session","durationMin":35,
       "attempts":[{"questionId":"2024-exam-q001","userAnswer":"D"}]}'
```

写模式的硬边界：`write.enabled=true` 但没有 `MEM_WRITE_TOKEN`（或短于 16 字符），
进程**直接拒绝启动**，不会留一个半开的服务。

## 部署 API 代码

改了 `server/*.mjs`、`web/render/*.mjs` 或依赖之后，从本机推送（只传代码与依赖，
不碰数据与配置）：

```bash
./deploy/deploy-api.sh
```

流程：

1. 本机检查 `node_modules/marked`、`node_modules/katex` 存在，否则拒绝打包（避免推出一个缺依赖的版本）
2. 打包 `server/`、`web/render/`、`web/assets/app.css`、`node_modules/`（约 216 KB）
3. 服务器上解到暂存目录，逐个 `node --check`，并确认包里有 `node_modules/marked`、`node_modules/katex` 与 `web/assets/katex`；
   随后（仍在停服务前）跑 `server/migrate-v2.mjs` 做库结构迁移（幂等，v2 已迁过则是 no-op），
   失败就原样退出，线上不受影响
4. 备份旧代码到 `.rollback/`（保留 10 份）
5. 停服务 → 换 `server`、`web/render`、`web/assets`、`node_modules` → 起服务
6. 健康检查：服务 active、页表 ≥ 100 页、`import('marked')` 与 `import('katex')` 可解析、
   `/study/`、一个**原文页**、一个**试卷页**与 KaTeX 的 CSS/字体都返回 200
   （原文页验 marked，试卷页与字体验 katex，能确认依赖真的可用）
7. 全部通过后才删掉旧的 `node_modules.old`；任一步失败自动回滚代码

**依赖不走 npm**：服务器不需要联网装包，`node_modules` 直接从本机打包过去。
版本由本机 `package-lock.json` 锁定，`package.json` 改动会被 pre-commit 钩子拦下（没带锁文件不让提交）。

配置（`config.local.json`）与 token（`mem-api.env`）**不在同步范围内**，必须在服务器上单独改。


## 常用命令

把线上最新数据同步回本机副本：

```bash
./scripts/pull-data.sh
```

用本机数据覆盖线上（应急，会让线上新记录消失）：

```bash
FORCE=1 ./scripts/push-data.sh
```

改完 `server/*.mjs` 或 `web/render/*.mjs` 重新部署（会一起同步页面渲染器与样式）：

```bash
./deploy/deploy-api.sh
```

页面不用手动刷新——进程内的页表自动跟上。只有绕过写接口直接改了库，才需要重导一次：

```bash
curl -X POST https://geyuqi.me/api/export -H "Authorization: Bearer $(cat ~/.mem-api-token)"
```

看日志：

```bash
ssh root@121.89.87.48 'journalctl -u mem-api -n 40 --no-pager'
ssh root@121.89.87.48 'journalctl -u mem-api -f'          # 跟着看
curl -s https://geyuqi.me/api/health | grep -A12 '"site"' # 页表版本 / 页数 / 上次重建耗时
```

看线上快照 / 手动打一份：

```bash
curl -s https://geyuqi.me/api/backups | head -40
curl -X POST -H "Authorization: Bearer $(cat ~/.mem-api-token)" https://geyuqi.me/api/backups
```

## 自动构建（已停用）

`geyuqi-deploy.timer` 原本每 5 分钟跑一次 `deploy.sh`：`git pull` 站点仓库 → 检测 `/www/data`
哈希变化 → 构建静态文件 → 软链切换。**页面改成运行时渲染后它没有存在意义了**，已停止并
`disable`，否则每 5 分钟白构建 172 个没人读的文件。

```bash
# 查看状态
ssh root@121.89.87.48 'systemctl status geyuqi-deploy.timer'
```

脚本本身保留，是静态兜底构建的入口（`deploy.sh` 与 `build-release.sh` 都没删）：

```bash
# 手动产一份静态 release 到 /www/releases/<TS>（不切换线上）
ssh root@121.89.87.48 'sudo -u deploy /www/builder/deploy.sh'
```

真要恢复定时构建：

```bash
ssh root@121.89.87.48 'systemctl enable --now geyuqi-deploy.timer'
```

但注意：nginx 的 `/study/` 已经指向 Node，定时构建出来的静态文件没人访问，
除非你把 nginx 也切回 `alias /www/site/`。

## 备份

三层，从近到远：

**① 写接口写前快照**（`/www/data/backups/<TS>-<方法>-<资源>/`，保留 20 份）

每次调写接口前自动生成，内容与下面那份一样。`GET /api/backups` 可以列出来。
恢复要停服务，所以只提供命令行：把快照里的 `mem.db` 拷回 `/www/data/`（知识树与卷注册都在库里），
`chown deploy:deploy`，重启 `mem-api`，再触发一次重建。

**② 每日全量备份**（`/www/backup/<YYYYMMDD>/`，保留 14 天）

`mem-backup.timer` 每天 03:30（±5 分钟随机延迟）执行 `backup-db.sh`：

- `sqlite3 .backup` 热备份（对正在写的连接也安全，不需要停服务）
- 同时拷走 `index.json` / `content.json`，保证三份文件属于同一时点
- 备份后跑 `PRAGMA integrity_check`，失败则删掉本次备份并报错退出

手动触发与检查：

```bash
ssh root@121.89.87.48 'systemctl start mem-backup.service'
ssh root@121.89.87.48 'journalctl -u mem-backup -n 10 --no-pager'
ssh root@121.89.87.48 'ls -lh /www/backup/'
```

从每日备份恢复：

```bash
ssh root@121.89.87.48 '
  D=$(ls -1dt /www/backup/20* | head -1)
  systemctl stop mem-api
  rm -f /www/data/mem.db-wal /www/data/mem.db-shm
  cp "$D"/mem.db "$D"/index.json "$D"/content.json /www/data/
  chown deploy:deploy /www/data/*
  systemctl start mem-api
  systemctl start geyuqi-deploy.service
'
```

**③ 本机副本**：`./scripts/pull-data.sh` 拉一份回来，再用 `./scripts/backup.sh` 留档。

注意：三层都在**同一台服务器 + 同一台电脑**上，只能防误操作与文件损坏，防不了机器故障。
要真正异地，就把 `backups/` 里的压缩包同步到网盘或另一台机器。

## 回滚

**代码回滚**（`deploy-api.sh` 部署失败时会自动做，也可以手动）：

```bash
ssh root@121.89.87.48 '
  cd /www/api
  ls -1t .rollback/            # 挑一份 .rollback/server-<TS>.tar.gz
  systemctl stop mem-api
  rm -rf server web/render
  tar xzf .rollback/server-<TS>.tar.gz
  tar xzf .rollback/web-<TS>.tar.gz
  chown -R deploy:deploy server web
  systemctl start mem-api
'
```

**页面临时退回静态托管**（Node 出问题、想先保住能打开）：

```bash
ssh root@121.89.87.48 '
  cp -a /etc/nginx/conf.d/geyuqi.me.conf /root/geyuqi.me.conf.ssr.bak
  python3 - <<PY
p="/etc/nginx/conf.d/geyuqi.me.conf"
s=open(p).read()
s=s.replace("""location /study/ {
        proxy_pass http://127.0.0.1:8137;""","""location /study/ {
        alias /www/site/;
        index index.html;
        error_page 404 /study/404.html;
        return 200;""")
open(p,"w").write(s)
PY
  nginx -t && systemctl reload nginx
'
```

注意这条只保页面，写接口仍然只更新库和 JSON——静态页会停在上一次构建的样子。
先确认 `/www/site` 里有一份可用的 release（`ls -l /www/site`）。

**数据回滚**两条路：

- 只改了少量东西 → 拿 `/www/data/backups/` 里的快照盖回去（见上面「备份」）
- 要整份退回某个时点 → 本机 `./scripts/restore.sh <备份目录>` 恢复到底层库，再 `FORCE=1 ./scripts/push-data.sh`

## 整体回退到旧架构（v1，git 驱动）

若需完全回到上线前状态：

```bash
ssh root@121.89.87.48 '
  systemctl stop mem-api.service
  systemctl disable mem-api.service
  systemctl stop geyuqi-deploy.timer
  cp /etc/systemd/system/geyuqi-deploy.service.bak.* /etc/systemd/system/geyuqi-deploy.service
  systemctl daemon-reload
  ln -sfn /www/releases/20261111-091042 /www/site
  systemctl start geyuqi-deploy.timer
'
```

nginx 配置备份在 `/etc/nginx/conf.d/geyuqi.me.conf.bak.*`（上线时的 `20261111-164122`，
加写接口限流时的 `20261111-2204*`），恢复后 `nginx -t && systemctl reload nginx`。

## 注意

- 服务器上有两套 Node：系统 `/usr/bin/node` v20（给 `npm run build` 用）与 `/opt/node22/bin/node` v22（API 与构建器用）。**不要**把系统 Node 升级或替换，`deploy.sh` 依赖系统 Node 跑 Tailwind。
- `mem-api` 以 `deploy` 用户运行，`ProtectSystem=strict`，只允许写 `/www/data`（SQLite 需要写 `-shm` / `-wal`，导出 JSON 与写前快照也落在那里）。
- `mem.db` 替换后必须重启 `mem-api`，否则进程持有的仍是旧文件句柄。
- 写接口需要 `mem-api.env` 存在且含 `MEM_WRITE_TOKEN`。**删了这个文件服务起不来**——这是故意的，宁可停服也不留半开的口子。
- **页面由 `mem-api` 进程提供**，进程挂了 `/study/` 就是 502（静态文件已经不用了）。
  `Restart=on-failure` 会自动拉起；重建失败时旧页表继续服务，不会白屏。
- 页表常驻内存，实测 RSS 约 130 MB、171 页；每次写库重建 40~230 ms，期间请求串行排队——
  单人使用没有感知，将来真要多端高并发再说。
- **依赖只有 `marked` 与 `katex`，随代码一起打包**，落在 `/www/api/node_modules`。不要在服务器上跑
  `npm install`——版本以本机 `package-lock.json` 为准，改了依赖就走 `npm ci` + `deploy-api.sh`。
  旧架构在 `/www/api/web/node_modules` 留过一份副本，已清掉：两份并存会让 `web/render/`
  优先解析到那份旧的，改了依赖却看不出变化。
- 改了 `server/*.mjs`、`web/render/*.mjs` 或依赖都要跑 `./deploy/deploy-api.sh`，
  **不要**只改 `/www/api` 里的文件（下次部署会被覆盖）。
- nginx 那两个 `conflicting server name "_"` 警告是别的 `conf.d` 文件带的，与本站无关，可以忽略。
