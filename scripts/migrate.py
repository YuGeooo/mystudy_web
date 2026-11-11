#!/usr/bin/env python3
"""一次性导入：把 mem 仓库（只读）的数据迁进 mem_new/data/mem.db。

用法：python3 scripts/migrate.py

约束：
  * 源仓库 /Users/geyuqi/WorkBuddy/mem 全程只读，导入前后做文件哈希快照比对。
  * 数据库文件仅写入 mem_new/data/，可重复执行（每次重建）。
  * 严格按 doc/database-design.md 的 4 张表 DDL，不增列、不增表。
  * 基线 index.json 里没有对应列的字段，收进既有 TEXT 备注列的 JSON 信封。
"""
from __future__ import annotations

import collections
import hashlib
import json
import re
import shutil
import sqlite3
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from memdb import (  # noqa: E402
    BASELINE_HEAD, BASELINE_INDEX, BASELINE_VOLUMES, DB_PATH, DATA,
    EXPORT_VOLUMES, ROOT, SCHEMA_PATH, SNAPSHOT, SRC, connect, envelope, jdump, read_json,
)

ANCHOR = re.compile(r'<a id="([^"]+)"></a>')
HEADING = re.compile(r"^#{2,4}\s*(?:Q(\d+)|第\s*(\d+)\s*题)", re.M)
FM_TIME = re.compile(r"^time:\s*(.+)$", re.M)
LEDGER_ROW = re.compile(
    r"^\|\s*answer(\d+)\s*\|\s*(\S+)\s+(\d+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|",
    re.M,
)

SUBJECTIVE_MAX = {
    "2020-exam": {"essay1": 30, "essay2": 35},
    "2024-exam": {"essay1": 30, "essay2": 35},
    "2025-english": {"translation": 15, "writing-a": 10, "writing-b": 15},
}


# ---------------------------------------------------------------- 源仓库只读保护
def tracked_files() -> list[str]:
    out = subprocess.run(
        ["git", "-C", str(SRC), "ls-files", "-z"], check=True, capture_output=True
    ).stdout
    return sorted(p.decode("utf-8") for p in out.split(b"\0") if p)


def snapshot() -> dict:
    head = subprocess.run(
        ["git", "-C", str(SRC), "rev-parse", "HEAD"], check=True, capture_output=True, text=True
    ).stdout.strip()
    status = subprocess.run(
        ["git", "-C", str(SRC), "status", "--short"], check=True, capture_output=True, text=True
    ).stdout
    files = {}
    for rel in tracked_files():
        p = SRC / rel
        if p.is_file():
            files[rel] = hashlib.sha256(p.read_bytes()).hexdigest()
    return {"head": head, "status": status, "sha256": files}


# ---------------------------------------------------------------- 源文件切分
def split_paper(text: str):
    """按 <a id> 锚点所在行的行首切块；prefix + 各块原样拼接 == 原文。"""
    ms = list(ANCHOR.finditer(text))
    if not ms:
        raise ValueError("paper 文件里没有锚点")
    starts = [text.rfind("\n", 0, m.start()) + 1 for m in ms]
    bounds = starts + [len(text)]
    blocks = {m.group(1): text[bounds[i]:bounds[i + 1]] for i, m in enumerate(ms)}
    return text[:starts[0]], blocks


def split_front_matter(text: str):
    if text.startswith("---\n"):
        end = text.find("\n---\n", 4)
        if end != -1:
            return text[:end + 5], text[end + 5:]
    return "", text


def started_at(front: str):
    m = FM_TIME.search(front)
    if not m:
        return None
    raw = m.group(1).strip()
    try:
        dt = datetime.strptime(raw[:16], "%Y-%m-%d %H:%M")
        return dt.replace(tzinfo=timezone(timedelta(hours=8))).isoformat(timespec="seconds")
    except ValueError:
        return raw


def per_question(body: str, number: int) -> str:
    """只在标题编号于该场次内唯一时才定位逐题片段，避免跨考点重号误配。"""
    ms = list(HEADING.finditer(body))
    nums = [int(m.group(1) or m.group(2)) for m in ms]
    if nums.count(number) != 1:
        return ""
    i = nums.index(number)
    end = ms[i + 1].start() if i + 1 < len(ms) else len(body)
    return body[ms[i].start():end].strip()


def parse_ledger(text: str, aliases: dict) -> dict:
    out = {}
    for m in LEDGER_ROW.finditer(text):
        sess_no, alias, num, tag, status, record = m.groups()
        topic = aliases.get(alias)
        if not topic:
            continue
        key = (f"math-applied-a{sess_no}", f"math-applied-{topic}-{int(num):02d}")
        out[key] = {
            "errorNote": tag.strip(),
            "redoStatus": status.strip(),
            "redoRecord": record.strip(),
        }
    return out


def source_file_set(volumes: dict, base: dict) -> set[str]:
    """复用原构建脚本的只读函数取出它实际读过的文件，再补上题库原文。"""
    sys.path.insert(0, str(SRC / "scripts"))
    import build_index as bi

    cfg = volumes
    qs, _ = bi.build_questions(cfg)
    ss = bi.build_sessions(cfg)
    sc = bi.parse_scores()
    bi.build_attempts(ss, {q["id"]: q for q in qs}, cfg, sc)
    files = set(bi.READ_FILES) | {q["paper"] for q in base["questions"]}
    if len(files) != base["meta"]["sourceFiles"]:
        raise RuntimeError(f"源文件数不符：{len(files)} != {base['meta']['sourceFiles']}")
    return files


def volume_dirs(vol: dict) -> set[str]:
    paths = list(vol.get("papers", [])) + list(vol.get("answerSources", []))
    return {p.split("/")[0] for p in paths}


# ---------------------------------------------------------------- 主流程
def main() -> int:
    before = snapshot()
    if before["head"] != BASELINE_HEAD or before["status"].strip():
        raise RuntimeError(f"源仓库基线不符：HEAD={before['head']} status={before['status']!r}")

    base = read_json(BASELINE_INDEX)
    volumes = read_json(BASELINE_VOLUMES)
    ts = base["meta"]["generatedAt"]
    all_source_files = source_file_set(volumes, base)

    # 试卷原文：按 paper 路径缓存切分结果
    paper_parts: dict[str, tuple[str, dict[str, str]]] = {}
    for rel in sorted({q["paper"] for q in base["questions"]}):
        paper_parts[rel] = split_paper((SRC / rel).read_text(encoding="utf-8"))

    session_docs: dict[str, tuple[str, str]] = {}
    for s in base["sessions"]:
        session_docs[s["file"]] = split_front_matter((SRC / s["file"]).read_text(encoding="utf-8"))

    ledger_text = (SRC / "数学应用题/待重做.md").read_text(encoding="utf-8")
    ledger = parse_ledger(ledger_text, volumes["topicAliases"])

    # 数据库只写在 mem_new/data/
    DATA.mkdir(parents=True, exist_ok=True)
    for suffix in ("", "-wal", "-shm"):
        p = Path(str(DB_PATH) + suffix)
        if p.exists():
            p.unlink()

    con = sqlite3.connect(DB_PATH)
    con.execute("PRAGMA journal_mode = WAL")
    con.execute("PRAGMA foreign_keys = ON")
    con.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))

    try:
        # ---- papers（先建，questions/sessions 有外键指向它）
        seq_in_vol: dict[str, int] = collections.defaultdict(int)
        qids_by_vol: dict[str, list[str]] = collections.defaultdict(list)
        for q in base["questions"]:
            seq_in_vol[q["volume"]] += 1
            qids_by_vol[q["volume"]].append(q["id"])

        for vol in volumes["volumes"]:
            slug = vol["slug"]
            dirs = volume_dirs(vol)
            own_files = sorted(f for f in all_source_files if f.split("/")[0] in dirs)
            prefix_by_paper = {
                p: paper_parts[p][0] for p in vol.get("papers", []) if p in paper_parts
            }
            extra = {
                "sourceFiles": own_files,
                "paperPrefix": prefix_by_paper,
                "answerSources": vol.get("answerSources", []),
                "totalQuestions": vol["totalQuestions"],
                "scorableQuestions": vol["scorableQuestions"],
            }
            if slug == "math-applied":
                extra["redoLedger"] = ledger_text
            rule = {"objective": 3, "subjective": SUBJECTIVE_MAX.get(slug, {})}
            if slug == "2025-english":
                rule["objective"] = None  # 英语客观题不按 3 分计，不臆造
            con.execute(
                "INSERT INTO papers VALUES (?,?,?,?,?,?,?,?)",
                (slug, vol["name"], vol["subject"], jdump(qids_by_vol[slug]),
                 vol["totalQuestions"], jdump(rule),
                 envelope(vol.get("notes"), **extra), ts),
            )

        # ---- questions（origin 自引用，先插无 origin 的，再插回指原题的）
        questions = []
        for q in base["questions"]:
            _, blocks = paper_parts[q["paper"]]
            if q["id"] not in blocks:
                raise RuntimeError(f"题目 {q['id']} 在 {q['paper']} 里找不到锚点块")
            extra = {
                "paper": q["paper"],
                "section": q["section"],
                "answerSource": q["answerSource"],
                "revision": q["revision"],
            }
            questions.append((
                q["id"], q["volume"], q["number"], 0, q["type"], q["topicId"], q["topic"],
                q.get("origin"), blocks[q["id"]], q["answer"], int(q["scorable"]),
                envelope(q["notes"], **extra), ts,
            ))
        # seq 按基线数组里的卷内出现顺序重编
        counter = collections.defaultdict(int)
        fixed = []
        for row in questions:
            counter[row[1]] += 1
            fixed.append(row[:3] + (counter[row[1]],) + row[4:])
        for row in sorted(fixed, key=lambda r: (r[7] is not None)):  # origin 非空者后置
            con.execute("INSERT INTO questions VALUES (" + ",".join("?" * 13) + ")", row)

        # ---- sessions
        sess_attempts: dict[str, list[dict]] = collections.defaultdict(list)
        for a in base["attempts"]:
            sess_attempts[a["sessionId"]].append(a)
        for s in base["sessions"]:
            front, _ = session_docs[s["file"]]
            ids = [a["questionId"] for a in sess_attempts[s["id"]]]
            con.execute(
                "INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (s["id"], s["volume"], s["date"], started_at(front), s["durationMin"],
                 s["timingMode"], s["durationSource"], jdump(ids), s["questionCount"],
                 envelope(s["note"], file=s["file"], frontMatter=front), ts),
            )

        # ---- attempts
        qnum_by_id = {q["id"]: q["number"] for q in base["questions"]}
        for a in base["attempts"]:
            front, body = session_docs[a["session"]]
            qnum = qnum_by_id[a["questionId"]]
            frag = per_question(body, qnum)
            parts = [f"<!-- attempt: {a['id']} | question: {a['questionId']} -->", ""]
            if frag:
                parts += [frag, ""]
            parts += [f"===== 场次全文：{a['session']} =====", "", body]
            process_md = "\n".join(parts)

            led = ledger.get((a["sessionId"], a["questionId"]))
            extra = {
                "source": a["source"],
                "errorTags": a["errorTags"],
                "errorNote": a["errorNote"],
                "durationMin": a["durationMin"],
                "durationSource": a["durationSource"],
            }
            if led:
                extra["redoRecord"] = led["redoRecord"]
            con.execute(
                "INSERT INTO attempts VALUES (" + ",".join("?" * 15) + ")",
                (a["id"], a["sessionId"], a["questionId"], a["userAnswer"],
                 None if a["correct"] is None else int(a["correct"]),
                 None if a["substantiveCorrect"] is None else int(a["substantiveCorrect"]),
                 a["score"], a["scoreMax"], int(a["isRedo"]),
                 a["errorTags"][0] if a["errorTags"] else None,
                 led["redoStatus"] if led else None,
                 None,  # resolved_at：台账 12 行均无「连续两次做对」销账
                 process_md, envelope(a["note"], **extra), ts),
            )

        con.commit()
    except Exception:
        con.rollback()
        raise
    finally:
        con.close()

    # 伴生配置：knowledgeTree 等按设计不入库
    shutil.copy2(BASELINE_VOLUMES, EXPORT_VOLUMES)

    after = snapshot()
    if after != before:
        raise RuntimeError("源仓库在导入过程中发生了变化，请检查！")
    SNAPSHOT.write_text(json.dumps({
        "capturedAt": datetime.now(timezone(timedelta(hours=8))).isoformat(timespec="seconds"),
        "baseline": before,
        "sourceFiles": sorted(all_source_files),
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    con = connect()
    counts = {t: con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
              for t in ("papers", "questions", "sessions", "attempts")}
    fk = con.execute("PRAGMA foreign_key_check").fetchall()
    con.close()
    print("导入完成：", counts)
    print("外键检查：", "通过" if not fk else fk)
    print("源仓库只读校验：通过（HEAD 未变、工作区干净、%d 个受版本控制文件哈希一致）"
          % len(before["sha256"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
