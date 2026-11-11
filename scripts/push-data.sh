#!/usr/bin/env bash
# 用本机数据覆盖线上（应急用，不是日常流程）。
#
# ⚠️ 写接口打开后，线上才是被写入的那一份真源。这个脚本会把线上整体替换成本机副本，
#    线上新建的场次、改过的答案都会消失。日常同步请改用 ./scripts/pull-data.sh（线上 → 本机）。
#    只有确认「线上被改坏了、要拿本机这份盖回去」时才用它，并且必须显式 FORCE=1。
#
# 用法：FORCE=1 ./scripts/push-data.sh
#       MEM_SERVER=root@1.2.3.4 FORCE=1 ./scripts/push-data.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER="${MEM_SERVER:-root@121.89.87.48}"
REMOTE_DATA="${MEM_REMOTE_DATA:-/www/data}"
SSH_OPTS="-o BatchMode=yes -o ConnectTimeout=15"

if [ "${FORCE:-0}" != "1" ]; then
  cat >&2 <<'MSG'
[push] 已取消：这个操作会用本机数据覆盖线上。
[push] 线上现在可以被写入，强行覆盖可能丢掉线上新建的记录。
[push]   · 只想把线上数据同步回来 → ./scripts/pull-data.sh
[push]   · 确实要拿本机盖回去   → FORCE=1 ./scripts/push-data.sh
MSG
  exit 1
fi

cd "$ROOT"

echo "[push] 合并 WAL"
sqlite3 data/mem.db "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null

echo "[push] 导出 JSON 契约"
./scripts/sync.sh >/dev/null

for f in mem.db index.json content.json volumes.json; do
  [ -s "data/$f" ] || { echo "[push] 本地缺少 data/$f" >&2; exit 1; }
done

# 覆盖前先在服务器上留一份现网数据，盖错了还能捞回来
echo "[push] 线上现网先备份"
ssh $SSH_OPTS "$SERVER" 'systemctl start mem-backup.service || true'

echo "[push] 上传（mem.db $(du -h data/mem.db | cut -f1)）"
scp -q $SSH_OPTS data/mem.db data/index.json data/content.json data/volumes.json \
  "$SERVER:$REMOTE_DATA/incoming/"

echo "[push] 服务器原子替换 + 重建"
ssh $SSH_OPTS "$SERVER" 'bash /www/builder/apply-data.sh'

echo "[push] 完成。线上站点 https://geyuqi.me/study/"
