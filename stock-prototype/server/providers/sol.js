// 국내 ETF 주당과세표준액 출처: SOL ETF (신한자산운용 홈페이지)
// - 분배금 현황 API: 지급기준일(WORK_DT), 실제지급일(DIVIDEND_DT), 분배금(DIVIDEND_PRI), 주당과세표준액(WEEK_PRI)
//   ※ 화면 열 이름 기준. TAX_PRI 는 '과표기준가'이므로 쓰지 않는다.
// - 종목코드 → 운용사 내부 펀드코드 대응은 전체 상품 목록 API에서 얻어 1일 동안 메모리에 보관
// - 날짜는 배당락일이 아니라 지급기준일이므로, 배당락일 대응은 market.js 에서 한다.
// - 비공식 경로이며 이용약관 확인 전 단계(정의서 7장 미결 사항)
const { fetchRaw } = require('./http');
const { SourceError } = require('./errors');

const NAME = 'SOL ETF (신한자산운용)';
const BASE = 'https://www.soletf.com';
const MAP_TTL_MS = 24 * 60 * 60 * 1000;
let fundMap = null;
let fundMapAt = 0;

const ymd = (s) => (s && /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null);

async function json(res, what) {
  if (!res.ok) throw new SourceError(`${what} 응답 오류 (HTTP ${res.status})`);
  try {
    return await res.json();
  } catch (_) {
    throw new SourceError(`${what} 응답을 해석하지 못했습니다.`);
  }
}

async function fundCodeOf(code) {
  if (!fundMap || Date.now() - fundMapAt > MAP_TTL_MS) {
    const body = await json(await fetchRaw(`${BASE}/api/common/searchByEtfNameOrFilter`, { form: { viewCount: '1000' } }), 'SOL ETF 상품 목록');
    fundMap = new Map(((body && body.items) || []).filter((x) => x.ETF_CD6).map((x) => [String(x.ETF_CD6).toUpperCase(), String(x.FUND_CD)]));
    fundMapAt = Date.now();
  }
  return fundMap.get(code) || null;
}

async function loadEtfTaxBase(code) {
  const fundCd = await fundCodeOf(code);
  if (!fundCd) return { source: NAME, events: [], note: 'SOL ETF 상품 목록에 없는 종목입니다.' };
  const body = await json(await fetchRaw(`${BASE}/api/etf/pds/dividend/${encodeURIComponent(fundCd)}`), 'SOL ETF 분배금');
  return {
    source: NAME,
    events: ((body && body.items) || [])
      .map((x) => ({
        recordDate: ymd(x.WORK_DT), // 지급기준일
        amount: x.DIVIDEND_PRI,
        taxBase: x.WEEK_PRI == null ? null : Number(x.WEEK_PRI),
        payDate: ymd(x.DIVIDEND_DT),
      }))
      .filter((x) => x.recordDate),
  };
}

module.exports = { NAME, loadEtfTaxBase };
