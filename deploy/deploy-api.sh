#!/usr/bin/env bash
# 把本机的 API 代码、页面渲染器、样式推到线上 /www/api，重启 mem-api 并做健康检查。
#
# 同步范围（只这三个，数据与配置不碰）：
#   server/*.mjs        API 与页面服务
#   web/render/*.mjs    页面渲染器（新架构下页面由这个进程渲染，归本仓库管）
#   web/assets/app.css  Tailwind 预编译样式
#
# 数据（/www/data）与配置（config.local.json、mem-api.env）都在服务器上单独维护，
# 这里绝不覆盖 —— 配置里带着写接口的开关和 token。
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

cd "$ROOT"

# 测试文件留在本机：服务器上没有测试库，传上去只会占地方。
tar czf "$PKG" \
  --exclude='test-write-api.mjs' --exclude='smoke-test.mjs' \
  server/*.mjs web/render/*.mjs web/assets/app.css
echo "[api] 打包 $(tar tzf "$PKG" | grep -cv '/$' || true) 个文件"

scp -q $SSH_OPTS "$PKG" "$SERVER:/tmp/mem-api-$TS.tar.gz"
rm -f "$PKG"

ssh $SSH_OPTS "$SERVER" "bash -s -- /tmp/mem-api-$TS.tar.gz '$API_DIR' '$TS'" <<'REMOTE'
set -euo pipefail

PKG="$1"; API_DIR="$2"; TS="$3"
NODE=/opt/node22/bin/node

cd "$API_DIR"

# ---- 1. 解到暂存区并做语法预检：坏代码不进生产 ----
STAGE=".stage-$TS"
rm -rf "$STAGE"
mkdir -p "$STAGE"
tar xzf "$PKG" -C "$STAGE"
rm -f "$PKG"
for f in "$STAGE"/server/*.mjs "$STAGE"/web/render/*.mjs; do
  "$NODE" --check "$f" >/dev/null || { echo "[api] 语法错误：$f" >&2; rm -rf "$STAGE"; exit 1; }
done
echo "[api] 语法预检通过（server $(ls -1 "$STAGE"/server/*.mjs | wc -l | tr -d ' ') 个 / render $(ls -1 "$STAGE"/web/render/*.mjs | wc -l | tr -d ' ') 个）"

# ---- 2. 备份旧代码 ----
mkdir -p .rollback
if [ -d server ]; then tar czf ".rollback/server-$TS.tar.gz" server; fi
if [ -d web/render ]; then tar czf ".rollback/web-$TS.tar.gz" web/render; fi
ls -1t .rollback/server-*.tar.gz 2>/dev/null | tail -n +11 | xargs -r rm -f

# ---- 3. 换代码 + 重启 ----
systemctl stop mem-api.service

rm -rf server.old
mv server server.old 2>/dev/null || true
mv "$STAGE/server" server

mkdir -p web
rm -rf web/render
mkdir -p web/render
cp "$STAGE"/web/render/*.mjs web/render/
mkdir -p web/assets
cp "$STAGE"/web/assets/app.css web/assets/app.css

rm -rf "$STAGE" server.old
chown -R deploy:deploy server web
chmod -R u=rwX,go=rX server web

systemctl start mem-api.service
sleep 3

if ! systemctl is-active --quiet mem-api.service; then
  echo "[api] 启动失败，回滚到 $TS 之前的代码" >&2
  journalctl -u mem-api.service -n 30 --no-pager >&2 || true
  rm -rf server
  tar xzf ".rollback/server-$TS.tar.gz"
  tar xzf ".rollback/web-$TS.tar.gz"
  chown -R deploy:deploy server web
  systemctl start mem-api.service
  exit 1
fi

# ---- 4. 健康检查：不只看 200，还要确认页表真的建起来了 ----
BODY="$(curl -sS --max-time 10 http://127.0.0.1:8137/api/health || echo '')"
echo "[api] health: $BODY"
PAGES="$(printf '%s' "$BODY" | sed -n 's/.*"pages": *\([0-9]*\).*/\1/p')"
if [ -z "$PAGES" ] || [ "$PAGES" -lt 100 ]; then
  echo "[api] 页表异常（pages=${PAGES:-空}），服务在跑但页面可能不可用" >&2
  exit 1
fi

# ---- 5. 抽检一个真实页面 ----
CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:8137/study/ || echo 000)"
echo "[api] /study/ → HTTP $CODE"
[ "$CODE" = "200" ] || { echo "[api] 页面不可用，请检查日志" >&2; exit 1; }

echo "[api] 完成：$API_DIR @ $TS（页表 $PAGES 页）"
REMOTE

echo "[api] 已部署。检查：curl -s https://geyuqi.me/api/health"
