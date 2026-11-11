// 把 web/.build/ 托管在 /study/ 下。纯 node:fs，无第三方依赖。
//
// 注意：线上与本地都已经改走 server/pages.mjs（进程内实时渲染），这个文件不再被路由引用。
// 保留它是因为静态构建（node server/build-site.mjs → web/.build/）仍然可用，
// 需要对着磁盘产物做离线预览时还会用到。
import fs from 'node:fs';
import path from 'node:path';
import { BUILD_DIR } from './build-site.mjs';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function json(res, status, data) {
  const body = JSON.stringify(data, null, 2) + '\n';
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

export function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname.replace(/^\/study\/?/, ''));
  } catch {
    return json(res, 400, { error: 'bad path' });
  }
  if (!rel || rel.endsWith('/')) rel += 'index.html';

  const file = path.resolve(BUILD_DIR, rel);
  if (file !== BUILD_DIR && !file.startsWith(BUILD_DIR + path.sep)) {
    return json(res, 403, { error: 'forbidden' });
  }

  fs.readFile(file, (err, buf) => {
    if (err) return json(res, 404, { error: 'not found', path: rel });
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': 'no-store',
    });
    res.end(req.method === 'HEAD' ? undefined : buf);
  });
}
