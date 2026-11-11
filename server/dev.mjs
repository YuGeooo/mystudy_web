import http from 'node:http';
import config from './config.mjs';
import { handle } from './routes.mjs';
import { openDb, closeDb, get } from './db.mjs';
import { SQL } from './queries.mjs';
import { buildSite } from './build-site.mjs';

const counts = get(SQL.coverage);
openDb();

// 本地默认启动即重建站点；服务器只跑 API（页面由构建流程产出），用 MEM_BUILD_SITE=0 关掉。
const BUILD_SITE = process.env.MEM_BUILD_SITE !== '0';
let site = null;
if (BUILD_SITE) {
  try {
    site = buildSite();
  } catch (err) {
    console.error(`站点构建失败：${err.message}`);
    closeDb();
    process.exit(1);
  }
}

const server = http.createServer((req, res) => {
  const start = performance.now();
  res.on('finish', () => {
    const ms = (performance.now() - start).toFixed(1);
    console.log(`${req.method} ${req.url} ${res.statusCode} ${ms}ms`);
  });
  handle(req, res);
});

server.listen(config.port, config.host, () => {
  console.log(`mem_new dev api  →  http://${config.host}:${config.port}`);
  console.log(`数据库 ${config.database}（只读，SQLite ${get('SELECT sqlite_version() v').v}）`);
  console.log(
    `行数 papers=${counts.papers} questions=${counts.questions} ` +
    `sessions=${counts.sessions} attempts=${counts.attempts}`
  );
  if (site) {
    console.log(`站点 http://${config.host}:${config.port}/study/  ` +
      `（${site.written.length} 个文件，${site.sessions} 场 / ${site.days} 学习日 / ` +
      `${site.volumes} 卷 / 警告 ${site.warnings.length}）`);
  } else {
    console.log('站点构建已关闭（MEM_BUILD_SITE=0），本进程只提供 /api/*。');
  }
  console.log('端点 /api/health  /api/meta  /api/days');
  console.log('说明 node:sqlite 是 Node 实验特性，启动时的 ExperimentalWarning 属预期。');
  console.log('Ctrl+C 停止。');
});

function shutdown() {
  server.close(() => {
    closeDb();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
