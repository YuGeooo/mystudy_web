#!/usr/bin/env bash
# 本地离线工具链：数据库（真源）→ 三份 JSON 数据契约。
# 只在开发者本机跑；服务器走静态产物，不需要 Python、也不需要本脚本。
set -euo pipefail
cd "$(dirname "$0")/.."
python3 scripts/export_index.py >/dev/null
python3 scripts/export_content.py >/dev/null
echo "已同步 data/index.json + data/content.json（volumes.json 为伴生配置）"
