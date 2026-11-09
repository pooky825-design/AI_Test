// 오프라인 시연용 샘플 출처 (DATA_PROVIDER=sample 로 실행 시 사용)
// 출처 연동부만 바꿔 끼우면 나머지 기능은 그대로 동작함을 보여주는 용도(FR-DATA-07)
// 값은 모두 가상이며 실제 시세가 아님
const { NotFoundError } = require('./errors');

const NAME = 'Sample (가상 데이터)';
const LIST = {
  '005930': { name: '삼성전자', market: 'KOSPI', type: '주식', currency: 'KRW', base: 50000, listed: '1975-06-11' },
  '000660': { name: 'SK하이닉스', market: 'KOSPI', type: '주식', currency: 'KRW', base: 80000, listed: '1996-12-26' },
  '247540': { name: '에코프로비엠', market: 'KOSDAQ', type: '주식', currency: 'KRW', base: 60000, listed: '2019-03-05' },
  '069500': { name: 'KODEX 200', market: 'KOSPI', type: 'ETF', currency: 'KRW', base: 28000, listed: '2002-10-14' },
  '0080G0': { name: 'KODEX 방산TOP10', market: 'KOSPI', type: 'ETF', currency: 'KRW', base: 5000, listed: '2025-07-15' },
  '530036': { name: '삼성 인버스 2X WTI원유 선물 ETN', market: 'KOSPI', type: 'ETN', currency: 'KRW', base: 3000, listed: '2017-09-20' },
  AAPL: { name: 'Apple Inc.', market: 'NASDAQ', type: '주식', currency: 'USD', base: 25, listed: '1980-12-12' },
  MSFT: { name: 'Microsoft Corporation', market: 'NASDAQ', type: '주식', currency: 'USD', base: 45, listed: '1986-03-13' },
  KO: { name: 'The Coca-Cola Company', market: 'NYSE', type: '주식', currency: 'USD', base: 40, listed: '1962-01-02' },
  SPY: { name: 'SPDR S&P 500 ETF Trust', market: 'NYSE Arca', type: 'ETF', currency: 'USD', base: 200, listed: '1993-01-29' },
};

function rng(seed) {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

function series(seed, base, startDate, drift) {
  const r = rng(seed);
  const rows = [];
  const d = new Date(startDate + 'T00:00:00Z');
  const end = new Date();
  let p = base;
  while (d <= end) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) {
      p = p * (1 + drift + (r() - 0.5) * 0.03);
      rows.push({ date: d.toISOString().slice(0, 10), close: Math.max(p, 1) });
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return rows;
}

function tenYearsAgo() {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - 10);
  return d.toISOString().slice(0, 10);
}

async function load(code) {
  const s = LIST[code];
  if (!s) throw new NotFoundError();
  const start = s.listed > tenYearsAgo() ? s.listed : tenYearsAgo();
  let rows = series(code, s.base, start, 0.0004);
  if (s.currency === 'KRW') rows = rows.map((x) => ({ ...x, close: Math.round(x.close / 5) * 5 }));
  const last = rows[rows.length - 1];
  return {
    source: NAME,
    info: { symbol: code, name: s.name, market: s.market, type: s.type, currency: s.currency, listedDate: s.listed,
      timezone: s.currency === 'KRW' ? 'Asia/Seoul' : 'America/New_York' },
    price: last.close,
    priceTime: new Date().toISOString(),
    rows,
    splits: [],
  };
}

async function loadFx() {
  const rows = series('USDKRW', 1150, tenYearsAgo(), 0.00006);
  return { source: NAME, rate: rows[rows.length - 1].close, rateTime: new Date().toISOString(), rows };
}

module.exports = { NAME, load, loadFx };
