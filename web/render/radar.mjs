// 构建时生成内联 SVG 雷达图：站点无运行时脚本，图表直接进 HTML。
// 颜色走 CSS 变量，light / dark 主题自动适配。

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const CX = 240;
const CY = 195;
const R = 120;
const LABEL_R = 144;

function point(index, count, scale) {
  const angle = ((-90 + (index * 360) / count) * Math.PI) / 180;
  return [CX + R * scale * Math.cos(angle), CY + R * scale * Math.sin(angle)];
}

function labelPoint(index, count) {
  const angle = ((-90 + (index * 360) / count) * Math.PI) / 180;
  return [CX + LABEL_R * Math.cos(angle), CY + LABEL_R * Math.sin(angle)];
}

function polygon(values, count, close = true) {
  const coords = values.map((value, index) => point(index, count, value).map((n) => n.toFixed(1)).join(','));
  return coords.join(' ');
}

function pct(value) {
  return value == null ? null : Math.round(value * 100);
}

export function radarSvg({ nodes, subjectName }) {
  const count = nodes.length;
  if (count < 3) return '';

  const ring = (scale) =>
    `<polygon points="${polygon(Array(count).fill(scale), count)}" fill="none" stroke="var(--color-track)" stroke-width="1"/>`;

  const spokes = nodes
    .map((_, index) => {
      const [x, y] = point(index, count, 1);
      return `<line x1="${CX}" y1="${CY}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="var(--color-track)" stroke-width="1"/>`;
    })
    .join('');

  const firstValues = nodes.map((node) => node.firstAccuracy ?? 0);
  const latestValues = nodes.map((node) => node.latestAccuracy ?? 0);

  const firstPolygon = `<polygon points="${polygon(firstValues, count)}" fill="none" stroke="var(--color-muted)" stroke-width="1.5" stroke-dasharray="5 4" stroke-linejoin="round"/>`;
  const latestPolygon = `<polygon points="${polygon(latestValues, count)}" fill="var(--color-ink)" fill-opacity="0.10" stroke="var(--color-ink)" stroke-width="2" stroke-linejoin="round"/>`;

  const dots = nodes
    .map((node, index) => {
      const [x, y] = point(index, count, node.latestAccuracy ?? 0);
      const latest = pct(node.latestAccuracy);
      const first = pct(node.firstAccuracy);
      const tip = `${node.name} · 首做 ${first == null ? '—' : `${first}%`} · 最近 ${latest == null ? '—' : `${latest}%`} · ${node.questions} 题`;
      return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.5" fill="var(--color-ink)"><title>${esc(tip)}</title></circle>`;
    })
    .join('');

  const labels = nodes
    .map((node, index) => {
      const [x, y] = labelPoint(index, count);
      const angle = ((-90 + (index * 360) / count) * Math.PI) / 180;
      const cos = Math.cos(angle);
      const anchor = cos > 0.25 ? 'start' : cos < -0.25 ? 'end' : 'middle';
      const value = pct(node.latestAccuracy);
      const small = node.sampleOk ? '' : ' · 样本少';
      return `<text x="${x.toFixed(1)}" y="${(y - 6).toFixed(1)}" text-anchor="${anchor}" font-size="12" fill="var(--color-ink)">${esc(node.name)}</text>` +
        `<text x="${x.toFixed(1)}" y="${(y + 9).toFixed(1)}" text-anchor="${anchor}" font-size="11" fill="var(--color-muted)">${value == null ? '—' : `${value}%`} · n${node.questions}${esc(small)}</text>`;
    })
    .join('');

  const rings = [0.25, 0.5, 0.75, 1].map(ring).join('');
  const scaleLabels = [0.5, 1]
    .map((scale) => {
      const y = CY - R * scale;
      return `<text x="${CX + 4}" y="${(y - 3).toFixed(1)}" font-size="10" fill="var(--color-muted)">${Math.round(scale * 100)}%</text>`;
    })
    .join('');

  return `<svg class="radar-svg" viewBox="0 0 480 400" width="100%" role="img" aria-label="${esc(subjectName)}考点正确率雷达图">
<title>${esc(subjectName)}考点正确率</title>
<desc>实心线为最近一次判定，虚线为首做；每个轴标注题量与最近正确率。</desc>
${rings}
${spokes}
${scaleLabels}
${firstPolygon}
${latestPolygon}
${dots}
${labels}
</svg>`;
}
