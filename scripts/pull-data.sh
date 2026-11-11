#!/usr/bin/env bash
# 从线上把数据拉回本机。
#
# 线上写接口打开后，数据在服务器上改，本机这份变成「离线副本 + 备份」。
# 本机要跟着线上走，用这个脚本；反过来用本机覆盖线上是 push-data.sh 的事，
# 那是应急手段，日常不要用。
#
# 用法：./scripts/pull-data.sh
#       MEM_SERVER=root@1.2.3.4 ./scripts/pull-data.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER="${MEM_SERVER:-root@121.89.87.48}"
REMOTE_DATA="${MEM_REMOTE_DATA:-/www/data}"
SSH_OPTS="-o BatchMode=yes -o ConnectTimeout=15"
IN="$ROOT/data/incoming"
TS="$(date +%Y%m%d-%H%M%S)"

cd "$ROOT"

# ---- 1. 先给本机现状留一份，拉取本身也能反悔 ----
if [ -s data/mem.db ]; then
  ./scripts/backup.sh
fi

# ---- 2. 下载到落地目录 ----
rm -rf "$IN"
mkdir -p "$IN"
echo "[pull] 从 $SERVER:$REMOTE_DATA 下载"
scp -q $SSH_OPTS \
  "$SERVER:$REMOTE_DATA/mem.db" \
  "$SERVER:$REMOTE_DATA/index.json" \
  "$SERVER:$REMOTE_DATA/content.json" \
  "$IN/"

for f in mem.db index.json content.json; do
  [ -s "$IN/$f" ] || { echo "[pull] 缺少 $f，放弃" >&2; exit 1; }
done

# ---- 3. 校验：半截文件绝不能进 data/ ----
if ! sqlite3 "$IN/mem.db" "PRAGMA integrity_check;" | grep -qx ok; then
  echo "[pull] mem.db 完整性检查失败，放弃替换" >&2
  exit 1
fi
ROWS="$(sqlite3 "$IN/mem.db" "SELECT (SELECT COUNT(*) FROM sessions)||' 场 / '||(SELECT COUNT(*) FROM attempts)||' 条作答 / '||(SELECT COUNT(*) FROM questions)||' 题';")"
echo "[pull] 校验通过：$ROWS"

# ---- 4. 替换（本机服务若在跑，换完要重启才能看到新数据）----
rm -f data/mem.db-wal data/mem.db-shm
mv -f "$IN/mem.db" "$IN/index.json" "$IN/content.json" "$IN/volumes.json" data/
# integrity_check 会在落地目录留下 -shm / -wal，一并清掉
rm -rf "$IN"

echo "[pull] 完成：$(du -h data/mem.db | cut -f1)  mem.db / $(date '+%F %T')"
echo "[pull] 注意：本机 8137 若在运行，需重启才读得到新数据（进程握着旧文件句柄）"
