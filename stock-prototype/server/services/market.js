// 시세·환율 수집과 저장 (요구사항 3.9)
// 종목·종가·환율은 전 회원 공통 데이터로 저장하고(2.2), 회원별 계산은 portfolio.js에서 한다.
const db = require('../db');
const providers = require('../providers');
const { NotFoundError, SourceError } = require('../providers/errors');

const QUOTE_TTL_MS = 5 * 60 * 1000; // FR-DATA-05 현재가 캐시 5분 (제안값)
const DIVIDEND_TTL_MS = 24 * 60 * 60 * 1000; // FR-DATA-09 배당 지급내역 재사용 1일 (제안값)
const HISTORY_YEARS = 10; // FR-DATA-02 과거 종가 10년 (제안값)
const FX = 'USD/KRW';

const nowIso = () => new Date().toISOString();

class ValidationError extends Error {
  constructor(message, fields) {
    super(message);
    this.code = 'VALIDATION';
    this.fields = fields;
  }
}

// ---------------------------------------------------------------------------
// 종목코드 (FR-STK-02, 4.2)
// ---------------------------------------------------------------------------
function normalizeCode(raw) {
  return String(raw || '').trim().toUpperCase().replace('-', '.');
}

/** 국내: 숫자로 시작하는 6자리(영문 포함 허용, 예 0080G0) / 미국: 영문 티커 */
function detectKind(code) {
  if (/^[0-9][0-9A-Z]{5}$/.test(code)) return 'KR';
  if (/^[A-Z]{1,5}(\.[A-Z]{1,2})?$/.test(code)) return 'US';
  return null;
}

function validateCode(raw) {
  const code = normalizeCode(raw);
  if (!code) throw new ValidationError('종목코드를 입력해 주세요.', { code: '종목코드를 입력해 주세요.' });
  const kind = detectKind(code);
  if (!kind) {
    const msg = '종목코드 형식이 올바르지 않습니다. 국내는 6자리 코드(예: 005930, 0080G0), 미국은 영문 티커(예: AAPL)를 입력하세요.';
    throw new ValidationError(msg, { code: msg });
  }
  return { code, kind };
}

// ---------------------------------------------------------------------------
// 날짜 도우미
// ---------------------------------------------------------------------------
function dateInTz(date, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
function hourInTz(date, timeZone) {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(date));
}
function weekdayInTz(date, timeZone) {
  return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(date);
}
function yearsAgo(n) {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - n);
  return d.toISOString().slice(0, 10);
}

// 과거 종가가 기대치의 절반도 안 되면 '거의 받지 못한 종목'으로 판단 (FR-DATA-08)
function isSparse(rows, listedDate) {
  const from = listedDate && listedDate > yearsAgo(HISTORY_YEARS) ? listedDate : yearsAgo(HISTORY_YEARS);
  const days = (Date.now() - new Date(from).getTime()) / 86400000;
  const expected = (days * 245) / 365;
  return expected > 20 && rows.length < expected * 0.5;
}

// ---------------------------------------------------------------------------
// 저장
// ---------------------------------------------------------------------------
function saveRows(code, rows, source) {
  const at = nowIso();
  const cutoff = yearsAgo(HISTORY_YEARS + 1);
  db.runMany(
    `INSERT INTO daily_prices (code, trade_date, close, source, collected_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(code, trade_date) DO UPDATE SET close = excluded.close, source = excluded.source, collected_at = excluded.collected_at`,
    rows.filter((r) => r.date >= cutoff).map((r) => [code, r.date, r.close, source, at])
  );
}

function saveSplits(code, splits) {
  const added = [];
  for (const s of splits) {
    const exists = db.get('SELECT 1 FROM splits WHERE code = ? AND split_date = ?', [code, s.date]);
    if (!exists) {
      db.run('INSERT INTO splits (code, split_date, ratio, detected_at) VALUES (?, ?, ?, ?)', [code, s.date, s.ratio, nowIso()]);
      added.push(s);
    }
  }
  return added;
}

// ---------------------------------------------------------------------------
// 종목 최초 적재 (FR-DATA-02, FR-DATA-08)
// ---------------------------------------------------------------------------
const inflight = new Map();

async function fetchFull(code, kind) {
  const { primary, backup } = providers;
  let res = null;
  let err = null;
  try {
    res = await primary.load(code, kind, '10y');
  } catch (e) {
    err = e;
  }

  let historyRows = res && res.rows;
  let historySource = res && res.source;

  // 주 출처에 없거나 과거 종가가 부족하면 예비 출처 사용
  if (backup && kind === 'KR' && (!res || isSparse(res.rows, res.info.listedDate))) {
    try {
      const b = await backup.load(code, kind, '10y');
      if (!res) {
        res = b;
        historyRows = b.rows;
        historySource = b.source;
      } else if (b.rows.length > res.rows.length) {
        historyRows = b.rows;
        historySource = b.source;
      }
    } catch (e) {
      if (!err || (err instanceof NotFoundError && e instanceof SourceError)) err = e;
    }
  }
  if (!res) throw err || new NotFoundError();

  // 국내 종목은 한글 종목명으로 보완
  if (kind === 'KR' && res.source !== (backup && backup.NAME)) {
    const ko = await providers.koreanName(code);
    if (ko) res.info.name = ko;
  }
  return { res, historyRows, historySource };
}

async function loadInstrument(code, kind) {
  const { res, historyRows, historySource } = await fetchFull(code, kind);
  const i = res.info;
  if (kind === 'US' && i.type === 'ETN') i.type = 'ETF'; // 미국은 주식·ETF 범위
  db.tx(() => {
    db.run(
      `INSERT INTO instruments (code, provider_symbol, name, market, type, currency, listed_date, timezone,
         price_source, history_source, history_loaded_at, last_price, price_time, price_fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(code) DO UPDATE SET provider_symbol = excluded.provider_symbol, name = excluded.name,
         market = excluded.market, type = excluded.type, currency = excluded.currency, listed_date = excluded.listed_date,
         timezone = excluded.timezone, price_source = excluded.price_source, history_source = excluded.history_source,
         history_loaded_at = excluded.history_loaded_at, last_price = excluded.last_price,
         price_time = excluded.price_time, price_fetched_at = excluded.price_fetched_at`,
      [code, i.symbol, i.name, i.market, i.type, i.currency, i.listedDate, i.timezone, res.source, historySource, nowIso(),
        res.price, res.priceTime, nowIso()]
    );
    db.run('DELETE FROM daily_prices WHERE code = ?', [code]);
    saveRows(code, historyRows, historySource);
    for (const s of res.splits) {
      db.run('INSERT OR IGNORE INTO splits (code, split_date, ratio, detected_at) VALUES (?, ?, ?, ?)', [code, s.date, s.ratio, nowIso()]);
    }
  });
  return getInstrumentRow(code);
}

function getInstrumentRow(code) {
  return db.get('SELECT * FROM instruments WHERE code = ?', [code]);
}

/** 종목 정보를 보장 (없으면 최초 적재). 오류: ValidationError / NotFoundError / SourceError */
async function ensureInstrument(rawCode) {
  const { code, kind } = validateCode(rawCode);
  const row = getInstrumentRow(code);
  if (row && row.history_loaded_at) return row;
  if (!inflight.has(code)) {
    inflight.set(code, loadInstrument(code, kind).finally(() => inflight.delete(code)));
  }
  return inflight.get(code);
}

// ---------------------------------------------------------------------------
// 현재가 (FR-STK-03, FR-DATA-05, FR-DATA-06, FR-DATA-03)
// ---------------------------------------------------------------------------
function providerFor(inst) {
  const { primary, backup } = providers;
  if (backup && inst.price_source === backup.NAME) return backup;
  return primary;
}

async function refreshQuote(inst) {
  const kind = detectKind(inst.code);
  const p = providerFor(inst);
  const r = await p.load(inst.code, kind, '5d', p === providers.primary ? inst.provider_symbol : undefined);
  let splitDetected = false;
  db.tx(() => {
    saveRows(inst.code, r.rows, r.source);
    const added = saveSplits(inst.code, r.splits);
    splitDetected = added.length > 0;
    db.run('UPDATE instruments SET last_price = ?, price_time = ?, price_fetched_at = ? WHERE code = ?', [
      r.price, r.priceTime, nowIso(), inst.code,
    ]);
  });
  // 액면분할·병합 발생 → 과거 종가 재수집 (회원 보유 수량은 변경하지 않음)
  if (splitDetected) {
    try {
      await loadInstrument(inst.code, kind);
    } catch (e) {
      console.warn(`[split] ${inst.code} 과거 종가 재수집 실패:`, e.message);
    }
  }
}

const quoteInflight = new Map();

async function getQuote(rawCode, { force = false } = {}) {
  const inst = await ensureInstrument(rawCode);
  let stale = false;
  let staleReason = null;
  const fresh = inst.price_fetched_at && Date.now() - new Date(inst.price_fetched_at).getTime() < QUOTE_TTL_MS;
  if (force || !fresh) {
    try {
      if (!quoteInflight.has(inst.code)) {
        quoteInflight.set(inst.code, refreshQuote(inst).finally(() => quoteInflight.delete(inst.code)));
      }
      await quoteInflight.get(inst.code);
    } catch (e) {
      stale = true;
      staleReason = e.message;
    }
  }
  const cur = getInstrumentRow(inst.code);
  if (cur.last_price == null) throw new SourceError();
  const priceDate = dateInTz(new Date(cur.price_time), cur.timezone);
  const prev = db.get('SELECT close, trade_date FROM daily_prices WHERE code = ? AND trade_date < ? ORDER BY trade_date DESC LIMIT 1', [
    cur.code, priceDate,
  ]);
  const change = prev ? cur.last_price - prev.close : null;
  return {
    instrument: publicInstrument(cur),
    price: cur.last_price,
    prevClose: prev ? prev.close : null,
    change,
    changePct: prev ? change / prev.close : null,
    priceTime: cur.price_time,
    source: cur.price_source,
    stale,
    staleReason,
  };
}

function publicInstrument(r) {
  return {
    code: r.code,
    name: r.name,
    market: r.market,
    type: r.type,
    currency: r.currency,
    listedDate: r.listed_date,
    priceSource: r.price_source,
    historySource: r.history_source,
  };
}

// ---------------------------------------------------------------------------
// 날짜별 종가 (FR-STK-04)
// ---------------------------------------------------------------------------
async function getPrices(rawCode, from, to) {
  const inst = await ensureInstrument(rawCode);
  return db.all('SELECT trade_date AS date, close, source FROM daily_prices WHERE code = ? AND trade_date BETWEEN ? AND ? ORDER BY trade_date', [
    inst.code, from, to,
  ]);
}

/**
 * 기간 종가 + 기간 수익률 (FR-STK-07)
 * 시작일 직전 거래일 종가 대비 기간 마지막 종가. 직전 종가가 없으면 기간 첫 종가 기준.
 * 배당과 환율 변동은 포함하지 않는다.
 */
async function getPeriod(rawCode, from, to) {
  const prices = await getPrices(rawCode, from, to);
  const code = normalizeCode(rawCode);
  let base = null;
  const prev = db.get('SELECT trade_date AS date, close FROM daily_prices WHERE code = ? AND trade_date < ? ORDER BY trade_date DESC LIMIT 1', [code, from]);
  if (prev) base = { ...prev, kind: 'prev' };
  else if (prices.length) base = { date: prices[0].date, close: prices[0].close, kind: 'first' };
  const end = prices.length ? prices[prices.length - 1] : null;
  const returnPct = base && end && base.close ? (end.close - base.close) / base.close : null;
  return { prices, base, end: end && { date: end.date, close: end.close }, returnPct };
}

// ---------------------------------------------------------------------------
// 배당 지급내역 (FR-STK-08, FR-DATA-09): 공통 데이터로 저장하고 1일 동안 재사용
// ---------------------------------------------------------------------------
const divInflight = new Map();

async function refreshDividends(inst) {
  const { primary, backup } = providers;
  let r;
  if (backup && inst.price_source === backup.NAME) {
    // 예비 출처(네이버 차트)는 배당 정보를 주지 않음 → 빈 내역으로 기록
    r = { source: backup.NAME, events: [] };
  } else {
    r = await primary.loadDividends(inst.provider_symbol);
  }

  // 국내 ETF: FunETF에서 회차별 주당과세표준액·실지급일을 받아 배당락일 기준으로 합친다.
  // 실패해도 배당 내역은 갱신하고, 과세표준은 이전 저장값을 유지한 채 실패 사유를 기록한다.
  const previous = new Map(
    db.all('SELECT ex_date, tax_base, tax_source, pay_date FROM dividend_events WHERE code = ?', [inst.code]).map((x) => [x.ex_date, x])
  );
  let tax = null;
  let taxError = null;
  if (providers.taxBase && inst.currency === 'KRW' && inst.type !== '주식') {
    try {
      tax = await providers.taxBase.loadEtfTaxBase(inst.code, inst.name);
    } catch (e) {
      taxError = e.message;
    }
  }
  const taxMap = new Map(((tax && tax.events) || []).map((e) => [e.exDate || alignToExDate(e.recordDate, r.events), e]).filter(([k]) => k));
  const rows = r.events.map((e) => {
    const t = taxMap.get(e.exDate);
    taxMap.delete(e.exDate);
    const p = previous.get(e.exDate);
    if (t) return { ...e, taxBase: t.taxBase, taxSource: tax.source, payDate: t.payDate, source: r.source };
    if (tax || !p) return { ...e, taxBase: null, taxSource: null, payDate: null, source: r.source };
    return { ...e, taxBase: p.tax_base, taxSource: p.tax_source, payDate: p.pay_date, source: r.source };
  });
  // 주 출처에 없고 과세표준 출처에만 있는 회차도 추가 (배당락일을 아는 경우만)
  for (const [exDate, t] of taxMap.entries()) {
    if (t.exDate) rows.push({ ...t, exDate, taxSource: tax.source, source: tax.source });
  }

  const at = nowIso();
  db.tx(() => {
    db.run('DELETE FROM dividend_events WHERE code = ?', [inst.code]);
    db.runMany(
      `INSERT OR REPLACE INTO dividend_events (code, ex_date, amount, source, collected_at, tax_base, tax_source, pay_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      rows.map((e) => [inst.code, e.exDate, e.amount, e.source, at, e.taxBase, e.taxSource, e.payDate])
    );
    db.run('UPDATE instruments SET div_loaded_at = ?, div_source = ?, div_tax_error = ? WHERE code = ?', [at, r.source, taxError, inst.code]);
  });
}

/**
 * 지급기준일만 주는 출처(SOL 등)의 회차를 배당락일에 맞춘다.
 * 배당락일은 지급기준일 직전 영업일이므로, 지급기준일 전 7일 안에서 가장 가까운 배당락일을 고른다.
 * 맞는 회차가 없으면 null (배당락일을 지어내지 않음)
 */
function alignToExDate(recordDate, events) {
  if (!recordDate) return null;
  const from = new Date(new Date(`${recordDate}T00:00:00Z`).getTime() - 7 * 86400000).toISOString().slice(0, 10);
  let best = null;
  for (const e of events) {
    if (e.exDate < recordDate && e.exDate >= from && (!best || e.exDate > best)) best = e.exDate;
  }
  return best;
}

async function getDividendEvents(rawCode, { force = false } = {}) {
  const inst = await ensureInstrument(rawCode);
  let stale = false;
  let staleReason = null;
  const fresh = inst.div_loaded_at && Date.now() - new Date(inst.div_loaded_at).getTime() < DIVIDEND_TTL_MS;
  if (force || !fresh) {
    try {
      if (!divInflight.has(inst.code)) {
        divInflight.set(inst.code, refreshDividends(inst).finally(() => divInflight.delete(inst.code)));
      }
      await divInflight.get(inst.code);
    } catch (e) {
      stale = true;
      staleReason = e.message;
    }
  }
  const cur = getInstrumentRow(inst.code);
  const since = `${new Date().getFullYear() - 9}-01-01`; // 최근 10년
  const events = db.all(
    `SELECT ex_date AS exDate, amount, tax_base AS taxBase, tax_source AS taxSource, pay_date AS payDate
     FROM dividend_events WHERE code = ? AND ex_date >= ? ORDER BY ex_date`,
    [cur.code, since]
  );
  return {
    instrument: publicInstrument(cur),
    lastPrice: cur.last_price,
    events,
    loadedAt: cur.div_loaded_at,
    source: cur.div_source,
    taxError: cur.div_tax_error,
    neverLoaded: !cur.div_loaded_at,
    stale,
    staleReason,
  };
}

function yearEndClose(code, year) {
  return db.get(
    'SELECT trade_date AS date, close FROM daily_prices WHERE code = ? AND trade_date BETWEEN ? AND ? ORDER BY trade_date DESC LIMIT 1',
    [code, `${year}-01-01`, `${year}-12-31`]
  );
}

// ---------------------------------------------------------------------------
// 환율 (FR-DATA-04)
// ---------------------------------------------------------------------------
function meta(key) {
  const r = db.get('SELECT value FROM app_meta WHERE key = ?', [key]);
  return r ? r.value : null;
}
function setMeta(key, value) {
  db.run('INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, String(value)]);
}

let fxInflight = null;

async function refreshFx() {
  const hasHistory = db.get('SELECT COUNT(*) AS n FROM fx_rates WHERE currency = ?', [FX]).n > 200;
  const r = await providers.fx.loadFx(hasHistory ? '5d' : '10y');
  db.tx(() => {
    db.runMany(
      `INSERT INTO fx_rates (currency, base_date, rate, source) VALUES (?, ?, ?, ?)
       ON CONFLICT(currency, base_date) DO UPDATE SET rate = excluded.rate, source = excluded.source`,
      r.rows.map((x) => [FX, x.date, x.close, r.source])
    );
    setMeta('fx_rate', r.rate);
    setMeta('fx_time', r.rateTime);
    setMeta('fx_source', r.source);
    setMeta('fx_fetched_at', nowIso());
  });
}

async function getCurrentFx({ force = false } = {}) {
  const fetched = meta('fx_fetched_at');
  let stale = false;
  let staleReason = null;
  if (force || !fetched || Date.now() - new Date(fetched).getTime() > QUOTE_TTL_MS) {
    try {
      if (!fxInflight) fxInflight = refreshFx().finally(() => (fxInflight = null));
      await fxInflight;
    } catch (e) {
      stale = true;
      staleReason = e.message;
    }
  }
  const rate = meta('fx_rate');
  if (rate == null) throw new SourceError('환율을 가져오지 못했습니다.');
  return { rate: Number(rate), time: meta('fx_time'), source: meta('fx_source'), stale, staleReason };
}

/** 해당 날짜 환율. 없으면(주말·공휴일) 직전 영업일 환율 */
function fxOn(date) {
  const r = db.get('SELECT rate, base_date FROM fx_rates WHERE currency = ? AND base_date <= ? ORDER BY base_date DESC LIMIT 1', [FX, date]);
  return r ? { rate: r.rate, date: r.base_date } : null;
}

// ---------------------------------------------------------------------------
// 일별 종가 자동 수집 (FR-DATA-01): 장 마감 후 아직 오늘 종가가 없으면 수집
// ---------------------------------------------------------------------------
async function collectDaily() {
  const now = new Date();
  try {
    await getCurrentFx({ force: true });
  } catch (_) { /* 다음 주기에 재시도 */ }
  for (const inst of db.all('SELECT * FROM instruments')) {
    const tz = inst.timezone;
    const wd = weekdayInTz(now, tz);
    if (wd === 'Sat' || wd === 'Sun') continue;
    const closeHour = tz === 'Asia/Seoul' ? 16 : 17; // 국내 15:30, 미국 16:00 마감 → 여유를 두고 수집
    if (hourInTz(now, tz) < closeHour) continue;
    const today = dateInTz(now, tz);
    const last = db.get('SELECT MAX(trade_date) AS d FROM daily_prices WHERE code = ?', [inst.code]).d;
    const fetchedToday = inst.price_fetched_at && dateInTz(new Date(inst.price_fetched_at), tz) === today
      && hourInTz(new Date(inst.price_fetched_at), tz) >= closeHour;
    if (last === today && fetchedToday) continue;
    try {
      await refreshQuote(inst);
    } catch (e) {
      console.warn(`[collect] ${inst.code} 수집 실패: ${e.message}`);
    }
  }
}

module.exports = {
  ValidationError,
  normalizeCode,
  detectKind,
  validateCode,
  ensureInstrument,
  getQuote,
  getPrices,
  getPeriod,
  getDividendEvents,
  yearEndClose,
  getCurrentFx,
  fxOn,
  collectDaily,
  publicInstrument,
  dateInTz,
  QUOTE_TTL_MS,
};
