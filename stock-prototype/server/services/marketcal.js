// 증시 개장·휴장 달력 (v0.30.8)
//  - 지난 날짜: 실제 거래 기록(야후 일별 시세)이 있으면 개장, 평일인데 없으면 휴장
//  - 오늘 이후: 미국은 규칙으로 계산한 NYSE·NASDAQ 휴장일(조기 폐장 포함), 한국은 KRX 휴장일표(2025~2027)
//  휴장일표는 거래소 공지(임시공휴일 등)로 바뀔 수 있으므로 앞날은 '예정'으로 표시한다
const providers = require('../providers');

const pad = (n) => String(n).padStart(2, '0');
const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const dow = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 일 ~ 6 토

// ---------- 미국 (NYSE·NASDAQ) ----------
function nthWeekday(y, m, wd, n) { // n번째 wd 요일 (n=-1 이면 마지막)
  if (n > 0) { const first = dow(y, m, 1); return 1 + ((wd - first + 7) % 7) + (n - 1) * 7; }
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return last - ((dow(y, m, last) - wd + 7) % 7);
}
function easter(y) { // 그레고리력 부활절 (익명 알고리즘)
  const a = y % 19; const b = Math.floor(y / 100); const c = y % 100; const d = Math.floor(b / 4); const e = b % 4;
  const f = Math.floor((b + 8) / 25); const g = Math.floor((b - f + 1) / 3); const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4); const k = c % 4; const l = (32 + 2 * e + 2 * i - h - k) % 7; const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); const day = ((h + l - 7 * m + 114) % 31) + 1;
  return [month, day];
}
function observed(y, m, d) { // 토요일이면 금요일, 일요일이면 월요일에 쉰다
  const w = dow(y, m, d);
  const t = new Date(Date.UTC(y, m - 1, d + (w === 6 ? -1 : w === 0 ? 1 : 0)));
  return ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}
function usHolidays(y) {
  const h = {};
  const add = (date, name) => { h[date] = { name }; };
  // 새해: 1/1 이 토요일이면 전년 12/31 에 쉬지 않음(NYSE 규칙)
  if (dow(y, 1, 1) !== 6) add(observed(y, 1, 1), '새해');
  add(ymd(y, 1, nthWeekday(y, 1, 1, 3)), '마틴 루서 킹 데이');
  add(ymd(y, 2, nthWeekday(y, 2, 1, 3)), '대통령의 날');
  const [em, ed] = easter(y);
  const gf = new Date(Date.UTC(y, em - 1, ed - 2));
  add(ymd(y, gf.getUTCMonth() + 1, gf.getUTCDate()), '성금요일');
  add(ymd(y, 5, nthWeekday(y, 5, 1, -1)), '메모리얼 데이');
  add(observed(y, 6, 19), '준틴스');
  add(observed(y, 7, 4), '독립기념일');
  add(ymd(y, 9, nthWeekday(y, 9, 1, 1)), '노동절');
  const tg = nthWeekday(y, 11, 4, 4);
  add(ymd(y, 11, tg), '추수감사절');
  add(observed(y, 12, 25), '성탄절');
  // 조기 폐장 (오후 1시, 한국 시간 새벽 3시·서머타임 2시)
  const early = {};
  early[ymd(y, 11, tg + 1)] = '추수감사절 다음 날 조기 폐장(13:00)';
  if (dow(y, 12, 24) >= 1 && dow(y, 12, 24) <= 5) early[ymd(y, 12, 24)] = '성탄 전날 조기 폐장(13:00)';
  if (dow(y, 7, 3) >= 1 && dow(y, 7, 3) <= 4) early[ymd(y, 7, 3)] = '독립기념일 전날 조기 폐장(13:00)';
  return { holidays: h, early };
}

// ---------- 한국 (KRX) ----------
// 주말이 아닌 휴장일만 적음. 음력 명절·대체공휴일·선거일·근로자의 날·연말 휴장 포함
const KRX = {
  2025: { '01-01': '새해', '01-27': '임시공휴일', '01-28': '설날 연휴', '01-29': '설날', '01-30': '설날 연휴', '03-03': '삼일절 대체공휴일', '05-01': '근로자의 날', '05-05': '어린이날·부처님오신날', '05-06': '대체공휴일', '06-03': '대통령 선거', '06-06': '현충일', '08-15': '광복절', '10-03': '개천절', '10-06': '추석 연휴', '10-07': '추석', '10-08': '추석 대체공휴일', '10-09': '한글날', '12-25': '성탄절', '12-31': '연말 휴장' },
  2026: { '01-01': '새해', '02-16': '설날 연휴', '02-17': '설날', '02-18': '설날 연휴', '03-02': '삼일절 대체공휴일', '05-01': '근로자의 날', '05-05': '어린이날', '05-25': '부처님오신날 대체공휴일', '06-03': '지방선거', '08-17': '광복절 대체공휴일', '09-24': '추석 연휴', '09-25': '추석', '10-05': '개천절 대체공휴일', '10-09': '한글날', '12-25': '성탄절', '12-31': '연말 휴장' },
  2027: { '01-01': '새해', '02-08': '설날 연휴', '02-09': '설날 대체공휴일', '03-01': '삼일절', '05-05': '어린이날', '05-13': '부처님오신날', '08-16': '광복절 대체공휴일', '09-14': '추석 연휴', '09-15': '추석', '09-16': '추석 연휴', '10-04': '개천절 대체공휴일', '10-11': '한글날 대체공휴일', '12-27': '성탄절 대체공휴일', '12-31': '연말 휴장' },
};
function krHolidays(y) {
  const t = KRX[y];
  const h = {};
  if (t) for (const [md, name] of Object.entries(t)) h[`${y}-${md}`] = { name };
  return { holidays: h, early: {}, known: !!t };
}

// 실제 거래일 (야후 일별 종가가 있는 날, 거래소 현지 날짜) — 6시간 캐시
const tradeCache = new Map();
async function tradedDays(symbol, tz) {
  const c = tradeCache.get(symbol);
  if (c && Date.now() - c.at < 6 * 3600 * 1000) return c.v;
  const r = await providers.quoteChart(symbol, '1y', false, '', '1d');
  const ts = r.timestamp || [];
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const v = new Set(ts.map((t) => fmt.format(new Date(t * 1000))));
  tradeCache.set(symbol, { at: Date.now(), v });
  return v;
}

const MK = {
  KR: { symbol: '^KS11', tz: 'Asia/Seoul', name: 'KRX', hol: krHolidays },
  US: { symbol: '^GSPC', tz: 'America/New_York', name: 'NYSE·NASDAQ', hol: usHolidays },
};

// month: 'YYYY-MM' (없으면 이번 달, 거래소 현지 기준)
async function getCalendar(market, month) {
  const M = MK[market];
  if (!M) return null;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: M.tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  let [y, m] = (/^\d{4}-\d{2}$/.test(String(month || '')) ? month : today.slice(0, 7)).split('-').map(Number);
  if (m < 1 || m > 12) [y, m] = today.slice(0, 7).split('-').map(Number);
  const { holidays, early, known } = M.hol(y);
  let traded = null;
  try { if (providers.quoteChart) traded = await tradedDays(M.symbol, M.tz); } catch (_) { traded = null; }
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const days = [];
  for (let d = 1; d <= last; d++) {
    const date = ymd(y, m, d);
    const w = dow(y, m, d);
    const hol = holidays[date];
    let status;
    let note = null;
    if (w === 0 || w === 6) status = 'weekend';
    else if (date < today && traded && traded.size) {
      // 지난 날: 실제 거래 기록 기준 (기록 범위보다 오래된 날은 휴장표)
      const oldest = [...traded].sort()[0];
      if (date >= oldest) { status = traded.has(date) ? 'open' : 'closed'; note = status === 'closed' ? (hol ? hol.name : '휴장') : early[date] || null; } else { status = hol ? 'closed' : 'open'; note = hol ? hol.name : early[date] || null; }
    } else {
      status = hol ? 'closed' : 'open';
      note = hol ? hol.name : early[date] || null;
    }
    if (status === 'open' && early[date]) status = 'early';
    days.push({ date, day: d, dow: w, status, note, today: date === today, future: date > today });
  }
  return {
    market, exchange: M.name, month: `${y}-${pad(m)}`, today, days,
    note: market === 'KR' && !known ? `${y}년 KRX 휴장일표가 없어 주말만 휴장으로 표시합니다.` : null,
  };
}

module.exports = { getCalendar, usHolidays, krHolidays };
