#!/usr/bin/env bash
# 安装 git 钩子。用 core.hooksPath 指向版本库内的 scripts/hooks/，
# 好处是钩子本身有版本管理，改一次全体生效，不用往每台机器的 .git/hooks 里拷。
#
# 注意：core.hooksPath 是本地仓库配置（不进版本库），换机器需要再跑一次本脚本。
# 设置后 .git/hooks/ 里的钩子会被忽略——本项目只维护 pre-commit，没有其他钩子。
set -euo pipefail
cd "$(dirname "$0")/.."

git rev-parse --git-dir >/dev/null 2>&1 || {
  echo "[hooks] 当前目录不是 git 仓库，无需安装。" >&2
  exit 1
}

chmod +x scripts/hooks/* 2>/dev/null || true
git config core.hooksPath scripts/hooks

printf '[hooks] 已启用 core.hooksPath = %s\n' "$(git config core.hooksPath)"
printf '        钩子：%s\n' "$(ls scripts/hooks | tr '\n' ' ')"
printf '        跳过单次检查：git commit --no-verify\n'
