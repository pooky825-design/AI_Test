// DB 파일 저장소 (PC / Node.js)
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

// 샘플 모드는 실데이터 DB와 섞이지 않도록 별도 폴더 사용
const DATA_DIR = path.join(__dirname, '..', (process.env.DATA_PROVIDER || '').toLowerCase() === 'sample' ? 'data-sample' : 'data');
const DB_FILE = path.join(DATA_DIR, 'stock.db');

module.exports = {
  initSql: () => initSqlJs(),
  load() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    return fs.existsSync(DB_FILE) ? fs.readFileSync(DB_FILE) : null;
  },
  save(bytes) {
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, Buffer.from(bytes));
    fs.renameSync(tmp, DB_FILE);
  },
};
