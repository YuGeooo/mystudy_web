#!/usr/bin/env python3
"""离线工具：从 mem.db 导出 data/content.json（第三份数据契约）。

content.json 还原 40 份场次 Markdown 与 8 份试卷 Markdown 的**完整原文**，
替代站点原本的 `git show HEAD:<file>`。导出时逐字节比对原仓库文件，
不一致直接报错，保证数据库里的正文确实无损。

只在开发者本机运行，不进服务器运行时。
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from memdb import DATA, SRC, connect  # noqa: E402

OUT = DATA / "content.json"


def main() -> int:
    con = connect()
    sessions: dict[str, str] = {}
    for r in con.execute(
        "SELECT id, "
        "json_extract(note, '$.baseline.file') AS file, "
        "json_extract(note, '$.baseline.frontMatter') AS fm "
        "FROM sessions ORDER BY rowid"
    ):
        file_path, fm = r["file"], r["fm"] or ""
        row = con.execute(
            "SELECT process_md FROM attempts WHERE session_id = ? LIMIT 1", (r["id"],)
        ).fetchone()
        if not row:
            raise RuntimeError(f"场次 {r['id']} 没有 attempt 承载正文")
        marker = f"===== 场次全文：{file_path} =====\n\n"
        pos = row["process_md"].find(marker)
        if pos < 0:
            raise RuntimeError(f"{file_path} 在 process_md 里找不到全文分隔标记")
        body = row["process_md"][pos + len(marker):]
        text = fm + body
        if text != (SRC / file_path).read_text(encoding="utf-8"):
            raise RuntimeError(f"{file_path} 还原后与原仓库不一致")
        sessions[file_path] = text

    papers: dict[str, str] = {}
    seen = set()
    for r in con.execute("SELECT notes FROM papers ORDER BY rowid"):
        bl = json.loads(r["notes"])["baseline"]
        for path, prefix in bl.get("paperPrefix", {}).items():
            if path in seen:
                continue
            seen.add(path)
            blocks = [
                x[0]
                for x in con.execute(
                    "SELECT content_md FROM questions "
                    "WHERE json_extract(notes, '$.baseline.paper') = ? ORDER BY seq",
                    (path,),
                )
            ]
            text = (prefix or "") + "".join(blocks)
            if text != (SRC / path).read_text(encoding="utf-8"):
                raise RuntimeError(f"{path} 还原后与原仓库不一致")
            papers[path] = text

    con.close()
    payload = {
        "generatedAt": datetime.now(timezone(timedelta(hours=8))).isoformat(timespec="seconds"),
        "source": "data/mem.db",
        "sessions": sessions,
        "papers": papers,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"已导出 {OUT}：{len(sessions)} 份场次原文 / {len(papers)} 份试卷原文，逐字节校验通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
