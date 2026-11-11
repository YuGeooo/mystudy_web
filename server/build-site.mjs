// 站点渲染：三份 JSON 契约 → 页面。
//
// 两种出口，共用同一套解析与聚合：
//   buildPages() → 内存 Map，运行时按请求出页面用（服务端常驻，写完立刻生效）
//   buildSite()  → 写盘，静态构建用（release 兜底、本地预览、离线查看）
//
// 与站点仓库 index.mjs 的差别只有两点：数据源从 git 换成 content.json，commits 恒为空。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isSessionPath, parseSession } from '../web/render/parse.mjs';
import { buildData } from '../web/render/aggregate.mjs';
import { renderSite } from '../web/render/render.mjs';
import { todayLocal } from './dates.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const WEB = path.join(ROOT, 'web');
// 默认输出到 web/.build；服务器构建时用 MEM_OUT 直接指向 release 目录。
export const BUILD_DIR = process.env.MEM_OUT
  ? path.resolve(process.env.MEM_OUT)
  : path.join(WEB, '.build');

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

function countBy(items, keyFn) {
  const out = {};
  for (const item of items) {
    const k = keyFn(item);
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

/**
 * 读契约、解析场次、聚合出渲染所需的全部输入。
 * 每次调用都是全量重算——库小（几十场、几百条作答），实测远快于一次网络往返。
 *
 * paths 可覆盖默认位置：测试进程要读 test-index.json / test-content.json，
 * 不能把正式契约渲染出来。
 */
export function prepare(paths = {}) {
  const siteConfigFile = paths.siteConfig || path.join(WEB, 'site.config.json');
  const volumesFile = paths.volumes || path.join(DATA, 'volumes.json');
  const indexFile = paths.index || path.join(DATA, 'index.json');
  const contentFile = paths.content || path.join(DATA, 'content.json');

  const config = readJson(siteConfigFile);
  const volumes = readJson(volumesFile);
  const jsonIndex = readJson(indexFile);
  const content = readJson(contentFile);
  const timeZone = config.site?.timezone || 'Asia/Shanghai';

  // 卷清单单一数据源：与站点 index.mjs 的派生规则逐字一致。
  const volumeNotes = config.volumeNotes || {};
  config.volumes = Object.fromEntries(
    (volumes.volumes || [])
      .filter((v) => v.papers?.length)
      .map((v) => {
        const dir = v.papers[0].split('/')[0];
        const entry = {
          slug: v.slug,
          subject: v.subject,
          totalQuestions: v.scorableQuestions ?? v.totalQuestions,
        };
        const note = volumeNotes[dir] || volumeNotes[v.slug];
        if (note) entry.note = note;
        return [dir, entry];
      })
  );

  const warnings = [];
  const sessions = [];
  const sources = [];
  const sessionFiles = Object.keys(content.sessions).filter(isSessionPath).sort();
  for (const filePath of sessionFiles) {
    const text = content.sessions[filePath];
    const { session, warnings: sw } = parseSession({
      filePath,
      content: text,
      config,
      firstCommitAt: null, // 不再用 git 推断时间；原文 front matter 自带 time
      timeZone,
    });
    warnings.push(...sw);
    if (session) {
      sessions.push(session);
      sources.push({ session, content: text });
    }
  }

  const today = todayLocal(timeZone);
  const data = buildData({
    sessions,
    commits: [], // 热力图 / 连续天数改由 sessions.date 驱动
    config,
    memCommit: 'localdb',
    today,
    timeZone,
    warnings,
    jsonIndex,
  });

  const scoreCounts = countBy(sessions, (s) => s.scoreSource);
  const report = {
    generatedAt: new Date().toISOString(),
    memCommit: 'localdb',
    memCommitShort: 'localdb',
    source: 'mem_new/data/mem.db（content.json / index.json / volumes.json）',
    counts: {
      commits: 0,
      trackedFiles: sessionFiles.length + Object.keys(content.papers).length,
      markdownFiles: sessionFiles.length + Object.keys(content.papers).length,
      sessionFiles: sessionFiles.length,
      sessions: sessions.length,
      volumes: data.volumes.length,
      days: data.days.length,
    },
    coverage: {
      timeExplicit: sessions.filter((s) => s.timeSource === 'explicit').length,
      timeFromCommit: 0,
      durationKnown: sessions.filter((s) => s.minutes != null).length,
      durationTotal: sessions.length,
      score: {
        explicit: scoreCounts.explicit || 0,
        table: scoreCounts.table || 0,
        tablePartial: scoreCounts['table-partial'] || 0,
        lines: scoreCounts.lines || 0,
        linesPartial: scoreCounts['lines-partial'] || 0,
        headings: scoreCounts.headings || 0,
        json: scoreCounts.json || 0,
        none: scoreCounts.none || 0,
      },
    },
    warnings: data.warnings,
    jsonIndex: {
      questions: jsonIndex.questions?.length || 0,
      sessions: jsonIndex.sessions?.length || 0,
      attempts: jsonIndex.attempts?.length || 0,
    },
  };

  return {
    data,
    config,
    report,
    sources,
    today,
    timeZone,
    stats: {
      sessions: sessions.length,
      days: data.days.length,
      volumes: data.volumes.length,
      warnings: data.warnings.length,
    },
  };
}

/**
 * 渲染到内存。返回 Map<相对路径, 内容>，一次磁盘写都不发生。
 * 运行时服务就是靠这个：写完库 → 重建这张表 → 下一次请求立刻是新页面。
 */
export function buildPages(paths = {}) {
  const ctx = prepare(paths);
  const pages = new Map();
  renderSite({
    data: ctx.data,
    config: ctx.config,
    report: ctx.report,
    sources: ctx.sources,
    outDir: '',
    emit: (relPath, content) => pages.set(relPath, content),
  });
  return { pages, today: ctx.today, stats: ctx.stats };
}

/** 渲染到磁盘（静态构建）。 */
export function buildSite(paths = {}) {
  const ctx = prepare(paths);
  const written = renderSite({
    data: ctx.data,
    config: ctx.config,
    report: ctx.report,
    sources: ctx.sources,
    outDir: BUILD_DIR,
  });
  // 本地开发用预编译好的 app.css 直接复制；服务器上由 Tailwind 在渲染后编译，源文件不存在时跳过。
  fs.mkdirSync(path.join(BUILD_DIR, 'assets'), { recursive: true });
  const cssSource = path.join(WEB, 'assets', 'app.css');
  if (fs.existsSync(cssSource)) {
    fs.copyFileSync(cssSource, path.join(BUILD_DIR, 'assets', 'app.css'));
  }

  return {
    written,
    warnings: ctx.data.warnings,
    ...ctx.stats,
    today: ctx.today,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = buildSite();
  console.log(`构建完成：${result.written.length} 个文件 → ${BUILD_DIR}`);
  console.log(`场次 ${result.sessions} · 学习日 ${result.days} · 卷 ${result.volumes} · 警告 ${result.warnings.length}`);
  for (const w of result.warnings) console.log(`  警告：${w}`);
}
