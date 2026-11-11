// 知识点维度聚合：事实来自 mem/data/index.json（questions / attempts / knowledgeTree）。
// 口径契约见 mem/doc/question-bank.md §12：
//   1) 重练题按 question.origin 归并回原题，同一道题的多次作答算一道题；
//   2) 首做 = 该原题最早一次判定，最近 = 最后一次判定；
//   3) 当前错题 = 最近一次判定为错的原题数；「连续两次做对才销账」是待重做台账的规则，
//      不推广为全题库的掌握度判定；
//   4) 只统计 scorable 且 correct 为 true/false 的作答，未判定不进分母。

function ratio(correct, wrong) {
  return correct + wrong > 0 ? correct / (correct + wrong) : null;
}

function sortAttempts(attempts) {
  return attempts
    .map((attempt, index) => ({ attempt, index }))
    .sort((a, b) => {
      const byDate = String(a.attempt.date || '').localeCompare(String(b.attempt.date || ''));
      return byDate || a.index - b.index;
    })
    .map((entry) => entry.attempt);
}

export function buildKnowledge({ jsonIndex, config }) {
  const tree = jsonIndex?.knowledgeTree;
  if (!tree?.nodes?.length || !jsonIndex?.questions?.length) return null;

  const knowledgeConfig = config.knowledge || {};
  const minSample = Number(knowledgeConfig.minSample) || 5;
  const maxAxes = Number(knowledgeConfig.maxAxes) || 8;

  const nodeMap = new Map(tree.nodes.map((node) => [node.id, node]));
  const questionMap = new Map(jsonIndex.questions.map((question) => [question.id, question]));

  // 重练卷题目 ID 独立，origin 指回原题；归并后同题多次作答只占一个样本。
  const canonicalId = new Map(
    jsonIndex.questions.map((question) => [question.id, question.origin || question.id])
  );

  const attemptsByQuestion = new Map();
  for (const attempt of jsonIndex.attempts || []) {
    const question = questionMap.get(attempt.questionId);
    if (!question || !question.scorable) continue;
    if (attempt.correct !== true && attempt.correct !== false) continue;
    const key = canonicalId.get(attempt.questionId);
    if (!attemptsByQuestion.has(key)) attemptsByQuestion.set(key, []);
    attemptsByQuestion.get(key).push(attempt);
  }

  const byTopic = new Map();
  for (const [questionId, attempts] of attemptsByQuestion) {
    const source = questionMap.get(questionId);
    const topicId = source?.topicId;
    if (!topicId || !nodeMap.has(topicId)) continue;
    if (!byTopic.has(topicId)) {
      byTopic.set(topicId, {
        firstCorrect: 0,
        firstWrong: 0,
        latestCorrect: 0,
        latestWrong: 0,
        questions: 0,
        redoQuestions: 0
      });
    }
    const entry = byTopic.get(topicId);
    const sorted = sortAttempts(attempts);
    const first = sorted[0];
    const latest = sorted.at(-1);

    entry.questions += 1;
    if (attempts.length > 1) entry.redoQuestions += 1;
    if (first.correct === true) entry.firstCorrect += 1;
    else entry.firstWrong += 1;
    if (latest.correct === true) entry.latestCorrect += 1;
    else entry.latestWrong += 1;
  }

  const subjects = (tree.subjects || []).map((subject) => {
    const nodes = tree.nodes
      .filter((node) => node.parent === subject.id && byTopic.has(node.id))
      .map((node) => {
        const stats = byTopic.get(node.id);
        const first = ratio(stats.firstCorrect, stats.firstWrong);
        const latest = ratio(stats.latestCorrect, stats.latestWrong);
        return {
          id: node.id,
          name: node.name,
          path: node.path || [subject.name, node.name],
          granularity: node.granularity || 'topic',
          questions: stats.questions,
          firstCorrect: stats.firstCorrect,
          firstWrong: stats.firstWrong,
          firstAccuracy: first,
          latestCorrect: stats.latestCorrect,
          latestWrong: stats.latestWrong,
          latestAccuracy: latest,
          wrongQuestions: stats.latestWrong,
          redoQuestions: stats.redoQuestions,
          sampleOk: stats.questions >= minSample
        };
      })
      .sort((a, b) => b.questions - a.questions || a.name.localeCompare(b.name, 'zh'));

    return {
      id: subject.id,
      name: subject.name,
      exam: subject.exam || null,
      nodes,
      axes: nodes.slice(0, maxAxes),
      omitted: Math.max(0, nodes.length - maxAxes),
      totals: {
        questions: nodes.reduce((sum, node) => sum + node.questions, 0),
        firstCorrect: nodes.reduce((sum, node) => sum + node.firstCorrect, 0),
        latestCorrect: nodes.reduce((sum, node) => sum + node.latestCorrect, 0),
        wrong: nodes.reduce((sum, node) => sum + node.wrongQuestions, 0)
      }
    };
  });

  const unmapped = [...attemptsByQuestion.keys()].filter((questionId) => {
    const topicId = questionMap.get(questionId)?.topicId;
    return !topicId || !nodeMap.has(topicId);
  });

  return {
    minSample,
    maxAxes,
    subjects: subjects.filter((subject) => subject.nodes.length > 0),
    totals: {
      questions: [...attemptsByQuestion.keys()].length,
      topics: byTopic.size,
      unmapped: unmapped.length
    }
  };
}
