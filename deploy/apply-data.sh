#!/usr/bin/env bash
# 原子替换线上数据：停 API → 换文件 → 启 API → 触发页面重建
set -euo pipefail
cd /

DATA=/www/data
IN="$DATA/incoming"

for f in mem.db index.json content.json; do
  [ -s "$IN/$f" ] || { echo "[data] 缺少 $IN/$f" >&2; exit 1; }
done

# 清掉上一轮残留的 WAL/SHM，否则新库会与旧日志配错
rm -f "$IN/mem.db-wal" "$IN/mem.db-shm"

# 数据库校验（防半截文件）
if ! sqlite3 -readonly "$IN/mem.db" "PRAGMA integrity_check;" | grep -qx ok; then
  echo "[data] mem.db 完整性检查失败，放弃替换" >&2
  exit 1
fi

echo "[data] 停 API"
systemctl stop mem-api.service

rm -f "$DATA/mem.db-wal" "$DATA/mem.db-shm"
mv -f "$IN/mem.db" "$IN/index.json" "$IN/content.json" "$DATA/"
chown deploy:deploy "$DATA"/mem.db "$DATA"/*.json
chmod 640 "$DATA"/mem.db "$DATA"/*.json

echo "[data] 启 API"
systemctl start mem-api.service
sleep 2
systemctl is-active --quiet mem-api.service || { echo "[data] API 启动失败" >&2; exit 1; }
curl -sS --max-time 5 -o /dev/null -w "[data] API health %{http_code}\n" http://127.0.0.1:8137/api/health

echo "[data] 触发页面重建"
systemctl start geyuqi-deploy.service
