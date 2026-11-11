#!/usr/bin/env bash
# 本机数据库备份（真源的兜底副本）。
#
#   ./scripts/backup.sh          手动备一份
#   KEEP=60 ./scripts/backup.sh  改保留份数
#
# 目录结构与本机写接口自动生成的快照一致：backups/<TS>-<原因>/{mem.db,volumes.json}
# 这样恢复脚本不用区分「API 快照」和「手动备份」。
set -euo pipefail
cd "$(dirname "$0")/.."

DB="${MEM_DB:-data/mem.db}"
BACKUP="${MEM_BACKUP_DIR:-backups}"
KEEP="${KEEP:-30}"
TS="$(date +%Y%m%d-%H%M%S)"
D="$BACKUP/$TS-manual"

[ -f "$DB" ] || { echo "[backup] 数据库不存在：$DB" >&2; exit 1; }
mkdir -p "$D"

# SQLite 自己的热备份：会把 WAL 里未落盘的页一并带上，比 cp 安全
sqlite3 "$DB" ".backup '$D/mem.db'"
# 知识树不在库里，改坏了同样要能退回
cp -f data/volumes.json "$D/volumes.json"

if ! sqlite3 "$D/mem.db" "PRAGMA integrity_check;" | grep -qx ok; then
  echo "[backup] 完整性检查失败，删除本次备份：$D" >&2
  rm -rf "$D"
  exit 1
fi

ROWS="$(sqlite3 "$D/mem.db" \
  "select (select count(*) from papers)||'/'||(select count(*) from questions)||'/'||(select count(*) from sessions)||'/'||(select count(*) from attempts);")"
SHA="$(shasum -a 256 "$D/mem.db" | cut -d' ' -f1)"
cat > "$D/meta.json" <<JSON
{
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "reason": "manual-script",
  "rows": "$ROWS",
  "sha256": "$SHA"
}
JSON

# 查询会在备份目录留下 WAL/SHM，清掉，保证备份是干净的单文件
rm -f "$D"/mem.db-wal "$D"/mem.db-shm

echo "[backup] $D ok · papers/questions/sessions/attempts = $ROWS · $(du -sh "$D" | cut -f1)"

# 只保留最近 KEEP 份（按修改时间，不按目录名）
ls -1dt "$BACKUP"/20* 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -rf
