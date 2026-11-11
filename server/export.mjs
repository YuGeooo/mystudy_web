// 导出器（Node 版）：数据库 → index.json + content.json。
//
// 为什么要在 Node 里：写接口提交后必须当场重新导出，否则页面永远停在旧数据。
// 2026-11-12 起迁移期的 Python 导出器（export_index.py / export_content.py）已退役，
// 本文件是唯一的导出实现（CLI 入口见 export-cli.mjs）。
import fs from 'node:fs';
import path from 'node:path';
import { get, all } from './db.mjs';
import { loadTree } from './registry.mjs';
import { SQL } from './queries.mjs';

/** ISO 8601 东八区秒级精度，如 2026-11-12T01:20:00+08:00 */
function nowIso8() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return `${d.toISOString().slice(0, 19)}+08:00`;
}

// 与 Python 侧字段顺序严格一致
const Q_FIELDS = [
  'answer', 'answerSource', 'answerStatus', 'scorable', 'revision', 'notes',
  'id', 'volume', 'paper', 'number', 'section', 'topic', 'type', 'source',
  'topicId', 'origin', 'topicPath', 'granularity',
];
const S_FIELDS = [
  'id', 'date', 'file', 'volume', 'questionCount', 'timingMode',
  'durationMin', 'durationSource', 'note',
];
const A_FIELDS = [
  'id', 'date', 'sessionId', 'session', 'questionId', 'userAnswer',
  'correctAnswer', 'correct', 'substantiveCorrect', 'score', 'scoreMax',
  'scoreBasis', 'errorTags', 'errorNote', 'isRedo', 'durationMin',
  'durationSource', 'source', 'verified', 'note',
];

const TIMING_MODES = ['session', 'per-question', 'mixed', 'none'];
const FULLTEXT_MARK = '===== 场次全文：';

function unenvelope(raw) {
  if (!raw) return { text: null, baseline: {} };
  try {
    const obj = JSON.parse(raw);
    return { text: obj.text ?? null, baseline: obj.baseline || {} };
  } catch {
    return { text: raw, baseline: {} };
  }
}

const asBool = (v) => (v === null || v === undefined ? null : Boolean(v));
// SQLite REAL 会把整数存成 8.0，导出还原成 8
const asNumber = (v) => {
  if (v === null || v === undefined) return null;
  return Number.isInteger(v) ? v : Number(v);
};

function knowledgeNodes(tree) {
  const subjects = new Map(tree.subjects.map((s) => [s.id, s]));
  const nodes = new Map();
  for (const n of tree.nodes) {
    nodes.set(n.id, { ...n, path: [subjects.get(n.parent).name, n.name] });
  }
  return { subjects, nodes };
}

// 与 Python 侧一致：只有 origin 为空时整键省略，其它字段的 null 一律保留
const DROP_WHEN_NULL = new Set(['origin']);

function pick(vals, fields) {
  const out = {};
  for (const f of fields) {
    if (DROP_WHEN_NULL.has(f) && (vals[f] === null || vals[f] === undefined)) continue;
    out[f] = vals[f] ?? null;
  }
  return out;
}

function buildQuestions(nodes) {
  const out = [];
  const byId = new Map();
  for (const r of all('SELECT * FROM questions ORDER BY rowid')) {
    const { text, baseline } = unenvelope(r.notes);
    const node = nodes.get(r.topic_id);
    if (!node) throw new Error(`${r.id} 的 topic_id=${r.topic_id} 在知识树里不存在`);
    const vals = {
      answer: r.answer,
      answerSource: baseline.answerSource ?? null,
      answerStatus: r.scorable ? 'confirmed' : 'estimated',
      scorable: Boolean(r.scorable),
      revision: baseline.revision ?? null,
      notes: text,
      id: r.id,
      volume: r.paper_slug,
      paper: baseline.paper ?? null,
      number: r.number,
      section: baseline.section ?? null,
      topic: r.topic,
      type: r.type,
      source: `${baseline.paper}#${r.id}`,
      topicId: r.topic_id,
      origin: r.origin,
      topicPath: node.path,
      granularity: node.granularity,
    };
    out.push(pick(vals, Q_FIELDS));
    byId.set(r.id, r);
  }
  return { questions: out, byId };
}

function buildSessions() {
  const out = [];
  const byId = new Map();
  for (const r of all('SELECT * FROM sessions ORDER BY rowid')) {
    const { text, baseline } = unenvelope(r.note);
    const vals = {
      id: r.id,
      date: r.date,
      file: baseline.file ?? null,
      volume: r.paper_slug,
      questionCount: r.question_count,
      timingMode: r.timing_mode,
      durationMin: r.duration_min,
      durationSource: r.duration_source,
      note: text,
    };
    out.push(pick(vals, S_FIELDS));
    byId.set(r.id, { row: r, baseline });
  }
  return { sessions: out, byId };
}

function buildAttempts(sessionsById, questionsById) {
  const out = [];
  for (const r of all('SELECT * FROM attempts ORDER BY rowid')) {
    const { text, baseline } = unenvelope(r.notes);
    const s = sessionsById.get(r.session_id);
    const q = questionsById.get(r.question_id);
    const vals = {
      id: r.id,
      date: s.row.date,
      sessionId: r.session_id,
      session: s.baseline.file ?? null,
      questionId: r.question_id,
      userAnswer: r.user_answer,
      correctAnswer: q.answer,
      correct: asBool(r.correct),
      substantiveCorrect: asBool(r.substantive_correct),
      score: asNumber(r.score),
      scoreMax: asNumber(r.score_max),
      scoreBasis: r.score !== null && r.score !== undefined ? 'estimated' : null,
      errorTags: baseline.errorTags ?? [],
      errorNote: baseline.errorNote ?? null,
      isRedo: Boolean(r.is_redo),
      durationMin: baseline.durationMin ?? null,
      durationSource: baseline.durationSource ?? null,
      source: baseline.source ?? null,
      verified: r.correct !== null && r.correct !== undefined,
      note: text,
    };
    out.push(pick(vals, A_FIELDS));
  }
  return out;
}

export function buildIndex() {
  const tree = loadTree();
  const { nodes } = knowledgeNodes(tree);
  const { questions, byId: questionsById } = buildQuestions(nodes);
  const { sessions, byId: sessionsById } = buildSessions();
  const attempts = buildAttempts(sessionsById, questionsById);

  const sourceFiles = new Set();
  for (const p of all('SELECT * FROM papers ORDER BY rowid')) {
    const { baseline } = unenvelope(p.notes);
    for (const f of baseline.sourceFiles || []) sourceFiles.add(f);
  }

  const timing = Object.fromEntries(TIMING_MODES.map((m) => [m, 0]));
  for (const r of all(SQL.timing)) timing[r.mode] = r.n;

  const redoRows = get('SELECT COUNT(*) AS n FROM attempts WHERE redo_status IS NOT NULL').n;
  const fk = all('PRAGMA foreign_key_check');
  if (fk.length) throw new Error(`外键悬空，拒绝导出：${JSON.stringify(fk)}`);

  return {
    meta: {
      generatedAt: nowIso8(),
      generator: 'server/export.mjs',
      sourceFiles: sourceFiles.size,
      coverage: {
        questions: questions.length,
        attempts: attempts.length,
        sessions: sessions.length,
        redoRows,
      },
      timing,
      errors: [],
    },
    knowledgeTree: {
      version: tree.version,
      subjects: tree.subjects,
      nodes: tree.nodes
        .filter((n) => nodes.has(n.id))
        .map((n) => nodes.get(n.id)),
    },
    questions,
    sessions,
    attempts,
  };
}

export function buildContent(dbName) {
  const sessions = {};
  for (const r of all('SELECT * FROM sessions ORDER BY rowid')) {
    const { baseline } = unenvelope(r.note);
    const file = baseline.file;
    const first = get(
      'SELECT process_md FROM attempts WHERE session_id = ? ORDER BY rowid LIMIT 1',
      r.id
    );
    if (!first) throw new Error(`场次 ${r.id} 没有 attempt 承载正文`);
    const md = first.process_md || '';
    const marker = `${FULLTEXT_MARK}${file} =====\n\n`;
    const pos = md.indexOf(marker);
    if (pos < 0) throw new Error(`${file} 在 process_md 里找不到全文分隔标记`);
    const body = md.slice(pos + marker.length);
    sessions[file] = (baseline.frontMatter || '') + body;
  }

  const papers = {};
  const seen = new Set();
  for (const r of all('SELECT * FROM papers ORDER BY rowid')) {
    const { baseline } = unenvelope(r.notes);
    for (const [p, prefix] of Object.entries(baseline.paperPrefix || {})) {
      if (seen.has(p)) continue;
      seen.add(p);
      const blocks = all(
        "SELECT content_md FROM questions WHERE json_extract(notes, '$.baseline.paper') = ? ORDER BY seq",
        p
      ).map((x) => x.content_md);
      // 题与题之间强制空行：有的卷 content_md 结尾不带换行（如削弱题），
      // 直接 join('') 会把相邻两题焊在同一行，渲染成一段。
      papers[p] = (prefix || '') + blocks.join('\n\n');
    }
  }

  return {
    generatedAt: nowIso8(),
    source: `data/${dbName}`,
    sessions,
    papers,
  };
}

/**
 * 导出两份契约文件。写接口提交后调用，保证页面与库同步。
 * 先写临时文件再 rename，避免导出中途失败留下半个 JSON。
 */
export function exportAll(config) {
  const index = buildIndex();
  const content = buildContent(path.basename(config.dbPath));

  for (const [file, payload] of [
    [config.exportIndexPath, index],
    [config.exportContentPath, content],
  ]) {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, file);
  }

  return {
    index: {
      file: path.relative(config.root, config.exportIndexPath),
      coverage: index.meta.coverage,
      timing: index.meta.timing,
      sourceFiles: index.meta.sourceFiles,
    },
    content: {
      file: path.relative(config.root, config.exportContentPath),
      sessions: Object.keys(content.sessions).length,
      papers: Object.keys(content.papers).length,
    },
  };
}
