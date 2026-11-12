// 데모 계정과 예시 데이터 (DB를 처음 만들 때 한 번 실행)
const bcrypt = require('bcryptjs');
const db = require('./db');

async function seedDemo() {
  const now = new Date().toISOString();
  const hash = await bcrypt.hash('1234', 10); // 4자리 비밀번호 (v0.30.0)
  const { lastId: uid } = db.run('INSERT INTO users (email, password_hash, email_verified, created_at, nickname, avatar) VALUES (?, ?, 1, ?, ?, ?)', [
    'demo@example.com', hash, now, '샘플', 'preset:1',
  ]);
  // 데모 그룹과 매수·매도 기록 (그룹별·연도별 관리 예시, 수량·단가는 가상의 값)
  const gid = {};
  ['일반', 'ISA', '연금'].forEach((name, i) => {
    gid[name] = db.run('INSERT INTO holding_groups (user_id, name, sort_order, created_at) VALUES (?, ?, ?, ?)', [uid, name, i, now]).lastId;
  });
  // 연도별 주식 항목: 그 해 말 보유 수량·평균 매입단가 (그 해 항목이 없으면 직전 연도 항목이 이어짐)
  const ty = new Date().getFullYear();
  const items = [
    ['일반', 'AAPL', ty - 5, 10, 150, null],
    ['일반', '005930', ty - 4, 50, 60000, '첫 매수'],
    ['일반', '005930', ty - 2, 100, 57500, '추가 매수'],
    ['일반', 'AAPL', ty - 2, 7, 150, '일부 매도'],
    ['일반', 'AAPL', ty - 1, 10, 171, '다시 매수'],
    ['ISA', '069500', ty - 3, 50, 35000, null],
    ['ISA', '0080G0', ty - 1, 200, 5000, null],
    ['연금', 'SPY', ty - 3, 5, 450, null],
    ['연금', '069500', ty - 2, 20, 33000, '연금 계좌에서도 보유'],
    ['연금', '360750', ty - 1, 30, 18000, '해외추종 예시'],
  ];
  for (const [g, code, year, q, p, memo] of items) {
    db.run(
      'INSERT INTO holding_items (user_id, group_id, code, year, quantity, avg_price, memo, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [uid, gid[g], code, year, q, p, memo, now, now]
    );
  }
  // 종목 분류 (국내·해외·해외추종)
  const cats = { '005930': 'DOMESTIC', '069500': 'DOMESTIC', '0080G0': 'DOMESTIC', AAPL: 'OVERSEAS', SPY: 'OVERSEAS', '360750': 'OVERSEAS_TRACK' };
  for (const [code, c] of Object.entries(cats)) {
    db.run('INSERT INTO stock_categories (user_id, code, category, updated_at) VALUES (?, ?, ?, ?)', [uid, code, c, now]);
  }
  // 배당 내역 (v0.30.47): 배당 입력 화면의 저장 회차(holding_dividends)는 실제 배당락일·주당 배당금과 맞아야 하므로
  // 시세 출처에서 배당 내역을 받아 와야 한다 → 처음 설치 때 '할 일'로 표시해 두고 seedSampleDividends() 가 채운다
  db.run("INSERT INTO app_meta (key, value) VALUES ('sample_dividends', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [JSON.stringify({ userId: uid, done: [] })]);
  console.log('샘플 계정 생성: 샘플(demo@example.com) / 1234');
}

// 샘플 계정의 배당 입력 회차 채우기 (v0.30.47, 처음 설치 때만)
// - 샘플 보유 종목(그룹·종목)마다 배당 내역(배당락일·주당 배당금·주당 과세표준·실지급일)을 받아,
//   보유한 연도의 회차를 그 해 말 보유 수량으로 저장한다(배당 입력 화면에서 직접 저장한 것과 같은 모양)
// - 인터넷이 안 되는 등으로 받지 못한 종목은 남겨 두었다가 다음 실행(또는 1시간 주기)에 다시 시도
// - 이미 채운 종목은 다시 건드리지 않음(사용자가 고치거나 지운 회차를 되살리지 않도록)
let sampleDivRunning = null;
function seedSampleDividends() {
  if (!sampleDivRunning) sampleDivRunning = runSampleDividends().catch((e) => console.warn('[sample-dividends]', e.message)).finally(() => { sampleDivRunning = null; });
  return sampleDivRunning;
}

async function runSampleDividends() {
  const row = db.get("SELECT value FROM app_meta WHERE key = 'sample_dividends'");
  if (!row || row.value === 'done') return;
  let job;
  try { job = JSON.parse(row.value); } catch (_) { job = null; }
  const finish = () => db.run("UPDATE app_meta SET value = 'done' WHERE key = 'sample_dividends'");
  const user = job && db.get('SELECT id FROM users WHERE id = ? AND id NOT IN (SELECT user_id FROM mirror_users)', [job.userId]);
  if (!user) return finish(); // 샘플 계정을 지웠으면 할 일 없음
  const portfolio = require('./services/portfolio');
  const positions = require('./services/positions');
  const uid = user.id;
  const done = new Set(job.done || []);
  const items = positions.itemsOf(uid);
  const pairs = [...new Map(items.map((it) => [`${it.group_id}|${it.code}`, { groupId: it.group_id, code: it.code }])).values()]
    .filter((p) => !done.has(`${p.groupId}|${p.code}`));
  const today = new Date().toISOString().slice(0, 10);
  const thisYear = new Date().getFullYear();
  const byCode = new Map(); // 같은 종목을 여러 그룹에서 보유하면 배당 내역은 한 번만 받음
  let failed = 0;
  for (const p of pairs) {
    try {
      if (!byCode.has(p.code)) byCode.set(p.code, await portfolio.getStockDividends(uid, p.code, {}));
      const d = byCode.get(p.code);
      if (d.neverLoaded) { failed++; continue; } // 배당 내역을 한 번도 받지 못함 → 다음에 다시
      const firstYear = Math.min(...items.filter((it) => it.group_id === p.groupId && it.code === p.code).map((it) => it.year));
      const qtyOf = new Map();
      const rows = [];
      for (const e of d.events) {
        const y = Number(e.exDate.slice(0, 4));
        if (y < firstYear || y > thisYear || e.exDate > today) continue;
        if (!qtyOf.has(y)) {
          const held = positions.positionsAt(uid, y, { groupId: p.groupId }).find((x) => x.code === d.instrument.code);
          qtyOf.set(y, held ? held.quantity : 0);
        }
        const q = qtyOf.get(y);
        if (!(q > 0)) continue;
        const tax = e.taxBase ?? null;
        const t = new Date().toISOString();
        rows.push([uid, p.groupId, d.instrument.code, e.exDate, e.payDate || null, e.amount, tax, q, q * e.amount, tax == null ? null : q * tax, t, t]);
      }
      db.tx(() => {
        for (const r of rows) {
          db.run(`INSERT OR IGNORE INTO holding_dividends (user_id, group_id, code, ex_date, pay_date, per_share, tax_per_share, quantity, amount, tax_amount, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, r);
        }
      });
      done.add(`${p.groupId}|${p.code}`);
      db.run("UPDATE app_meta SET value = ? WHERE key = 'sample_dividends'", [JSON.stringify({ userId: uid, done: [...done] })]);
    } catch (e) {
      if (e.code === 'NOT_FOUND') { // 출처에 없는 종목(샘플 시세 모드 등)은 채울 것이 없음
        done.add(`${p.groupId}|${p.code}`);
        db.run("UPDATE app_meta SET value = ? WHERE key = 'sample_dividends'", [JSON.stringify({ userId: uid, done: [...done] })]);
      } else failed++;
    }
  }
  if (!failed) {
    finish();
    console.log('샘플 계정 배당 내역 준비 완료');
  }
}

module.exports = { seedDemo, seedSampleDividends };
