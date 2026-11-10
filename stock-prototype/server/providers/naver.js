// 예비 출처: 네이버 증권 차트 데이터 (국내 종목 전용)
// - 야후에 없는 국내 ETN 등의 과거 종가 대체(FR-DATA-08)
// - 국내 종목의 한글 종목명 보완
const { fetchRaw } = require('./http');
const { NotFoundError, SourceError } = require('./errors');

const NAME = 'Naver Finance';
const ETF_BRANDS = /^(KODEX|TIGER|ACE|RISE|KBSTAR|SOL|PLUS|HANARO|KOSEF|ARIRANG|TIMEFOLIO|KIWOOM|WON|BNK|HK|UNICORN|마이티|파워|에셋플러스|1Q|DAISHIN343|TRUSTON|VITA|FOCUS|KCGI|하나|히어로즈)\b/i;

function guessType(name) {
  if (/ETN/i.test(name)) return 'ETN';
  if (ETF_BRANDS.test(name)) return 'ETF';
  return '주식';
}

// XML 속성값의 문자 참조 복원 (예: TIGER 미국S&amp;P500 → TIGER 미국S&P500)
function decodeXml(v) {
  return String(v || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function ymd(s) {
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

async function fetchChartData(code, count) {
  const url = `https://fchart.stock.naver.com/sise.nhn?symbol=${encodeURIComponent(code)}&timeframe=day&count=${count}&requestType=0`;
  const res = await fetchRaw(url);
  if (!res.ok) throw new SourceError(`네이버 증권 응답 오류 (HTTP ${res.status})`);
  const xml = new TextDecoder('euc-kr').decode(await res.arrayBuffer());
  const head = xml.match(/<chartdata[^>]*symbol="([^"]*)"[^>]*name="([^"]*)"[^>]*origintime="(\d*)"/);
  if (!head) throw new NotFoundError();
  const rows = [];
  for (const m of xml.matchAll(/<item data="([^"]+)"/g)) {
    const [d, , , , close] = m[1].split('|');
    if (close && close !== 'null') rows.push({ date: ymd(d), close: Number(close) });
  }
  if (!rows.length) throw new NotFoundError();
  return { name: decodeXml(head[2]), listedDate: head[3] ? ymd(head[3]) : null, rows };
}

async function load(code, kind, range) {
  if (kind !== 'KR') throw new NotFoundError();
  const data = await fetchChartData(code, range === '10y' ? 2600 : 7);
  const last = data.rows[data.rows.length - 1];
  return {
    source: NAME,
    info: {
      symbol: code,
      name: data.name,
      market: 'KOSPI', // 네이버 차트 데이터는 시장 구분을 주지 않음. ETN은 유가증권시장 상장
      type: guessType(data.name),
      currency: 'KRW',
      listedDate: data.listedDate,
      timezone: 'Asia/Seoul',
    },
    price: last.close,
    priceTime: new Date(`${last.date}T15:30:00+09:00`).toISOString(),
    rows: data.rows,
    splits: [],
  };
}

// 한글 종목명만 조회 (실패해도 무시)
async function koreanName(code) {
  try {
    return (await fetchChartData(code, 1)).name;
  } catch (_) {
    return null;
  }
}

// 종목명 검색 (v0.21): 네이버 증권 자동완성. 국내·미국 종목만 돌려준다
const NATION = { KOR: 'KR', USA: 'US' };
async function search(q) {
  const url = `https://ac.stock.naver.com/ac?q=${encodeURIComponent(q)}&target=stock,etf`;
  const res = await fetchRaw(url, { timeoutMs: 6000 });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return (data.items || [])
    .filter((it) => NATION[it.nationCode] && it.code)
    .map((it) => ({ code: String(it.code).toUpperCase(), name: it.name, market: it.typeName || it.typeCode || '', nation: NATION[it.nationCode], source: 'naver' }));
}

module.exports = { NAME, load, koreanName, search };
