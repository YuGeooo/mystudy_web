// 导出 CLI：node server/export-cli.mjs
// 支持用环境变量指定库与产物路径：
//   MEM_DB=data/test.db MEM_EXPORT_INDEX=/tmp/i.json MEM_EXPORT_CONTENT=/tmp/c.json node server/export-cli.mjs
import config from './config.mjs';
import { exportAll } from './export.mjs';
import { openDb, closeDb } from './db.mjs';

openDb();
try {
  const result = exportAll(config);
  console.log(JSON.stringify({
    database: config.database,
    index: result.index,
    content: result.content,
  }, null, 2));
} finally {
  closeDb();
}
