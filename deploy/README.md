# 线上部署说明

线上地址：<https://geyuqi.me/study/>（API 在 `/api/*`）

服务器：阿里云 ECS `121.89.87.48`（Alibaba Cloud Linux 3，x86_64），登录 `root`。

## 目录布局

```
/opt/node22                 Node 22.23.4（独立安装，不替换系统 /usr/bin/node 20）
/www/app                    站点仓库（渲染器、Tailwind、样式），git pull 来源不变
/www/mem                    旧数据仓库，v2 起不再被拉取，仅作存档
/www/data                   ★ 线上数据（mem.db + 三份 JSON），写接口的数据源
  incoming/                 推数据时的落地目录，替换后清空
  backups/                  写接口每次写库前的自动快照，保留最近 20 份
/www/api                    Node API 服务（systemd: mem-api.service）
  config.local.json         线上配置（write.enabled=true）
  mem-api.env               写接口 token（600 root:root，不进版本库）
  server/                   API 代码，由 ./deploy/deploy-api.sh 同步
  .rollback/                每次部署前的代码备份，保留 10 份
  data -> /www/data         软链
/www/builder                构建器与部署脚本
  server/build-site.mjs     三份 JSON → 静态站点
  web/render -> /www/app/scripts/build/lib    渲染器软链，代码只有一份
  web/site.config.json -> /www/app/site.config.json
  build-release.sh          构建到指定目录
  deploy.sh                 部署 v2（替代 /www/app/scripts/deploy.sh）
  apply-data.sh             原子替换数据 + 重启 API + 触发重建
/www/releases/<TS>/         每次构建一份，保留最近 5 份
/www/site -> /www/releases/<TS>   当前线上版本（软链）
/www/backup/<YYYYMMDD>/     每日备份（mem.db + 三份 JSON），保留 14 天
```

## 数据流

线上是**可写入的那一份真源**。改数据有两条路，日常走第一条：

```
① 写接口（日常）── 不在电脑前也能用
   curl -X POST https://geyuqi.me/api/sessions -H "Authorization: Bearer $TOKEN" ...
     ├─ 写库前 VACUUM INTO 快照 → /www/data/backups/
     ├─ 单事务落库
     ├─ 自动重导 index.json / content.json
     └─ geyuqi-deploy.timer（5 分钟）发现 data/ 哈希变了 → 重建页面

② 本机改库 → 覆盖线上（应急，FORCE=1）
   本机 mem.db → ./scripts/push-data.sh（需 FORCE=1）
     ├─ WAL checkpoint + sync.sh 导出
     ├─ 先触发 mem-backup 备份现网
     ├─ scp 到 /www/data/incoming/
     └─ ssh 执行 apply-data.sh → integrity_check → 停/换/起 → 触发重建
```

反向同步（线上 → 本机副本）：`./scripts/pull-data.sh`。线上被写入后，本机这份会落后，
拉一次即可；拉取前脚本自动给本机现状打一份 `backups/<TS>-manual/`。

**注意**：`apply-data.sh` 会把线上整体替换成本机数据，**线上新建的场次会消失**。只在确认
线上被改坏时使用。

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

改了 `server/*.mjs` 之后，从本机推送（只传代码，不碰数据与配置）：

```bash
./deploy/deploy-api.sh
```

流程：打包 → 上传 → 服务器上解到 `server.new` 逐个 `node --check` → 备份旧代码到
`.rollback/` → 停服务 / 换目录 / 起服务 → `/api/health` 不通就自动回滚。

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

改完 `server/*.mjs` 重新部署 API：

```bash
./deploy/deploy-api.sh
```

线上手动重建（改了渲染器或想立刻刷新页面）：

```bash
ssh root@121.89.87.48 'sudo -u deploy /www/builder/deploy.sh'
```

看部署日志：

```bash
ssh root@121.89.87.48 'journalctl -u geyuqi-deploy -n 30 --no-pager'
ssh root@121.89.87.48 'journalctl -u mem-api -n 30 --no-pager'
```

看线上快照 / 手动打一份：

```bash
curl -s https://geyuqi.me/api/backups | head -40
curl -X POST -H "Authorization: Bearer $(cat ~/.mem-api-token)" https://geyuqi.me/api/backups
```

## 自动部署

`geyuqi-deploy.timer` 每 5 分钟触发 `deploy.sh`，逻辑已改为：

1. `git pull` 站点仓库（渲染器 / 样式更新照旧）
2. **不再 pull `/www/mem`**
3. 对 `/www/data` 四个文件做 sha256，与 `/www/.data-hash` 比对
4. 有变化、站点有更新、或今天还没构建过 → 重新构建 + 软链切换 + 健康检查
5. 健康检查失败自动切回上一份 release

无变化时 5 分钟内直接退出，开销仅为一次 `git fetch` 与几次 `sha256sum`。

## 备份

三层，从近到远：

**① 写接口写前快照**（`/www/data/backups/<TS>-<方法>-<资源>/`，保留 20 份）

每次调写接口前自动生成，内容与下面那份一样。`GET /api/backups` 可以列出来。
恢复要停服务，所以只提供命令行：把快照里的 `mem.db` + `volumes.json` 拷回 `/www/data/`，
`chown deploy:deploy`，重启 `mem-api`，再触发一次重建。

**② 每日全量备份**（`/www/backup/<YYYYMMDD>/`，保留 14 天）

`mem-backup.timer` 每天 03:30（±5 分钟随机延迟）执行 `backup-db.sh`：

- `sqlite3 .backup` 热备份（对正在写的连接也安全，不需要停服务）
- 同时拷走 `index.json` / `content.json` / `volumes.json`，保证四份文件属于同一时点
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
  cp "$D"/mem.db "$D"/index.json "$D"/content.json "$D"/volumes.json /www/data/
  chown deploy:deploy /www/data/*
  systemctl start mem-api
  systemctl start geyuqi-deploy.service
'
```

**③ 本机副本**：`./scripts/pull-data.sh` 拉一份回来，再用 `./scripts/backup.sh` 留档。

注意：三层都在**同一台服务器 + 同一台电脑**上，只能防误操作与文件损坏，防不了机器故障。
要真正异地，就把 `backups/` 里的压缩包同步到网盘或另一台机器。

## 回滚

页面回滚（秒级，不需要重新构建）：

```bash
ssh root@121.89.87.48 '
  ln -sfn /www/releases/<上一份TS> /www/site
  curl -sk -o /dev/null -w "%{http_code}\n" --resolve geyuqi.me:443:127.0.0.1 https://geyuqi.me/study/
'
```

数据回滚两条路：

- 只改了少量东西 → 拿 `/www/data/backups/` 里的快照盖回去（见上面「备份」）
- 要整份退回某个时点 → 本机 `./scripts/restore.sh <备份目录>` 恢复到底层库，再 `FORCE=1 ./scripts/push-data.sh`

代码回滚（API 部署失败时自动做，也可以手动）：

```bash
ssh root@121.89.87.48 '
  cd /www/api
  systemctl stop mem-api
  rm -rf server
  tar xzf .rollback/server-<TS>.tar.gz
  chown -R deploy:deploy server
  systemctl start mem-api
'
```

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
- 页面更新有最长 5 分钟延迟（`geyuqi-deploy.timer` 的周期）。急着看效果就手动 `systemctl start geyuqi-deploy.service`。
- nginx 那两个 `conflicting server name "_"` 警告是别的 `conf.d` 文件带的，与本站无关，可以忽略。
