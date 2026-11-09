// 연도별 매수·매도 기록 → 연도 말 보유 수량·평균 매입단가 (v0.5, 그룹별 v0.6)
// - 보유는 (그룹, 종목) 단위로 계산한다. 같은 종목이라도 그룹(ISA·연금·일반 등)이 다르면 따로 관리
// - 연도 말 보유 수량 = 그 해까지의 매수 합계 − 매도 합계
// - 평균 매입단가: 이동평균. 매수하면 (기존 원가 + 수량 × 단가) ÷ 새 수량, 매도하면 평균 단가는 그대로
// - 같은 해 안의 매매 시점은 알 수 없으므로, 한 해 안에서는 매수를 먼저 반영하고 매도를 나중에 반영한다
const db = require('../db');

const EPS = 1e-9;
const keyOf = (t) => `${t.group_id || 0}|${t.code}`;

function tradesOf(userId) {
  return db.all('SELECT * FROM holding_trades WHERE user_id = ?', [userId]);
}

function sortTrades(list) {
  return list.slice().sort((a, b) => a.year - b.year || (a.side === b.side ? 0 : a.side === 'BUY' ? -1 : 1) || (a.id || 0) - (b.id || 0));
}

/** 기록을 (그룹, 종목)별로 누적. upToYear 까지 반영 */
function accumulate(trades, upToYear) {
  const map = new Map();
  for (const t of sortTrades(trades)) {
    if (t.year > upToYear) continue;
    const k = keyOf(t);
    const p = map.get(k) || {
      code: t.code, groupId: t.group_id || null, quantity: 0, cost: 0, firstYear: t.year, lastTradeAt: t.updated_at, tradesInYear: 0,
    };
    if (t.side === 'BUY') {
      p.cost += t.quantity * t.price;
      p.quantity += t.quantity;
    } else {
      const avg = p.quantity > EPS ? p.cost / p.quantity : 0;
      p.quantity -= t.quantity;
      p.cost -= avg * t.quantity;
      if (p.quantity < EPS) { p.quantity = Math.max(p.quantity, 0); p.cost = 0; }
    }
    if (!p.lastTradeAt || t.updated_at > p.lastTradeAt) p.lastTradeAt = t.updated_at;
    if (t.year === upToYear) p.tradesInYear++;
    map.set(k, p);
  }
  return map;
}

/** 종목별 합계 (그룹 합산). 연도별 조회·배당 추정액에 사용 */
function accumulateByCode(trades, upToYear) {
  const out = new Map();
  for (const p of accumulate(trades, upToYear).values()) {
    const o = out.get(p.code) || { code: p.code, quantity: 0, cost: 0, tradesInYear: 0, lastTradeAt: p.lastTradeAt };
    o.quantity += p.quantity;
    o.cost += p.cost;
    o.tradesInYear += p.tradesInYear;
    if (p.lastTradeAt > o.lastTradeAt) o.lastTradeAt = p.lastTradeAt;
    out.set(p.code, o);
  }
  return out;
}

/** upToYear 말 보유 (그룹, 종목) 목록 (수량 0 초과만). groupId 를 주면 그 그룹만 */
function positionsAt(userId, upToYear, { groupId } = {}) {
  return [...accumulate(tradesOf(userId), upToYear).values()]
    .filter((p) => p.quantity > EPS && (!groupId || p.groupId === groupId))
    .map((p) => ({ ...p, avgPrice: p.cost / p.quantity }));
}

/** upToYear 말 종목별 합계 (그룹 합산, 수량 0 초과만) */
function totalsAt(userId, upToYear) {
  return [...accumulateByCode(tradesOf(userId), upToYear).values()]
    .filter((p) => p.quantity > EPS)
    .map((p) => ({ ...p, avgPrice: p.cost / p.quantity }));
}

/**
 * 같은 그룹·종목에서 매도 수량이 보유 수량을 넘지 않는지 확인 (모든 연도 말 기준)
 * @returns null 또는 { code, groupId, year, held } (처음으로 음수가 되는 연도)
 */
function findShortfall(trades, code, groupId) {
  const list = sortTrades(trades.filter((t) => t.code === code && (t.group_id || 0) === (groupId || 0)));
  let qty = 0;
  for (const t of list) {
    qty += t.side === 'BUY' ? t.quantity : -t.quantity;
    if (qty < -EPS) return { code, groupId, year: t.year, held: qty + t.quantity };
  }
  return null;
}

function tradeYearRange(userId) {
  const r = db.get('SELECT MIN(year) AS minY, MAX(year) AS maxY FROM holding_trades WHERE user_id = ?', [userId]);
  return { min: r && r.minY, max: r && r.maxY };
}

/** 그 해까지 한 번이라도 기록이 있는 종목코드 */
function codesUpTo(userId, upToYear) {
  return db.all('SELECT DISTINCT code FROM holding_trades WHERE user_id = ? AND year <= ?', [userId, upToYear]).map((r) => r.code);
}

// ---------------------------------------------------------------------------
// 그룹
// ---------------------------------------------------------------------------
function groupsOf(userId) {
  let list = db.all('SELECT id, name, sort_order FROM holding_groups WHERE user_id = ? ORDER BY sort_order, id', [userId]);
  if (!list.length) {
    // 그룹이 하나도 없으면 기본 '일반' 그룹을 만든다
    db.run('INSERT INTO holding_groups (user_id, name, sort_order, created_at) VALUES (?, ?, 0, ?)', [userId, '일반', new Date().toISOString()]);
    list = db.all('SELECT id, name, sort_order FROM holding_groups WHERE user_id = ? ORDER BY sort_order, id', [userId]);
  }
  return list;
}

module.exports = { tradesOf, positionsAt, totalsAt, accumulate, accumulateByCode, findShortfall, tradeYearRange, codesUpTo, groupsOf };
