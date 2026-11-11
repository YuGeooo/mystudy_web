import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_NAME = process.env.MEM_CONFIG || 'config.local.json';
const CONFIG_PATH = path.resolve(ROOT, CONFIG_NAME);
const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

// 硬边界：进程绝不监听公网地址（公网暴露由 nginx 反代承担）。
if (!['127.0.0.1', 'localhost', '::1'].includes(raw.host)) {
  throw new Error(`拒绝启动：host 必须是本机回环地址，当前为 ${raw.host}`);
}
if (!Number.isInteger(raw.port) || raw.port < 1024 || raw.port > 65535) {
  throw new Error(`端口不合法：${raw.port}`);
}

const dbPath = path.resolve(ROOT, process.env.MEM_DB || raw.database);
if (!fs.existsSync(dbPath)) {
  throw new Error(`数据库不存在：${dbPath}（先跑 python3 scripts/migrate.py）`);
}

// ---- 写模式 ----
// 写能力必须同时满足：配置开启 + 有 token + 不与 readOnly 冲突。
// 缺任一项就直接拒绝启动，而不是运行中返回 403 —— 宁可起不来，不要留半开的口子。
const writeCfg = raw.write || {};
const writeEnabled = writeCfg.enabled === true;
const writeToken = process.env.MEM_WRITE_TOKEN || writeCfg.token || '';
const hasToken = typeof writeToken === 'string' && writeToken.length >= 16;

if (writeEnabled && !hasToken) {
  throw new Error(
    '拒绝启动：write.enabled=true 但没有有效 token。' +
      '请设置环境变量 MEM_WRITE_TOKEN（至少 16 字符）。'
  );
}
if (writeEnabled && raw.readOnly === true) {
  throw new Error('拒绝启动：write.enabled=true 与 readOnly=true 互斥，请检查配置。');
}

// ---- 导出产物路径 ----
// 测试配置写不同文件名，避免把正式 index.json / content.json 覆盖掉。
const exportCfg = raw.export || {};
const exportIndexPath = path.resolve(
  ROOT, process.env.MEM_EXPORT_INDEX || exportCfg.index || path.join('data', 'index.json')
);
const exportContentPath = path.resolve(
  ROOT, process.env.MEM_EXPORT_CONTENT || exportCfg.content || path.join('data', 'content.json')
);
const volumesPath = path.resolve(
  ROOT, process.env.MEM_VOLUMES || raw.volumes || path.join('data', 'volumes.json')
);

// ---- 备份 ----
// 写接口每次写库前自动快照，改坏了能退回去。只读进程不做备份。
const backupCfg = raw.backup || {};
const backupDir = path.resolve(ROOT, process.env.MEM_BACKUP_DIR || backupCfg.dir || 'backups');
const backupKeep = Number.isInteger(backupCfg.keep) && backupCfg.keep > 0 ? backupCfg.keep : 20;
const backupBeforeWrite = backupCfg.beforeWrite !== false;

export default {
  ...raw,
  root: ROOT,
  configPath: CONFIG_PATH,
  configName: CONFIG_NAME,
  dbPath,
  volumesPath,
  exportIndexPath,
  exportContentPath,
  backupDir,
  backupKeep,
  backupBeforeWrite,
  writeEnabled,
  writeToken: hasToken ? writeToken : null,
  // 数据库连接是否只读：写模式开启才允许读写。
  readOnly: !writeEnabled,
};
