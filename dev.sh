#!/usr/bin/env bash
# 本地开发服务：只监听 127.0.0.1，零 npm 依赖，不部署、不上服务器。
# 启动前自动把数据库同步成三份 JSON 契约，改库后重启即可看到站点更新。
# 若只想用现有 JSON 启动（例如本机没有 Python），用 SKIP_SYNC=1 ./dev.sh。
set -euo pipefail
cd "$(dirname "$0")"
if [[ "${SKIP_SYNC:-0}" != "1" ]]; then
  ./scripts/sync.sh
fi
exec node server/dev.mjs
