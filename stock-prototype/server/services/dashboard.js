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
  { id: 'myyear', group: 'mine', label: '연간 수익 증감', kind: 'mine' }, // v0.28.1
  { id: 'mytotal', group: 'mine', label: '총 자산', kind: 'mine' }, // v0.28.1
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

// 표시 순서 (v0.28.1): dash.order = { groups: [그룹 id…], items: [항목 id…] }. 빠진 것은 기본 순서로 뒤에
function orderOf(uid) {
  const r = db.get("SELECT value FROM user_settings WHERE user_id = ? AND key = 'dash.order'", [uid]);
  let v = {};
  try { v = r ? JSON.parse(r.value) || {} : {}; } catch (_) { v = {}; }
  const pick = (saved, all) => [...(Array.isArray(saved) ? saved.filter((x) => all.includes(x)) : []), ...all.filter((x) => !(Array.isArray(saved) && saved.includes(x)))];
  return { groups: pick(v.groups, GROUPS.map((g) => g.id)), items: pick(v.items, IDS) };
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

async function itemData(uid, it, assetsOnce) {
  try {
    if (it.kind === 'mine') {
      const a = await assetsOnce();
      const t = a.total || {};
      const base = { total: t.valueKrw ?? null, time: (a.basis && a.basis.priceTimeOldest) || null, empty: !a.rows || !a.rows.length };
      if (it.id === 'myyear') return { ...base, value: t.pnlKrw ?? null, change: t.pnlKrw ?? null, pct: t.returnPct ?? null, basisKrw: t.costKrw ?? null }; // 손익 기준액(나의 자산 화면과 같음)
      if (it.id === 'mytotal') return { ...base, value: t.valueKrw ?? null, change: t.todayPnlKrw ?? null, pct: t.todayPct ?? null, costKrw: t.origCostKrw ?? null }; // 매입금액
      return { ...base, value: t.todayPnlKrw ?? null, pct: t.todayPct ?? null, change: t.todayPnlKrw ?? null };
    }
    return await quote(it.symbol);
  } catch (e) {
    return { error: e.message || '가져오지 못했습니다.' };
  }
}

async function getDashboard(uid) {
  const ids = enabledIds(uid);
  const ord = orderOf(uid);
  const items = ord.items.map((id) => ITEMS.find((x) => x.id === id)).filter((x) => ids.includes(x.id));
  // 나의 자산 항목이 여러 개여도 자산 계산은 한 번만
  let assetsP = null;
  const assetsOnce = () => (assetsP || (assetsP = portfolio.getAssets(uid, new Date().getFullYear(), null, false)));
  const data = await portfolio.mapLimit(items, 5, (it) => itemData(uid, it, assetsOnce));
  return {
    groups: ord.groups.map((id) => GROUPS.find((g) => g.id === id)),
    items: items.map((it, i) => ({ id: it.id, group: it.group, label: it.label, kind: it.kind, symbol: it.symbol || null, ...data[i] })),
    enabled: ids,
    at: new Date().toISOString(),
    source: 'Yahoo Finance',
  };
}

module.exports = { GROUPS, ITEMS, IDS, getDashboard, orderOf };
