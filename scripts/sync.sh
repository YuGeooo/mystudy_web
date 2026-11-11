#!/usr/bin/env bash
# 本地离线工具链：数据库（真源）→ index.json + content.json 数据契约。
# 只在开发者本机跑；服务器上写接口提交后会当场重导，不需要本脚本。
set -euo pipefail
cd "$(dirname "$0")/.."
node server/export-cli.mjs >/dev/null
echo "已同步 data/index.json + data/content.json"
