import config from './config.mjs';
import { get } from './db.mjs';
import { buildMeta, buildDays } from './aggregate.mjs';
import { todayLocal } from './dates.mjs';
import { serveStatic } from './static.mjs';

function send(res, status, data) {
  const body = JSON.stringify(data, null, 2) + '\n';
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

export function handle(req, res) {
  const url = new URL(req.url, `http://${config.host}:${config.port}`);

  // 站点静态产物（P2）
  if (url.pathname === '/' || url.pathname === '/study') {
    res.writeHead(302, { Location: '/study/' });
    return res.end();
  }
  if (url.pathname.startsWith('/study/')) {
    return serveStatic(req, res, url.pathname);
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, { error: '只提供 GET / HEAD', method: req.method });
  }

  try {
    switch (url.pathname) {
      case '/api':
        return send(res, 200, {
          service: 'mem_new dev api',
          stage: 'P2',
          source: 'sqlite (read-only)',
          site: `http://${config.host}:${config.port}/study/`,
          endpoints: ['/api/health', '/api/meta', '/api/days'],
        });
      case '/api/health':
        return send(res, 200, {
          ok: true,
          sqlite: get('SELECT sqlite_version() AS version').version,
          readOnly: config.readOnly,
          database: config.database,
        });
      case '/api/meta':
        return send(res, 200, buildMeta({ timeZone: config.timeZone }));
      case '/api/days':
        return send(res, 200, buildDays({
          timeZone: config.timeZone,
          today: todayLocal(config.timeZone),
        }));
      default:
        return send(res, 404, { error: 'not found', path: url.pathname, hint: '站点在 /study/' });
    }
  } catch (err) {
    return send(res, 500, { error: err.message });
  }
}
