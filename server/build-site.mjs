// 站点渲染：SQLite → 页面。
//
// 两种出口，共用同一套解析与聚合：
//   buildPages() → 内存 Map，运行时按请求出页面用（服务端常驻，写完立刻生效）
//   buildSite()  → 写盘，静态构建用（release 兜底、本地预览、离线查看）
//
// 数据直接从库构造（server/export.mjs 的 buildIndex / buildContent），
// index.json / content.json 仍是导出物，但只是对外契约与备份，不再是渲染输入。
// 与站点仓库 index.mjs 的差别只有两点：数据源从 git 换成库，commits 恒为空。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isSessionPath, parseSession } from '../web/render/parse.mjs';
import { buildData } from '../web/render/aggregate.mjs';
import { buildPaper } from '../web/render/paper.mjs';
import { renderSite } from '../web/render/render.mjs';
import { buildIndex, buildContent } from './export.mjs';
import appConfig from './config.mjs';
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

// 试卷渲染结果按 Markdown 原文缓存。KaTeX 是这一步最慢的地方（8 份约 45ms），
// 而写接口通常只改作答与判定、试卷正文不动，所以原文没变就直接复用上次的 HTML，
// 写库后的页表重建不会因为试卷页变慢。
const paperCache = new Map();

/**
 * 试卷：volumes.json 决定顺序与归属，content.json 提供原文。
 * 一个卷只有一份试卷时用卷 slug（/papers/2024-exam/），有多份时补序号
 * （/papers/formal-logic-1/），保证 URL 稳定、不因文件名带中文而变形。
 */
function buildPapers(content, volumesJson) {
  const papers = [];
  const missing = [];
  for (const volume of volumesJson.volumes || []) {
    const paths = (volume.papers || []).filter((p) => content.papers[p] != null);
    for (const p of volume.papers || []) {
      if (content.papers[p] == null) missing.push(p);
    }
    paths.forEach((paperPath, index) => {
      const md = content.papers[paperPath];
      const cached = paperCache.get(paperPath);
      const paper = cached && cached.md === md ? cached.paper : buildPaper({ path: paperPath, md });
      if (!cached || cached.md !== md) paperCache.set(paperPath, { md, paper });
      papers.push({
        ...paper,
        slug: paths.length > 1 ? `${volume.slug}-${index + 1}` : volume.slug,
        volumeSlug: volume.slug,
        volumeName: volume.name,
        subject: volume.subject,
      });
    });
  }
  // 没被任何卷收录的原文不静默丢掉：挂一条 warning，提醒回 volumes.json 补登记
  for (const p of Object.keys(content.papers)) {
    if (!papers.some((x) => x.path === p)) missing.push(p);
  }
  return { papers, missing };
}

/**
 * 读配置、从库构造数据、解析场次、聚合出渲染所需的全部输入。
 * 每次调用都是全量重算——库小（几十场、几百条作答），实测远快于一次网络往返。
 *
 * paths 只覆盖 siteConfig 与 volumes；数据一律来自配置指向的库
 * （测试进程 MEM_CONFIG=config.test.json → data/test.db，天然与正式数据隔离）。
 */
export function prepare(paths = {}) {
  const siteConfigFile = paths.siteConfig || path.join(WEB, 'site.config.json');
  const volumesFile = paths.volumes || path.join(DATA, 'volumes.json');

  const config = readJson(siteConfigFile);
  const volumes = readJson(volumesFile);
  // 页面数据直接从库构造，不再读 index.json / content.json 的导出快照。
  // 两份文件仍然导出（对外契约、备份、离线预览），但不再是渲染输入：
  // 导出与渲染之间不再有时间窗，绕过接口改了库也不会出现「页面旧、API 新」。
  const jsonIndex = buildIndex(volumes);
  const content = buildContent(path.basename(appConfig.dbPath));
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
  const { papers, missing: missingPapers } = buildPapers(content, volumes);
  for (const paperPath of missingPapers) warnings.push(`试卷未能上线（原文缺失或未登记卷）：${paperPath}`);
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
    source: 'mem_web/data/mem.db（content.json / index.json / volumes.json）',
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
    papers,
    today,
    timeZone,
    stats: {
      sessions: sessions.length,
      days: data.days.length,
      volumes: data.volumes.length,
      papers: papers.length,
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
    papers: ctx.papers,
    outDir: '',
    emit: (relPath, content) => pages.set(relPath, content),
  });
  return { pages, today: ctx.today, stats: ctx.stats, data: ctx.data };
}

/** 渲染到磁盘（静态构建）。 */
export function buildSite(paths = {}) {
  const ctx = prepare(paths);
  const written = renderSite({
    data: ctx.data,
    config: ctx.config,
    report: ctx.report,
    sources: ctx.sources,
    papers: ctx.papers,
    outDir: BUILD_DIR,
  });
  // 静态资源整目录复制：app.css + KaTeX 的样式与字体（试卷页公式要用）。
  // 服务器上由 Tailwind 在渲染后编译，源文件不存在时跳过。
  const assetsSource = path.join(WEB, 'assets');
  if (fs.existsSync(assetsSource)) {
    fs.cpSync(assetsSource, path.join(BUILD_DIR, 'assets'), { recursive: true });
  }

  return {
    written,
    ...ctx.stats,
    // warnings 放最后：stats 里有个同名的计数，展开顺序错了会让这个字段变成数字
    warnings: ctx.data.warnings,
    today: ctx.today,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = buildSite();
  console.log(`构建完成：${result.written.length} 个文件 → ${BUILD_DIR}`);
  console.log(`场次 ${result.sessions} · 学习日 ${result.days} · 卷 ${result.volumes} · 警告 ${result.warnings.length}`);
  for (const w of result.warnings) console.log(`  警告：${w}`);
}
