"""mem_new 数据库共用常量与工具。

只依赖标准库。源仓库 SRC 在任何时候都只以只读方式访问。
"""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
DB_PATH = DATA / "mem.db"
SCHEMA_PATH = ROOT / "scripts" / "schema.sql"
SRC = Path("/Users/geyuqi/WorkBuddy/mem")
BASELINE_INDEX = SRC / "data" / "index.json"
BASELINE_VOLUMES = SRC / "data" / "volumes.json"
EXPORT_INDEX = DATA / "index.json"
EXPORT_VOLUMES = DATA / "volumes.json"
SNAPSHOT = DATA / "source-snapshot.json"
REPORT = ROOT / "doc" / "migration-report.md"

BASELINE_HEAD = "ad4f3ffc65584783631380889e63b068751961ec"

# 导出契约：与站点读取的基线 index.json 字段顺序一致（不含 content_md / process_md）
Q_FIELDS = [
    "answer", "answerSource", "answerStatus", "scorable", "revision", "notes",
    "id", "volume", "paper", "number", "section", "topic", "type", "source",
    "topicId", "origin", "topicPath", "granularity",
]
S_FIELDS = [
    "id", "date", "file", "volume", "questionCount", "timingMode",
    "durationMin", "durationSource", "note",
]
A_FIELDS = [
    "id", "date", "sessionId", "session", "questionId", "userAnswer",
    "correctAnswer", "correct", "substantiveCorrect", "score", "scoreMax",
    "scoreBasis", "errorTags", "errorNote", "isRedo", "durationMin",
    "durationSource", "source", "verified", "note",
]


def jdump(obj) -> str:
    # 不排序：revision 等嵌套对象必须保持基线里的键顺序，导出才能做到文本级零差异
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def envelope(text, **baseline) -> str:
    """把基线里 DDL 无法表达的余量字段收进既有 TEXT 备注列。

    text     : 原来人类可读的 note / notes 原文（保持原值，可能是 None）
    baseline : 仅放「既无对应列、也无法由确定性规则重建」的字段
    """
    return jdump({"text": text, "baseline": baseline})


def unenvelope(raw):
    if not raw:
        return None, {}
    obj = json.loads(raw)
    return obj.get("text"), obj.get("baseline", {})


def connect(path: Path = DB_PATH) -> sqlite3.Connection:
    con = sqlite3.connect(path)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    return con


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))
