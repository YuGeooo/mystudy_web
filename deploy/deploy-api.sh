#!/usr/bin/env bash
# 把本机 server/ 的运行时代码推到线上 /www/api，重启 mem-api 并做健康检查。
#
# 只同步代码：数据（/www/data）与配置（config.local.json、mem-api.env）都在服务器上单独维护，
# 这里绝不覆盖 —— 配置里带着写接口的开关和 token，被本机配置盖掉就等于把写能力弄丢或弄松。
#
# 用法：./deploy/deploy-api.sh
#       MEM_SERVER=root@1.2.3.4 ./deploy/deploy-api.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER="${MEM_SERVER:-root@121.89.87.48}"
API_DIR="${MEM_REMOTE_API:-/www/api}"
SSH_OPTS="-o BatchMode=yes -o ConnectTimeout=15"
TS="$(date +%Y%m%d-%H%M%S)"
PKG="/tmp/mem-api-$TS.tar.gz"

cd "$ROOT/server"

# 测试文件留在本机：服务器上没有测试库，传上去只会占地方。
tar czf "$PKG" --exclude='test-write-api.mjs' --exclude='smoke-test.mjs' *.mjs
echo "[api] 打包 $(tar tzf "$PKG" | wc -l | tr -d ' ') 个文件"

scp -q $SSH_OPTS "$PKG" "$SERVER:/tmp/mem-api-$TS.tar.gz"
rm -f "$PKG"

ssh $SSH_OPTS "$SERVER" "bash -s -- /tmp/mem-api-$TS.tar.gz '$API_DIR' '$TS'" <<'REMOTE'
set -euo pipefail

PKG="$1"; API_DIR="$2"; TS="$3"
NODE=/opt/node22/bin/node

cd "$API_DIR"

# ---- 1. 语法预检（解到临时目录，坏代码不进生产）----
rm -rf server.new
mkdir -p server.new
tar xzf "$PKG" -C server.new
rm -f "$PKG"
for f in server.new/*.mjs; do
  "$NODE" --check "$f" >/dev/null || { echo "[api] 语法错误：$f" >&2; rm -rf server.new; exit 1; }
done
echo "[api] 语法预检通过（$(ls -1 server.new/*.mjs | wc -l | tr -d ' ') 个文件）"

# ---- 2. 备份旧代码 ----
mkdir -p .rollback
if [ -d server ]; then
  tar czf ".rollback/server-$TS.tar.gz" server
  # 只留最近 10 份
  ls -1t .rollback/server-*.tar.gz 2>/dev/null | tail -n +11 | xargs -r rm -f
fi

# ---- 3. 换代码 + 重启 ----
systemctl stop mem-api.service
rm -rf server.old
[ -d server ] && mv server server.old
mv server.new server
chown -R deploy:deploy server
chmod -R u=rwX,go=rX server

systemctl start mem-api.service
sleep 2

if ! systemctl is-active --quiet mem-api.service; then
  echo "[api] 启动失败，回滚到 $TS 之前的代码" >&2
  journalctl -u mem-api.service -n 20 --no-pager >&2 || true
  rm -rf server
  tar xzf ".rollback/server-$TS.tar.gz"
  chown -R deploy:deploy server
  systemctl start mem-api.service
  exit 1
fi

# ---- 4. 健康检查 ----
sleep 1
BODY="$(curl -sS --max-time 5 http://127.0.0.1:8137/api/health || echo '')"
echo "[api] health: $BODY"
case "$BODY" in
  *'"ok": true'*|*'"ok":true'*) ;;
  *) echo "[api] health 返回异常，中止（服务仍在运行，请人工检查）" >&2; exit 1 ;;
esac

rm -rf server.old
echo "[api] 完成：$API_DIR/server @ $TS"
REMOTE

echo "[api] 已部署。检查：curl -s https://geyuqi.me/api/health"
