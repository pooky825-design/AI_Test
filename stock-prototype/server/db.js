// SQLite (sql.js, WebAssembly) wrapper.
// 네이티브 빌드 없이 Windows에서 바로 설치·실행되도록 sql.js를 쓴다.
// DB 파일을 어디에 저장할지는 storage.js가 정한다
//  - PC(Node): data/stock.db 파일
//  - 안드로이드 앱: 앱 내부 저장소 (mobile/storage.js로 교체되어 번들됨)
const storage = require('./storage');
// 데모 계정 4자리 비밀번호 '1234' 의 bcrypt 해시 (v0.30.0, 미리 계산해 둠)
const DEMO_PIN_HASH = '$2b$10$GLwRtcF03NwWzugrNqUZ2eahZBuK5t2965OlqjxAHtZSUlFgTU.5S';

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

-- 보유 종목 그룹 (v0.6): ISA·연금·일반 등 회원이 만드는 계좌 그룹
CREATE TABLE IF NOT EXISTS holding_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, name)
);

-- 연도별 매수·매도 기록 (v0.5): 연도 말 보유 수량 = 그 해까지의 기록 누적
CREATE TABLE IF NOT EXISTS holding_trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  year INTEGER NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  group_id INTEGER,                 -- holding_groups.id (v0.6)
  quantity REAL NOT NULL,           -- 항상 양수
  price REAL,                       -- 매수 단가 (거래 통화). 매도는 선택
  memo TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trades_user ON holding_trades (user_id, year, code);

-- 연도별 주식 항목 (v0.8): 그룹·종목별 그 해 말 보유 수량과 평균 매입단가.
-- 그 해 항목이 없으면 직전 연도 항목이 이어진다(이월). 수량 0 = 그 해부터 보유하지 않음
CREATE TABLE IF NOT EXISTS holding_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id INTEGER NOT NULL,
  code TEXT NOT NULL,
  year INTEGER NOT NULL,
  quantity REAL NOT NULL,
  avg_price REAL,
  memo TEXT,
  carry_mode TEXT,                  -- 이월 여부 (v0.8.1): CARRIED(이월) / NEW(신규) / NULL(자동: 전년 말 보유 여부)
  realized_pnl REAL,                -- 그 해 실현손익 (v0.10, 거래 통화, 선택): 매도한 수량의 매도금액 − 원래 매입금액
  carry_qty REAL,                   -- 그 해 이월 수량 (v0.12.3): 전년 항목 없이 이월로 등록할 때 입력. NULL이면 그 해 수량 전부
  formulas TEXT,                    -- 숫자 칸에 입력한 계산식 (v0.26.7, JSON 예: {"quantity":"=10+30"})
  carry_amount REAL,                -- 그 해 이월액 (v0.11, 거래 통화): 일괄이월·등록 때 고정, 수정 화면에서만 변경. NULL이면 전년 말 수량 × 전년 마지막 종가
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, group_id, code, year)
);

-- 회원별 종목 분류 (v0.7): 국내 / 해외 / 해외추종(해외 자산을 따라가는 국내 상장 ETF 등)
CREATE TABLE IF NOT EXISTS stock_categories (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('DOMESTIC', 'OVERSEAS', 'OVERSEAS_TRACK')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, code)
);

-- 배당금 관리 (v0.13): 그룹·종목별로 선택해 저장한 배당 회차 (배당락일 기준)
CREATE TABLE IF NOT EXISTS holding_dividends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id INTEGER NOT NULL,
  code TEXT NOT NULL,
  ex_date TEXT NOT NULL,            -- 배당락일 (회차)
  pay_date TEXT,                    -- 실지급일 (제공되는 경우)
  per_share REAL NOT NULL,          -- 주당 배당금 (거래 통화)
  tax_per_share REAL,               -- 주당 과세표준 (없으면 NULL)
  quantity REAL NOT NULL,           -- 배당 받은 수량 (기본: 보유 수량, 수정 가능)
  amount REAL NOT NULL,             -- 총 배당금 = 수량 × 주당 배당금
  tax_amount REAL,                  -- 총 과세표준 = 수량 × 주당 과세표준
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, group_id, code, ex_date)
);

-- 회원별 화면 설정 (마지막 조회 기간·선택 연도)
CREATE TABLE IF NOT EXISTS user_settings (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);

-- 화면 공유·권한 (v0.16): owner 가 viewer 에게 화면별 권한(view/edit)을 준다
CREATE TABLE IF NOT EXISTS screen_shares (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  viewer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  perms TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (owner_id, viewer_id)
);

-- 동기화·복원으로 받은 화면 공유 중, 이 기기에 아직 없는 사용자(이메일)에게 준 공유 (v0.26.9)
-- 그 이메일이 이 기기에 사용자로 추가되면 screen_shares 로 옮긴다
CREATE TABLE IF NOT EXISTS pending_shares (
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  viewer_email TEXT NOT NULL,
  perms TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, viewer_email)
);

-- 공유받은 자료 (v0.27.2): 같은 동기화 파일에 있는 다른 사용자(나에게 화면을 공유한 사람)의 자료를
-- 이 기기에 조회 전용으로 받아 둔 사용자. 로그인할 수 없고, 동기화할 때마다 새로 받아 바뀐다
CREATE TABLE IF NOT EXISTS mirror_users (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  source_hash TEXT,
  saved_at TEXT,
  device TEXT,
  updated_at TEXT NOT NULL
);

-- 구글 드라이브 직접 연결 (v0.27.0): 기기·사용자별 OAuth 정보. 백업·동기화 파일에는 넣지 않는다
CREATE TABLE IF NOT EXISTS gdrive_auth (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  client_id TEXT,
  client_secret TEXT,
  refresh_token TEXT,
  access_token TEXT,
  expires_at INTEGER,
  account TEXT,
  file_id TEXT,
  updated_at TEXT NOT NULL
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
  price_fetched_at TEXT,            -- 마지막으로 외부에서 가져온 시각 (캐시 판단용)
  div_loaded_at TEXT,               -- 배당 지급내역 갱신 시각
  div_source TEXT,
  div_tax_error TEXT                -- 주당과세표준액 갱신 실패 사유
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

-- 배당 지급내역 (FR-DATA-09): 배당락일·주당 배당금, 1일 동안 재사용
CREATE TABLE IF NOT EXISTS dividend_events (
  code TEXT NOT NULL,
  ex_date TEXT NOT NULL,            -- 배당락일 (거래소 현지 날짜)
  amount REAL NOT NULL,             -- 주당 배당금 (거래 통화, 분할 반영)
  source TEXT NOT NULL,
  collected_at TEXT NOT NULL,
  tax_base REAL,                    -- 주당과세표준액 (국내 ETF, FunETF 공시값)
  tax_source TEXT,
  pay_date TEXT,                    -- 실지급일 (제공되는 경우만)
  PRIMARY KEY (code, ex_date)
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
  storage.save(data);
}

async function init() {
  const SQL = await storage.initSql();
  const bytes = storage.load();
  const isNew = !bytes;
  db = isNew ? new SQL.Database() : new SQL.Database(bytes);
  db.run(SCHEMA);
  migrate();
  if (isNew) saveNow();
  return { isNew };
}

// 이전 버전 DB에 새 컬럼 추가
function migrate() {
  const cols = all('PRAGMA table_info(instruments)').map((c) => c.name);
  if (!cols.includes('div_loaded_at')) db.run('ALTER TABLE instruments ADD COLUMN div_loaded_at TEXT');
  if (!cols.includes('div_source')) db.run('ALTER TABLE instruments ADD COLUMN div_source TEXT');
  if (!cols.includes('div_tax_error')) db.run('ALTER TABLE instruments ADD COLUMN div_tax_error TEXT');
  const dcols = all('PRAGMA table_info(dividend_events)').map((c) => c.name);
  if (!dcols.includes('tax_base')) db.run('ALTER TABLE dividend_events ADD COLUMN tax_base REAL');
  if (!dcols.includes('tax_source')) db.run('ALTER TABLE dividend_events ADD COLUMN tax_source TEXT');
  if (!dcols.includes('pay_date')) db.run('ALTER TABLE dividend_events ADD COLUMN pay_date TEXT');

  // v0.5: 기존 보유 종목(holdings)을 등록 연도의 매수 기록으로 한 번만 옮긴다
  const migrated = all("SELECT value FROM app_meta WHERE key = 'holdings_to_trades'")[0];
  if (!migrated) {
    const now = new Date().toISOString();
    for (const h of all('SELECT * FROM holdings')) {
      db.run(
        `INSERT INTO holding_trades (user_id, code, year, side, quantity, price, memo, created_at, updated_at)
         VALUES (?, ?, ?, 'BUY', ?, ?, ?, ?, ?)`,
        [h.user_id, h.code, Number(String(h.created_at).slice(0, 4)), h.quantity, h.avg_price, '이전 보유 종목에서 옮김', h.created_at, now]
      );
    }
    db.run("INSERT INTO app_meta (key, value) VALUES ('holdings_to_trades', ?)", [now]);
  }

  // 별명·프로필 사진 (v0.30.0): 로그인 아이디(email 칸)는 이메일 또는 별명(소문자로 비교), nickname 은 화면 표시용(입력한 그대로)
  const ucols = all('PRAGMA table_info(users)').map((c) => c.name);
  if (!ucols.includes('nickname')) db.run('ALTER TABLE users ADD COLUMN nickname TEXT');
  if (!ucols.includes('avatar')) db.run('ALTER TABLE users ADD COLUMN avatar TEXT');
  // 사용자 정보 동기화 (v0.30.23): 별명·사진·비밀번호를 마지막으로 바꾼 시각, 지운 사용자 기록(다른 기기에도 삭제를 전하기 위해)
  if (!ucols.includes('profile_at')) db.run('ALTER TABLE users ADD COLUMN profile_at TEXT');
  db.run('CREATE TABLE IF NOT EXISTS deleted_users (email TEXT PRIMARY KEY, deleted_at TEXT NOT NULL)');
  // 종목명 언어 (v0.30.37): 한글명·영문명
  db.run('CREATE TABLE IF NOT EXISTS stock_names (code TEXT PRIMARY KEY, ko TEXT, en TEXT, tried_at TEXT)');
  // 받지 않기 (v0.30.26): 공유받은 사람이 거절한 공유. 공유한 사람이 그 뒤에 다시 공유(updated_at 이 더 늦음)하면 다시 보인다
  db.run(`CREATE TABLE IF NOT EXISTS share_declines (
    viewer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    owner_email TEXT NOT NULL,
    declined_at TEXT NOT NULL,
    PRIMARY KEY (viewer_id, owner_email))`);
  // 데모 계정: 별명·사진을 붙이고 비밀번호를 4자리(1234)로 (한 번만, 별명이 없을 때)
  if (get("SELECT 1 FROM users WHERE email = 'demo@example.com' AND nickname IS NULL")) {
    db.run("UPDATE users SET nickname = '샘플', avatar = 'preset:1', password_hash = ? WHERE email = 'demo@example.com'", [DEMO_PIN_HASH]);
  }
  // v0.30.27: 기본 사용자 별명 '데모' → '샘플' (한 번, 다른 사용자가 '샘플'을 쓰지 않을 때)
  if (get("SELECT 1 FROM users WHERE email = 'demo@example.com' AND nickname = '데모'")
    && !get("SELECT 1 FROM users WHERE email != 'demo@example.com' AND (lower(nickname) = '샘플' OR lower(email) = '샘플')")) {
    db.run("UPDATE users SET nickname = '샘플' WHERE email = 'demo@example.com'");
  }

  const icols = all('PRAGMA table_info(holding_items)').map((c) => c.name);
  if (!icols.includes('carry_mode')) db.run('ALTER TABLE holding_items ADD COLUMN carry_mode TEXT');
  if (!icols.includes('realized_pnl')) db.run('ALTER TABLE holding_items ADD COLUMN realized_pnl REAL');
  if (!icols.includes('carry_amount')) db.run('ALTER TABLE holding_items ADD COLUMN carry_amount REAL');
  if (!icols.includes('carry_qty')) db.run('ALTER TABLE holding_items ADD COLUMN carry_qty REAL');
  if (!icols.includes('formulas')) db.run('ALTER TABLE holding_items ADD COLUMN formulas TEXT'); // v0.26.7 입력 계산식 (JSON)

  // v0.8: 매수·매도 기록(holding_trades)을 연도별 주식 항목(holding_items)으로 한 번 변환
  if (!all("SELECT value FROM app_meta WHERE key = 'trades_to_items'")[0]) {
    const now = new Date().toISOString();
    const trades = all('SELECT * FROM holding_trades ORDER BY year, CASE side WHEN \'BUY\' THEN 0 ELSE 1 END, id');
    const state = new Map(); // user|group|code → {qty, cost}
    const byYear = new Map(); // user|group|code|year → 마지막 상태
    for (const t of trades) {
      const k = `${t.user_id}|${t.group_id || 0}|${t.code}`;
      const st = state.get(k) || { qty: 0, cost: 0, memos: [] };
      if (t.side === 'BUY') { st.cost += t.quantity * t.price; st.qty += t.quantity; } else {
        const avg = st.qty > 1e-9 ? st.cost / st.qty : 0;
        st.qty -= t.quantity; st.cost -= avg * t.quantity;
        if (st.qty < 1e-9) { st.qty = 0; st.cost = 0; }
      }
      state.set(k, st);
      const yk = `${k}|${t.year}`;
      const prev = byYear.get(yk);
      byYear.set(yk, { user: t.user_id, group: t.group_id, code: t.code, year: t.year, qty: st.qty, avg: st.qty > 0 ? st.cost / st.qty : null, memo: [prev && prev.memo, t.memo].filter(Boolean).join(' / ') || null });
    }
    for (const v of byYear.values()) {
      if (!v.group) continue;
      db.run('INSERT OR REPLACE INTO holding_items (user_id, group_id, code, year, quantity, avg_price, memo, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [v.user, v.group, v.code, v.year, v.qty, v.avg, v.memo, now, now]);
    }
    db.run("INSERT INTO app_meta (key, value) VALUES ('trades_to_items', ?)", [now]);
  }

  // v0.7: 네이버에서 받은 종목명에 남아 있던 XML 문자 참조 복원 (예: S&amp;P → S&P)
  db.run("UPDATE instruments SET name = REPLACE(REPLACE(REPLACE(REPLACE(name, '&lt;', '<'), '&gt;', '>'), '&quot;', '\"'), '&amp;', '&') WHERE name LIKE '%&%;%'");

  // v0.6: 그룹 컬럼 추가, 그룹이 없는 기록은 회원별 '일반' 그룹으로
  const tcols = all('PRAGMA table_info(holding_trades)').map((c) => c.name);
  if (!tcols.includes('group_id')) db.run('ALTER TABLE holding_trades ADD COLUMN group_id INTEGER');
  for (const r of all('SELECT DISTINCT user_id FROM holding_trades WHERE group_id IS NULL')) {
    let g = all('SELECT id FROM holding_groups WHERE user_id = ? ORDER BY sort_order, id LIMIT 1', [r.user_id])[0];
    if (!g) {
      db.run('INSERT INTO holding_groups (user_id, name, sort_order, created_at) VALUES (?, ?, 0, ?)', [r.user_id, '일반', new Date().toISOString()]);
      g = { id: all('SELECT last_insert_rowid() AS id')[0].id };
    }
    db.run('UPDATE holding_trades SET group_id = ? WHERE user_id = ? AND group_id IS NULL', [g.id, r.user_id]);
  }
}

module.exports = { init, all, get, run, runMany, tx, saveNow };
