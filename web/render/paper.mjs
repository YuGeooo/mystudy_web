// 试卷页：把 content.json 里的试卷 Markdown 变成可以直接看的 HTML。
//
// 这里只做两件事，版式留给 render.mjs：
//   1. 公式：$...$ 与 $$...$$ 交给 KaTeX 在服务端渲染，页面因此不需要任何前端 JS
//   2. 结构：抽出标题、导语、章节、每题锚点，供顶部题号导航用
//
// 锚点形状是固定的 <a id="2024-exam-q001"></a>，由 export.mjs 从 questions.content_md
// 逐题拼接产出，与 questions.id 一一对应；题号导航只依赖这一种写法，认不出的锚点就退化成序号。
import katex from 'katex';
import { marked } from 'marked';

// 试卷原文偶尔自带答案附录（如「形式逻辑与综合推理一」书末的答案速查表），
// 看卷时不该剧透，整节略去并在页面上注明。
const ANSWER_SECTION = /^(参考)?答案/

// 章节标题只取冒号前的部分做导航文案：「一、问题求解：第 1～15 小题…」→「一、问题求解」。
const NAV_TITLE_MAX = 28;

function shortTitle(text) {
  const head = String(text).split(/[：:]/)[0].trim() || String(text).trim();
  return head.length > NAV_TITLE_MAX ? `${head.slice(0, NAV_TITLE_MAX)}…` : head;
}

/** 从锚点 id 推一个短标签：q001 → 1，writing-a → 写A，translation → 译，其余退化为序号。 */
function anchorLabel(id, seq) {
  const tail = String(id).split('-').pop();
  if (/^translation$/i.test(tail)) return '译';
  const writing = /(?:^|-)writing-([a-z])$/i.exec(id);
  if (writing) return `写${writing[1].toUpperCase()}`;
  const essay = /essay(\d+)$/i.exec(id);
  if (essay) return `写${Number(essay[1])}`;
  if (/^\d+$/.test(tail)) return String(Number(tail));
  return String(seq);
}

/**
 * Markdown → HTML，其中公式先用占位符替换再交给 marked，避免 marked 把 TeX 里的
 * `_` `*` `\` 当成 Markdown 语法吃掉。
 */
function convertMath(md) {
  const maths = [];
  const token = (index) => `@@KATEX${index}@@`;
  const put = (tex, display) => {
    maths.push({ tex, display });
    return token(maths.length - 1);
  };

  const parts = md.split(/(```[\s\S]*?```)/);
  const prepared = parts
    .map((part) => {
      if (part.startsWith('```')) return part; // 代码块原样保留
      let text = part.replace(/\$\$([\s\S]+?)\$\$/g, (_, tex) => `\n\n${put(tex.trim(), true)}\n\n`);
      text = text
        .split('\n')
        .map((line) =>
          // 只在一行内配对：这样「US $2.13 an hour」这种单个美元符不会被吞成公式。
          line.replace(/\$([^$\n]+?)\$/g, (whole, tex) => {
            if (!tex.trim()) return whole;
            if (/^\s|\s$/.test(tex)) return whole; // $ 100 这类空格包裹的不当公式
            return put(tex, false);
          })
        )
        .join('\n');
      return text;
    })
    .join('');

  // breaks: true —— 试卷原文是逐行抄的（题干一行、A–E 各一行），
  // 不把单换行当换行的话，选项会挤成一段。
  let html = marked.parse(prepared, { gfm: true, breaks: true });
  // 独占一段的公式（$$ 块）不要把 <p> 留在外面，否则上下会多出段落间距
  html = html.replace(/<p>\s*(@@KATEX\d+@@)\s*<\/p>/g, '<div class="math-block">$1</div>');
  html = html.replace(/@@KATEX(\d+)@@/g, (_, index) => {
    const math = maths[Number(index)];
    return katex.renderToString(math.tex, {
      displayMode: math.display,
      throwOnError: false, // 坏公式渲染成红字，不让整页渲染失败
      strict: 'ignore', // \dfrac 之类的中文排版警告不必逐条打在日志里
      output: 'htmlAndMathml',
    });
  });

  return {
    html,
    count: maths.length,
    errors: (html.match(/katex-error/g) || []).length,
  };
}

/** 切开 H1 与开头引言，剩下的才是正文。 */
function splitHead(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  let title = '';
  let index = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^#\s+\S/.test(lines[i])) {
      title = lines[i].replace(/^#\s+/, '').trim();
      index = i + 1;
      break;
    }
  }

  while (index < lines.length && !lines[index].trim()) index += 1;
  const intro = [];
  while (index < lines.length && /^>\s?/.test(lines[index])) {
    intro.push(lines[index].replace(/^>\s?/, '').trim());
    index += 1;
  }

  let body = lines.slice(index).join('\n');
  // 紧跟引言的那条分隔线去掉：版式上已经有间隔了
  body = body.replace(/^(?:[ \t]*\n)*(?:---[ \t]*\n)+/, '');
  return { title, intro: intro.filter(Boolean).join(' '), body };
}

/** 按 `## ` 切节，顺便把答案附录整节拿掉。 */
function splitSections(body) {
  const lines = body.split('\n');
  const kept = [];
  let dropped = null;
  let skipping = false;
  for (const line of lines) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      skipping = ANSWER_SECTION.test(heading[1]);
      if (skipping) {
        dropped = heading[1];
        continue;
      }
    }
    if (!skipping) kept.push(line);
  }
  return { body: kept.join('\n').replace(/\n{3,}/g, '\n\n').trim(), dropped };
}

/** 章节与题目锚点，按正文出现顺序。 */
function scanStructure(body) {
  const sections = [];
  const questions = [];
  let current = null;
  for (const line of body.split('\n')) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      current = {
        id: `s${sections.length + 1}`,
        title: shortTitle(heading[1]),
        full: heading[1],
        count: 0,
      };
      sections.push(current);
    }
    for (const match of line.matchAll(/<a id="([^"]+)"><\/a>/g)) {
      questions.push({
        id: match[1],
        label: anchorLabel(match[1], questions.length + 1),
        section: current ? current.id : null,
      });
      if (current) current.count += 1;
    }
  }
  return { sections, questions };
}

/**
 * 一份试卷的全部渲染产物。
 * @param {{path: string, md: string}} input
 */
export function buildPaper({ path, md }) {
  const head = splitHead(md);
  const cut = splitSections(head.body);
  const { sections, questions } = scanStructure(cut.body);
  const math = convertMath(cut.body);

  // 章节用 s1… 的 id，与 scanStructure 的顺序一致；marked 输出顺序与正文相同，所以顺序编号即可。
  let h2 = 0;
  const html = math.html.replace(/<h2>/g, () => `<h2 id="s${(h2 += 1)}">`);

  return {
    path,
    title: head.title || path,
    intro: head.intro || null,
    html,
    sections,
    questions,
    dropped: cut.dropped,
    mathCount: math.count,
    mathErrors: math.errors,
    bytes: Buffer.byteLength(md, 'utf8'),
    source: md,
  };
}
