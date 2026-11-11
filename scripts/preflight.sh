#!/usr/bin/env bash
# 启动前预检：把「环境不对」变成一句人话，而不是让 Node 抛 ERR_MODULE_NOT_FOUND。
#
# 检查四件事：
#   1. Node 版本（node:sqlite 需要 >= 22.5，这是硬门槛，勉强不了）
#   2. 依赖是否装齐（marked 渲染原文页、katex 渲染试卷页公式，缺了整站起不来）
#   3. 渲染器整条 import 链能否加载（顺带做了语法检查）
#   4. 关键数据文件在不在
#
# 由 dev.sh、deploy-api.sh 调用，也可以单独跑：./scripts/preflight.sh
set -euo pipefail
cd "$(dirname "$0")/.."

fail() {
  printf '\n[预检失败] %s\n\n' "$1" >&2
  exit 1
}

# ---- 1. Node 版本 ----
command -v node >/dev/null 2>&1 || fail "没找到 node。装 Node 22（nvm use）或把 /opt/node22/bin 加进 PATH 再来。"

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
NODE_MINOR=$(node -p 'process.versions.node.split(".")[1]')
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 5 ]; }; then
  fail "需要 Node >= 22.5（node:sqlite 从 22.5 才可用），当前 $(node -v)。服务器上请用 /opt/node22/bin/node。"
fi

# ---- 2 & 3. 依赖与渲染器 ----
# 只跑一次加载，避免重复开销；渲染器在模块顶层 import 'marked'，试卷模块 import 'katex'，
# 所以这一条同时验证了「依赖装了」和「渲染器语法没问题」。
if ! LOAD_ERR=$(node -e "import('./web/render/render.mjs').then(() => import('./web/render/paper.mjs'))" 2>&1); then
  if grep -q "ERR_MODULE_NOT_FOUND" <<<"$LOAD_ERR"; then
    MISSING=$(grep -oE "Cannot find (package|module) '[^']*'" <<<"$LOAD_ERR" | head -1)
    fail "$MISSING —— 依赖没装齐。跑一次：npm ci"
  fi
  fail "渲染器加载失败（不是缺依赖，是代码本身有问题）：$(head -5 <<<"$LOAD_ERR")"
fi

# ---- 4. 关键文件 ----
for f in web/site.config.json web/assets/app.css web/assets/katex/katex.min.css; do
  [ -e "$f" ] || fail "缺少 $f —— 仓库不完整，检查是否漏拉文件。"
done
# 数据库不入版本库（二进制），新机器上需要单独取回。
if [ ! -e data/mem.db ]; then
  fail "缺少 data/mem.db。新机器上执行 ./scripts/pull-data.sh 从线上取回，或 ./scripts/restore.sh <备份目录> 恢复。"
fi

echo "[预检] Node $(node -v) · 依赖齐全（marked / katex） · 渲染器可加载 · 数据文件就位"
