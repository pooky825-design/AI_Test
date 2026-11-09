// 주 출처: 야후 파이낸스 chart API
// 주의: 비공식 API이며 이용약관 확인 전 단계(요구사항 정의서 7장 미결 사항)
const { fetchRaw } = require('./http');
const { NotFoundError, SourceError } = require('./errors');

const NAME = 'Yahoo Finance';
const HOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];

const EXCHANGES = {
  KSC: 'KOSPI', KOE: 'KOSDAQ',
  NMS: 'NASDAQ', NGM: 'NASDAQ', NCM: 'NASDAQ', NAS: 'NASDAQ',
  NYQ: 'NYSE', NYS: 'NYSE',
  PCX: 'NYSE Arca', ARCA: 'NYSE Arca',
  ASE: 'NYSE American', AMEX: 'NYSE American',
  BTS: 'Cboe', BATS: 'Cboe', CBO: 'Cboe', CXE: 'Cboe',
};

function localDate(ts, gmtoffset) {
  return new Date((ts + (gmtoffset || 0)) * 1000).toISOString().slice(0, 10);
}

async function fetchChart(symbol, range, withSplits, extra = '', interval = '1d') {
  const qs = `range=${range}&interval=${interval}${withSplits ? '&events=split' : ''}${extra}`;
  let lastErr;
  for (const host of HOSTS) {
    try {
      const res = await fetchRaw(`${host}/v8/finance/chart/${encodeURIComponent(symbol)}?${qs}`);
      let body = null;
      try { body = await res.json(); } catch (_) { /* ignore */ }
      const err = body && body.chart && body.chart.error;
      if (res.status === 404 || (err && err.code === 'Not Found')) throw new NotFoundError();
      if (!res.ok || !body || !body.chart || !body.chart.result) {
        throw new SourceError(`야후 파이낸스 응답 오류 (HTTP ${res.status})`);
      }
      return body.chart.result[0];
    } catch (e) {
      if (e instanceof NotFoundError) throw e;
      lastErr = e;
    }
  }
  throw lastErr || new SourceError();
}

function parse(result) {
  const m = result.meta;
  const off = m.gmtoffset || 0;
  const ts = result.timestamp || [];
  const closes = (result.indicators && result.indicators.quote && result.indicators.quote[0].close) || [];
  const rows = [];
  ts.forEach((t, i) => {
    // chart API의 close는 액면분할·병합이 반영되고 배당은 반영되지 않은 값(= 정의서의 수정 종가)
    if (closes[i] != null) rows.push({ date: localDate(t, off), close: closes[i] });
  });
  const splits = Object.values((result.events && result.events.splits) || {}).map((s) => ({
    date: localDate(s.date, off),
    ratio: s.splitRatio || `${s.numerator}:${s.denominator}`,
  }));
  return { meta: m, rows, splits };
}

function toInfo(code, symbol, meta) {
  const market = EXCHANGES[meta.exchangeName];
  const name = meta.longName || meta.shortName || code;
  let type = { EQUITY: '주식', ETF: 'ETF' }[meta.instrumentType] || null;
  if (type && /\bETN\b/i.test(name)) type = 'ETN';
  if (!market || !type) return null; // 지원하지 않는 시장·상품
  return {
    symbol,
    name,
    market,
    type,
    currency: meta.currency,
    listedDate: meta.firstTradeDate ? localDate(meta.firstTradeDate, meta.gmtoffset) : null,
    timezone: meta.exchangeTimezoneName,
  };
}

/**
 * 종목 시세 로드
 * @param {string} code  국내 6자리 또는 미국 티커
 * @param {'KR'|'US'} kind
 * @param {'10y'|'5d'} range
 * @param {string} [symbol] 이미 알고 있는 출처 심볼
 */
async function load(code, kind, range, symbol) {
  const candidates = symbol
    ? [symbol]
    : kind === 'KR'
      ? [`${code}.KS`, `${code}.KQ`]
      : [code.replace('.', '-')];
  for (const sym of candidates) {
    let parsed;
    try {
      parsed = parse(await fetchChart(sym, range, true));
    } catch (e) {
      if (e instanceof NotFoundError) continue;
      throw e;
    }
    const info = toInfo(code, sym, parsed.meta);
    if (!info) continue; // 예: KOSDAQ 종목을 .KS로 조회하면 MUTUALFUND로 나오는 경우
    return {
      source: NAME,
      info,
      price: parsed.meta.regularMarketPrice,
      priceTime: new Date(parsed.meta.regularMarketTime * 1000).toISOString(),
      rows: parsed.rows,
      splits: parsed.splits,
    };
  }
  throw new NotFoundError();
}

async function loadFx(range) {
  const parsed = parse(await fetchChart('KRW=X', range, false));
  return {
    source: NAME,
    rate: parsed.meta.regularMarketPrice,
    rateTime: new Date(parsed.meta.regularMarketTime * 1000).toISOString(),
    rows: parsed.rows,
  };
}

/**
 * 배당 지급내역 (FR-STK-08): 최근 10년 배당락일·주당 배당금
 * 야후는 배당락일만 제공하며 실제 지급일은 제공하지 않음(정의서 7.1 미결 사항)
 */
async function loadDividends(symbol) {
  // 배당 이벤트만 필요하므로 월봉으로 받아 응답 크기를 줄임
  const result = await fetchChart(symbol, '10y', false, '&events=div', '1mo');
  const off = result.meta.gmtoffset || 0;
  return {
    source: NAME,
    events: Object.values((result.events && result.events.dividends) || {})
      .map((d) => ({ exDate: localDate(d.date, off), amount: d.amount }))
      .sort((a, b) => (a.exDate < b.exDate ? -1 : 1)),
  };
}

module.exports = { NAME, load, loadFx, loadDividends };
