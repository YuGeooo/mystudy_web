// SQL 执行器验收：只读闸门有没有漏、文档里的查询还能不能跑。
//
// 用法：node server/test-sql.mjs
//
// 跑在正式库的只读连接上（不写文件、不改数据），所以不需要另起测试库。
// 第二段把 doc/sql.md 里所有 ```sql 块抽出来执行一遍——文档写错的 SQL
// 比没有文档更坑人，字段一改名就该在这里红。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER = path.join(ROOT, 'server', 'sqlrun.mjs');
const DB = path.join(ROOT, 'data', 'mem.db');
const DOC = path.join(ROOT, 'doc', 'sql.md');

let failed = 0;
let passed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

function run(sql, { maxRows, db = DB } = {}) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['--no-warnings', RUNNER, '--db', db],
      { cwd: ROOT }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => {
      let data = null;
      const line = stdout.trim().split('\n').filter(Boolean).pop() || '';
      try { data = JSON.parse(line); } catch { /* 交给断言报 */ }
      resolve({ code, data, stdout, stderr });
    });
    child.stdin.end(JSON.stringify({ sql, maxRows }));
  });
}

console.log('=== 1. 只读闸门 ===');

await check('select 正常返回列与行', async () => {
  const r = await run('select count(*) as n from attempts');
  assert.equal(r.code, 0, r.stdout || r.stderr);
  assert.equal(r.data.ok, true);
  assert.deepEqual(r.data.columns, ['n']);
  assert.ok(r.data.rows[0].n > 0);
});

await check('delete 被拒（不进 SQLite 就已经拦下）', async () => {
  const r = await run('delete from attempts');
  assert.equal(r.code, 1);
  assert.equal(r.data.code, 'bad_request');
  assert.match(r.data.error, /只读/);
});

await check('insert 被拒', async () => {
  const r = await run("insert into attempts (id) values ('x')");
  assert.equal(r.data.code, 'bad_request');
});

await check('update ... set 被拒', async () => {
  const r = await run('update attempts set correct = 1');
  assert.equal(r.data.code, 'bad_request');
});

await check('多语句被拒', async () => {
  const r = await run('select 1; drop table attempts');
  assert.match(r.data.error, /单条语句/);
});

await check('drop 被拒', async () => {
  const r = await run('drop table attempts');
  assert.equal(r.data.code, 'bad_request');
});

// 这两条是误杀回归：replace() 是字符串函数，'delete from' 可能出现在字面量里。
await check('replace() 字符串函数不被当成 REPLACE INTO', async () => {
  const r = await run("select replace('abc', 'b', 'X') as v");
  assert.equal(r.code, 0, r.stdout || r.stderr);
  assert.equal(r.data.rows[0].v, 'aXc');
});

await check('字面量里的写关键字不误杀', async () => {
  const r = await run("select 'delete from x' as s, 'insert into y' as t");
  assert.equal(r.code, 0, r.stdout || r.stderr);
  assert.equal(r.data.rows[0].s, 'delete from x');
});

await check('注释里的写关键字不误杀', async () => {
  const r = await run('select 1 as x -- delete from attempts\n');
  assert.equal(r.code, 0, r.stdout || r.stderr);
});

console.log('\n=== 2. 边界 ===');

await check('PRAGMA table_info 放行', async () => {
  const r = await run('pragma table_info(attempts)');
  assert.equal(r.code, 0, r.stdout || r.stderr);
  assert.ok(r.data.rows.some((x) => x.name === 'question_id'));
});

await check('带副作用的 PRAGMA 被拒', async () => {
  const r = await run('pragma journal_mode = delete');
  assert.equal(r.code, 1);
  assert.equal(r.data.code, 'bad_request');
});

await check('行数上限生效并标记 truncated', async () => {
  const r = await run('select id from attempts', { maxRows: 3 });
  assert.equal(r.data.count, 3);
  assert.equal(r.data.truncated, true);
  assert.ok(r.data.rows.length === 3);
});

await check('语法/表名错误返回 bad_sql', async () => {
  const r = await run('select * from no_such_table');
  assert.equal(r.code, 1);
  assert.equal(r.data.code, 'bad_sql');
});

await check('库文件不存在时明确报错', async () => {
  const r = await run('select 1', { db: path.join(ROOT, 'data', 'nope.db') });
  assert.equal(r.data.code, 'no_database');
});

console.log('\n=== 3. 文档里的 SQL 全部可执行 ===');

const blocks = [...fs.readFileSync(DOC, 'utf8').matchAll(/```sql\n([\s\S]*?)```/g)]
  .map((m) => m[1].trim());

await check(`doc/sql.md 有 ${blocks.length} 条示例（至少 10 条）`, async () => {
  assert.ok(blocks.length >= 10, `只有 ${blocks.length} 条`);
});

for (const [i, sql] of blocks.entries()) {
  const head = sql.split('\n')[0].replace(/\s+/g, ' ').slice(0, 42);
  await check(`示例 ${String(i + 1).padStart(2)}：${head}`, async () => {
    const r = await run(sql, { maxRows: 20 });
    assert.equal(r.code, 0, r.data?.error || r.stderr);
    assert.equal(r.data.ok, true);
    assert.ok(Array.isArray(r.data.rows));
  });
}

console.log(`\n${failed === 0 ? '全部通过' : '有失败'}：${passed} 通过 / ${failed} 失败`);
process.exitCode = failed === 0 ? 0 : 1;
