/** 拆出 YAML front matter；只支持本仓库用到的「key: value」单行格式。 */
export function splitFrontMatter(text) {
  const normalized = String(text).replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    return { has: false, data: {}, body: normalized };
  }

  const end = normalized.indexOf('\n---', 4);
  if (end === -1) {
    return { has: false, data: {}, body: normalized };
  }

  const block = normalized.slice(4, end);
  const body = normalized.slice(end + 4).replace(/^\n+/, '');
  const data = {};

  for (const line of block.split('\n')) {
    const match = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    data[match[1]] = value;
  }

  return { has: true, data, body };
}
