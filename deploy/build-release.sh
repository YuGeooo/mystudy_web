#!/usr/bin/env bash
# mem_new 构建：三份 JSON → 静态站点。供 deploy.sh 调用。
# 用法：build-release.sh <输出目录>
set -euo pipefail
cd /

OUT="${1:?用法: build-release.sh <输出目录>}"
NODE=/opt/node22/bin/node
APP=/www/app
BUILDER=/www/builder

rm -rf "$OUT"
mkdir -p "$OUT"

MEM_OUT="$OUT" "$NODE" "$BUILDER/server/build-site.mjs"

# Tailwind 扫描渲染器源码生成 CSS（@source ../scripts/build/**/*.mjs）
( cd "$APP" && ./node_modules/.bin/tailwindcss -i src/app.css -o "$OUT/assets/app.css" --minify >/dev/null )

# 试卷页的 KaTeX 样式与字体放在运行时目录（/www/api/web/assets/katex），静态产物也带一份，
# 免得回滚到静态站时公式没有样式。注意：静态构建用的渲染器是 /www/builder 下的副本，
# 它是否产出 /papers/ 页面取决于那份副本有没有同步，不在本脚本范围内。
if [ -d /www/api/web/assets/katex ]; then
  mkdir -p "$OUT/assets"
  cp -R /www/api/web/assets/katex "$OUT/assets/katex"
fi

for f in index.html data.json assets/app.css build-report.json; do
  [ -s "$OUT/$f" ] || { echo "[build] 产物缺失：$f" >&2; exit 1; }
done

echo "[build] 完成：$(find "$OUT" -type f | wc -l) 个文件 → $OUT"
