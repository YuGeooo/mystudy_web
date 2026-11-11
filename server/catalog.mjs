// 题目与试卷的写业务。
//
// 这两张表是「题库」，比场次/作答更底层：改动会连带影响导出契约与站点题库页，
// 所以每条写路径都守三条：
//   1. topic_id 必须在库里的知识树（subjects / knowledge_nodes）里 —— 否则导出器直接抛错
//   2. 题的原文归属（notes.baseline.paper）必须在卷的 paperPrefix 里 ——
//      否则 content.json 的原文页会静默少一块
//   3. 删除有保护：题被作答引用、卷里还有题/场次，一律拒绝，
//      把「删数据」这件事挡在误操作之外
import { get, all, run, withTransaction } from './db.mjs';
import { loadTree } from './registry.mjs';
import {
  ApiError, envelope, unenvelope, nowIso, needString, asBoolInt,
} from './write.mjs';

const TYPES = new Set([
  'problem', 'data-sufficiency', 'logic', 'cloze', 'reading',
  'new-type', 'translation', 'writing', 'essay',
]);
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const ID_RE = /^[A-Za-z0-9._-]+$/;
const jdump = (v) => JSON.stringify(v);

// ---------------------------------------------------------------- 知识树

let tree = null;

/** 树在库里（subjects / knowledge_nodes）；写树同样走库，同进程读到的一直是新的。 */
function knowledgeNodes() {
  if (!tree) {
    tree = new Map(loadTree().nodes.map((n) => [n.id, n]));
  }
  return tree;
}

function assertTopic(topicId) {
  const nodes = knowledgeNodes();
  const node = nodes.get(topicId);
  if (!node) {
    throw new ApiError(
      400, 'unknown_topic',
      `知识点不存在：${topicId}（库里共 ${nodes.size} 个知识点；改树请更新 subjects / knowledge_nodes 表）`
    );
  }
  return node;
}

// ---------------------------------------------------------------- 公共小工具

function paperRow(slug) {
  const row = get('SELECT * FROM papers WHERE slug = ?', slug);
  if (!row) throw new ApiError(404, 'not_found', `卷不存在：${slug}`);
  return row;
}

function paperBaseline(row) {
  return unenvelope(row.notes).baseline;
}

/** 卷内最后一题的基线字段，新题默认继承（section / answerSource / 原文页）。 */
function lastQuestionBaseline(slug) {
  const r = get('SELECT notes FROM questions WHERE paper_slug = ? ORDER BY seq DESC LIMIT 1', slug);
  return r ? unenvelope(r.notes).baseline : {};
}

function paperFileKeys(row) {
  return Object.keys(paperBaseline(row).paperPrefix || {});
}

function assertPaperFile(row, file) {
  const keys = paperFileKeys(row);
  if (!keys.length) return { warned: true };
  if (!file || !keys.includes(file)) {
    throw new ApiError(
      400, 'unknown_paper_file',
      `原文页不存在：${file ?? '(未提供)'}；该卷可选：${keys.join(' / ')}`
    );
  }
  return { warned: false };
}

/** 题号、顺序都在变，question_ids 与 question_count 一律按库内实际值重算。 */
function syncPaper(slug, ts) {
  const ids = all(
    'SELECT id FROM questions WHERE paper_slug = ? ORDER BY seq, number', slug
  ).map((r) => r.id);
  run(
    'UPDATE papers SET question_ids = ?, question_count = ?, updated_at = ? WHERE slug = ?',
    jdump(ids), ids.length, ts, slug
  );
  return ids;
}

/** 题干要带锚点，站点才能按题号跳转；调用方没写就补一个。 */
function withAnchor(contentMd, questionId) {
  if (contentMd.includes(`id="${questionId}"`)) return contentMd;
  return `${contentMd.trimEnd()}\n\n<a id="${questionId}"></a>\n\n`;
}

// ---------------------------------------------------------------- 试卷

export function createPaper(input) {
  if (!input || typeof input !== 'object') {
    throw new ApiError(400, 'invalid_body', '请求体必须是对象');
  }
  const slug = needString(input.slug ?? input.paperSlug, 'slug');
  if (!SLUG_RE.test(slug)) {
    throw new ApiError(400, 'invalid_field', 'slug 只能用小写字母、数字与连字符');
  }
  if (get('SELECT 1 AS x FROM papers WHERE slug = ?', slug)) {
    throw new ApiError(409, 'paper_exists', `卷已存在：${slug}`);
  }
  const title = needString(input.title, 'title');
  const subject = input.subject === undefined || input.subject === null
    ? null
    : needString(input.subject, 'subject');

  let scoreRule = null;
  if (input.scoreRule !== undefined && input.scoreRule !== null) {
    if (typeof input.scoreRule !== 'object') {
      throw new ApiError(400, 'invalid_field', 'scoreRule 必须是对象，如 {"objective":3}');
    }
    scoreRule = jdump(input.scoreRule);
  }

  const questionCount = Number.isInteger(input.questionCount) && input.questionCount >= 0
    ? input.questionCount
    : 0;

  const baseline = {};
  const paperFile = input.paperFile === undefined || input.paperFile === null
    ? null
    : needString(input.paperFile, 'paperFile');
  if (paperFile) {
    baseline.paperPrefix = {
      [paperFile]: input.paperPrefix === undefined || input.paperPrefix === null
        ? ''
        : String(input.paperPrefix),
    };
  }
  if (Array.isArray(input.sourceFiles)) baseline.sourceFiles = input.sourceFiles.map(String);

  return withTransaction(() => {
    run(
      `INSERT INTO papers (slug, title, subject, question_ids, question_count,
                           score_rule_json, notes, updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      slug, title, subject, '[]', questionCount, scoreRule,
      envelope(input.note ?? null, baseline), nowIso()
    );
    return {
      slug, title, subject, questionCount,
      paperFile,
      hint: '加题用 POST /api/questions（paperSlug 填这个 slug）；没有原文页时题干不会出现在原文页，但会进题库',
    };
  });
}

const PATCHABLE_PAPER = new Set([
  'title', 'subject', 'scoreRule', 'note', 'questionCount',
  'paperFile', 'paperPrefix', 'removePaperFile', 'sourceFiles',
]);

export function patchPaper(slug, patch) {
  if (!patch || typeof patch !== 'object' || Object.keys(patch).length === 0) {
    throw new ApiError(400, 'invalid_body', '请求体不能为空');
  }
  const unknown = Object.keys(patch).filter((k) => !PATCHABLE_PAPER.has(k));
  if (unknown.length) {
    throw new ApiError(400, 'unknown_field', `不支持修改的字段：${unknown.join(', ')}`);
  }

  const row = paperRow(slug);
  const { text, baseline } = unenvelope(row.notes);

  const title = 'title' in patch ? needString(patch.title, 'title') : row.title;
  const subject = 'subject' in patch
    ? (patch.subject === null ? null : needString(patch.subject, 'subject'))
    : row.subject;
  const noteText = 'note' in patch
    ? (patch.note === null ? null : String(patch.note))
    : text;

  let scoreRule = row.score_rule_json;
  if ('scoreRule' in patch) {
    if (patch.scoreRule === null) scoreRule = null;
    else if (typeof patch.scoreRule !== 'object') {
      throw new ApiError(400, 'invalid_field', 'scoreRule 必须是对象');
    } else scoreRule = jdump(patch.scoreRule);
  }

  let questionCount = row.question_count;
  if ('questionCount' in patch) {
    if (!Number.isInteger(patch.questionCount) || patch.questionCount < 0) {
      throw new ApiError(400, 'invalid_field', 'questionCount 必须是非负整数');
    }
    questionCount = patch.questionCount;
  }

  const prefixes = { ...(baseline.paperPrefix || {}) };
  if ('paperFile' in patch || 'paperPrefix' in patch) {
    const file = needString(patch.paperFile, 'paperFile');
    prefixes[file] = patch.paperPrefix === undefined
      ? (prefixes[file] ?? '')
      : String(patch.paperPrefix);
  }
  if ('removePaperFile' in patch) {
    const file = needString(patch.removePaperFile, 'removePaperFile');
    const n = get(
      "SELECT COUNT(*) AS n FROM questions WHERE paper_slug = ? AND json_extract(notes, '$.baseline.paper') = ?",
      slug, file
    ).n;
    if (n > 0) {
      throw new ApiError(409, 'paper_file_in_use', `还有 ${n} 道题引用原文页 ${file}，先改题再删页`);
    }
    delete prefixes[file];
  }

  const baselineNext = { ...baseline, paperPrefix: prefixes };
  if ('sourceFiles' in patch) {
    if (!Array.isArray(patch.sourceFiles)) {
      throw new ApiError(400, 'invalid_field', 'sourceFiles 必须是字符串数组');
    }
    baselineNext.sourceFiles = patch.sourceFiles.map(String);
  }

  return withTransaction(() => {
    run(
      `UPDATE papers SET title = ?, subject = ?, question_count = ?, score_rule_json = ?,
              notes = ?, updated_at = ? WHERE slug = ?`,
      title, subject, questionCount, scoreRule,
      envelope(noteText, baselineNext), nowIso(), slug
    );
    return {
      slug, title, subject, questionCount,
      paperFiles: Object.keys(prefixes),
      changed: Object.keys(patch).length,
    };
  });
}

export function deletePaper(slug) {
  const row = paperRow(slug);
  const questions = get('SELECT COUNT(*) AS n FROM questions WHERE paper_slug = ?', slug).n;
  const sessions = get('SELECT COUNT(*) AS n FROM sessions WHERE paper_slug = ?', slug).n;
  if (questions > 0 || sessions > 0) {
    throw new ApiError(
      409, 'paper_not_empty',
      `卷 ${slug} 还有 ${questions} 道题、${sessions} 场记录，先清空再删`,
      { questions, sessions }
    );
  }
  return withTransaction(() => {
    run('DELETE FROM papers WHERE slug = ?', slug);
    return { slug, deleted: true, title: row.title };
  });
}

// ---------------------------------------------------------------- 题目

export function createQuestion(input) {
  if (!input || typeof input !== 'object') {
    throw new ApiError(400, 'invalid_body', '请求体必须是对象');
  }

  const paperSlug = needString(input.paperSlug ?? input.paper ?? input.volume, 'paperSlug');
  const paper = get('SELECT * FROM papers WHERE slug = ?', paperSlug);
  if (!paper) throw new ApiError(400, 'unknown_paper', `卷不存在：${paperSlug}`);
  const inherited = lastQuestionBaseline(paperSlug);

  const type = needString(input.type, 'type');
  if (!TYPES.has(type)) {
    throw new ApiError(400, 'invalid_field', `type 只能是 ${[...TYPES].join(' | ')}`);
  }

  const topicId = needString(input.topicId, 'topicId');
  const node = assertTopic(topicId);
  // topic 是展示用的中文标签（如「问题求解」），和知识点名不是一回事，必须显式给
  const topic = needString(input.topic, 'topic');
  const contentMd = needString(input.contentMd ?? input.content, 'contentMd');

  const answer = input.answer === undefined || input.answer === null || String(input.answer).trim() === ''
    ? null
    : String(input.answer).trim();
  let scorable = asBoolInt(input.scorable, 'scorable');
  if (scorable === null) scorable = answer !== null ? 1 : 0;

  const origin = input.origin === undefined || input.origin === null
    ? null
    : needString(input.origin, 'origin');
  if (origin && !get('SELECT 1 AS x FROM questions WHERE id = ?', origin)) {
    throw new ApiError(400, 'unknown_question', `origin 指向的题不存在：${origin}`);
  }

  const maxSeq = get('SELECT COALESCE(MAX(seq), 0) AS n FROM questions WHERE paper_slug = ?', paperSlug).n;
  const maxNumber = get('SELECT COALESCE(MAX(number), 0) AS n FROM questions WHERE paper_slug = ?', paperSlug).n;
  let seq = Number.isInteger(input.seq) ? input.seq : maxSeq + 1;
  if (seq <= 0) throw new ApiError(400, 'invalid_field', 'seq 必须是正整数');
  const number = Number.isInteger(input.number) ? input.number : maxNumber + 1;
  if (number <= 0) throw new ApiError(400, 'invalid_field', 'number 必须是正整数');

  const paperFile = input.paperFile === undefined || input.paperFile === null
    ? (inherited.paper ?? paperFileKeys(paper)[0] ?? null)
    : needString(input.paperFile, 'paperFile');
  const fileCheck = assertPaperFile(paper, paperFile);

  const section = input.section === undefined || input.section === null
    ? (inherited.section ?? null)
    : String(input.section);
  const answerSource = input.answerSource === undefined || input.answerSource === null
    ? (inherited.answerSource ?? null)
    : String(input.answerSource);
  const revision = input.revision === undefined ? (inherited.revision ?? null) : input.revision;

  const explicitId = input.id === undefined || input.id === null ? null : needString(input.id, 'id');
  if (explicitId && !ID_RE.test(explicitId)) {
    throw new ApiError(400, 'invalid_field', 'id 只能包含字母数字 . _ -');
  }
  let id = explicitId ?? `${paperSlug}-q${String(seq).padStart(3, '0')}`;
  if (get('SELECT 1 AS x FROM questions WHERE id = ?', id)) {
    if (explicitId) throw new ApiError(409, 'question_exists', `题目已存在：${id}`);
    let n = seq;
    do {
      n += 1;
      id = `${paperSlug}-q${String(n).padStart(3, '0')}`;
    } while (get('SELECT 1 AS x FROM questions WHERE id = ?', id));
  }

  const md = withAnchor(contentMd, id);

  return withTransaction(() => {
    const ts = nowIso();
    // 指定 seq 插队时，把后面同卷的题整体后移，避免两题挤在同一个位置
    if (Number.isInteger(input.seq) && get(
      'SELECT 1 AS x FROM questions WHERE paper_slug = ? AND seq = ?', paperSlug, seq
    )) {
      run('UPDATE questions SET seq = seq + 1 WHERE paper_slug = ? AND seq >= ?', paperSlug, seq);
    }

    run(
      `INSERT INTO questions
         (id, paper_slug, number, seq, type, topic_id, topic, origin,
          content_md, answer, scorable, notes, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, paperSlug, number, seq, type, topicId, topic, origin,
      md, answer, scorable,
      envelope(input.note ?? null, {
        paper: paperFile,
        section,
        answerSource,
        revision,
      }), ts
    );

    const ids = syncPaper(paperSlug, ts);
    return {
      id,
      paperSlug,
      number,
      seq,
      topicId,
      topicName: node.name,
      questionCount: ids.length,
      warnings: fileCheck.warned
        ? [`该卷还没有原文页（paperPrefix），题干只在题库里，不会出现在原文页`]
        : [],
    };
  });
}

const PATCHABLE_QUESTION = new Set([
  'number', 'seq', 'type', 'topicId', 'topic', 'origin', 'answer', 'scorable',
  'contentMd', 'note', 'section', 'paperFile', 'answerSource', 'revision',
]);

export function patchQuestion(questionId, patch) {
  if (!patch || typeof patch !== 'object' || Object.keys(patch).length === 0) {
    throw new ApiError(400, 'invalid_body', '请求体不能为空');
  }
  const unknown = Object.keys(patch).filter((k) => !PATCHABLE_QUESTION.has(k));
  if (unknown.length) {
    throw new ApiError(
      400, 'unknown_field',
      `不支持修改的字段：${unknown.join(', ')}（题目不能换卷，换卷请删掉重建）`
    );
  }

  const row = get('SELECT * FROM questions WHERE id = ?', questionId);
  if (!row) throw new ApiError(404, 'not_found', `题目不存在：${questionId}`);
  const paper = get('SELECT * FROM papers WHERE slug = ?', row.paper_slug);
  const { text, baseline } = unenvelope(row.notes);

  let number = row.number;
  if ('number' in patch) {
    if (!Number.isInteger(patch.number) || patch.number <= 0) {
      throw new ApiError(400, 'invalid_field', 'number 必须是正整数');
    }
    number = patch.number;
  }

  let seq = row.seq;
  if ('seq' in patch) {
    if (!Number.isInteger(patch.seq) || patch.seq <= 0) {
      throw new ApiError(400, 'invalid_field', 'seq 必须是正整数');
    }
    seq = patch.seq;
  }

  let type = row.type;
  if ('type' in patch) {
    type = needString(patch.type, 'type');
    if (!TYPES.has(type)) {
      throw new ApiError(400, 'invalid_field', `type 只能是 ${[...TYPES].join(' | ')}`);
    }
  }

  let topicId = row.topic_id;
  if ('topicId' in patch) {
    topicId = needString(patch.topicId, 'topicId');
    assertTopic(topicId);
  }
  const topic = 'topic' in patch ? needString(patch.topic, 'topic') : row.topic;

  let origin = row.origin;
  if ('origin' in patch) {
    origin = patch.origin === null || patch.origin === '' ? null : needString(patch.origin, 'origin');
    if (origin === questionId) throw new ApiError(400, 'invalid_field', 'origin 不能指向自己');
    if (origin && !get('SELECT 1 AS x FROM questions WHERE id = ?', origin)) {
      throw new ApiError(400, 'unknown_question', `origin 指向的题不存在：${origin}`);
    }
  }

  let answer = row.answer;
  if ('answer' in patch) {
    answer = patch.answer === null || String(patch.answer).trim() === ''
      ? null
      : String(patch.answer).trim();
  }

  let scorable = row.scorable;
  if ('scorable' in patch) {
    const v = asBoolInt(patch.scorable, 'scorable');
    if (v === null) throw new ApiError(400, 'invalid_field', 'scorable 只能是布尔 / 0 / 1');
    scorable = v;
  }

  let contentMd = row.content_md;
  if ('contentMd' in patch) {
    contentMd = withAnchor(needString(patch.contentMd, 'contentMd'), questionId);
  }

  let paperFile = baseline.paper ?? null;
  if ('paperFile' in patch) {
    paperFile = needString(patch.paperFile, 'paperFile');
    assertPaperFile(paper, paperFile);
  }

  const section = 'section' in patch
    ? (patch.section === null ? null : String(patch.section))
    : (baseline.section ?? null);
  const answerSource = 'answerSource' in patch
    ? (patch.answerSource === null ? null : String(patch.answerSource))
    : (baseline.answerSource ?? null);
  const revision = 'revision' in patch ? patch.revision : (baseline.revision ?? null);
  const noteText = 'note' in patch
    ? (patch.note === null ? null : String(patch.note))
    : text;

  // 改了标准答案，历史作答的判定不会自动重判 —— 告知，不代劳
  const warnings = [];
  if ('answer' in patch && answer !== row.answer) {
    const n = get('SELECT COUNT(*) AS n FROM attempts WHERE question_id = ?', questionId).n;
    if (n > 0) {
      warnings.push(`该题已有 ${n} 条作答，correct 不会按新答案自动重判；要重判请 PATCH /api/attempts/:id`);
    }
  }

  const baselineNext = {
    ...baseline, paper: paperFile, section, answerSource, revision,
  };

  return withTransaction(() => {
    run(
      `UPDATE questions
          SET number = ?, seq = ?, type = ?, topic_id = ?, topic = ?, origin = ?,
              content_md = ?, answer = ?, scorable = ?, notes = ?, updated_at = ?
        WHERE id = ?`,
      number, seq, type, topicId, topic, origin, contentMd, answer, scorable,
      envelope(noteText, baselineNext), nowIso(), questionId
    );
    const ids = syncPaper(row.paper_slug, nowIso());
    return { id: questionId, paperSlug: row.paper_slug, questionCount: ids.length, warnings };
  });
}

export function deleteQuestion(questionId) {
  const row = get('SELECT * FROM questions WHERE id = ?', questionId);
  if (!row) throw new ApiError(404, 'not_found', `题目不存在：${questionId}`);

  const attempts = get('SELECT COUNT(*) AS n FROM attempts WHERE question_id = ?', questionId).n;
  if (attempts > 0) {
    throw new ApiError(
      409, 'question_in_use',
      `题目 ${questionId} 已有 ${attempts} 条作答，删了会让场次缺题；请先删相关场次`,
      { attempts }
    );
  }
  const refs = all('SELECT id FROM questions WHERE origin = ?', questionId).map((r) => r.id);
  if (refs.length) {
    throw new ApiError(
      409, 'question_referenced',
      `题目 ${questionId} 被重练题引用：${refs.join(', ')}，先清掉 origin`,
      { questions: refs }
    );
  }

  return withTransaction(() => {
    run('DELETE FROM questions WHERE id = ?', questionId);
    const ids = syncPaper(row.paper_slug, nowIso());
    return { id: questionId, paperSlug: row.paper_slug, questionCount: ids.length };
  });
}
