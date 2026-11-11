// node:sqlite 为 Node 22 内置（22.5+），零 npm 依赖。
//
// 两种模式，由配置决定，同一个进程只走一种：
//   只读（默认）：readOnly + PRAGMA query_only，任何写入被 SQLite 内核拒绝
//   可写（write.enabled）：读写打开，写入必须走 withTransaction 单事务
import { DatabaseSync } from 'node:sqlite';
import config from './config.mjs';

let connection = null;
const statements = new Map();

export function openDb() {
  if (connection) return connection;
  connection = new DatabaseSync(config.dbPath, { readOnly: config.readOnly });
  if (config.readOnly) {
    connection.exec('PRAGMA query_only = ON');
  } else {
    // 写模式：并发写冲突时最多等 5 秒，超时抛错而不是立刻 SQLITE_BUSY。
    connection.exec('PRAGMA busy_timeout = 5000');
  }
  connection.exec('PRAGMA foreign_keys = ON');
  return connection;
}

export function closeDb() {
  statements.clear();
  if (connection) {
    connection.close();
    connection = null;
  }
}

export function prepare(sql) {
  let stmt = statements.get(sql);
  if (!stmt) {
    stmt = openDb().prepare(sql);
    statements.set(sql, stmt);
  }
  return stmt;
}

export function get(sql, ...params) {
  return prepare(sql).get(...params);
}

export function all(sql, ...params) {
  return prepare(sql).all(...params);
}

export function run(sql, ...params) {
  if (config.readOnly) throw new Error('数据库以只读模式打开，拒绝写入');
  return prepare(sql).run(...params);
}

/**
 * 单事务执行：一次录入 = 一个事务（设计文档 §5）。
 * BEGIN IMMEDIATE 先拿写锁，避免并发下升级锁失败。
 * 任何异常都整体回滚，不会留下半场记录。
 */
export function withTransaction(fn) {
  if (config.readOnly) throw new Error('数据库以只读模式打开，拒绝写入');
  const db = openDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* 回滚失败时保留原始错误 */
    }
    throw err;
  }
}
