// 홈 대시보드 (v0.28.0): 주요 지수·금리·환율·유가와 내 자산의 오늘 손익을 전일 대비로 보여 준다
const db = require('../db');
const providers = require('../providers');
const portfolio = require('./portfolio');

const GROUPS = [
  { id: 'domestic', label: '국내' },
  { id: 'us', label: '미국' },
  { id: 'etc', label: '기타' },
  { id: 'mine', label: '나의 자산' },
];
// kind: index(지수) · rate(금리 %) · fx(원) · oil(달러) · mine(내 자산)
const ITEMS = [
  { id: 'kospi', group: 'domestic', label: '코스피', symbol: '^KS11', kind: 'index' },
  { id: 'kosdaq', group: 'domestic', label: '코스닥', symbol: '^KQ11', kind: 'index' },
  { id: 'sp500', group: 'us', label: 'S&P 500', symbol: '^GSPC', kind: 'index' },
  { id: 'nasdaq', group: 'us', label: '나스닥', symbol: '^IXIC', kind: 'index' },
  { id: 'us10y', group: 'us', label: '미국채 10년물 금리', symbol: '^TNX', kind: 'rate' },
  { id: 'us30y', group: 'us', label: '미국채 30년물 금리', symbol: '^TYX', kind: 'rate' },
  { id: 'usdkrw', group: 'etc', label: '원/달러 환율', symbol: 'KRW=X', kind: 'fx' },
  { id: 'wti', group: 'etc', label: 'WTI 유가', symbol: 'CL=F', kind: 'oil' },
  { id: 'mytoday', group: 'mine', label: '오늘 수익 증감', kind: 'mine' },
];
const IDS = ITEMS.map((x) => x.id);

// 설정(dash.items): 보여 줄 항목 id 목록. 없으면 전부
function enabledIds(uid) {
  const r = db.get("SELECT value FROM user_settings WHERE user_id = ? AND key = 'dash.items'", [uid]);
  if (!r) return IDS.slice();
  try {
    const v = JSON.parse(r.value);
    if (Array.isArray(v)) return IDS.filter((id) => v.includes(id));
  } catch (_) { /* 기본값 */ }
  return IDS.slice();
}

// 시세: 3분 동안 다시 쓰기 (전 회원 공통)
const TTL = 3 * 60 * 1000;
const cache = new Map();
async function quote(symbol) {
  const c = cache.get(symbol);
  if (c && Date.now() - c.at < TTL) return c.v;
  if (!providers.quoteChart) throw new Error('샘플 모드에서는 시장 지표를 제공하지 않습니다.');
  const r = await providers.quoteChart(symbol, '1d');
  const m = r.meta || {};
  const value = Number(m.regularMarketPrice);
  const prev = Number(m.chartPreviousClose ?? m.previousClose);
  if (!Number.isFinite(value)) throw new Error('시세가 없습니다.');
  const ok = Number.isFinite(prev) && prev !== 0;
  const v = {
    value, prev: ok ? prev : null, change: ok ? value - prev : null, pct: ok ? (value - prev) / prev : null,
    time: m.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString() : null, currency: m.currency || null,
  };
  cache.set(symbol, { at: Date.now(), v });
  return v;
}

async function itemData(uid, it) {
  try {
    if (it.kind === 'mine') {
      const ty = new Date().getFullYear();
      const a = await portfolio.getAssets(uid, ty, null, false);
      const t = a.total || {};
      return { value: t.todayPnlKrw ?? null, pct: t.todayPct ?? null, change: t.todayPnlKrw ?? null, total: t.valueKrw ?? null, time: (a.basis && a.basis.priceTimeOldest) || null, empty: !a.rows || !a.rows.length };
    }
    return await quote(it.symbol);
  } catch (e) {
    return { error: e.message || '가져오지 못했습니다.' };
  }
}

async function getDashboard(uid) {
  const ids = enabledIds(uid);
  const items = ITEMS.filter((x) => ids.includes(x.id));
  const data = await portfolio.mapLimit(items, 5, (it) => itemData(uid, it));
  return {
    groups: GROUPS,
    items: items.map((it, i) => ({ id: it.id, group: it.group, label: it.label, kind: it.kind, symbol: it.symbol || null, ...data[i] })),
    enabled: ids,
    at: new Date().toISOString(),
    source: 'Yahoo Finance',
  };
}

module.exports = { GROUPS, ITEMS, IDS, getDashboard };
