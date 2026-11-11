// P2 Node 构建器：三份 JSON → 原来的 parseSession / buildData / renderSite → 静态 HTML。
// 与站点 index.mjs 的差别只有两点：数据源从 git 换成 content.json，commits 恒为空。
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

export function buildSite() {
  const config = readJson(path.join(WEB, 'site.config.json'));
  const volumes = readJson(path.join(DATA, 'volumes.json'));
  const jsonIndex = readJson(path.join(DATA, 'index.json'));
  const content = readJson(path.join(DATA, 'content.json'));
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

  const written = renderSite({ data, config, report, outDir: BUILD_DIR, sources });
  // 本地开发用预编译好的 app.css 直接复制；服务器上由 Tailwind 在渲染后编译，源文件不存在时跳过。
  fs.mkdirSync(path.join(BUILD_DIR, 'assets'), { recursive: true });
  const cssSource = path.join(WEB, 'assets', 'app.css');
  if (fs.existsSync(cssSource)) {
    fs.copyFileSync(cssSource, path.join(BUILD_DIR, 'assets', 'app.css'));
  }

  return {
    written,
    warnings: data.warnings,
    sessions: sessions.length,
    days: data.days.length,
    volumes: data.volumes.length,
    today,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = buildSite();
  console.log(`构建完成：${result.written.length} 个文件 → ${BUILD_DIR}`);
  console.log(`场次 ${result.sessions} · 学习日 ${result.days} · 卷 ${result.volumes} · 警告 ${result.warnings.length}`);
  for (const w of result.warnings) console.log(`  警告：${w}`);
}
