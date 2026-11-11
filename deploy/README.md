# 线上部署说明

线上地址：<https://geyuqi.me/study/>（API 在 `/api/*`）

服务器：阿里云 ECS `121.89.87.48`（Alibaba Cloud Linux 3，x86_64），登录 `root`。

## 目录布局

```
/opt/node22                 Node 22.23.4（独立安装，不替换系统 /usr/bin/node 20）
/www/app                    站点仓库（渲染器、Tailwind、样式），git pull 来源不变
/www/mem                    旧数据仓库，v2 起不再被拉取，仅作存档
/www/data                   ★ 线上数据（mem.db + 三份 JSON），只读 API 的数据源
  incoming/                 推数据时的落地目录，替换后清空
/www/api                    Node 只读 API 服务（systemd: mem-api.service）
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

```
本机 mem.db（唯一真源）
  └─ ./scripts/push-data.sh
       ├─ WAL checkpoint
       ├─ sync.sh 导出 index.json / content.json
       ├─ scp 到 /www/data/incoming/
       └─ ssh 执行 apply-data.sh
            ├─ sqlite3 integrity_check 校验
            ├─ 停 mem-api → 换 4 个文件 → 启 mem-api
            └─ 触发 geyuqi-deploy.service（hash 变了 → 重新构建页面）
```

**关键**：服务器上的 `mem.db` 是只读副本，不在这里写入。改数据永远在本机改，然后 `push-data.sh`。

## 常用命令

改完数据后推送（在本机 `mem_new/` 下）：

```bash
./scripts/push-data.sh
```

线上手动重建（改了渲染器或想强制刷新）：

```bash
ssh root@121.89.87.48 'sudo -u deploy /www/builder/deploy.sh'
```

看部署日志：

```bash
ssh root@121.89.87.48 'journalctl -u geyuqi-deploy -n 30 --no-pager'
ssh root@121.89.87.48 'journalctl -u mem-api -n 30 --no-pager'
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

`mem-backup.timer` 每天 03:30（±5 分钟随机延迟）执行 `backup-db.sh`：

- `sqlite3 .backup` 热备份（对只读连接安全，不需要停服务）
- 同时拷走 `index.json` / `content.json` / `volumes.json`，保证四份文件属于同一时点
- 备份后跑 `PRAGMA integrity_check`，失败则删掉本次备份并报错退出
- 保留最近 14 份，即 `KEEP=14`

手动触发与检查：

```bash
ssh root@121.89.87.48 'systemctl start mem-backup.service'
ssh root@121.89.87.48 'journalctl -u mem-backup -n 10 --no-pager'
ssh root@121.89.87.48 'ls -lh /www/backup/'
```

从备份恢复：

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

注意：备份在**同一台服务器**上，只防误操作与文件损坏，不防机器故障。真正的异地副本要靠本机 `mem.db`（唯一真源）或把备份同步到别处。

## 回滚

页面回滚（秒级，不需要重新构建）：

```bash
ssh root@121.89.87.48 '
  ln -sfn /www/releases/<上一份TS> /www/site
  curl -sk -o /dev/null -w "%{http_code}\n" --resolve geyuqi.me:443:127.0.0.1 https://geyuqi.me/study/
'
```

数据回滚：把本机 `mem.db` 恢复到目标版本，再 `./scripts/push-data.sh`。

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

nginx 配置备份在 `/etc/nginx/conf.d/geyuqi.me.conf.bak.20261111-164122`，
恢复后 `nginx -t && systemctl reload nginx`。

## 注意

- 服务器上有两套 Node：系统 `/usr/bin/node` v20（给 `npm run build` 用）与 `/opt/node22/bin/node` v22（API 与构建器用）。**不要**把系统 Node 升级或替换，`deploy.sh` 依赖系统 Node 跑 Tailwind。
- `mem-api` 以 `deploy` 用户运行，`ProtectSystem=strict`，只允许写 `/www/data`（SQLite 需要写 `-shm` / `-wal`）。
- `mem.db` 替换后必须重启 `mem-api`，否则进程持有的仍是旧文件句柄。
- 数据库只读 API 无任何写接口，非 GET 请求返回 405。
