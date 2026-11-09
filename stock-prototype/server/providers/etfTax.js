// 국내 ETF 주당과세표준액 출처 선택 (FR-DATA-07: 출처별 연동부 분리)
//  - SOL ETF   → 신한자산운용 홈페이지
//  - TIGER ETF → 미래에셋자산운용 홈페이지. 접속이 거절되면(클라우드 서버 등) FunETF로 실지급일만 표시하고 사유를 남김
//  - 그 밖     → FunETF (과세표준은 KODEX만 제공, 실지급일은 대부분 제공)
const funetf = require('./funetf');
const sol = require('./sol');
const tiger = require('./tiger');

function brand(name) {
  const n = String(name || '').trim().toUpperCase();
  if (/^SOL\b/.test(n)) return 'SOL';
  if (/^TIGER\b/.test(n)) return 'TIGER';
  return 'OTHER';
}

async function loadEtfTaxBase(code, name) {
  const b = brand(name);
  if (b === 'SOL') return sol.loadEtfTaxBase(code);
  if (b === 'TIGER') {
    try {
      return await tiger.loadEtfTaxBase(code, name);
    } catch (e) {
      const fallback = await funetf.loadEtfTaxBase(code);
      return { ...fallback, warning: `TIGER 과세표준을 가져오지 못했습니다: ${e.message}` };
    }
  }
  return funetf.loadEtfTaxBase(code);
}

module.exports = { loadEtfTaxBase, brand };
