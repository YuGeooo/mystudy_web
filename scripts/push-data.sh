#!/usr/bin/env bash
# 把本机数据库与导出 JSON 推到线上，并触发重建。
# 用法：./scripts/push-data.sh            （默认 root@121.89.87.48）
#       MEM_SERVER=... ./scripts/push-data.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER="${MEM_SERVER:-root@121.89.87.48}"
REMOTE_DATA="${MEM_REMOTE_DATA:-/www/data}"
SSH_OPTS="-o BatchMode=yes -o ConnectTimeout=15"

cd "$ROOT"

echo "[push] 合并 WAL"
sqlite3 data/mem.db "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null

echo "[push] 导出 JSON 契约"
./scripts/sync.sh >/dev/null

for f in mem.db index.json content.json volumes.json; do
  [ -s "data/$f" ] || { echo "[push] 本地缺少 data/$f" >&2; exit 1; }
done

echo "[push] 上传（mem.db $(du -h data/mem.db | cut -f1)）"
scp -q $SSH_OPTS data/mem.db data/index.json data/content.json data/volumes.json \
  "$SERVER:$REMOTE_DATA/incoming/"

echo "[push] 服务器原子替换 + 重建"
ssh $SSH_OPTS "$SERVER" 'bash /www/builder/apply-data.sh'

echo "[push] 完成。线上站点 https://geyuqi.me/study/"
