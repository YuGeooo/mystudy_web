// 闭环验证：改一条数据库记录 → 同步 JSON → 重建站点 → 统计必须跟着变 → 完整恢复。
// 需要服务已停止（避免只读连接与文件覆盖冲突）。不改原 mem / myWebsite 仓库。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { buildSite } from '../server/build-site.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB = path.join(ROOT, 'data', 'mem.db');
const TARGET = '2026-09-13-2024-exam-a1-2024-exam-q002';
const backup = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mem-loopback-')), 'mem.db');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function checkpoint() {
  const db = new DatabaseSync(DB);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
}
function sync() {
  execFileSync('bash', [path.join(ROOT, 'scripts', 'sync.sh')], { cwd: ROOT, stdio: 'pipe' });
}
function stats() {
  return JSON.parse(
    fs.readFileSync(path.join(ROOT, 'web', '.build', 'data.json'), 'utf8')
  ).stats;
}
const fmt = (s) =>
  `knownCorrect=${s.knownCorrect} knownWrong=${s.knownWrong} accuracy=${s.accuracy.toFixed(6)}`;

checkpoint();
fs.copyFileSync(DB, backup);
const before = stats();
let changed;

try {
  const db = new DatabaseSync(DB);
  db.exec('BEGIN');
  const info = db.prepare('UPDATE attempts SET correct = 1 WHERE id = ?').run(TARGET);
  db.exec('COMMIT');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
  assert(info.changes === 1, '测试行未命中');

  sync();
  buildSite();
  changed = stats();
  assert(changed.knownCorrect === before.knownCorrect + 1, '站点正确数未 +1');
  assert(changed.knownWrong === before.knownWrong - 1, '站点错误数未 -1');
  assert(changed.accuracy > before.accuracy, '站点正确率未上升');
} finally {
  fs.rmSync(DB + '-wal', { force: true });
  fs.rmSync(DB + '-shm', { force: true });
  fs.copyFileSync(backup, DB);
  sync();
  buildSite();
  fs.rmSync(backup, { force: true });
}

const restored = stats();
assert(restored.knownCorrect === before.knownCorrect, '恢复后正确数不一致');
assert(restored.knownWrong === before.knownWrong, '恢复后错误数不一致');
assert(restored.accuracy === before.accuracy, '恢复后正确率不一致');

console.log('闭环验证通过：改库 → sync.sh → build-site.mjs → 站点 data.json');
console.log('  改库前  ' + fmt(before));
console.log('  改库后  ' + fmt(changed));
console.log('  恢复后  ' + fmt(restored));
console.log('数据库与三份 JSON 均已恢复原状。');
