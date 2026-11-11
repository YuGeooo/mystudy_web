#!/usr/bin/env bash
# 统一测试入口。依次跑：预检 → 语法 → 导出等价 → 写接口 → 只读链路。
#
# 设计原则：任何一步失败立刻停，不让后面的绿色输出掩盖前面的红。
# 所有写操作都发生在 data/test.db 上，正式库 data/mem.db 的 sha256 会被前后比对。
#
# 用法：
#   ./scripts/test.sh              # 全跑
#   SKIP_SMOKE=1 ./scripts/test.sh # 跳过需要 8137 在跑的只读回归
set -euo pipefail
cd "$(dirname "$0")/.."

# 测试用的写 token：只在 8138 的临时进程里有效，不是线上那把。
export MEM_WRITE_TOKEN="${MEM_WRITE_TOKEN:-testtoken-testtoken-1234}"

echo '=== 0/4 环境预检 ==='
./scripts/preflight.sh

echo
echo '=== 1/4 语法检查 ==='
./scripts/check.sh

echo
echo '=== 2/4 导出等价性（Node 导出器 vs Python 导出器，逐字段 + 键顺序）==='
if ! command -v python3 >/dev/null 2>&1; then
  echo '  跳过：本机没有 python3。这一步用于保证两套导出器输出完全一致，' >&2
  echo '        只影响迁移期的交叉校验，不影响服务运行。' >&2
else
  node scripts/compare-export.mjs
fi

echo
echo '=== 3/4 写接口自测（在 data/test.db 上跑，正式库不动）==='
if curl -fsS --max-time 1 http://127.0.0.1:8138/api/health >/dev/null 2>&1; then
  echo '  8138 已被占用，测试需要自己起进程。先停掉它：kill $(lsof -tiTCP:8138 -sTCP:LISTEN)' >&2
  exit 1
fi
node server/test-write-api.mjs

echo
echo '=== 4/4 只读链路回归 ==='
if [ "${SKIP_SMOKE:-0}" = "1" ]; then
  echo '  跳过（SKIP_SMOKE=1）'
elif curl -fsS --max-time 1 http://127.0.0.1:8137/api/health >/dev/null 2>&1; then
  node server/smoke-test.mjs
else
  echo '  跳过：8137 没有服务在跑。先 ./dev.sh 起服务，这一步才跑得起来。'
fi

echo
printf '全部通过。\n'
