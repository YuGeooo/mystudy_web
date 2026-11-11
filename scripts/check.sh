#!/usr/bin/env bash
# 全量语法检查：所有 .mjs 走 node --check，所有 .sh 走 bash -n。
# 不执行代码，只解析。用于提交前和部署前的快速兜底。
set -euo pipefail
cd "$(dirname "$0")/.."

js_count=0
sh_count=0
bad=0

while IFS= read -r f; do
  [ -n "$f" ] || continue
  js_count=$((js_count + 1))
  if ! err=$(node --check "$f" 2>&1); then
    printf '语法错误  %s\n' "$f"
    printf '%s\n' "$err" | grep -v '^$' | head -3 | sed 's/^/    /'
    bad=$((bad + 1))
  fi
done < <(ls -1 server/*.mjs web/render/*.mjs scripts/*.mjs bin/mem 2>/dev/null || true)

while IFS= read -r f; do
  [ -n "$f" ] || continue
  sh_count=$((sh_count + 1))
  if ! err=$(bash -n "$f" 2>&1); then
    printf '语法错误  %s\n' "$f"
    printf '%s\n' "$err" | head -4 | sed 's/^/    /'
    bad=$((bad + 1))
  fi
done < <(ls -1 ./*.sh scripts/*.sh deploy/*.sh 2>/dev/null || true)

if [ "$bad" -gt 0 ]; then
  printf '\n%d 个文件有语法错误\n' "$bad" >&2
  exit 1
fi
printf '[语法] %d 个 .mjs + %d 个 .sh 全部通过\n' "$js_count" "$sh_count"
