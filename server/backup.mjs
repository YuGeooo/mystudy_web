// 备份：写库之前先留一份能退回去的完整副本。
//
// 为什么不用 cp：SQLite 在 WAL 模式下直接拷 .db 会漏掉还没 checkpoint 的页，
// 拷出来可能是坏的。用 `VACUUM INTO` 让 SQLite 自己导出一份一致快照，
// 不需要外部 sqlite3 命令（服务器上没装也不影响）。
//
// 一次备份 = 一个目录：
//   backups/20261111-193012-pre-write-questions/
//     mem.db         一致性快照（知识树与卷注册都在库里，随库退回）
//     meta.json      行数、sha256、原因，便于挑选与核对
//
// 恢复走命令行 scripts/restore.sh —— 不做「一键恢复」API：
// 恢复要替换正在被进程打开的文件，必须停服务，这种动作不该由 HTTP 触发。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import config from './config.mjs';
import { openDb } from './db.mjs';

const sha256 = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const safe = (s) => String(s).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

/** 备份目录里的目录列表，新的在前。 */
export function listBackups() {
  let entries = [];
  try {
    entries = fs.readdirSync(config.backupDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name);
  } catch {
    return [];
  }
  return entries
    .map((name) => {
      const dir = path.join(config.backupDir, name);
      const db = path.join(dir, 'mem.db');
      const st = fs.existsSync(db) ? fs.statSync(db) : null;
      let meta = null;
      try {
        meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
      } catch {
        /* 老备份可能没有 meta */
      }
      return {
        name,
        path: path.relative(config.root, dir),
        dbBytes: st ? st.size : 0,
        mtimeMs: st ? st.mtimeMs : 0,
        createdAt: meta?.createdAt ?? (st ? new Date(st.mtimeMs).toISOString() : null),
        reason: meta?.reason ?? null,
        rows: meta?.rows ?? null,
        sha256: meta?.sha256 ?? null,
      };
    })
    .filter((x) => x.dbBytes > 0)
    // 按落地时间排，不能按目录名：同一秒内先扣掉后半段，'post-xxx' 会排到 'manual' 前面
    .sort((a, b) => b.mtimeMs - a.mtimeMs || String(b.name).localeCompare(String(a.name)));
}

/** 只保留最近 keep 份，protect 指定的那份额外保护（刚生成的一定不能被删）。 */
function prune(protect) {
  const items = listBackups().filter((x) => x.name !== protect);
  const dead = items.slice(Math.max(0, config.backupKeep - 1));
  for (const d of dead) {
    fs.rmSync(path.join(config.root, d.path), { recursive: true, force: true });
  }
  return dead.length;
}

/**
 * 生成一份快照。返回快照信息；只读进程直接跳过。
 * 会顺手校验副本完整性，坏的备份当场删掉并报错，不留定时炸弹。
 */
export function snapshot(reason = 'manual') {
  if (config.readOnly) {
    return { ok: false, skipped: 'readonly', message: '只读模式不做备份' };
  }

  fs.mkdirSync(config.backupDir, { recursive: true });
  const base = `${stamp()}-${safe(reason) || 'manual'}`;
  let dir = path.join(config.backupDir, base);
  let n = 1;
  while (fs.existsSync(dir)) dir = path.join(config.backupDir, `${base}-${++n}`);
  fs.mkdirSync(dir, { recursive: true });

  const target = path.join(dir, 'mem.db');
  // 路径里的单引号要转义；同一连接不能处于事务中（调用点都在事务之前）
  openDb().exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);

  const probe = new DatabaseSync(target, { readOnly: true });
  let check = null;
  let rows = null;
  try {
    check = probe.prepare('PRAGMA integrity_check').get().integrity_check;
    rows = probe.prepare(`
      SELECT (SELECT COUNT(*) FROM papers)    AS papers,
             (SELECT COUNT(*) FROM questions) AS questions,
             (SELECT COUNT(*) FROM sessions)  AS sessions,
             (SELECT COUNT(*) FROM attempts)  AS attempts`).get();
  } finally {
    probe.close();
  }

  if (check !== 'ok') {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(`备份完整性校验失败（${check}），已删除本次备份`);
  }

  fs.writeFileSync(
    path.join(dir, 'meta.json'),
    JSON.stringify({
      createdAt: new Date().toISOString(),
      reason,
      rows,
      sha256: sha256(target),
      config: config.configName,
    }, null, 2) + '\n',
    'utf8'
  );

  const pruned = prune(path.basename(dir));
  return {
    ok: true,
    dir: path.relative(config.root, dir),
    rows,
    keep: config.backupKeep,
    pruned,
  };
}
