#!/usr/bin/env bash
# 从备份恢复本机数据库。
#
#   ./scripts/restore.sh backups/20261111-193012-post-questions
#   ./scripts/restore.sh <目录> --volumes    # 连知识树 volumes.json 一起退回
#
# 恢复前会把当前库另存一份（backups/<TS>-before-restore），所以恢复本身也能反悔。
# 服务在跑的时候不要恢复：进程握着旧文件句柄，换掉文件它还在写旧库。
set -euo pipefail
cd "$(dirname "$0")/.."

SRC="${1:-}"
[ -n "$SRC" ] || { echo "用法：$0 <备份目录> [--volumes]" >&2; exit 1; }
[ -d "$SRC" ] || SRC="backups/$SRC"
[ -f "$SRC/mem.db" ] || { echo "[restore] 找不到备份：$SRC/mem.db" >&2; exit 1; }

WITH_VOLUMES=0
for a in "${@:2}"; do [ "$a" = "--volumes" ] && WITH_VOLUMES=1; done

DB="${MEM_DB:-data/mem.db}"

if [ "${FORCE:-0}" != "1" ] && curl -fsS --max-time 1 http://127.0.0.1:8137/api/health >/dev/null 2>&1; then
  echo "[restore] 8137 还有服务在跑，先停掉 ./dev.sh 再恢复（确认无妨可 FORCE=1）" >&2
  exit 1
fi

echo "[restore] 先校验备份完整性：$SRC"
if ! sqlite3 "$SRC/mem.db" "PRAGMA integrity_check;" | grep -qx ok; then
  echo "[restore] 备份本身是坏的，拒绝恢复" >&2
  exit 1
fi

TS="$(date +%Y%m%d-%H%M%S)"
SAFE="backups/$TS-before-restore"
mkdir -p "$SAFE"
if [ -f "$DB" ]; then
  sqlite3 "$DB" ".backup '$SAFE/mem.db'"
  cp -f data/volumes.json "$SAFE/volumes.json" 2>/dev/null || true
  rm -f "$SAFE"/mem.db-wal "$SAFE"/mem.db-shm
  echo "[restore] 当前库已另存：$SAFE"
fi

cp -f "$SRC/mem.db" "$DB"
rm -f "$DB-wal" "$DB-shm"
echo "[restore] 数据库已替换：$SRC/mem.db → $DB"

if [ "$WITH_VOLUMES" = "1" ] && [ -f "$SRC/volumes.json" ]; then
  cp -f "$SRC/volumes.json" data/volumes.json
  echo "[restore] 知识树也已退回：data/volumes.json"
fi

ROWS="$(sqlite3 "$DB" \
  "select (select count(*) from papers)||'/'||(select count(*) from questions)||'/'||(select count(*) from sessions)||'/'||(select count(*) from attempts);")"
echo "[restore] 恢复后 papers/questions/sessions/attempts = $ROWS"

echo "[restore] 重新导出 JSON 契约…"
./scripts/sync.sh

echo "[restore] 完成。起服务：./dev.sh"
