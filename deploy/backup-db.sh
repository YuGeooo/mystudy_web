#!/usr/bin/env bash
# 每日备份线上数据（mem.db + 三份 JSON），保留 14 天。
set -euo pipefail
cd /

BACKUP=/www/backup
DATA=/www/data
KEEP="${KEEP:-14}"
TS="$(date +%Y%m%d)"
D="$BACKUP/$TS"

mkdir -p "$D"

# SQLite 在线热备份，对只读连接安全
sqlite3 "$DATA/mem.db" ".backup '$D/mem.db'"
cp -f "$DATA/index.json" "$DATA/content.json" "$DATA/volumes.json" "$D/"

if ! sqlite3 -readonly "$D/mem.db" "PRAGMA integrity_check;" | grep -qx ok; then
  echo "[backup] 完整性检查失败，删除本次备份：$D" >&2
  rm -rf "$D"
  exit 1
fi

ROWS="$(sqlite3 -readonly "$D/mem.db" \
  "select (select count(*) from questions)||'/'||(select count(*) from sessions)||'/'||(select count(*) from attempts);")"
echo "[backup] $TS ok · questions/sessions/attempts = $ROWS · $(du -sh "$D" | cut -f1)"

# 校验与查询会在备份目录留下 WAL/SHM，清掉，保证备份是干净的单文件
rm -f "$D"/mem.db-wal "$D"/mem.db-shm

ls -1dt "$BACKUP"/20* 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -rf
