// 库内注册表：知识树 + 卷清单。volumes.json 退役后，这里是唯一的读取入口。
//
// 形状刻意与退役前的 volumes.json 保持一致（subjects/nodes/volumes 的键与顺序），
// 下游（aggregate、topics.mjs）不需要跟着改。
// 与 JSON 时代的差异只有一处：知识树节点不再带 aliases——全仓库零消费，
// 历史值随归档的 volumes.json 留在 archive/ 里。
//
// 人工维护入口：改树 / 加卷走写接口或 bin/mem 落库，然后从这里读出。
import { all, get } from './db.mjs';

function unenvelope(raw) {
  if (!raw) return { text: null, baseline: {} };
  try {
    const obj = JSON.parse(raw);
    return { text: obj.text ?? null, baseline: obj.baseline || {} };
  } catch {
    return { text: raw, baseline: {} };
  }
}

/** 知识树：{ version, subjects:[{id,name,exam}], nodes:[{id,name,parent,granularity}] } */
export function loadTree() {
  const metaRow = get("SELECT value FROM knowledge_meta WHERE key = 'treeVersion'");
  if (!metaRow) {
    throw new Error('knowledge_meta 里没有 treeVersion——数据库是旧版结构，先 ./scripts/pull-data.sh 拉最新数据');
  }
  const subjects = all('SELECT id, name, exam FROM subjects ORDER BY ord').map((r) => ({
    id: r.id,
    name: r.name,
    exam: r.exam,
  }));
  const nodes = all('SELECT id, subject_id, name, granularity FROM knowledge_nodes ORDER BY ord').map(
    (r) => ({
      id: r.id,
      name: r.name,
      parent: r.subject_id,
      granularity: r.granularity,
    })
  );
  return { version: Number(metaRow.value), subjects, nodes };
}

/**
 * 卷清单：papers 表即卷注册表（slug = 卷 slug，notes.baseline 存原文路径与题数）。
 * 排序：ord 升序，没编 ord 的按 rowid 排在后面。
 */
export function loadVolumes() {
  return all(
    `SELECT * FROM papers
     ORDER BY CASE WHEN ord IS NULL THEN 1 ELSE 0 END, ord, rowid`
  ).map((r) => {
    const { text, baseline } = unenvelope(r.notes);
    return {
      slug: r.slug,
      name: r.title,
      subject: r.subject,
      papers: Object.keys(baseline.paperPrefix || {}),
      answerSources: baseline.answerSources ?? [],
      totalQuestions: baseline.totalQuestions ?? null,
      scorableQuestions: baseline.scorableQuestions ?? null,
      notes: text,
    };
  });
}
