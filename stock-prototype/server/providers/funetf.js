// 국내 ETF 주당과세표준액 출처: FunETF (삼성자산운용 ETF 정보 플랫폼)
// - 회차별 배당락일, 분배금, 주당과세표준액, 실지급일을 제공
// - 확인 결과 과세표준은 KODEX ETF만 제공하고(타 운용사는 빈 값), 2022년 이후 회차만 있음
// - 비공식 경로이며 이용약관 확인 전 단계(정의서 7장 미결 사항). 짧은 시간에 많이 호출하면 차단(HTTP 429)되므로
//   배당 지급내역과 함께 1일 동안 저장값을 재사용한다(FR-DATA-09).
const { fetchRaw } = require('./http');
const { SourceError } = require('./errors');

const NAME = 'FunETF';

/** 국내 단축코드 → ISIN (KR7 + 코드 6자리 + 00 + 검사숫자) */
function toIsin(code) {
  const body = `KR7${code}00`;
  const digits = body.split('').map((c) => (/[0-9]/.test(c) ? c : String(c.charCodeAt(0) - 55))).join('');
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return body + ((10 - (sum % 10)) % 10);
}

const ymd = (s) => (s && /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null);

async function loadEtfTaxBase(code) {
  const res = await fetchRaw(`https://www.funetf.co.kr/api/public/product/view/divBasic?itemId=${toIsin(code)}`);
  if (res.status === 429) throw new SourceError('FunETF 요청이 많아 잠시 차단되었습니다. 잠시 후 다시 시도해 주세요.');
  if (!res.ok) throw new SourceError(`FunETF 응답 오류 (HTTP ${res.status})`);
  let body;
  try {
    body = await res.json();
  } catch (_) {
    throw new SourceError('FunETF 응답을 해석하지 못했습니다.');
  }
  return {
    source: NAME,
    events: ((body && body.list) || [])
      .map((x) => ({
        exDate: ymd(x.divDt),
        amount: x.divAmt,
        taxBase: x.taxDivAmt == null ? null : Number(x.taxDivAmt),
        payDate: ymd(x.payDt),
      }))
      .filter((x) => x.exDate),
  };
}

module.exports = { NAME, loadEtfTaxBase, toIsin };
