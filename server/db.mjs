// node:sqlite 为 Node 22 内置（22.5+），零 npm 依赖。
// 本服务全程只读：P1 不开放任何写接口，写入留给 P3 并走单事务。
import { DatabaseSync } from 'node:sqlite';
import config from './config.mjs';

let connection = null;
const statements = new Map();

export function openDb() {
  if (connection) return connection;
  connection = new DatabaseSync(config.dbPath, { readOnly: true });
  connection.exec('PRAGMA query_only = ON');
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
