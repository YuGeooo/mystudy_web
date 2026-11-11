// 导出等价性校验：同一个库，Python 版与 Node 版各导一次，逐字段比对。
//
// 目的：证明 server/export.mjs 可以替代 scripts/export_index.py 与 export_content.py。
// 两边只有两处允许不同：meta.generatedAt、meta.generator（以及 content 的 generatedAt/source）。
//
// 用法：node scripts/compare-export.mjs [db路径]（默认 data/test.db）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = process.argv[2] || 'data/test.db';
const dbPath = path.resolve(ROOT, db);
if (!fs.existsSync(dbPath)) {
  console.error(`数据库不存在：${dbPath}`);
  process.exit(1);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-compare-'));
const pyIndex = path.join(tmp, 'py-index.json');
const pyContent = path.join(tmp, 'py-content.json');
const nodeIndex = path.join(tmp, 'node-index.json');
const nodeContent = path.join(tmp, 'node-content.json');

function sh(cmd, args, env) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} 失败(${code})：${out}`))));
  });
}

const IGNORED = {
  'meta.generatedAt': true,
  'meta.generator': true,
  generatedAt: true,
  source: true,
};

/** 返回第一处差异的路径与两侧值；一致返回 null。 */
function diff(a, b, prefix = '') {
  if (IGNORED[prefix]) return null;
  if (a === b) return null;
  if (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b)) return null;

  const isObj = (v) => v !== null && typeof v === 'object';
  if (!isObj(a) || !isObj(b)) {
    const sa = JSON.stringify(a);
    const sb = JSON.stringify(b);
    if (sa === sb) return null;
    return { path: prefix || '(root)', a: sa, b: sb };
  }
  if (Array.isArray(a) !== Array.isArray(b)) {
    return { path: prefix, a: `array=${Array.isArray(a)}`, b: `array=${Array.isArray(b)}` };
  }
  if (Array.isArray(a)) {
    if (a.length !== b.length) return { path: `${prefix}.length`, a: String(a.length), b: String(b.length) };
    for (let i = 0; i < a.length; i += 1) {
      const d = diff(a[i], b[i], `${prefix}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const d = diff(a[k], b[k], prefix ? `${prefix}.${k}` : k);
    if (d) return d;
  }
  return null;
}

/** 键顺序也要一致：index.json 的字段顺序是站点契约的一部分。 */
function keyOrderDiff(a, b, prefix = '') {
  if (IGNORED[prefix]) return null;
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!isObj(a) || !isObj(b)) return null;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.join(',') !== kb.join(',')) {
    return { path: prefix || '(root)', a: ka.join(','), b: kb.join(',') };
  }
  for (const k of ka) {
    const d = keyOrderDiff(a[k], b[k], prefix ? `${prefix}.${k}` : k);
    if (d) return d;
  }
  if (Array.isArray(a)) {
    for (let i = 0; i < Math.min(a.length, b.length, 3); i += 1) {
      const d = keyOrderDiff(a[i], b[i], `${prefix}[${i}]`);
      if (d) return d;
    }
  }
  return null;
}

console.log(`比对库：${db}`);

await sh('python3', ['scripts/export_index.py', '--db', dbPath, '--out', pyIndex]);
await sh('python3', ['scripts/export_content.py', '--db', dbPath, '--out', pyContent, '--no-verify-src']);
await sh(process.execPath, ['server/export-cli.mjs'], {
  MEM_DB: dbPath,
  MEM_EXPORT_INDEX: nodeIndex,
  MEM_EXPORT_CONTENT: nodeContent,
});

const results = [];
for (const [name, pa, pb] of [
  ['index.json', pyIndex, nodeIndex],
  ['content.json', pyContent, nodeContent],
]) {
  const a = JSON.parse(fs.readFileSync(pa, 'utf8'));
  const b = JSON.parse(fs.readFileSync(pb, 'utf8'));
  const valueDiff = diff(a, b);
  const orderDiff = keyOrderDiff(a, b);
  const ok = !valueDiff && !orderDiff;
  results.push({ name, ok, valueDiff, orderDiff });
  console.log(`\n--- ${name} ---`);
  console.log(`  字段值：${valueDiff ? `差异在 ${valueDiff.path}\n    python: ${valueDiff.a}\n    node  : ${valueDiff.b}` : '完全一致'}`);
  console.log(`  键顺序：${orderDiff ? `差异在 ${orderDiff.path}\n    python: ${orderDiff.a}\n    node  : ${orderDiff.b}` : '完全一致'}`);
  const sa = fs.statSync(pa).size;
  const sb = fs.statSync(pb).size;
  console.log(`  体积：python ${(sa / 1024).toFixed(0)} KB / node ${(sb / 1024).toFixed(0)} KB`);
}

fs.rmSync(tmp, { recursive: true, force: true });

const allOk = results.every((r) => r.ok);
console.log(`\n${allOk ? 'PASS' : 'FAIL'} 导出等价性：${results.filter((r) => r.ok).length}/${results.length} 一致`);
process.exit(allOk ? 0 : 1);
