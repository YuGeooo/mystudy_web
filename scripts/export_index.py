#!/usr/bin/env python3
"""从 mem.db 导出站点读取的 index.json。

只读数据库 + 伴生配置 volumes.json；不读基线 index.json、不读原仓库 Markdown。
字段与顺序严格对齐站点契约，数据库新增的 content_md / process_md 不进入导出物。
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from memdb import (  # noqa: E402
    A_FIELDS, EXPORT_INDEX, EXPORT_VOLUMES, Q_FIELDS, S_FIELDS,
    connect, read_json, unenvelope,
)

TIMING_MODES = ("session", "per-question", "mixed", "none")


def as_bool(v):
    return None if v is None else bool(v)


def as_number(v):
    """SQLite REAL 会把整数写成 8.0，导出时还原成基线里的整数 8。"""
    if v is None:
        return None
    return int(v) if float(v).is_integer() else v


def knowledge_nodes(volumes: dict):
    tree = volumes["knowledgeTree"]
    subjects = {s["id"]: s for s in tree["subjects"]}
    nodes = {}
    for n in tree["nodes"]:
        item = dict(n)
        item["path"] = [subjects[n["parent"]]["name"], n["name"]]
        nodes[n["id"]] = item
    return subjects, nodes


def build_questions(con, nodes):
    text_by_id, bl_by_id = {}, {}
    rows = con.execute("SELECT * FROM questions ORDER BY rowid").fetchall()
    out = []
    for r in rows:
        text, bl = unenvelope(r["notes"])
        text_by_id[r["id"]] = text
        bl_by_id[r["id"]] = bl
        node = nodes.get(r["topic_id"])
        if node is None:
            raise RuntimeError(f"{r['id']} 的 topic_id={r['topic_id']} 在知识树里不存在")
        vals = {
            "answer": r["answer"],
            "answerSource": bl["answerSource"],
            "answerStatus": "confirmed" if r["scorable"] else "estimated",
            "scorable": bool(r["scorable"]),
            "revision": bl["revision"],
            "notes": text,
            "id": r["id"],
            "volume": r["paper_slug"],
            "paper": bl["paper"],
            "number": r["number"],
            "section": bl["section"],
            "topic": r["topic"],
            "type": r["type"],
            "source": f'{bl["paper"]}#{r["id"]}',
            "topicId": r["topic_id"],
            "origin": r["origin"],
            "topicPath": node["path"],
            "granularity": node["granularity"],
        }
        out.append({k: vals[k] for k in Q_FIELDS if k != "origin" or vals[k] is not None})
    return out, bl_by_id


def build_sessions(con):
    rows = con.execute("SELECT * FROM sessions ORDER BY rowid").fetchall()
    out, bl_by_id = [], {}
    for r in rows:
        text, bl = unenvelope(r["note"])
        bl_by_id[r["id"]] = bl
        vals = {
            "id": r["id"],
            "date": r["date"],
            "file": bl["file"],
            "volume": r["paper_slug"],
            "questionCount": r["question_count"],
            "timingMode": r["timing_mode"],
            "durationMin": r["duration_min"],
            "durationSource": r["duration_source"],
            "note": text,
        }
        out.append({k: vals[k] for k in S_FIELDS})
    return out, bl_by_id


def build_attempts(con, sessions_by_id, session_bl, questions_by_id):
    rows = con.execute("SELECT * FROM attempts ORDER BY rowid").fetchall()
    out = []
    for r in rows:
        text, bl = unenvelope(r["notes"])
        s = sessions_by_id[r["session_id"]]
        q = questions_by_id[r["question_id"]]
        vals = {
            "id": r["id"],
            "date": s["date"],                       # 导出时 JOIN sessions 填回
            "sessionId": r["session_id"],
            "session": session_bl[r["session_id"]]["file"],
            "questionId": r["question_id"],
            "userAnswer": r["user_answer"],
            "correctAnswer": q["answer"],
            "correct": as_bool(r["correct"]),
            "substantiveCorrect": as_bool(r["substantive_correct"]),
            "score": as_number(r["score"]),
            "scoreMax": as_number(r["score_max"]),
            "scoreBasis": "estimated" if r["score"] is not None else None,
            "errorTags": bl["errorTags"],
            "errorNote": bl["errorNote"],
            "isRedo": bool(r["is_redo"]),
            "durationMin": bl["durationMin"],
            "durationSource": bl["durationSource"],
            "source": bl["source"],
            "verified": r["correct"] is not None,
            "note": text,
        }
        out.append({k: vals[k] for k in A_FIELDS})
    return out


def main() -> int:
    volumes = read_json(EXPORT_VOLUMES)
    subjects, nodes = knowledge_nodes(volumes)
    con = connect()

    papers = con.execute("SELECT * FROM papers ORDER BY rowid").fetchall()
    questions, _ = build_questions(con, nodes)
    sessions, session_bl = build_sessions(con)
    attempts = build_attempts(
        con,
        {r["id"]: r for r in con.execute("SELECT * FROM sessions")},
        session_bl,
        {r["id"]: r for r in con.execute("SELECT * FROM questions")},
    )

    source_files = set()
    for p in papers:
        _, bl = unenvelope(p["notes"])
        source_files.update(bl.get("sourceFiles", []))
    timing_rows = con.execute("SELECT timing_mode, COUNT(*) FROM sessions GROUP BY timing_mode").fetchall()
    timing = {r[0]: r[1] for r in timing_rows}
    redo_rows = con.execute("SELECT COUNT(*) FROM attempts WHERE redo_status IS NOT NULL").fetchone()[0]
    fk_errors = con.execute("PRAGMA foreign_key_check").fetchall()
    con.close()

    if fk_errors:
        raise RuntimeError(f"外键悬空，拒绝导出：{fk_errors}")

    now = datetime.now(timezone(timedelta(hours=8))).isoformat(timespec="seconds")
    index = {
        "meta": {
            "generatedAt": now,
            "generator": "scripts/export_index.py",
            "sourceFiles": len(source_files),
            "coverage": {
                "questions": len(questions),
                "attempts": len(attempts),
                "sessions": len(sessions),
                "redoRows": redo_rows,
            },
            "timing": {m: timing.get(m, 0) for m in TIMING_MODES},
            "errors": [],
        },
        "knowledgeTree": {
            "version": volumes["knowledgeTree"]["version"],
            "subjects": volumes["knowledgeTree"]["subjects"],
            "nodes": [nodes[n["id"]] for n in volumes["knowledgeTree"]["nodes"]
                      if n["id"] in nodes],
        },
        "questions": questions,
        "sessions": sessions,
        "attempts": attempts,
    }
    EXPORT_INDEX.write_text(
        json.dumps(index, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"已导出 {EXPORT_INDEX}")
    print("  meta.coverage =", index["meta"]["coverage"])
    print("  meta.timing   =", index["meta"]["timing"])
    print("  sourceFiles   =", len(source_files))
    return 0


if __name__ == "__main__":
    sys.exit(main())
