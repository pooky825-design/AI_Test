// server/storage.js 의 앱용 버전: DB 파일을 앱 내부 저장소(네이티브)에 보관
const initSqlJs = require('sql.js');
const wasmBinary = require('sql.js/dist/sql-wasm.wasm'); // esbuild binary 로더로 번들에 포함
const bridge = require('./bridge');

const LS_KEY = 'stock_db_b64';

module.exports = {
  initSql: () => initSqlJs({ wasmBinary }),
  load() {
    let b64 = '';
    if (bridge.Native) b64 = bridge.Native.loadDb() || '';
    else try { b64 = localStorage.getItem(LS_KEY) || ''; } catch (_) { /* ignore */ }
    return b64 ? bridge.fromBase64(b64) : null;
  },
  save(bytes) {
    const b64 = bridge.toBase64(bytes);
    if (bridge.Native) bridge.Native.saveDb(b64);
    else try { localStorage.setItem(LS_KEY, b64); } catch (_) { /* ignore */ }
  },
};
