// SQLite (sql.js, WebAssembly) wrapper.
// 네이티브 빌드 없이 Windows에서 바로 설치·실행되도록 sql.js를 쓰고,
// 쓰기가 발생하면 data/stock.db 파일로 저장한다.
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

// 샘플 모드는 실데이터 DB와 섞이지 않도록 별도 폴더 사용
const DATA_DIR = path.join(__dirname, '..', (process.env.DATA_PROVIDER || '').toLowerCase() === 'sample' ? 'data-sample' : 'data');
const DB_FILE = path.join(DATA_DIR, 'stock.db');

let db = null;
let saveTimer = null;
let inTx = false;

const SCHEMA = `
PRAGMA foreign_keys = ON;

-- 회원별 데이터 ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  email_verified INTEGER NOT NULL DEFAULT 1,   -- 프로토타입: 이메일 인증 생략
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reset_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS holdings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  quantity REAL NOT NULL,
  avg_price REAL NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, code)
);

-- 보유 종목을 삭제해도 배당 내역은 유지(FR-DIV-05) → holdings FK 없음
CREATE TABLE IF NOT EXISTS dividends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  pay_date TEXT NOT NULL,
  amount REAL NOT NULL,
  currency TEXT NOT NULL,
  memo TEXT,
  created_at TEXT NOT NULL
);

-- 전 회원 공통 데이터 ------------------------------------------------------
CREATE TABLE IF NOT EXISTS instruments (
  code TEXT PRIMARY KEY,            -- 국내 6자리 / 미국 티커 (대문자)
  provider_symbol TEXT NOT NULL,    -- 출처별 심볼 (예: 005930.KS, BRK-B)
  name TEXT NOT NULL,
  market TEXT NOT NULL,             -- KOSPI, KOSDAQ, NYSE, NASDAQ, NYSE Arca, NYSE American, Cboe
  type TEXT NOT NULL,               -- 주식, ETF, ETN
  currency TEXT NOT NULL,           -- KRW, USD
  listed_date TEXT,
  timezone TEXT NOT NULL,
  price_source TEXT NOT NULL,       -- 현재가 출처
  history_source TEXT,              -- 과거 종가 출처
  history_loaded_at TEXT,
  last_price REAL,
  price_time TEXT,                  -- 시세 기준 시각 (ISO)
  price_fetched_at TEXT             -- 마지막으로 외부에서 가져온 시각 (캐시 판단용)
);

CREATE TABLE IF NOT EXISTS daily_prices (
  code TEXT NOT NULL,
  trade_date TEXT NOT NULL,         -- 거래소 현지 거래일
  close REAL NOT NULL,              -- 수정 종가 (분할·병합 반영, 배당 미반영)
  source TEXT NOT NULL,
  collected_at TEXT NOT NULL,
  PRIMARY KEY (code, trade_date)
);

CREATE TABLE IF NOT EXISTS splits (
  code TEXT NOT NULL,
  split_date TEXT NOT NULL,
  ratio TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  PRIMARY KEY (code, split_date)
);

CREATE TABLE IF NOT EXISTS fx_rates (
  currency TEXT NOT NULL,           -- USD/KRW
  base_date TEXT NOT NULL,
  rate REAL NOT NULL,
  source TEXT NOT NULL,
  PRIMARY KEY (currency, base_date)
);

CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

function norm(params) {
  return (params || []).map((v) => (v === undefined ? null : v));
}

function all(sql, params) {
  const st = db.prepare(sql);
  try {
    st.bind(norm(params));
    const rows = [];
    while (st.step()) rows.push(st.getAsObject());
    return rows;
  } finally {
    st.free();
  }
}

function get(sql, params) {
  return all(sql, params)[0];
}

function run(sql, params) {
  db.run(sql, norm(params));
  const changes = db.getRowsModified();
  const lastId = get('SELECT last_insert_rowid() AS id').id;
  if (!inTx) scheduleSave();
  return { changes, lastId };
}

// 여러 행을 빠르게 넣을 때 사용
function runMany(sql, rowsOfParams) {
  const st = db.prepare(sql);
  try {
    for (const p of rowsOfParams) st.run(norm(p));
  } finally {
    st.free();
  }
  if (!inTx) scheduleSave();
}

function tx(fn) {
  if (inTx) return fn();
  db.run('BEGIN');
  inTx = true;
  try {
    const r = fn();
    db.run('COMMIT');
    return r;
  } catch (e) {
    db.run('ROLLBACK');
    throw e;
  } finally {
    inTx = false;
    scheduleSave();
  }
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveNow();
  }, 300);
}

function saveNow() {
  if (!db) return;
  const data = db.export();
  // export() 이후에도 foreign_keys 설정 유지
  db.run('PRAGMA foreign_keys = ON;');
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, Buffer.from(data));
  fs.renameSync(tmp, DB_FILE);
}

async function init() {
  const SQL = await initSqlJs();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const isNew = !fs.existsSync(DB_FILE);
  db = isNew ? new SQL.Database() : new SQL.Database(fs.readFileSync(DB_FILE));
  db.run(SCHEMA);
  if (isNew) saveNow();
  return { isNew };
}

module.exports = { init, all, get, run, runMany, tx, saveNow, DB_FILE };
