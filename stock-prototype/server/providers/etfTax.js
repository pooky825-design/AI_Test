// 국내 ETF 주당과세표준액 출처 선택 (FR-DATA-07: 출처별 연동부 분리)
//  - SOL ETF  → 신한자산운용 홈페이지
//  - 그 밖    → FunETF (과세표준은 KODEX만 제공, 실지급일은 대부분 제공)
//  - TIGER    → 미래에셋 홈페이지가 자동 요청을 차단(HTTP 403)해 연동하지 못함. FunETF로 실지급일만 표시
const funetf = require('./funetf');
const sol = require('./sol');

function pick(name) {
  if (/^SOL\b/i.test(String(name || '').trim())) return sol;
  return funetf;
}

async function loadEtfTaxBase(code, name) {
  return pick(name).loadEtfTaxBase(code);
}

module.exports = { loadEtfTaxBase, pick };
