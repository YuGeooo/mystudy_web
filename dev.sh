#!/usr/bin/env bash
# 本地开发服务：只监听 127.0.0.1，零框架、单一第三方依赖（marked）。
# 启动前先做环境预检，再导出 index.json / content.json 数据契约，最后起服务。
# 若想跳过导出直接启动，用 SKIP_SYNC=1 ./dev.sh。
set -euo pipefail
cd "$(dirname "$0")"

./scripts/preflight.sh

if [[ "${SKIP_SYNC:-0}" != "1" ]]; then
  ./scripts/sync.sh
fi

exec node server/dev.mjs
