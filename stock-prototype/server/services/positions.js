// 연도별 매수·매도 기록 → 연도 말 보유 수량·평균 매입단가 (v0.5)
// - 연도 말 보유 수량 = 그 해까지의 매수 합계 − 매도 합계
// - 평균 매입단가: 이동평균. 매수하면 (기존 원가 + 수량 × 단가) ÷ 새 수량, 매도하면 평균 단가는 그대로
// - 같은 해 안의 매매 시점은 알 수 없으므로, 한 해 안에서는 매수를 먼저 반영하고 매도를 나중에 반영한다
const db = require('../db');

const EPS = 1e-9;

function tradesOf(userId) {
  return db.all('SELECT * FROM holding_trades WHERE user_id = ? ORDER BY year, CASE side WHEN \'BUY\' THEN 0 ELSE 1 END, id', [userId]);
}

function sortTrades(list) {
  return list.slice().sort((a, b) => a.year - b.year || (a.side === b.side ? 0 : a.side === 'BUY' ? -1 : 1) || (a.id || 0) - (b.id || 0));
}

/** 기록 목록을 종목별로 누적. upToYear 까지 반영 */
function accumulate(trades, upToYear) {
  const map = new Map();
  for (const t of sortTrades(trades)) {
    if (t.year > upToYear) continue;
    const p = map.get(t.code) || { code: t.code, quantity: 0, cost: 0, firstYear: t.year, lastTradeYear: t.year, lastTradeAt: t.updated_at, tradesInYear: 0 };
    if (t.side === 'BUY') {
      p.cost += t.quantity * t.price;
      p.quantity += t.quantity;
    } else {
      const avg = p.quantity > EPS ? p.cost / p.quantity : 0;
      p.quantity -= t.quantity;
      p.cost -= avg * t.quantity;
      if (p.quantity < EPS) { p.quantity = Math.max(p.quantity, 0); p.cost = 0; }
    }
    p.lastTradeYear = t.year;
    if (!p.lastTradeAt || t.updated_at > p.lastTradeAt) p.lastTradeAt = t.updated_at;
    if (t.year === upToYear) p.tradesInYear++;
    map.set(t.code, p);
  }
  return map;
}

/** upToYear 말 보유 종목 (수량 0 초과만) */
function positionsAt(userId, upToYear) {
  return [...accumulate(tradesOf(userId), upToYear).values()]
    .filter((p) => p.quantity > EPS)
    .map((p) => ({ ...p, avgPrice: p.cost / p.quantity }));
}

/**
 * 매도 수량이 보유 수량을 넘지 않는지 확인 (모든 연도 말 기준)
 * @returns null 또는 { code, year, held } (처음으로 음수가 되는 연도)
 */
function findShortfall(trades, code) {
  const list = sortTrades(trades.filter((t) => t.code === code));
  let qty = 0;
  for (const t of list) {
    qty += t.side === 'BUY' ? t.quantity : -t.quantity;
    if (qty < -EPS) return { code, year: t.year, held: qty + t.quantity };
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

module.exports = { tradesOf, positionsAt, accumulate, findShortfall, tradeYearRange, codesUpTo };
