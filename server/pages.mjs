// 运行时页面服务：库 → 页面，按请求直接给出，不再预生成文件。
//
// 以前的链路是「构建 172 个文件 → nginx 发静态文件 → 定时任务发现数据变了再构建一次」，
// 页面永远是「上一次构建时」的快照。现在改成进程里常驻一张页表：
//
//   启动渲染一次  →  每次写库后重建  →  请求直接命中内存
//
// 写完立刻生效，没有定时任务、没有轮询、没有最长 5 分钟的窗口。
// 代价是页面可用性绑在这个进程上（以前 Node 挂了静态文件还能看），
// 所以进程加了 Restart=on-failure，重建失败也不会清空旧表——宁可发旧页面，不发白屏。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPages } from './build-site.mjs';
import config from './config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = path.join(ROOT, 'web', 'assets');

// 契约路径走配置：测试进程（8138）读的是 test-index.json，不会把正式数据渲染出来。
const CONTRACTS = {
  index: config.exportIndexPath,
  content: config.exportContentPath,
  volumes: config.volumesPath,
};

const MIME = {
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

const mimeOf = (rel) => MIME[path.extname(rel).toLowerCase()] || 'application/octet-stream';

let pages = new Map();
// 页面数据的全集（buildData 的返回值）：stats / volumes / knowledge / days / weeks / countdown。
// `/api/study` 直接返回这一份，不重新算——页面与接口同源，避免第二套聚合口径。
let siteData = null;
let state = {
  version: 0,
  builtAt: null,
  today: null,
  stats: null,
  ms: 0,
  reason: null,
  error: null,
};

// 静态资源单独缓存：CSS 是 Tailwind 预编译产物，不随数据变化。
let cssCache = null; // { body: Buffer, mtimeMs }

// 契约文件的指纹（大小 + mtime）。写接口会主动重建页表，但直接改库再重导 JSON
// 这种绕开写接口的路径也得让页面跟上，所以每次请求顺手比对一下。
let contractsStamp = '';

function contractsFingerprint() {
  const parts = [];
  for (const file of [CONTRACTS.index, CONTRACTS.content, CONTRACTS.volumes]) {
    try {
      const st = fs.statSync(file);
      parts.push(`${st.size}:${Math.round(st.mtimeMs)}`);
    } catch {
      parts.push('-');
    }
  }
  return parts.join('|');
}

/**
 * 全量重建页表。库小（几十场、几百条作答），一次重建是毫秒级，
 * 换来的是「改完立刻可见」，不需要任何增量失效逻辑。
 */
export function rebuild(reason = 'manual') {
  const t0 = performance.now();
  const stamp = contractsFingerprint();
  const { pages: next, today, stats, data } = buildPages(CONTRACTS);
  if (next.size === 0) throw new Error('渲染结果为空，拒绝替换页表');

  pages = next;
  siteData = data;
  contractsStamp = stamp;
  state = {
    version: state.version + 1,
    builtAt: new Date().toISOString(),
    today,
    stats,
    ms: Math.round(performance.now() - t0),
    reason,
    error: null,
  };
  return status();
}

/** 重建失败不回滚已发布的表：旧页面还能看，错误挂在 status 里。 */
export function rebuildSafe(reason = 'write') {
  try {
    return rebuild(reason);
  } catch (err) {
    state = { ...state, error: err.message, reason };
    console.error(`[pages] 重建失败（${reason}）：${err.message}；继续提供上一版页面`);
    return status();
  }
}

export function status() {
  return { ...state, pages: pages.size };
}

function loadCss() {
  const file = path.join(ASSETS, 'app.css');
  try {
    const st = fs.statSync(file);
    if (!cssCache || cssCache.mtimeMs !== st.mtimeMs) {
      cssCache = { body: fs.readFileSync(file), mtimeMs: st.mtimeMs };
    }
    return cssCache.body;
  } catch {
    return null;
  }
}

/**
 * 页面数据的全集——就是渲染这批页面时用的那份 buildData() 结果。
 * `/api/study` 原样返回，不重新查库：页面看到什么，接口就返回什么。
 */
export function getSiteData() {
  return siteData;
}

function send(req, res, status_, body, type, etag) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  const headers = {
    'Content-Type': type,
    'Content-Length': buf.length,
    // 必须回源校验：内容会随写库变化，不能给浏览器一个"一段时间内别问"的缓存
    'Cache-Control': 'no-cache',
  };
  if (etag) headers.ETag = etag;

  const inm = req.headers['if-none-match'];
  if (etag && inm && inm === etag) {
    delete headers['Content-Length'];
    res.writeHead(304, headers);
    return res.end();
  }
  res.writeHead(status_, headers);
  return res.end(req.method === 'HEAD' ? undefined : buf);
}

/**
 * 处理 /study/* 的请求。
 * @param {string} today 调用方算好的本地日期，用于跨天失效
 */
export function serve(req, res, pathname, today) {
  // 页面里的「今天」「倒计时天数」是按渲染那一刻算的，跨天必须重算。
  if (state.builtAt && state.today && today && state.today !== today) {
    rebuildSafe('date-roll');
  } else if (state.builtAt && contractsFingerprint() !== contractsStamp) {
    // 绕开写接口改了库、重新导了 JSON（本机 scripts/sync.sh、运维手工替换）时，
    // 下一次请求就把页面补齐，不用重启进程。
    rebuildSafe('contracts-changed');
  }

  let rel;
  try {
    rel = decodeURIComponent(pathname.replace(/^\/study\/?/, ''));
  } catch {
    return send(req, res, 400, '{"error":"bad path"}\n', 'application/json; charset=utf-8');
  }
  if (!rel || rel.endsWith('/')) rel += 'index.html';

  if (rel.startsWith('assets/')) {
    const css = loadCss();
    if (rel === 'assets/app.css' && css) {
      return send(req, res, 200, css, MIME['.css'], `W/"css-${css.length}"`);
    }
    return send(req, res, 404, '{"error":"not found"}\n', 'application/json; charset=utf-8');
  }

  const body = pages.get(rel);
  if (body == null) {
    // 用同一份页表里的 404 页，视觉上和站点一致
    const page404 = pages.get('404.html');
    if (page404) return send(req, res, 404, page404, MIME['.html']);
    return send(req, res, 404, '{"error":"not found","path":"' + rel + '"}\n', 'application/json; charset=utf-8');
  }

  return send(req, res, 200, body, mimeOf(rel), `W/"v${state.version}-${Buffer.byteLength(body)}"`);
}
