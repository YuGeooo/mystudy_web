#!/usr/bin/env bash
# 把本机的 API 代码、页面渲染器、样式和第三方依赖推到线上 /www/api，
# 重启 mem-api 并做健康检查。
#
# 同步范围（从不碰数据与配置）：
#   server/*.mjs        API 与页面服务
#   web/render/*.mjs    页面渲染器（页面由这个进程渲染，归本仓库管）
#   web/assets/         静态资源：Tailwind 预编译样式 app.css + KaTeX 的样式与字体
#   node_modules/       第三方依赖（marked + katex，打包过去省得服务器跑 npm）
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

# 依赖没装齐就别打包：否则服务器上会带着一个"缺 marked / 缺 katex"的版本上线。
if [ ! -d node_modules/marked ]; then
  echo "[api] 本机缺 node_modules/marked —— 先跑 npm ci" >&2
  exit 1
fi
if [ ! -d node_modules/katex ]; then
  echo "[api] 本机缺 node_modules/katex —— 试卷页公式要靠它，先跑 npm ci" >&2
  exit 1
fi

# 测试文件留在本机：服务器上没有测试库，传上去只会占地方。
tar czf "$PKG" \
  --exclude='test-write-api.mjs' --exclude='smoke-test.mjs' \
  --exclude='test-cli.mjs' --exclude='test-sql.mjs' \
  --exclude='node_modules/.bin' \
  --exclude='node_modules/katex/contrib' --exclude='node_modules/katex/README.md' \
  server/*.mjs web/render/*.mjs web/assets node_modules
echo "[api] 打包 $(tar tzf "$PKG" | grep -cv '/$' || true) 个文件（含依赖 $(du -sh node_modules | cut -f1)）"

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
[ -d "$STAGE/node_modules/marked" ] || { echo "[api] 包里没有 node_modules/marked" >&2; rm -rf "$STAGE"; exit 1; }
[ -d "$STAGE/node_modules/katex" ] || { echo "[api] 包里没有 node_modules/katex" >&2; rm -rf "$STAGE"; exit 1; }
[ -f "$STAGE/web/assets/katex/katex.min.css" ] || { echo "[api] 包里缺 KaTeX 样式（web/assets/katex）" >&2; rm -rf "$STAGE"; exit 1; }
echo "[api] 预检通过（server $(ls -1 "$STAGE"/server/*.mjs | wc -l | tr -d ' ') 个 / render $(ls -1 "$STAGE"/web/render/*.mjs | wc -l | tr -d ' ') 个 / 依赖就位）"

# ---- 1.5 库结构守卫：新代码要求知识树/卷注册在库里（subjects / knowledge_nodes）----
# v2 迁移已于 2026-11-12 完成、脚本已退役；这里只校验不迁移，失败就不上线。
# 用 sqlite3 直查，不走 node：import registry 会连带加载 config，裸进程没有
# MEM_WRITE_TOKEN，config 直接拒绝启动，守卫会误报「库是旧版」。
TREE_VERSION="$(sqlite3 data/mem.db "SELECT value FROM knowledge_meta WHERE key='treeVersion'" 2>/dev/null || true)"
if [ -z "$TREE_VERSION" ]; then
  echo "[api] 库里没有知识树（knowledge_meta 缺失）——数据库是旧版结构，先迁移再部署" >&2
  rm -rf "$STAGE"
  exit 1
fi
echo "[api] 库结构 v2 就位（treeVersion=$TREE_VERSION）"

# ---- 2. 备份旧代码 ----
mkdir -p .rollback
if [ -d server ]; then tar czf ".rollback/server-$TS.tar.gz" server; fi
if [ -d web/render ]; then tar czf ".rollback/web-$TS.tar.gz" web/render; fi
ls -1t .rollback/server-*.tar.gz 2>/dev/null | tail -n +11 | xargs -r rm -f

# ---- 3. 换代码 + 依赖 + 重启 ----
systemctl stop mem-api.service

rm -rf server.old
mv server server.old 2>/dev/null || true
mv "$STAGE/server" server

mkdir -p web
rm -rf web/render
mkdir -p web/render
cp "$STAGE"/web/render/*.mjs web/render/
# 静态资源整目录同步（app.css + katex 样式与字体）。不先删旧目录：文件名稳定，留着无害。
mkdir -p web/assets
cp -R "$STAGE"/web/assets/. web/assets/

# 依赖统一放 /www/api/node_modules。旧的那份先挪开，健康检查通过后才删。
rm -rf node_modules.old
if [ -d node_modules ]; then mv node_modules node_modules.old; fi
mv "$STAGE/node_modules" node_modules

# 旧架构遗留：静态构建产物、web 下的依赖副本、macOS 的 AppleDouble 文件。
# 留着会造成两个隐患：web/node_modules 抢在根依赖之前被解析、.build 占 2.6 MB 却没人读。
rm -rf web/node_modules web/.build web/._render web/._site.config.json

rm -rf "$STAGE" server.old
chown -R deploy:deploy server web node_modules
chmod -R u=rwX,go=rX server web node_modules

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

# ---- 5. 依赖自检：marked（原文页）与 katex（试卷页公式）必须能从 /www/api 解析到 ----
if ! "$NODE" -e "import('marked')" >/dev/null 2>&1; then
  echo "[api] 依赖 marked 无法解析 —— 原文页会全部 500。检查 node_modules 位置。" >&2
  exit 1
fi
if ! "$NODE" -e "import('katex')" >/dev/null 2>&1; then
  echo "[api] 依赖 katex 无法解析 —— 试卷页会渲染失败。检查 node_modules 位置。" >&2
  exit 1
fi

# ---- 6. 抽检页面：首页 + 原文页 + 试卷页 + KaTeX 字体样式 ----
CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:8137/study/ || echo 000)"
echo "[api] /study/ → HTTP $CODE"
[ "$CODE" = "200" ] || { echo "[api] 页面不可用，请检查日志" >&2; exit 1; }

SRC_PATH="$(curl -s --max-time 10 http://127.0.0.1:8137/study/sitemap.xml | grep -o '/study/source/[^<]*' | head -1 || true)"
if [ -n "$SRC_PATH" ]; then
  SCODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://127.0.0.1:8137${SRC_PATH}" || echo 000)"
  echo "[api] 原文页抽检 → HTTP $SCODE"
  [ "$SCODE" = "200" ] || { echo "[api] 原文页不可用，多半是 marked 渲染失败" >&2; exit 1; }
else
  echo "[api] sitemap 里没有 source 页，跳过原文页抽检"
fi

PAPER_PATH="$(curl -s --max-time 10 http://127.0.0.1:8137/study/sitemap.xml | grep -o '/study/papers/[^<]*' | grep -v '/papers/$' | head -1 || true)"
if [ -n "$PAPER_PATH" ]; then
  PCODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://127.0.0.1:8137${PAPER_PATH}" || echo 000)"
  echo "[api] 试卷页抽检（${PAPER_PATH}）→ HTTP $PCODE"
  [ "$PCODE" = "200" ] || { echo "[api] 试卷页不可用，多半是 katex 渲染失败" >&2; exit 1; }
else
  echo "[api] sitemap 里没有试卷页，跳过试卷页抽检"
fi

KCODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:8137/study/assets/katex/katex.min.css || echo 000)"
FCODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:8137/study/assets/katex/fonts/KaTeX_Main-Regular.woff2 || echo 000)"
echo "[api] KaTeX 样式 → HTTP $KCODE · 字体 → HTTP $FCODE"
[ "$KCODE" = "200" ] && [ "$FCODE" = "200" ] || { echo "[api] KaTeX 静态资源缺失：公式会退化成方框或错位" >&2; exit 1; }

# ---- 7. 一切正常，清掉旧依赖副本 ----
rm -rf node_modules.old

echo "[api] 完成：$API_DIR @ $TS（页表 $PAGES 页）"
REMOTE

echo "[api] 已部署。检查：curl -s https://geyuqi.me/api/health"
