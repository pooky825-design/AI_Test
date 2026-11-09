// 회원별 자산 계산 (요구사항 2.3, 2.4, 3.4, 3.5, 3.6)
// 금액은 내부적으로 반올림하지 않고 계산하며, 화면 표시 단계에서만 반올림한다(4.3).
const db = require('../db');
const market = require('./market');
const positions = require('./positions');

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
async function getAssets(userId, year) {
  const ty = thisYear();
  const y = Number(year) || ty;
  const ongoing = y >= ty;
  const yearEnd = `${y}-12-31`;
  const list = positions.positionsAt(userId, y);

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
    const base = { code: h.code, quantity: h.quantity, avgPrice: h.avgPrice, tradesInYear: h.tradesInYear };
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
      const cost = h.avgPrice * h.quantity;
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
        pnlKrw: rate == null ? null : (value - cost) * rate,
        returnPct: (price - h.avgPrice) / h.avgPrice,
        splitNotice: ongoing ? splitNotice(h) : null,
      };
    } catch (e) {
      return { ...base, error: e.message };
    }
  });

  const ok = rows.filter((r) => r.valueKrw != null);
  const totalValue = ok.reduce((s, r) => s + r.valueKrw, 0);
  const totalCost = ok.reduce((s, r) => s + r.costKrw, 0);
  const priceTimes = ok.map((r) => r.priceTime).sort();
  const range = positions.tradeYearRange(userId);
  return {
    year: y,
    ongoing,
    yearRange: { min: Math.min(range.min || ty, ty - 9), max: ty },
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
    const held = positions.accumulate(allTrades, y);
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
      note: '연도별 매수·매도 기록을 누적한 연말 보유 수량 기준 금액입니다. 연도 중 매매 시점의 가격 변동은 반영하지 않습니다.',
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
  const held = positions.positionsAt(userId, new Date().getFullYear()).find((p) => p.code === d.instrument.code);
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
