// 只读 SQL 的进程隔离执行器：给 HTTP `/api/sql` 用。
//
// 为什么不在请求里直接跑 `node:sqlite`：
//   `node:sqlite` 是同步驱动，一条没收敛的查询（递归 CTE、意外笛卡尔积）
//   会把整个事件循环卡住 —— 页面服务和写接口一起停摆。这条服务的原则是
//   「宁可发旧页面，也不白屏」，所以每次查询起一个一次性子进程，超时 SIGKILL。
//
// 为什么不把闸门写在这里：
//   执行器仍然是 `server/sqlrun.mjs` 那一份（只读连接 + 单条语句 + 只读关键字
//   + 行数上限）。本机 HTTP、SSH 到线上，跑的是同一份代码，规则不会分叉。
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER = path.join(ROOT, 'server', 'sqlrun.mjs');

/** 与 SSH 那条路的服务器端 `timeout 20` 保持一致。 */
export const DEFAULT_TIMEOUT_MS = 20000;

/** 执行器的错误码；路由据此决定 HTTP 状态码，CLI 据此决定退出码。 */
export const SQL_ERROR_CODES = new Set([
  'bad_request', 'bad_sql', 'exec_failed', 'no_database', 'open_failed', 'timeout',
]);

export class SqlError extends Error {
  constructor(message, code = 'exec_failed') {
    super(message);
    this.name = 'SqlError';
    this.code = code;
  }
}

/**
 * 在子进程里跑一条只读 SQL。
 *
 * @param {string} dbPath 数据库文件
 * @param {string} sql    单条只读语句
 * @returns {Promise<{columns: string[], rows: object[], count: number,
 *                    truncated: boolean, ms: number, limit: number, hint?: string}>}
 * @throws {SqlError} 校验失败 / 语法错误 / 超时 / 库不存在
 */
export function runSqlIsolated(dbPath, sql, { maxRows, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--no-warnings', RUNNER, '--db', dbPath],
      { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] }
    );

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new SqlError(`执行超时（${timeoutMs / 1000}s 已终止）`, 'timeout'));
    }, timeoutMs);

    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => finish(() => reject(new SqlError(`无法执行执行器：${err.message}`, 'exec_failed'))));
    child.stdin.on('error', () => {}); // 子进程提前退出时写 stdin 会 EPIPE

    child.on('close', (code) => finish(() => {
      const line = stdout.trim().split('\n').filter(Boolean).pop() || '';
      let data = null;
      try { data = JSON.parse(line); } catch { /* 下面统一报错 */ }

      if (!data) {
        const err = stderr.trim().split('\n').filter(Boolean).slice(-1)[0] || '';
        reject(new SqlError(`执行器没有返回结果（exit ${code}）${err ? `：${err}` : ''}`, 'exec_failed'));
        return;
      }
      if (!data.ok) {
        reject(new SqlError(data.error || 'SQL 执行失败', data.code || 'exec_failed'));
        return;
      }
      resolve({
        columns: data.columns || [],
        rows: data.rows || [],
        count: data.count ?? (data.rows || []).length,
        truncated: Boolean(data.truncated),
        ms: data.ms ?? 0,
        limit: data.limit,
        ...(data.hint ? { hint: data.hint } : {}),
      });
    }));

    child.stdin.end(JSON.stringify({ sql, maxRows }));
  });
}

/** RFC 4180 风格：含逗号/引号/换行的字段加引号，引号翻倍。 */
export function toCsv(columns, rows) {
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.map(esc).join(',')];
  for (const r of rows) lines.push(columns.map((c) => esc(r[c])).join(','));
  return lines.join('\n') + '\n';
}
