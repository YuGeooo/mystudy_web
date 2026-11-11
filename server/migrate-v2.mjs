// v2 迁移：把 data/volumes.json 的「人工口径」灌进库，从此 JSON 不再是存储。
//
// 灌什么：
//   knowledgeTree.subjects → subjects 表
//   knowledgeTree.nodes    → knowledge_nodes 表
//   knowledgeTree.version  → knowledge_meta 表
//   volumes[].顺序         → papers.ord 列（卷的显示顺序）
//
// 不灌什么（在代码里已确认零消费，历史值随归档的 volumes.json 保留）：
//   questionTopics / topicAliases / mathTopics —— 运行时没人读
//   volumes[].answerOverrides —— 答案裁决早已落到 questions.answer + notes
//   volumes[].papers / answerSources —— 路径本来就存在 papers.notes 的
//     baseline.paperPrefix 里，加载器直接从那里取，不重复存
//
// 幂等：全部 INSERT OR REPLACE，重复跑结果一致。
// 用法：node server/migrate-v2.mjs [db路径] [volumes.json路径]
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
import { fileURLToPath } from 'node:url';

// 路径规则：显式传参按当前目录解析（部署脚本在 /www/api 下执行），
// 不传参按仓库根解析（本机默认 data/mem.db + data/volumes.json）。
const dbFile = process.argv[2]
  ? path.resolve(process.cwd(), process.argv[2])
  : path.resolve(ROOT, 'data/mem.db');
const jsonFile = process.argv[3]
  ? path.resolve(process.cwd(), process.argv[3])
  : path.resolve(ROOT, 'data/volumes.json');

const volumesJson = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
const tree = volumesJson.knowledgeTree;

// 动库前先留一份快照，失败可整体回退。
const backup = `${dbFile}.pre-v2`;
fs.copyFileSync(dbFile, backup);

const db = new DatabaseSync(dbFile);
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS subjects (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  exam TEXT,
  ord  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS knowledge_nodes (
  id          TEXT PRIMARY KEY,
  subject_id  TEXT NOT NULL REFERENCES subjects(id),
  name        TEXT NOT NULL,
  granularity TEXT NOT NULL,
  ord         INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS knowledge_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

const colExists = (table, col) =>
  db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
if (!colExists('papers', 'ord')) {
  db.exec('ALTER TABLE papers ADD COLUMN ord INTEGER');
}

const insSubject = db.prepare('INSERT OR REPLACE INTO subjects (id, name, exam, ord) VALUES (?, ?, ?, ?)');
const insNode = db.prepare(
  'INSERT OR REPLACE INTO knowledge_nodes (id, subject_id, name, granularity, ord) VALUES (?, ?, ?, ?, ?)'
);
const insMeta = db.prepare('INSERT OR REPLACE INTO knowledge_meta (key, value) VALUES (?, ?)');

const subjectIds = new Set();
tree.subjects.forEach((s, i) => {
  subjectIds.add(s.id);
  insSubject.run(s.id, s.name, s.exam ?? null, i);
});
tree.nodes.forEach((n, i) => {
  if (!subjectIds.has(n.parent)) throw new Error(`节点 ${n.id} 的 parent=${n.parent} 不是科目 id`);
  insNode.run(n.id, n.parent, n.name, n.granularity, i);
});
insMeta.run('treeVersion', String(tree.version));

const setOrd = db.prepare('UPDATE papers SET ord = ? WHERE slug = ?');
const paperSlugs = new Set(db.prepare('SELECT slug FROM papers').all().map((r) => r.slug));
const skipped = [];
(volumesJson.volumes || []).forEach((v, i) => {
  if (paperSlugs.has(v.slug)) setOrd.run(i, v.slug);
  else skipped.push(v.slug);
});

// ---- 校验：库里的题必须都能在树上找到家，否则渲染期会炸 ----
const nodeIds = new Set(db.prepare('SELECT id FROM knowledge_nodes').all().map((r) => r.id));
const orphans = db
  .prepare('SELECT id, topic_id FROM questions WHERE topic_id IS NOT NULL')
  .all()
  .filter((r) => !nodeIds.has(r.topic_id));
if (orphans.length) {
  throw new Error(`以下题目的 topic_id 在知识树里不存在：${orphans.slice(0, 5).map((r) => r.id).join(', ')}`);
}

const count = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
console.log(
  `[v2] 完成：subjects ${count('subjects')} · nodes ${count('knowledge_nodes')} · papers.ord 已回填` +
    (skipped.length ? ` · 未入库的卷（papers 表还没有，等录入）：${skipped.join(', ')}` : '') +
    ` · 备份在 ${backup}`
);
db.close();
