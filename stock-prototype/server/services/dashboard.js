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
  { id: 'krmarket', group: 'etc', label: '한국 증시', symbol: '^KS11', kind: 'market', market: 'KR' }, // v0.28.2 개장·휴장
  { id: 'usmarket', group: 'etc', label: '미국 증시', symbol: '^GSPC', kind: 'market', market: 'US' },
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
  const reg = m.currentTradingPeriod && m.currentTradingPeriod.regular;
  const v = {
    value, prev: ok ? prev : null, change: ok ? value - prev : null, pct: ok ? (value - prev) / prev : null,
    time: m.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString() : null, currency: m.currency || null,
    periodStart: reg && reg.start ? reg.start * 1000 : null, // 거래소가 알려 주는 현재(또는 다음) 정규장 시작
  };
  cache.set(symbol, { at: Date.now(), v });
  return v;
}

// 개장 상태 (v0.28.2): 정규장 시간은 거래소 공식 시간, 휴장 여부는 야후 시세(오늘 거래가 있었는지·다음 정규장 날짜)로 판단
//  한국 KRX 09:00~15:30 (Asia/Seoul) · 미국 NYSE·NASDAQ 09:30~16:00 (America/New_York, 서머타임 자동)
const MARKETS = {
  KR: { tz: 'Asia/Seoul', open: [9, 0], close: [15, 30], name: 'KRX' },
  US: { tz: 'America/New_York', open: [9, 30], close: [16, 0], name: 'NYSE·NASDAQ' },
};
const partsIn = (ms, tz) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, mins: Number(p.hour) * 60 + Number(p.minute), wd: p.weekday };
};
// 거래소 현지 날짜·시각 → UTC ms (그날의 시간대 오프셋 적용)
function localToUtc(date, h, mi, tz) {
  const guess = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), h, mi);
  const p = partsIn(guess, tz);
  const shown = Date.UTC(Number(p.date.slice(0, 4)), Number(p.date.slice(5, 7)) - 1, Number(p.date.slice(8, 10))) + p.mins * 60000;
  return guess - (shown - guess);
}
const hhmm = (ms, tz) => { const p = partsIn(ms, tz); return `${String(Math.floor(p.mins / 60)).padStart(2, '0')}:${String(p.mins % 60).padStart(2, '0')}`; };
function marketStatus(q, mk) {
  const M = MARKETS[mk];
  const now = Date.now();
  const t = partsIn(now, M.tz);
  const openMs = localToUtc(t.date, M.open[0], M.open[1], M.tz);
  const closeMs = localToUtc(t.date, M.close[0], M.close[1], M.tz);
  const hours = { local: `${hhmm(openMs, M.tz)}~${hhmm(closeMs, M.tz)}`, kst: `${hhmm(openMs, 'Asia/Seoul')}~${hhmm(closeMs, 'Asia/Seoul')}` };
  if (t.wd === 'Sat' || t.wd === 'Sun') return { status: 'closed', reason: 'weekend', hours, exchange: M.name };
  const tradedToday = q.time && partsIn(Date.parse(q.time), M.tz).date === t.date;
  const nextIsToday = q.periodStart && partsIn(q.periodStart, M.tz).date === t.date;
  if (!tradedToday && !nextIsToday && !(now >= openMs && now < openMs + 20 * 60000)) return { status: 'closed', reason: 'holiday', hours, exchange: M.name };
  if (now < openMs) return { status: 'pre', hours, exchange: M.name, opensAt: new Date(openMs).toISOString() };
  if (now < closeMs) return { status: 'open', hours, exchange: M.name, closesAt: new Date(closeMs).toISOString() };
  return { status: 'after', hours, exchange: M.name };
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
    if (it.kind === 'market') return marketStatus(await quote(it.symbol), it.market);
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

module.exports = { GROUPS, ITEMS, IDS, getDashboard, orderOf, marketStatus };
