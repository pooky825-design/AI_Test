// 회원별 자산 계산 (요구사항 2.3, 2.4, 3.4, 3.5, 3.6)
// 금액은 내부적으로 반올림하지 않고 계산하며, 화면 표시 단계에서만 반올림한다(4.3).
const db = require('../db');
const market = require('./market');
const positions = require('./positions');
const categories = require('./categories');

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

const thisYear = () => new Date().getFullYear();

// 마지막 매수·매도 기록 이후 발생한 액면분할·병합 (FR-DATA-03: 수량 수정 안내)
function splitNotice(p) {
  const s = db.get('SELECT split_date, ratio FROM splits WHERE code = ? AND split_date > ? ORDER BY split_date DESC LIMIT 1', [
    p.code, String(p.lastTradeAt || '').slice(0, 10),
  ]);
  return s ? { date: s.split_date, ratio: s.ratio } : null;
}

// ---------------------------------------------------------------------------
// 자산 현황 (2.3) — 선택 연도 말 보유 수량 기준 (v0.5)
// 올해: 원화 평가금액 = 현재가 × 보유 수량 × 현재 환율 (국내 종목은 환율 1)
// 지난 연도: 원화 평가금액 = 연말 수정 종가 × 그 해 말 보유 수량 × 연말 환율
// 수익률 = (가격 − 평균 매입단가) ÷ 평균 매입단가
// ---------------------------------------------------------------------------
// merged: 전체 선택 시 그룹 구분 없이 종목별로 합산 (수량·매입금액 합계, 평균 매입단가 = 합계 매입금액 ÷ 합계 수량)
async function getAssets(userId, year, groupId, merged) {
  const ty = thisYear();
  const y = Number(year) || ty;
  const ongoing = y >= ty;
  const yearEnd = `${y}-12-31`;
  const groups = positions.groupsOf(userId);
  const gid = groups.some((g) => g.id === Number(groupId)) ? Number(groupId) : null; // 없거나 잘못되면 전체
  const groupName = new Map(groups.map((g) => [g.id, g.name]));
  const order = new Map(groups.map((g, i) => [g.id, i]));
  const isMerged = !!merged && !gid;
  const perGroup = positions.positionsAt(userId, y, { groupId: gid })
    .sort((a, b) => (order.get(a.groupId) ?? 99) - (order.get(b.groupId) ?? 99));

  // 연초 기준 평균 매입단가·매입금액: 전년 말 이월분은 1월 1일 평가액(전년 마지막 종가), 그 해 매수분은 매수 단가
  const allTrades = positions.tradesOf(userId);
  const codes = [...new Set(perGroup.map((p) => p.code))];
  await mapLimit(codes, 5, (c) => market.ensureInstrument(c).catch(() => null));
  const startClose = new Map(codes.map((c) => [c, market.yearEndClose(c, y - 1)]));
  for (const p of perGroup) {
    const sc = startClose.get(p.code);
    // 그 해 손익 기준 (v0.11): 이월액(고정 또는 전년 종가) + 올해 매수금액, 판 수량의 원래 매입금액
    const yb = positions.yearBase(allTrades, p.groupId, p.code, y, sc ? sc.close : null);
    p.origCost = p.cost;
    p.origAvgPrice = p.avgPrice;
    p.carry = yb.carry;
    p.newBuys = yb.newBuys;
    p.cost = yb.carry + yb.newBuys; // (참고) 이월액 + 올해 매수금액
    // 손익 기준액(금년) (v0.12.5): 이월 금액이 있으면 이월 금액, 없으면 총 매입금액
    p.base = yb.carry > 1e-9 ? yb.carry : p.origCost;
    p.avgPrice = p.cost / p.quantity;
    p.carriedQty = yb.carriedQty;
    p.carryFixed = yb.fixed;
    p.basisFallback = yb.fallback;
    p.startClose = yb.carriedQty > 0 && sc ? sc : null;
    const pp = positions.pnlParts(allTrades, p.groupId, p.code, y, null);
    Object.assign(p, { realizedYear: pp.realizedYear, realizedCum: pp.realizedCum, hasRealized: pp.hasRealized, soldQty: yb.soldQty, soldCost: yb.soldCost, yearExtra: pp.realizedYear + yb.soldCost });
  }
  // 그 해 전량 매도한 종목: 수량 0 항목 (전년 말 보유했거나 실현손익을 입력한 경우)
  const prevState = positions.stateAt(allTrades, y - 1);
  const curState = positions.stateAt(allTrades, y);
  const soldOut = [];
  for (const c of curState.values()) {
    if (c.itemYear !== y || c.quantity > 1e-9 || (gid && c.groupId !== gid)) continue;
    const pv = prevState.get(`${c.groupId}|${c.code}`);
    const pp0 = positions.pnlParts(allTrades, c.groupId, c.code, y, null);
    if (!(pv && pv.quantity > 1e-9) && !pp0.hasRealized) continue;
    await market.ensureInstrument(c.code).catch(() => null);
    const sc = market.yearEndClose(c.code, y - 1);
    const pp = positions.pnlParts(allTrades, c.groupId, c.code, y, null);
    const yb = positions.yearBase(allTrades, c.groupId, c.code, y, sc ? sc.close : null);
    soldOut.push({ code: c.code, groupId: c.groupId, realizedYear: pp.realizedYear, realizedCum: pp.realizedCum, hasRealized: pp.hasRealized, soldQty: yb.soldQty, soldCost: yb.soldCost, carry: yb.carry, carryFixed: yb.fixed, newBuys: 0, yearExtra: pp.realizedYear + yb.soldCost });
  }
  soldOut.sort((a, b) => (order.get(a.groupId) ?? 99) - (order.get(b.groupId) ?? 99));
  let soldList = soldOut;
  let list = perGroup;
  if (isMerged) {
    const byCode = new Map();
    for (const p of perGroup) {
      const m = byCode.get(p.code) || {
        code: p.code, groupId: null, quantity: 0, cost: 0, origCost: 0, carriedQty: 0, basisFallback: false, startClose: null,
        tradesInYear: 0, lastTradeAt: p.lastTradeAt, mergedGroups: [], realizedYear: 0, realizedCum: 0, hasRealized: false, soldQty: 0, soldCost: 0, carry: 0, newBuys: 0, yearExtra: 0, carryFixed: false, base: 0,
      };
      m.quantity += p.quantity;
      m.cost += p.cost;
      m.origCost += p.origCost;
      for (const f of ['realizedYear', 'realizedCum', 'soldQty', 'soldCost', 'carry', 'newBuys', 'yearExtra', 'base']) m[f] += p[f];
      m.hasRealized = m.hasRealized || p.hasRealized;
      m.carryFixed = m.carryFixed || p.carryFixed;
      m.carriedQty += p.carriedQty;
      m.basisFallback = m.basisFallback || p.basisFallback;
      m.startClose = m.startClose || p.startClose;
      m.tradesInYear += p.tradesInYear;
      if (p.lastTradeAt > m.lastTradeAt) m.lastTradeAt = p.lastTradeAt;
      m.mergedGroups.push(groupName.get(p.groupId) || '-');
      byCode.set(p.code, m);
    }
    list = [...byCode.values()].map((m) => ({ ...m, avgPrice: m.cost / m.quantity, origAvgPrice: m.origCost / m.quantity }));
    // 통합: 다른 그룹에서 계속 보유 중인 종목의 전량 매도분은 그 종목 행에 합친다
    const soldByCode = new Map();
    for (const so of soldOut) {
      const held = list.find((m) => m.code === so.code);
      const tgt = held || soldByCode.get(so.code) || { ...so, groupId: null, realizedYear: 0, realizedCum: 0, soldQty: 0, soldCost: 0, carry: 0, newBuys: 0, yearExtra: 0, hasRealized: false, mergedGroups: [] };
      for (const f of ['realizedYear', 'realizedCum', 'soldQty', 'soldCost', 'carry', 'yearExtra']) tgt[f] += so[f];
      tgt.hasRealized = tgt.hasRealized || so.hasRealized;
      if (!held) { tgt.mergedGroups.push(groupName.get(so.groupId) || '-'); soldByCode.set(so.code, tgt); }
    }
    soldList = [...soldByCode.values()];
  }

  let fx = null;
  let fxError = null;
  if (ongoing) {
    try {
      fx = await market.getCurrentFx();
    } catch (e) {
      fxError = e.message;
    }
  } else {
    try {
      await market.getCurrentFx(); // 환율 이력 적재 보장
    } catch (_) { /* 저장된 이력으로 계산 */ }
    const r = market.fxOn(yearEnd);
    fx = r ? { rate: r.rate, time: `${r.date}T00:00:00Z`, source: '연말 환율', stale: false } : null;
    if (!r) fxError = `${y}년 말 환율 데이터가 없습니다.`;
  }

  const rows = await mapLimit(list, 5, async (h) => {
    const base = {
      code: h.code, groupId: h.groupId, groupName: isMerged ? '통합' : groupName.get(h.groupId) || '-',
      mergedGroups: h.mergedGroups || null, quantity: h.quantity, avgPrice: h.avgPrice, tradesInYear: h.tradesInYear,
      origAvgPrice: h.origAvgPrice, carriedQty: h.carriedQty, basisFallback: h.basisFallback, startClose: h.startClose,
      realizedYear: h.realizedYear, realizedCum: h.realizedCum, hasRealized: h.hasRealized, soldQty: h.soldQty,
      carry: h.carry, newBuys: h.newBuys, soldCost: h.soldCost, carryFixed: h.carryFixed, base: h.base,
    };
    try {
      let price;
      let priceTime;
      let inst;
      let extra = {};
      if (ongoing) {
        const q = await market.getQuote(h.code);
        inst = q.instrument;
        price = q.price;
        priceTime = q.priceTime;
        extra = { change: q.change, changePct: q.changePct, stale: q.stale, staleReason: q.staleReason };
      } else {
        inst = market.publicInstrument(await market.ensureInstrument(h.code));
        const c = market.yearEndClose(h.code, y);
        if (!c) {
          const before = inst.listedDate && inst.listedDate > yearEnd;
          return { ...base, instrument: inst, error: before ? `${y}년 말에는 상장 전입니다.` : `${y}년 종가 데이터가 없습니다.` };
        }
        price = c.close;
        priceTime = `${c.date}T15:30:00+09:00`;
      }
      const usd = inst.currency === 'USD';
      const rate = usd ? (fx ? fx.rate : null) : 1;
      const value = price * h.quantity; // 거래 통화 기준
      const cost = h.base; // 손익 기준액(금년) = 이월 금액이 있으면 이월 금액, 없으면 총 매입금액
      const origCost = h.origAvgPrice * h.quantity; // 원래 매입금액
      const yearPnl = value - cost; // 금년 손익 = 평가금액 − 손익 기준액(금년) (v0.12.5)
      const totalPnl = value - origCost + h.realizedCum; // 전체기간 손익 (누적 실현손익 포함)
      const k = (x) => (rate == null ? null : x * rate);
      return {
        ...base,
        ...extra,
        instrument: inst,
        price,
        priceTime,
        value,
        cost,
        fxRate: rate,
        valueKrw: rate == null ? null : value * rate,
        costKrw: rate == null ? null : cost * rate,
        origCost,
        origCostKrw: k(origCost),
        realizedYearKrw: k(h.realizedYear),
        realizedCumKrw: k(h.realizedCum),
        carryKrw: k(h.carry),
        newBuysKrw: k(h.newBuys),
        soldCostKrw: k(h.soldCost),
        unrealizedKrw: k(value - cost),
        pnlKrw: k(yearPnl), // 올해 손익
        totalPnlKrw: k(totalPnl), // 전체기간 손익
        totalPct: origCost ? totalPnl / origCost : null,
        // 오늘 손익 = 전일 대비 × 보유 수량 × 현재 환율 (올해만, 환율 변동 미반영)
        todayPnlKrw: ongoing && rate != null && extra.change != null ? extra.change * h.quantity * rate : null,
        returnPct: cost ? yearPnl / cost : null, // 금년 수익률 = 금년 손익 ÷ 손익 기준액(금년)
        splitNotice: ongoing ? splitNotice(h) : null,
      };
    } catch (e) {
      return { ...base, error: e.message };
    }
  });

  // 종목 분류 (국내·해외·해외추종)
  const savedCats = categories.savedMap(userId);
  rows.forEach((r) => {
    const c = categories.categoryOf(userId, r.code, r.instrument, savedCats);
    r.category = c.id;
    r.categoryLabel = c.label;
  });
  const ok = rows.filter((r) => r.valueKrw != null);
  // 그 해 전량 매도 종목 행: 올해 손익 = 실현손익 − 전년까지 오른 몫, 전체기간 손익 = 누적 실현손익
  const soldRows = [];
  for (const so of soldList) {
    let inst = null;
    try { inst = market.publicInstrument(await market.ensureInstrument(so.code)); } catch (_) { continue; }
    const rate = inst.currency === 'USD' ? (fx ? fx.rate : null) : 1;
    if (rate == null) continue;
    const c = categories.categoryOf(userId, so.code, inst, categories.savedMap(userId));
    soldRows.push({
      code: so.code, groupId: so.groupId, groupName: isMerged ? '통합' : groupName.get(so.groupId) || '-', mergedGroups: so.mergedGroups || null,
      instrument: inst, fxRate: rate, soldQty: so.soldQty, hasRealized: so.hasRealized, category: c.id, categoryLabel: c.label,
      realizedYear: so.realizedYear, realizedYearKrw: so.realizedYear * rate, soldCostKrw: so.soldCost * rate,
      carryKrw: so.carry * rate, costKrw: 0, newBuysKrw: 0, carryFixed: so.carryFixed,
      // 전량 매도 종목은 평가금액이 없어 금년 손익(평가금액 − 손익 기준액)을 계산하지 않고, 전체기간 손익(누적 실현손익)만 표시
      pnlKrw: null, totalPnlKrw: so.realizedCum * rate, returnPct: null,
    });
  }
  // 합계 행: 보유 종목 + 전량 매도 종목의 올해 손익·전체기간 손익
  const sumOf = (rs, ss) => {
    const v = rs.reduce((a, r) => a + r.valueKrw, 0);
    const c = rs.reduce((a, r) => a + r.costKrw, 0) + ss.reduce((a, r) => a + r.costKrw, 0);
    const carry = rs.reduce((a, r) => a + r.carryKrw, 0) + ss.reduce((a, r) => a + r.carryKrw, 0);
    const oc = rs.reduce((a, r) => a + r.origCostKrw, 0);
    const pnl = rs.reduce((a, r) => a + r.pnlKrw, 0);
    const tp = rs.reduce((a, r) => a + r.totalPnlKrw, 0) + ss.reduce((a, r) => a + r.totalPnlKrw, 0);
    return { valueKrw: v, costKrw: c, carryKrw: carry, origCostKrw: oc, pnlKrw: pnl, returnPct: c ? pnl / c : null, totalPnlKrw: tp, totalPct: oc ? tp / oc : null };
  };
  const priceTimes = ok.map((r) => r.priceTime).sort();
  const range = positions.tradeYearRange(userId);
  // 그룹별 합계
  // 오늘 손익 합계와 손익률 (오늘 손익 ÷ 전일 종가 기준 평가금액)
  const todayOf = (rs) => {
    const t = rs.filter((r) => r.todayPnlKrw != null);
    if (!ongoing || !t.length) return { todayPnlKrw: null, todayPct: null };
    const pnl = t.reduce((a, r) => a + r.todayPnlKrw, 0);
    const prev = t.reduce((a, r) => a + r.valueKrw - r.todayPnlKrw, 0);
    return { todayPnlKrw: pnl, todayPct: prev ? pnl / prev : null };
  };
  const groupTotals = groups.map((g) => {
    const rs = ok.filter((r) => r.groupId === g.id);
    const ss = soldRows.filter((r) => r.groupId === g.id);
    return { groupId: g.id, name: g.name, count: rs.length, soldCount: ss.length, ...sumOf(rs, ss), ...todayOf(rs) };
  }).filter((g) => (g.count || g.soldCount) && (!gid || g.groupId === gid));
  return {
    year: y,
    ongoing,
    basisDate: `${y}-01-01`, // 평균 매입단가·매입금액 기준일
    groups,
    groupId: gid,
    merged: isMerged,
    groupTotals,
    // 분류별 합계 (선택한 그룹 범위 안에서)
    categoryTotals: categories.CATEGORIES.map((c) => {
      const rs = ok.filter((r) => r.category === c.id);
      const ss = soldRows.filter((r) => r.category === c.id);
      return { id: c.id, label: c.label, count: new Set(rs.map((r) => r.code)).size, soldCount: ss.length, ...sumOf(rs, ss), ...todayOf(rs) };
    }),
    yearRange: { min: Math.min(range.min || ty, ty - 9), max: ty },
    rows,
    soldRows,
    total: {
      ...sumOf(ok, soldRows),
      ...todayOf(ok),
      excluded: rows.length - ok.length,
    },
    basis: {
      fxRate: fx ? fx.rate : null,
      // 전일 대비 환율 증감 (v0.13): 적용 환율 기준일 전날까지의 마지막 환율과 비교
      ...(() => {
        if (!fx || !fx.time) return { fxPrev: null, fxChangePct: null };
        const d0 = new Date(`${String(fx.time).slice(0, 10)}T00:00:00Z`);
        d0.setUTCDate(d0.getUTCDate() - 1);
        const prev = market.fxOn(d0.toISOString().slice(0, 10));
        return { fxPrev: prev ? prev.rate : null, fxPrevDate: prev ? prev.date : null, fxChangePct: prev && prev.rate ? (fx.rate - prev.rate) / prev.rate : null };
      })(),
      fxTime: fx ? fx.time : null,
      fxSource: fx ? fx.source : null,
      fxStale: fx ? fx.stale : true,
      fxError: fxError || (fx && fx.staleReason) || null,
      priceTimeOldest: priceTimes[0] || null,
      priceTimeLatest: priceTimes[priceTimes.length - 1] || null,
      anyStale: rows.some((r) => r.stale),
      generatedAt: new Date().toISOString(),
    },
  };
}

// ---------------------------------------------------------------------------
// 배당 (3.6): 지급일 환율로 원화 환산
// ---------------------------------------------------------------------------
function dividendKrw(d) {
  if (d.currency === 'KRW') return { krw: d.amount, fxRate: 1 };
  const fx = market.fxOn(d.pay_date);
  return fx ? { krw: d.amount * fx.rate, fxRate: fx.rate } : { krw: null, fxRate: null };
}

function dividendsByYear(userId, fromYear, toYear) {
  const list = db.all('SELECT * FROM dividends WHERE user_id = ? AND pay_date BETWEEN ? AND ?', [
    userId, `${fromYear}-01-01`, `${toYear}-12-31`,
  ]);
  const map = {};
  for (let y = fromYear; y <= toYear; y++) map[y] = { year: y, krw: 0, count: 0, missingFx: 0 };
  for (const d of list) {
    const y = Number(d.pay_date.slice(0, 4));
    const { krw } = dividendKrw(d);
    if (krw == null) map[y].missingFx++;
    else map[y].krw += krw;
    map[y].count++;
  }
  return Object.values(map);
}

// ---------------------------------------------------------------------------
// 연도별 자산 (2.4)
// 연도별 자산금액 = Σ (연말 수정 종가 × 그 해 말 보유 수량 × 해당 연도 말 환율)
// 그 해 말 보유 수량은 연도별 매수·매도 기록을 누적해 계산 (v0.5)
// ---------------------------------------------------------------------------
async function getYearly(userId, fromYear, toYear) {
  const thisYear = new Date().getFullYear();
  const allTrades = positions.tradesOf(userId);
  const holdings = positions.codesUpTo(userId, toYear).map((code) => ({ code }));

  let fx = null;
  try {
    fx = await market.getCurrentFx();
  } catch (_) { /* 올해 환율 없음 → 미국 종목 올해 '-' */ }

  // 종목 정보·과거 종가 보장 + 올해 계산용 현재가
  const prepared = await mapLimit(holdings, 5, async (h) => {
    try {
      const inst = await market.ensureInstrument(h.code);
      let quote = null;
      if (toYear >= thisYear) quote = await market.getQuote(h.code);
      return { h, inst: market.publicInstrument(inst), quote };
    } catch (e) {
      return { h, error: e.message };
    }
  });

  const years = [];
  for (let y = fromYear; y <= toYear; y++) {
    const ongoing = y === thisYear;
    const yearEnd = `${y}-12-31`;
    const fxEnd = ongoing ? (fx ? { rate: fx.rate, date: fx.time } : null) : market.fxOn(yearEnd);
    const held = positions.accumulateByCode(allTrades, y); // 그룹 합산
    const items = prepared.filter(({ h }) => held.has(h.code) && held.get(h.code).quantity > 1e-9).map(({ h, inst, quote, error }) => {
      const pos = held.get(h.code);
      const base = {
        code: h.code, name: inst ? inst.name : h.code, type: inst ? inst.type : null, currency: inst ? inst.currency : null,
        quantity: pos.quantity, tradedThisYear: pos.tradesInYear > 0,
      };
      if (error) return { ...base, excluded: true, reason: '시세 조회 실패' };
      let close = null;
      let closeDate = null;
      if (ongoing) {
        if (quote) {
          close = quote.price;
          closeDate = quote.priceTime;
        }
      } else {
        const c = market.yearEndClose(h.code, y);
        if (c) {
          close = c.close;
          closeDate = c.date;
        }
      }
      if (close == null) {
        const beforeListing = inst.listedDate && inst.listedDate > yearEnd;
        return { ...base, excluded: true, reason: beforeListing ? '상장 전' : '종가 데이터 없음' };
      }
      const rate = inst.currency === 'USD' ? (fxEnd ? fxEnd.rate : null) : 1;
      if (rate == null) return { ...base, close, closeDate, excluded: true, reason: '환율 데이터 없음' };
      return { ...base, close, closeDate, fxRate: rate, valueKrw: close * pos.quantity * rate, excluded: false };
    });
    const included = items.filter((i) => !i.excluded);
    years.push({
      year: y,
      ongoing,
      fxRate: fxEnd ? fxEnd.rate : null,
      valueKrw: included.length ? included.reduce((s, i) => s + i.valueKrw, 0) : null,
      excludedCount: items.length - included.length,
      items,
    });
  }

  // 전년 대비 (FR-YR-02)
  years.forEach((y, i) => {
    const prev = years[i - 1];
    if (prev && prev.valueKrw != null && y.valueKrw != null) {
      y.diffKrw = y.valueKrw - prev.valueKrw;
      y.diffPct = prev.valueKrw ? y.diffKrw / prev.valueKrw : null;
    } else {
      y.diffKrw = null;
      y.diffPct = null;
    }
  });

  const divs = dividendsByYear(userId, fromYear, toYear);
  years.forEach((y) => {
    const d = divs.find((x) => x.year === y.year);
    y.dividendKrw = d ? d.krw : 0;
    y.dividendCount = d ? d.count : 0;
  });

  return {
    fromYear,
    toYear,
    years,
    basis: {
      generatedAt: new Date().toISOString(),
      fxRate: fx ? fx.rate : null,
      fxTime: fx ? fx.time : null,
      note: '연도별로 입력한 연말 보유 수량 기준 금액입니다(입력하지 않은 연도는 직전 연도 수량이 이어짐). 연도 중 매매 시점의 가격 변동은 반영하지 않습니다.',
      formula: '연도별 자산금액 = Σ (연말 수정 종가 × 그 해 말 보유 수량 × 해당 연도 말 환율). 올해는 최신 시세와 현재 환율로 계산(진행 중).',
    },
  };
}

// ---------------------------------------------------------------------------
// 종목 배당 지급내역 팝업 (FR-STK-08)
// 연도별 주당 배당 합계·배당수익률, 배당락일별 주당 배당금, 보유 중이면 세전 추정액
// 배당수익률 = 연간 주당 배당 합계 ÷ 연말 종가 (올해는 현재가, 진행 중)
// ---------------------------------------------------------------------------
// 국내 ETF 주당과세표준액 출처 안내 (운용사별)
function etfTaxNote(name) {
  const base = '국내 ETF는 분배금 중 비과세 이익(국내 주식 매매차익 등)을 뺀 금액에 과세하며, 운용사가 공시한 회차별 값을 표시합니다. ';
  const n = String(name || '').trim();
  if (/^SOL\b/i.test(n)) return base + '출처: 신한자산운용 SOL ETF 홈페이지.';
  if (/^KODEX\b/i.test(n)) return base + '출처: FunETF (2022년 이후 회차만 제공). 값이 없는 회차는 ‘-’로 표시합니다.';
  if (/^TIGER\b/i.test(n)) {
    return base + '출처: 미래에셋자산운용 TIGER ETF 홈페이지. 홈페이지가 접속을 거절하는 환경(클라우드 서버 등)에서는 ‘-’로 표시합니다.';
  }
  return base + '이 운용사는 과세표준 출처가 연동되지 않아 ‘-’로 표시합니다(현재 연동: KODEX·SOL·TIGER).';
}

async function getStockDividends(userId, code, opts) {
  const d = await market.getDividendEvents(code, opts);
  const cur = d.instrument.currency;
  const usd = cur === 'USD';
  if (usd) {
    try { await market.getCurrentFx(); } catch (_) { /* 환율 없으면 원화 추정액 '-' */ }
  }
  const held = positions.totalsAt(userId, new Date().getFullYear()).find((p) => p.code === d.instrument.code);
  const qty = held ? held.quantity : null;
  const thisYear = new Date().getFullYear();

  // 주당과세표준액
  //  - 국내 주식·미국 종목: 배당금 전액이 배당소득 과세 대상이므로 주당 배당금과 같다.
  //  - 국내 ETF: 분배금 중 비과세 이익(국내 주식 매매차익 등)을 뺀 값이 회차별로 공시된다.
  //    FunETF 공시값을 쓰고, 값이 없는 회차는 '-'로 표시한다.
  const isKrEtf = cur === 'KRW' && d.instrument.type !== '주식';
  const taxBaseKnown = !isKrEtf;

  const events = d.events.map((e) => {
    const est = qty == null ? null : e.amount * qty;
    const fx = usd && est != null ? market.fxOn(e.exDate) : null;
    return {
      ...e,
      taxBase: taxBaseKnown ? e.amount : e.taxBase,
      estimate: est,
      estimateKrw: est == null ? null : usd ? (fx ? est * fx.rate : null) : est,
    };
  });

  const byYear = {};
  for (const e of events) {
    const y = Number(e.exDate.slice(0, 4));
    byYear[y] = byYear[y] || { year: y, perShare: 0, taxBase: 0, taxMissing: 0, count: 0, estimate: qty == null ? null : 0, estimateKrw: qty == null ? null : 0 };
    byYear[y].perShare += e.amount;
    if (e.taxBase == null) byYear[y].taxMissing++;
    else byYear[y].taxBase += e.taxBase;
    byYear[y].count++;
    if (qty != null) {
      byYear[y].estimate += e.estimate;
      byYear[y].estimateKrw = byYear[y].estimateKrw == null || e.estimateKrw == null ? null : byYear[y].estimateKrw + e.estimateKrw;
    }
  }
  const years = Object.values(byYear).sort((a, b) => b.year - a.year).map((y) => {
    const ongoing = y.year === thisYear;
    const ref = ongoing ? (d.lastPrice != null ? { close: d.lastPrice } : null) : market.yearEndClose(d.instrument.code, y.year);
    return {
      ...y,
      // 한 회차라도 과세표준이 없으면 연도 합계는 '-' (부분 합계로 오해하지 않도록)
      taxBase: y.taxMissing ? null : y.taxBase,
      ongoing,
      refClose: ref ? ref.close : null,
      yieldPct: ref && ref.close ? y.perShare / ref.close : null,
    };
  });

  return {
    instrument: d.instrument,
    quantity: qty,
    isKrEtf,
    taxBaseKnown,
    taxCount: events.filter((e) => e.taxBase != null).length,
    taxSource: isKrEtf ? (events.find((e) => e.taxBase != null && e.taxSource) || {}).taxSource || null : null,
    taxError: d.taxError,
    hasPayDate: events.some((e) => e.payDate),
    taxBaseNote: taxBaseKnown
      ? '배당금 전액이 배당소득 과세 대상이므로 주당 배당금과 같습니다.'
      : etfTaxNote(d.instrument.name),
    events: events.slice().reverse(),
    years,
    loadedAt: d.loadedAt,
    source: d.source,
    stale: d.stale,
    staleReason: d.staleReason,
    neverLoaded: d.neverLoaded,
  };
}

module.exports = { getStockDividends, getAssets, getYearly, dividendsByYear, dividendKrw, mapLimit };
