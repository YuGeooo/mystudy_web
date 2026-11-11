import http from 'node:http';
import config from './config.mjs';
import { handle } from './routes.mjs';
import { openDb, closeDb, get } from './db.mjs';
import { SQL } from './queries.mjs';
import * as pages from './pages.mjs';

const counts = get(SQL.coverage);
openDb();

// 页面在进程内渲染：只读、写模式都一样要建一次页表。
// 以前写模式不建站是因为页面由外部构建流程产出，现在页面就是本进程的一部分。
const BUILD_SITE = process.env.MEM_BUILD_SITE !== '0';
let site = null;
if (BUILD_SITE) {
  try {
    site = pages.rebuild('startup');
  } catch (err) {
    console.error(`页表构建失败：${err.message}`);
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
  handle(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    }
    res.end(JSON.stringify({ error: err.message }) + '\n');
  });
});

server.listen(config.port, config.host, () => {
  const mode = config.writeEnabled ? '读写（写接口已启用，需 Bearer token）' : '只读';
  console.log(`mem_web api  →  http://${config.host}:${config.port}`);
  console.log(`配置 ${config.configName} · 数据库 ${config.database} · ${mode}`);
  console.log(`SQLite ${get('SELECT sqlite_version() v').v}`);
  console.log(
    `行数 papers=${counts.papers} questions=${counts.questions} ` +
    `sessions=${counts.sessions} attempts=${counts.attempts}`
  );
  if (site) {
    console.log(
      `站点 http://${config.host}:${config.port}/study/  页表 v${site.version} · ` +
      `${site.pages} 页 · ${site.stats.sessions} 场 / ${site.stats.days} 学习日 / ` +
      `${site.stats.volumes} 卷 · 首次渲染 ${site.ms}ms`
    );
    console.log('页面按请求从内存出，写库后自动重建；不再依赖构建产物与定时任务。');
  } else {
    console.log('页表构建已关闭（MEM_BUILD_SITE=0），本进程只提供 /api/*。');
  }
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
