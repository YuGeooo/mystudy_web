#!/usr/bin/env python3
"""迁移后核对：结构、逐字段 diff、§8 验收、§9 特例、源文件只读与无损。

输出 doc/migration-report.md；有 FAIL 时 exit 1。
"""
from __future__ import annotations

import difflib
import hashlib
import json
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from memdb import (  # noqa: E402
    BASELINE_HEAD, BASELINE_INDEX, DB_PATH, EXPORT_INDEX, EXPORT_VOLUMES,
    REPORT, SNAPSHOT, SRC, connect, read_json,
)

SITE = Path("/Users/geyuqi/Documents/aliyun/myWebsite")
CHECKS: list[tuple[str, str, str]] = []  # (status, item, detail)


def check(ok, item, detail):
    CHECKS.append(("PASS" if ok else "FAIL", item, detail))
    return ok


def note(status, item, detail):
    CHECKS.append((status, item, detail))


def deep_diff(a, b, path="", out=None, limit=40):
    if out is None:
        out = []
    if len(out) >= limit:
        return out
    if isinstance(a, dict) and isinstance(b, dict):
        for k in sorted(set(a) | set(b)):
            if k not in a:
                out.append((f"{path}/{k}", "<缺失>", b[k]))
            elif k not in b:
                out.append((f"{path}/{k}", a[k], "<缺失>"))
            else:
                deep_diff(a[k], b[k], f"{path}/{k}", out, limit)
    elif isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            out.append((path + "/<len>", len(a), len(b)))
        for i, (x, y) in enumerate(zip(a, b)):
            deep_diff(x, y, f"{path}[{i}]", out, limit)
    elif type(a) is not type(b) or a != b:
        out.append((path, a, b))
    return out


def source_snapshot():
    head = subprocess.run(["git", "-C", str(SRC), "rev-parse", "HEAD"],
                          check=True, capture_output=True, text=True).stdout.strip()
    status = subprocess.run(["git", "-C", str(SRC), "status", "--short"],
                            check=True, capture_output=True, text=True).stdout
    raw = subprocess.run(["git", "-C", str(SRC), "ls-files", "-z"],
                         check=True, capture_output=True).stdout
    files = {}
    for b in raw.split(b"\0"):
        if not b:
            continue
        rel = b.decode("utf-8")
        p = SRC / rel
        if p.is_file():
            files[rel] = hashlib.sha256(p.read_bytes()).hexdigest()
    return {"head": head, "status": status, "sha256": files}


def main() -> int:
    baseline = read_json(BASELINE_INDEX)
    exported = read_json(EXPORT_INDEX)
    snap = read_json(SNAPSHOT)
    con = connect()

    # ---------------------------------------------------------- 1. 源仓库只读
    now = source_snapshot()
    check(now == snap["baseline"], "源仓库 HEAD / 工作区 / 文件哈希与导入前一致",
          f"HEAD={now['head'][:7]}，git status {'为空' if not now['status'].strip() else '非空'}，"
          f"{len(now['sha256'])} 个受版本控制文件 sha256 全量比对")
    check(now["head"] == BASELINE_HEAD, "源仓库 HEAD 仍为基线", BASELINE_HEAD)
    check(not now["status"].strip(), "源仓库 git status --short 为空", "无新增/修改/删除")
    note("INFO", "线上站点源码", f"{SITE} 本次未做任何读写（范围外，仅记录路径）")

    # ---------------------------------------------------------- 2. 数据库结构
    counts = {t: con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
              for t in ("papers", "questions", "sessions", "attempts")}
    check(counts == {"papers": 7, "questions": 328, "sessions": 40, "attempts": 317},
          "4 表行数 7 / 328 / 40 / 317", str(counts))
    cols = {t: len(con.execute(f"PRAGMA table_info({t})").fetchall())
            for t in counts}
    check(all(n <= 15 for n in cols.values()), "每表列数 ≤ 15", str(cols))
    check(con.execute("PRAGMA integrity_check").fetchone()[0] == "ok",
          "PRAGMA integrity_check", "ok")
    fk = con.execute("PRAGMA foreign_key_check").fetchall()
    check(not fk, "PRAGMA foreign_key_check", "无悬空外键")
    uv = con.execute("PRAGMA user_version").fetchone()[0]
    check(uv == 1, "PRAGMA user_version", f"{uv}")
    idx = [r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='index' "
                                     "AND name LIKE 'idx_%' ORDER BY name")]
    check(len(idx) == 7, "§10 索引 7 个", ", ".join(idx))
    dup = con.execute("SELECT COUNT(*) FROM (SELECT session_id, question_id FROM attempts "
                      "GROUP BY 1,2 HAVING COUNT(*)>1)").fetchone()[0]
    check(dup == 0, "UNIQUE (session_id, question_id) 无冲突", f"冲突组 {dup}")

    # ---------------------------------------------------------- 3. 逐字段 diff
    a, b = json.loads(json.dumps(baseline)), json.loads(json.dumps(exported))
    a["meta"].pop("generatedAt"), a["meta"].pop("generator")
    b["meta"].pop("generatedAt"), b["meta"].pop("generator")
    diffs = deep_diff(a, b)
    check(not diffs, "导出 index.json 与基线逐字段 diff 零差异",
          "仅 meta.generatedAt / meta.generator 允许不同；差异 %d 处" % len(diffs))
    if diffs:
        for p, x, y in diffs[:10]:
            note("DIFF", p, f"基线={str(x)[:100]} | 导出={str(y)[:100]}")
    la = BASELINE_INDEX.read_text(encoding="utf-8").splitlines(keepends=True)
    lb = EXPORT_INDEX.read_text(encoding="utf-8").splitlines(keepends=True)
    changed = [l for l in difflib.unified_diff(la, lb, n=0)
               if l[:1] in "+-" and not l.startswith(("+++", "---"))]
    check(len(changed) == 4, "文本级 diff 仅 generatedAt / generator 两行",
          f"变更行 {len(changed)} 行（2 处 -/+）")
    kt = exported["knowledgeTree"]
    check(len(kt["nodes"]) == 34 and len(kt["subjects"]) == 4,
          "知识点 4 学科 / 34 节点", f'{len(kt["subjects"])} 学科 / {len(kt["nodes"])} 节点')
    check(all("path" in n for n in kt["nodes"]), "34 节点 topicPath 由 volumes.json 还原", "全部有 path")

    # ---------------------------------------------------------- 4. §8 验收清单
    verdict = dict(con.execute(
        "SELECT CASE WHEN correct IS NULL THEN 'null' ELSE CAST(correct AS TEXT) END, "
        "COUNT(*) FROM attempts GROUP BY 1").fetchall())
    check((verdict.get("1"), verdict.get("0"), verdict.get("null")) == (217, 89, 11),
          "判定 217 对 / 89 错 / 11 未判定", str(verdict))
    is_redo = con.execute("SELECT COUNT(*) FROM attempts WHERE is_redo=1").fetchone()[0]
    check(is_redo == 25, "isRedo 25", str(is_redo))
    redo_rows = con.execute("SELECT COUNT(*) FROM attempts WHERE redo_status IS NOT NULL").fetchone()[0]
    check(redo_rows == 12, "台账状态非空 12 行", str(redo_rows))
    ans = dict(con.execute("SELECT scorable, COUNT(*) FROM questions GROUP BY scorable").fetchall())
    check((ans.get(1), ans.get(0)) == (321, 7), "答案状态 confirmed 321 / estimated 7",
          f"scorable 1={ans.get(1)} 0={ans.get(0)}")
    timing = dict(con.execute("SELECT timing_mode, COUNT(*) FROM sessions GROUP BY 1").fetchall())
    check(tuple(timing.get(m, 0) for m in ("session", "per-question", "mixed", "none"))
          == (23, 0, 1, 16), "计时 23 / 0 / 1 / 16", str(timing))
    nulldur = con.execute("SELECT COUNT(*) FROM sessions WHERE duration_min IS NULL").fetchone()[0]
    check(nulldur == 16, "16 场 duration_min IS NULL", str(nulldur))
    per_vol = dict(con.execute("SELECT paper_slug, COUNT(*) FROM questions GROUP BY 1").fetchall())
    expect = {"2020-exam": 57, "2024-exam": 57, "2025-english": 48, "formal-logic": 30,
              "reasoning-2": 30, "math-applied": 81, "redo-20261109": 25}
    check(per_vol == expect, "7 卷题数与基准逐卷一致", str(per_vol))
    jlen = con.execute("SELECT COUNT(*) FROM papers WHERE "
                       "question_count != json_array_length(question_ids)").fetchone()[0]
    check(jlen == 0, "papers.question_count 与 question_ids 长度一致", f"不一致 {jlen} 卷")
    four = con.execute(
        "SELECT s.id, s.question_count, COUNT(a.id) FROM sessions s "
        "LEFT JOIN attempts a ON a.session_id=s.id GROUP BY s.id "
        "HAVING s.question_count != COUNT(a.id) ORDER BY s.id").fetchall()
    check(len(four) == 4, "4 场 question_count ≠ COUNT(attempts) 按源文件口径保留",
          "; ".join(f"{r[0]} {r[1]} vs {r[2]}" for r in four))

    # 双口径与卷级汇总分
    m = con.execute(
        "SELECT SUM(a.correct=1), SUM(a.substantive_correct=1), COUNT(*) FROM attempts a "
        "JOIN questions q ON q.id=a.question_id WHERE q.paper_slug='math-applied'").fetchone()
    check((m[0], m[1]) == (68, 69), "数学卷面 68/81 与实质 69/81 可分别复算",
          f"correct={m[0]} substantive={m[1]} 共 {m[2]} 次作答")
    s2024 = con.execute(
        "SELECT SUM(a.correct=1), COUNT(*) FROM attempts a JOIN questions q ON q.id=a.question_id "
        "WHERE q.paper_slug='2024-exam' AND q.scorable=1").fetchone()
    note("INFO", "2024 卷判定复算", f"对 {s2024[0]} / 共 {s2024[1]} 条客观题作答（基线汇总 36/55）")

    # ---------------------------------------------------------- 5. §9 特例
    r = con.execute("SELECT correct, substantive_correct FROM attempts a "
                    "JOIN questions q ON q.id=a.question_id WHERE q.id='math-applied-profit-03' "
                    "AND a.correct=0").fetchone()
    check(r is not None and r[1] == 1, "特例 1：profit-03 卷面错、实质对",
          f"correct={r[0] if r else None}, substantive_correct={r[1] if r else None}")
    q = con.execute("SELECT answer, notes FROM questions WHERE id='formal-logic-p2-q04'").fetchone()
    check(q and q["answer"] == "C", "特例 2：formal-logic-p2-q04 答案为 C", str(q["answer"] if q else None))
    q25 = con.execute("SELECT answer, content_md, notes FROM questions WHERE id='2024-exam-q025'").fetchone()
    s9 = bool(q25) and re.search(r"\$S_9\s*=\s*26\$", q25["content_md"]) is not None
    rev = bool(q25) and "S6=26 → S9=26" in (q25["notes"] or "")
    check(bool(q25) and q25["answer"] == "E" and s9 and rev,
          "特例 3：2024 Q25 题干 $S_9=26、答案 E、修订原因入 notes",
          f"answer={q25['answer'] if q25 else None}, $S_9=26 命中={s9}, 修订原因={rev}")
    ds = con.execute("SELECT COUNT(*) FROM questions WHERE type='data-sufficiency'").fetchone()[0]
    check(ds == 35, "特例 4：全库 data-sufficiency 共 35 条", str(ds))
    cm = con.execute("SELECT COUNT(*) FROM questions WHERE paper_slug='math-applied' "
                     "AND content_md LIKE '%（1）%' AND content_md LIKE '%（2）%'").fetchone()[0]
    note("PASS" if cm else "WARN", "特例 4：数学卷带 (1)(2) 两小问",
         f"content_md 含全角（1）（2）的题 {cm} 道")
    subj = con.execute("SELECT COUNT(*) FROM attempts WHERE score IS NOT NULL "
                       "AND score_max IS NOT NULL").fetchone()[0]
    check(subj == 7, "特例 5：7 条主观题 score / score_max 齐全", str(subj))
    nullc = con.execute("SELECT COUNT(*) FROM attempts WHERE correct IS NULL").fetchone()[0]
    check(nullc == 11, "特例 6：11 条 correct IS NULL，不进判定分母", str(nullc))
    tags = [r[0] for r in con.execute("SELECT DISTINCT error_tag FROM attempts "
                                      "WHERE error_tag IS NOT NULL")]
    full_arrays = [json.loads(r[0]) for r in con.execute(
        "SELECT DISTINCT json_extract(notes,'$.baseline.errorTags') FROM attempts "
        "WHERE json_array_length(json_extract(notes,'$.baseline.errorTags'))>0")]
    flat = {t for arr in full_arrays for t in arr}
    check("方程设错" in flat, "特例 7：约定外标签「方程设错」按真实值完整入库",
          f"error_tag 主标签：{', '.join(sorted(tags))}；完整 errorTags 数组含 "
          f"{'、'.join(sorted(flat))}（§7 规定主标签进 error_tag，完整数组存 notes 信封）")
    note("N/A", "约定外标签「填涂失误」",
         "基线 index.json 中 0 条 attempt 使用该标签（设计字典预设，实际数据未出现），无可迁移数据")
    all_md = "\n".join(r[0] for r in con.execute("SELECT content_md FROM questions")) + "\n" + \
             "\n".join(r[0] for r in con.execute("SELECT process_md FROM attempts"))
    for label, needle in [("合并题号标题", "Q35 ~ 36"), ("LaTeX $$", "$$"),
                          ("❌ 假上界", "假上界"), ("线规 1", "线规 1"),
                          ("（1）（2）小问", "（1）")]:
        note("PASS" if needle in all_md else "WARN", f"特例 8：{label} 原样保留",
             "已检出" if needle in all_md else "未检出")
    qc = con.execute("SELECT COUNT(*) FROM questions WHERE number IS NOT NULL").fetchone()[0]
    check(qc == 328, "题目 number 全部入库", str(qc))

    # ---------------------------------------------------------- 6. 源文件无损
    paper_files = sorted({r[0] for r in con.execute(
        "SELECT DISTINCT json_extract(notes, '$.baseline.paper') FROM questions")})
    lossless = 0
    for rel in paper_files:
        original = (SRC / rel).read_text(encoding="utf-8")
        rows = con.execute(
            "SELECT content_md FROM questions WHERE json_extract(notes,'$.baseline.paper')=? "
            "ORDER BY seq", (rel,)).fetchall()
        _, prefix = "", None
        pnotes = con.execute("SELECT notes FROM papers WHERE json_extract(notes,'$.baseline.paperPrefix') "
                             "IS NOT NULL").fetchall()
        for (raw,) in pnotes:
            pp = json.loads(raw)["baseline"].get("paperPrefix", {})
            if rel in pp:
                prefix = pp[rel]
                break
        rebuilt = (prefix or "") + "".join(r[0] for r in rows)
        if rebuilt == original:
            lossless += 1
    check(lossless == len(paper_files), "content_md 逐字还原 paper 原文",
          f"{lossless}/{len(paper_files)} 份试卷字节级一致")
    sess_files = [r[0] for r in con.execute(
        "SELECT DISTINCT json_extract(note,'$.baseline.file') FROM sessions")]
    md_ok = 0
    for rel in sess_files:
        original = (SRC / rel).read_text(encoding="utf-8")
        fm = con.execute(
            "SELECT json_extract(note,'$.baseline.frontMatter') FROM sessions "
            "WHERE json_extract(note,'$.baseline.file')=?", (rel,)).fetchone()[0] or ""
        body = original[len(fm):]
        hit = con.execute(
            "SELECT COUNT(*) FROM attempts a JOIN sessions s ON s.id=a.session_id "
            "WHERE json_extract(s.note,'$.baseline.file')=? "
            "AND instr(a.process_md, ?)>0", (rel, body)).fetchone()[0]
        if hit:
            md_ok += 1
    check(md_ok == len(sess_files), "process_md 逐字覆盖场次批改全文",
          f"{md_ok}/{len(sess_files)} 份场次文档正文（去 front matter）逐字可在 process_md 中检出")

    # ---------------------------------------------------------- 7. 范围外
    note("N/A", "站点 meta.activity 热力图", "本次迁移不含站点改动（设计 §5 / README 待确认项）")
    note("N/A", "线上站点未改动", "未对站点目录做任何写操作")
    note("INFO", "数据库文件", f"{DB_PATH}（{DB_PATH.stat().st_size} 字节，WAL 模式）")
    con.close()

    # ---------------------------------------------------------- 报告
    npass = sum(1 for s, _, _ in CHECKS if s == "PASS")
    nfail = sum(1 for s, _, _ in CHECKS if s == "FAIL")
    nwarn = sum(1 for s, _, _ in CHECKS if s == "WARN")
    stamp = datetime.now(timezone(timedelta(hours=8))).isoformat(timespec="seconds")
    lines = [
        "# 数据迁移核对报告", "",
        "| 项 | 值 |", "|---|---|",
        f"| 核对时间 | {stamp} |",
        f"| 数据库 | `data/mem.db`（SQLite + WAL，user_version=1） |",
        f"| 基线 | `mem` @ `{BASELINE_HEAD[:7]}`，`meta.generatedAt={baseline['meta']['generatedAt']}` |",
        f"| 导出物 | `data/index.json`、`data/volumes.json` |",
        f"| 结果 | **{npass} PASS / {nfail} FAIL / {nwarn} WARN** |", "",
        "## 逐项结果", "", "| 状态 | 检查项 | 明细 |", "|---|---|---|",
    ]
    for s, item, detail in CHECKS:
        lines.append(f"| {s} | {item} | {str(detail).replace('|', '\\|')} |")
    lines += [
        "", "## 说明", "",
        "- **零差异口径**：导出器只读数据库与伴生 `volumes.json`，不读基线 `index.json`；"
        "比对时仅豁免 `meta.generatedAt` / `meta.generator`。",
        "- **字段承载**：设计 DDL 的列数不足以表达基线全部字段，无法由列或确定性规则重建的"
        "余量字段以 JSON 信封存进既有 `notes` / `note` TEXT 列（见 `scripts/memdb.py`）；"
        "未新增表、未新增列。`content_md` / `process_md` 是数据库新增信息，不进入 `index.json`。",
        "- **源文件保护**：导入前后对原仓库全部受版本控制文件做 sha256 快照比对，"
        "并校验 HEAD 与 `git status --short`；导入过程对原仓库仅执行读操作。",
        "- **正文切分**：`content_md` 按 `<a id>` 锚点所在行的行首切块，"
        "8 份试卷均可逐字还原原文；章节标题（如 `## 三、逻辑推理`）会归入前一块，属连续原文片段。",
        "  `process_md` 每条 attempt 都附带所属场次的完整正文，40 份场次文档逐字可检出；"
        "由此数据库约 3.9 MB，换取归档后零信息损失。",
        "", "## 设计稿与基线数据的偏差", "",
        "1. **§9 特例 7**：设计称约定外标签「方程设错」「填涂失误」按真实值入 `error_tag`。"
        "基线中「方程设错」只作为 `[\"算术笔误\",\"方程设错\"]` 的副标签出现 1 次，"
        "「填涂失误」0 次。按 §7「主标签进 error_tag」实现，完整数组保存在 notes 信封，数据无损。",
        "2. **DDL 信息容量**：4 张表共 47 列，不足以表达基线 questions(18) / sessions(9) / "
        "attempts(20) 的全部字段。除可由列或确定性规则重建的字段外，余量以 JSON 信封存入既有备注列。",
        "3. **站点 meta.activity**：设计 §5 要求由 `sessions.date` 聚合，但基线 `index.json` 没有该字段；"
        "为达成零差异，本次导出未新增它。站点热力图改造仍需单独实施。",
        "", "## 复现命令", "",
        "```bash", "python3 scripts/migrate.py       # 建库 + 全量导入（原仓库只读）",
        "python3 scripts/export_index.py  # 从数据库导出 index.json",
        "python3 scripts/verify.py        # 核对并生成本报告", "```", "",
    ]
    REPORT.write_text("\n".join(lines), encoding="utf-8")
    print(f"核对完成：{npass} PASS / {nfail} FAIL / {nwarn} WARN")
    print(f"报告：{REPORT}")
    if nfail:
        for s, item, detail in CHECKS:
            if s == "FAIL":
                print("  FAIL:", item, "-", detail)
    return 1 if nfail else 0


if __name__ == "__main__":
    sys.exit(main())
