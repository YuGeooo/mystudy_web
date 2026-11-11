import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.local.json'), 'utf8'));

// 硬边界：本地开发服务绝不监听公网接口。
if (!['127.0.0.1', 'localhost', '::1'].includes(raw.host)) {
  throw new Error(`拒绝启动：host 必须是本机回环地址，当前为 ${raw.host}`);
}
if (!Number.isInteger(raw.port) || raw.port < 1024 || raw.port > 65535) {
  throw new Error(`端口不合法：${raw.port}`);
}

const dbPath = path.resolve(ROOT, raw.database);
if (!fs.existsSync(dbPath)) {
  throw new Error(`数据库不存在：${dbPath}（先跑 python3 scripts/migrate.py）`);
}

export default {
  ...raw,
  root: ROOT,
  dbPath,
};
