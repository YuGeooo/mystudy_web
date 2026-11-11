#!/usr/bin/env bash
# 统一测试入口。依次跑：预检 → 语法 → 导出等价 → SQL 执行器 → 写接口 → CLI → 只读链路。
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

echo '=== 0/6 环境预检 ==='
./scripts/preflight.sh

echo
echo '=== 1/6 语法检查 ==='
./scripts/check.sh

echo
echo '=== 2/6 导出等价性（Node 导出器 vs Python 导出器，逐字段 + 键顺序）==='
# compare-export 读 data/test.db；它可能刚被清理过，这里按需从正式库复制一份。
if [ ! -e data/test.db ]; then
  sqlite3 data/mem.db ".backup 'data/test.db'"
  rm -f data/test.db-wal data/test.db-shm
  echo '  已从 data/mem.db 生成测试库'
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo '  跳过：本机没有 python3。这一步用于保证两套导出器输出完全一致，' >&2
  echo '        只影响迁移期的交叉校验，不影响服务运行。' >&2
else
  node scripts/compare-export.mjs
fi

echo
echo '=== 3/6 SQL 执行器（只读闸门 + 文档里的查询能不能跑）==='
node server/test-sql.mjs

echo
echo '=== 4/6 写接口自测（在 data/test.db 上跑，正式库不动）==='
if curl -fsS --max-time 1 http://127.0.0.1:8138/api/health >/dev/null 2>&1; then
  echo '  8138 已被占用，测试需要自己起进程。先停掉它：kill $(lsof -tiTCP:8138 -sTCP:LISTEN)' >&2
  exit 1
fi
node server/test-write-api.mjs

echo
echo '=== 5/6 CLI 验收（日常命令的退出码 / 输出 / --json / --dry-run）==='
if curl -fsS --max-time 1 http://127.0.0.1:8138/api/health >/dev/null 2>&1; then
  echo '  8138 已被占用，测试需要自己起进程。先停掉它：kill $(lsof -tiTCP:8138 -sTCP:LISTEN)' >&2
  exit 1
fi
node server/test-cli.mjs

echo
echo '=== 6/6 只读链路回归 ==='
# 本机 8137 不再常驻（省一个后台进程），没起就临时起一个，跑完立刻停。
SMOKE_PID=""
cleanup_smoke() {
  if [ -n "$SMOKE_PID" ] && kill -0 "$SMOKE_PID" 2>/dev/null; then
    kill "$SMOKE_PID" 2>/dev/null || true
  fi
}
trap cleanup_smoke EXIT

if [ "${SKIP_SMOKE:-0}" = "1" ]; then
  echo '  跳过（SKIP_SMOKE=1）'
else
  if ! curl -fsS --max-time 1 http://127.0.0.1:8137/api/health >/dev/null 2>&1; then
    echo '  8137 没有服务，临时启动（跑完自动停）'
    SKIP_SYNC=$([ -s data/index.json ] && echo 1 || echo 0) ./dev.sh >/tmp/mem-smoke-server.log 2>&1 &
    SMOKE_PID=$!
    for _ in $(seq 1 60); do
      curl -fsS --max-time 1 http://127.0.0.1:8137/api/health >/dev/null 2>&1 && break
      sleep 0.2
    done
  fi
  node server/smoke-test.mjs
  cleanup_smoke
  SMOKE_PID=""
fi

echo
printf '全部通过。\n'
