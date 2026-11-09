// 회원별 자산 계산 (요구사항 2.3, 2.4, 3.4, 3.5, 3.6)
// 금액은 내부적으로 반올림하지 않고 계산하며, 화면 표시 단계에서만 반올림한다(4.3).
const db = require('../db');
const market = require('./market');

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

function holdingsOf(userId) {
  return db.all('SELECT * FROM holdings WHERE user_id = ? ORDER BY created_at, id', [userId]);
}

// 보유 종목 등록·수정 이후 발생한 액면분할·병합 (FR-DATA-03: 수량 수정 안내)
function splitNotice(h) {
  // 보유 항목을 마지막으로 등록·수정한 날 이후에 효력이 생긴 분할·병합만 안내
  const s = db.get('SELECT split_date, ratio FROM splits WHERE code = ? AND split_date > ? ORDER BY split_date DESC LIMIT 1', [
    h.code, h.updated_at.slice(0, 10),
  ]);
  return s ? { date: s.split_date, ratio: s.ratio } : null;
}

// ---------------------------------------------------------------------------
// 자산 현황 (2.3)
// 원화 평가금액 = 현재가 × 보유 수량 × 현재 환율 (국내 종목은 환율 1)
// 수익률 = (현재가 − 평균 매입단가) ÷ 평균 매입단가
// ---------------------------------------------------------------------------
async function getAssets(userId) {
  const holdings = holdingsOf(userId);
  let fx = null;
  let fxError = null;
  try {
    fx = await market.getCurrentFx();
  } catch (e) {
    fxError = e.message;
  }

  const rows = await mapLimit(holdings, 5, async (h) => {
    try {
      const q = await market.getQuote(h.code);
      const usd = q.instrument.currency === 'USD';
      const rate = usd ? (fx ? fx.rate : null) : 1;
      const value = q.price * h.quantity; // 거래 통화 기준
      const cost = h.avg_price * h.quantity;
      return {
        id: h.id,
        code: h.code,
        instrument: q.instrument,
        quantity: h.quantity,
        avgPrice: h.avg_price,
        price: q.price,
        change: q.change,
        changePct: q.changePct,
        priceTime: q.priceTime,
        stale: q.stale,
        staleReason: q.staleReason,
        value,
        cost,
        fxRate: rate,
        valueKrw: rate == null ? null : value * rate,
        costKrw: rate == null ? null : cost * rate,
        pnlKrw: rate == null ? null : (value - cost) * rate,
        returnPct: (q.price - h.avg_price) / h.avg_price,
        splitNotice: splitNotice(h),
      };
    } catch (e) {
      return { id: h.id, code: h.code, quantity: h.quantity, avgPrice: h.avg_price, error: e.message };
    }
  });

  const ok = rows.filter((r) => r.valueKrw != null);
  const totalValue = ok.reduce((s, r) => s + r.valueKrw, 0);
  const totalCost = ok.reduce((s, r) => s + r.costKrw, 0);
  const priceTimes = ok.map((r) => r.priceTime).sort();
  return {
    rows,
    total: {
      valueKrw: totalValue,
      costKrw: totalCost,
      pnlKrw: totalValue - totalCost,
      returnPct: totalCost ? (totalValue - totalCost) / totalCost : null,
      excluded: rows.length - ok.length,
    },
    basis: {
      fxRate: fx ? fx.rate : null,
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
// 연도별 자산금액 = Σ (연말 수정 종가 × 현재 보유 수량 × 해당 연도 말 환율)
// ---------------------------------------------------------------------------
async function getYearly(userId, fromYear, toYear) {
  const thisYear = new Date().getFullYear();
  const holdings = holdingsOf(userId);

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
    const items = prepared.map(({ h, inst, quote, error }) => {
      const base = { code: h.code, name: inst ? inst.name : h.code, type: inst ? inst.type : null, currency: inst ? inst.currency : null, quantity: h.quantity };
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
      return { ...base, close, closeDate, fxRate: rate, valueKrw: close * h.quantity * rate, excluded: false };
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
      note: '현재 보유 수량 기준의 가정 금액이며 실제 과거 자산이 아닙니다.',
      formula: '연도별 자산금액 = Σ (연말 수정 종가 × 현재 보유 수량 × 해당 연도 말 환율). 올해는 최신 시세와 현재 환율로 계산(진행 중).',
    },
  };
}

// ---------------------------------------------------------------------------
// 종목 배당 지급내역 팝업 (FR-STK-08)
// 연도별 주당 배당 합계·배당수익률, 배당락일별 주당 배당금, 보유 중이면 세전 추정액
// 배당수익률 = 연간 주당 배당 합계 ÷ 연말 종가 (올해는 현재가, 진행 중)
// ---------------------------------------------------------------------------
async function getStockDividends(userId, code, opts) {
  const d = await market.getDividendEvents(code, opts);
  const cur = d.instrument.currency;
  const usd = cur === 'USD';
  if (usd) {
    try { await market.getCurrentFx(); } catch (_) { /* 환율 없으면 원화 추정액 '-' */ }
  }
  const h = db.get('SELECT quantity FROM holdings WHERE user_id = ? AND code = ?', [userId, d.instrument.code]);
  const qty = h ? h.quantity : null;
  const thisYear = new Date().getFullYear();

  const events = d.events.map((e) => {
    const est = qty == null ? null : e.amount * qty;
    const fx = usd && est != null ? market.fxOn(e.exDate) : null;
    return { ...e, estimate: est, estimateKrw: est == null ? null : usd ? (fx ? est * fx.rate : null) : est };
  });

  const byYear = {};
  for (const e of events) {
    const y = Number(e.exDate.slice(0, 4));
    byYear[y] = byYear[y] || { year: y, perShare: 0, count: 0, estimate: qty == null ? null : 0, estimateKrw: qty == null ? null : 0 };
    byYear[y].perShare += e.amount;
    byYear[y].count++;
    if (qty != null) {
      byYear[y].estimate += e.estimate;
      byYear[y].estimateKrw = byYear[y].estimateKrw == null || e.estimateKrw == null ? null : byYear[y].estimateKrw + e.estimateKrw;
    }
  }
  const years = Object.values(byYear).sort((a, b) => b.year - a.year).map((y) => {
    const ongoing = y.year === thisYear;
    const ref = ongoing ? (d.lastPrice != null ? { close: d.lastPrice } : null) : market.yearEndClose(d.instrument.code, y.year);
    return { ...y, ongoing, refClose: ref ? ref.close : null, yieldPct: ref && ref.close ? y.perShare / ref.close : null };
  });

  return {
    instrument: d.instrument,
    quantity: qty,
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
