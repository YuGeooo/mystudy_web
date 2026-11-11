#!/usr/bin/env bash
# geyuqi.me 部署 v2
# 数据源：/www/data 的 index.json / content.json（mem.db 为只读 API 用）
# 站点仓库只负责渲染器与样式，不再 git pull mem 仓库。
set -euo pipefail

REPO_DIR="/www/app"
DATA_DIR="/www/data"
RELEASES_DIR="/www/releases"
SITE_LINK="/www/site"
BUILDER_DIR="/www/builder"
KEEP_RELEASES="${KEEP_RELEASES:-5}"
HEALTH_URL="https://127.0.0.1/study/"
HOST_HEADER="geyuqi.me"
BRANCH="main"
LAST_BUILD_DATE_FILE="/www/.last-build-date"
DATA_HASH_FILE="/www/.data-hash"
NPM_HASH_FILE="/www/.npm-ci-hash"
GIT_SSH="ssh -o BatchMode=yes -o ConnectTimeout=15"

cd "$REPO_DIR"

# ---- 1. 数据完整性（缺文件直接中止，不破坏线上）----
for f in index.json content.json mem.db; do
  if [ ! -s "$DATA_DIR/$f" ]; then
    echo "[deploy] 数据文件缺失：$DATA_DIR/$f，中止" >&2
    exit 1
  fi
done

# ---- 2. 站点仓库快进（渲染器 / CSS 更新）----
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "[deploy] 工作区有未提交改动，中止（服务器上不应手工改文件）" >&2
  exit 1
fi

PREV_APP="$(git rev-parse HEAD)"
APP_CHANGED=0
if GIT_SSH_COMMAND="$GIT_SSH" git fetch --prune origin "$BRANCH" --quiet 2>/dev/null; then
  REMOTE_APP="$(git rev-parse "origin/$BRANCH")"
  if [ "$PREV_APP" != "$REMOTE_APP" ]; then
    if ! git merge --ff-only "$REMOTE_APP" --quiet; then
      echo "[deploy] 站点无法快进合并，中止" >&2
      exit 1
    fi
    APP_CHANGED=1
    echo "[deploy] 站点 $(git rev-parse --short "$PREV_APP") → $(git rev-parse --short "$REMOTE_APP")"
  fi
else
  echo "[deploy] WARN: 站点仓库拉取失败，沿用当前版本 $(git rev-parse --short HEAD)" >&2
fi

# ---- 3. 数据变更检测 ----
DATA_HASH="$(sha256sum "$DATA_DIR/index.json" "$DATA_DIR/content.json" "$DATA_DIR/mem.db" | sha256sum | awk '{print $1}')"
DATA_CHANGED=0
if [ "$(cat "$DATA_HASH_FILE" 2>/dev/null || true)" != "$DATA_HASH" ]; then
  DATA_CHANGED=1
fi

TODAY="$(date +%F)"
LAST_BUILD_DATE="$(cat "$LAST_BUILD_DATE_FILE" 2>/dev/null || true)"
if [ "$APP_CHANGED" = 0 ] && [ "$DATA_CHANGED" = 0 ] && [ "$LAST_BUILD_DATE" = "$TODAY" ] && [ -f "$SITE_LINK/index.html" ]; then
  echo "[deploy] 无变更且今天已构建：app $(git rev-parse --short HEAD) / data ${DATA_HASH:0:8}"
  exit 0
fi

# ---- 4. 依赖（仅随 package-lock 变化）----
NPM_NEEDED=0
if [ ! -x node_modules/.bin/tailwindcss ]; then
  NPM_NEEDED=1
fi
LOCK_HASH="$(sha256sum package-lock.json | awk '{print $1}')"
if [ "$(cat "$NPM_HASH_FILE" 2>/dev/null || true)" != "$LOCK_HASH" ]; then
  NPM_NEEDED=1
fi
if [ "$NPM_NEEDED" = 1 ]; then
  echo "[deploy] npm ci"
  npm ci --no-audit --no-fund
  printf '%s\n' "$LOCK_HASH" > "$NPM_HASH_FILE"
fi

# ---- 5. 构建 ----
TS="$(date +%Y%m%d-%H%M%S)"
OUT="$RELEASES_DIR/$TS"
mkdir -p "$RELEASES_DIR"
echo "[deploy] 构建 $OUT（data ${DATA_HASH:0:8}）"
"$BUILDER_DIR/build-release.sh" "$OUT"

for f in index.html data.json assets/app.css build-report.json; do
  if [ ! -s "$OUT/$f" ]; then
    echo "[deploy] 构建产物不完整（缺 $f），保留上一版" >&2
    rm -rf "$OUT"
    exit 1
  fi
done

# ---- 6. 切换 + 健康检查 ----
PREV_RELEASE="$(readlink -f "$SITE_LINK" 2>/dev/null || true)"
ln -sfn "$OUT" "$SITE_LINK"

CODE="$(curl -sk -o /dev/null -w '%{http_code}' --resolve "$HOST_HEADER:443:127.0.0.1" "$HEALTH_URL" || echo 000)"
if [ "$CODE" != "200" ]; then
  echo "[deploy] 健康检查失败（HTTP $CODE），切回上一版 $PREV_RELEASE" >&2
  if [ -n "$PREV_RELEASE" ]; then
    ln -sfn "$PREV_RELEASE" "$SITE_LINK"
  else
    rm -f "$SITE_LINK"
  fi
  exit 1
fi

printf '%s\n' "$TODAY" > "$LAST_BUILD_DATE_FILE"
printf '%s\n' "$DATA_HASH" > "$DATA_HASH_FILE"
echo "[deploy] OK，线上已切换到 $(basename "$OUT")（app $(git rev-parse --short HEAD) / data ${DATA_HASH:0:8}）"

# ---- 7. 只保留最近 N 份 release ----
ls -1dt "$RELEASES_DIR"/20* 2>/dev/null | tail -n +$((KEEP_RELEASES + 1)) | while IFS= read -r old; do
  if [ "$old" != "$OUT" ] && [ "$old" != "$PREV_RELEASE" ]; then
    rm -rf "$old"
  fi
done
