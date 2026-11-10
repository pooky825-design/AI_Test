// 보유 종목: 연도별 주식 항목 (v0.8)
// - 그룹·종목별로 그 해 말 보유 수량과 평균 매입단가를 저장한다(holding_items).
// - 어느 연도의 보유 = 그 연도 이하에서 가장 최근 항목 (그 해 항목이 없으면 직전 항목이 이어짐 = 이월)
// - 수량 0 항목 = 그 해부터 보유하지 않음
const db = require('../db');

const EPS = 1e-9;
const keyOf = (t) => `${t.group_id || 0}|${t.code}`;

function itemsOf(userId) {
  return db.all('SELECT * FROM holding_items WHERE user_id = ? ORDER BY year, id', [userId]);
}

/** 각 (그룹, 종목)의 upToYear 기준 상태. items 는 itemsOf 결과 */
function stateAt(items, upToYear) {
  const map = new Map();
  for (const it of items) {
    if (it.year > upToYear) continue;
    const k = keyOf(it);
    const prev = map.get(k);
    if (prev && prev.itemYear > it.year) continue;
    map.set(k, {
      code: it.code,
      groupId: it.group_id,
      quantity: it.quantity,
      avgPrice: it.quantity > EPS ? it.avg_price : 0,
      cost: it.quantity > EPS ? it.quantity * it.avg_price : 0,
      itemId: it.id,
      itemYear: it.year,
      memo: it.memo,
      carryMode: it.year === upToYear ? it.carry_mode || null : null, // 그 해 항목에 지정한 이월 여부
      lastTradeAt: it.updated_at,
      createdAt: it.created_at, // 입력일
      firstYear: prev ? prev.firstYear : it.year,
      tradesInYear: it.year === upToYear ? 1 : 0,
      realized: it.year === upToYear && it.realized_pnl != null ? it.realized_pnl : null, // 그 해 실현손익 (v0.10)
      carryAmount: it.year === upToYear && it.carry_amount != null ? it.carry_amount : null, // 고정 이월액 (v0.11)
    });
  }
  return map;
}

// 이전 코드와 같은 이름: (그룹, 종목)별 상태
const accumulate = stateAt;

/** 종목별 합계 (그룹 합산) */
function accumulateByCode(items, upToYear) {
  const out = new Map();
  for (const p of stateAt(items, upToYear).values()) {
    if (p.quantity <= EPS) continue;
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
  const items = itemsOf(userId);
  const prev = stateAt(items, upToYear - 1);
  return [...stateAt(items, upToYear).values()]
    .filter((p) => p.quantity > EPS && (!groupId || p.groupId === groupId))
    .map((p) => {
      const pv = prev.get(`${p.groupId}|${p.code}`);
      // 이월 여부
      //  - 이전 연도 항목을 그대로 가져온 종목(그 해 항목 없음) → 항상 이월
      //  - 그 해 항목에 이월 여부를 지정했으면 그 값
      //  - 그 밖에는 전년 말에도 보유했는지로 판단
      if (p.itemYear < upToYear) return { ...p, carried: true };
      const auto = !!(pv && pv.quantity > EPS);
      return { ...p, carried: p.carryMode ? p.carryMode === 'CARRIED' : auto };
    });
}

/** upToYear 말 종목별 합계 (그룹 합산, 수량 0 초과만) */
function totalsAt(userId, upToYear) {
  return [...accumulateByCode(itemsOf(userId), upToYear).values()].map((p) => ({ ...p, avgPrice: p.cost / p.quantity }));
}

/**
 * 연초 기준 매입금액: 선택 연도 1월 1일을 기준으로 다시 잡은 매입금액
 * - 전년 말 보유(이월) 수량은 전년 마지막 거래일 종가(= 1월 1일 평가액)로 평가
 * - 수량이 늘었으면 늘어난 수량은 그 해 매수분: 매수 금액 = 올해 말 매입금액 − 전년 말 매입금액 (이동평균 역산)
 * - 수량이 줄었으면 이월분에서 판 것으로 보고 남은 수량 × 1월 1일 평가액
 * startPrice 가 없으면(종가 없음) 이월분은 실제 평균 매입단가를 쓰고 fallback 으로 표시
 */
function yearBasis(items, groupId, code, year, startPrice) {
  const k = `${groupId || 0}|${code}`;
  const prev = stateAt(items, year - 1).get(k);
  const cur = stateAt(items, year).get(k);
  const N = cur && cur.quantity > EPS ? cur.quantity : 0;
  // 이월 여부를 직접 지정한 경우 (v0.8.1)
  //  - 이월: 보유 수량 전부를 1월 1일 평가액(전년 마지막 종가)으로
  //  - 신규: 그 해 매입금액(수량 × 평균 매입단가) 그대로
  if (cur && cur.carryMode === 'CARRIED') {
    const unit = startPrice == null ? cur.avgPrice : startPrice;
    return { cost: N * unit, quantity: N, startQty: N, fallback: N > EPS && startPrice == null };
  }
  if (cur && cur.carryMode === 'NEW') return { cost: cur.cost, quantity: N, startQty: 0, fallback: false };
  const Q = prev && prev.quantity > EPS ? prev.quantity : 0;
  const startUnit = startPrice == null ? (prev ? prev.avgPrice : 0) : startPrice;
  const carried = Math.min(Q, N);
  let cost = carried * startUnit;
  if (N > Q + EPS) cost += Math.max(0, cur.cost - (prev ? prev.cost : 0));
  return { cost, quantity: N, startQty: carried, fallback: carried > EPS && startPrice == null };
}

/**
 * 올해 손익·전체기간 손익 보조값 (v0.10, 거래 통화)
 * - realizedYear: 그 해 항목에 입력한 실현손익 (매도금액 − 원래 매입금액)
 * - realizedCum: 그 해까지 입력한 실현손익 합계 (전체기간 손익에 더함)
 * - soldAdj: 전년 말 이월분에서 판 수량의 전년까지 오른 몫 = (1월 1일 가격 − 전년 말 평균 매입단가) × 판 수량.
 *   이 몫은 전년도 손익에 이미 들어갔으므로 올해 손익에서 뺀다 (이월 여부가 ‘신규’면 0)
 * (v0.11부터 올해 손익은 yearBase 의 soldCost 방식으로 계산하고, 여기서는 실현손익 합계만 쓴다)
 * 전체기간 손익 = 평가금액 − 원래 매입금액 + realizedCum
 */
function pnlParts(items, groupId, code, year, startPrice) {
  const k = `${groupId || 0}|${code}`;
  let realizedYear = 0;
  let realizedCum = 0;
  let hasRealized = false;
  for (const it of items) {
    if (keyOf(it) !== k || it.year > year || it.realized_pnl == null) continue;
    realizedCum += it.realized_pnl;
    if (it.year === year) { realizedYear += it.realized_pnl; hasRealized = true; }
  }
  const prev = stateAt(items, year - 1).get(k);
  const cur = stateAt(items, year).get(k);
  const Q = prev && prev.quantity > EPS ? prev.quantity : 0;
  const N = cur && cur.quantity > EPS ? cur.quantity : 0;
  const sold = Math.max(0, Q - N);
  const soldAdj = sold > EPS && startPrice != null && !(cur && cur.carryMode === 'NEW') ? (startPrice - prev.avgPrice) * sold : 0;
  return { realizedYear, realizedCum, hasRealized, soldAdj, soldQty: sold, prevQty: Q, prevAvg: prev ? prev.avgPrice : null };
}

/**
 * 그 해 손익의 기준 (v0.11, 거래 통화)
 * - carry: 이월액 = 전년 말부터 가져온 수량의 1월 1일 평가액. 그 해 항목에 고정값(carry_amount)이 있으면 그 값,
 *   없으면 전년 말 수량 × 전년 마지막 종가(종가가 없으면 전년 말 매입금액). 이월 여부 ‘신규’면 0
 *   (그 해 항목 없이 ‘이월’로 처음 등록한 종목은 그 해 수량 × 전년 종가)
 * - newBuys: 올해 매수금액 = 수량이 늘었을 때 늘어난 매입금액 (그 해 매입금액 − 전년 말 매입금액). ‘신규’면 그 해 매입금액 전부
 * - soldCost: 판 수량의 원래 매입금액 = 줄어든 수량 × 전년 말 평균 매입단가 (실현손익과 더하면 매도금액)
 * 올해 손익 = 평가금액 − carry − newBuys + 그 해 실현손익 + soldCost
 */
function yearBase(items, groupId, code, year, startPrice) {
  const k = `${groupId || 0}|${code}`;
  const prev = stateAt(items, year - 1).get(k);
  const cur = stateAt(items, year).get(k);
  const Q = prev && prev.quantity > EPS ? prev.quantity : 0;
  const N = cur && cur.quantity > EPS ? cur.quantity : 0;
  const mode = cur && cur.itemYear === year ? cur.carryMode : null;
  const fixed = cur && cur.itemYear === year && cur.carryAmount != null && mode !== 'NEW' ? cur.carryAmount : null;
  if (mode === 'NEW') {
    return { carry: 0, carriedQty: 0, newBuys: N > EPS ? cur.cost : 0, soldQty: 0, soldCost: 0, prevAvg: null, fixed: false, fallback: false };
  }
  let carriedQty = Q;
  let auto;
  let fallback = false;
  if (Q > EPS) {
    auto = startPrice != null ? Q * startPrice : prev.cost;
    fallback = startPrice == null;
  } else if (mode === 'CARRIED' && N > EPS) {
    carriedQty = N; // 전년 항목 없이 ‘이월’로 등록: 그 해 수량 전부를 1월 1일 가격으로
    auto = startPrice != null ? N * startPrice : cur.cost;
    fallback = startPrice == null;
  } else {
    auto = 0;
  }
  const carry = fixed != null ? fixed : auto;
  const prevCost = Q > EPS ? prev.cost : (carriedQty > EPS ? (cur ? cur.cost : 0) : 0);
  const newBuys = N > carriedQty + EPS && cur ? Math.max(0, cur.cost - prevCost) : 0;
  const soldQty = Q > EPS ? Math.max(0, Q - N) : 0;
  return { carry, carriedQty, autoCarry: auto, newBuys, soldQty, soldCost: soldQty * (prev ? prev.avgPrice : 0), prevAvg: prev ? prev.avgPrice : null, fixed: fixed != null, fallback: fixed == null && fallback };
}

function tradeYearRange(userId) {
  const r = db.get('SELECT MIN(year) AS minY, MAX(year) AS maxY FROM holding_items WHERE user_id = ?', [userId]);
  return { min: r && r.minY, max: r && r.maxY };
}

/** 그 해까지 한 번이라도 항목이 있는 종목코드 */
function codesUpTo(userId, upToYear) {
  return db.all('SELECT DISTINCT code FROM holding_items WHERE user_id = ? AND year <= ?', [userId, upToYear]).map((r) => r.code);
}

// ---------------------------------------------------------------------------
// 그룹
// ---------------------------------------------------------------------------
function groupsOf(userId) {
  let list = db.all('SELECT id, name, sort_order FROM holding_groups WHERE user_id = ? ORDER BY sort_order, id', [userId]);
  if (!list.length) {
    db.run('INSERT INTO holding_groups (user_id, name, sort_order, created_at) VALUES (?, ?, 0, ?)', [userId, '일반', new Date().toISOString()]);
    list = db.all('SELECT id, name, sort_order FROM holding_groups WHERE user_id = ? ORDER BY sort_order, id', [userId]);
  }
  return list;
}

module.exports = {
  itemsOf, tradesOf: itemsOf, stateAt, accumulate, accumulateByCode, positionsAt, totalsAt, yearBasis, tradeYearRange, codesUpTo, groupsOf, pnlParts, yearBase,
};
