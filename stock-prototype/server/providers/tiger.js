// 국내 ETF 주당과세표준액 출처: TIGER ETF (미래에셋자산운용 홈페이지)
// - 상품 상세의 분배금 지급현황 요청(refDivAjax.ajax, POST)을 사용. 응답은 HTML 표의 행(<tr>)
//   열 순서: 지급기준일, 실지급일, 분배금, 주당과세표준액
// - 날짜는 배당락일이 아니라 지급기준일이므로, 배당락일 대응은 market.js 에서 한다.
// - 미래에셋 홈페이지는 클라우드 서버(데이터센터)에서 오는 요청을 차단(HTTP 403)한다.
//   사용자 PC(start.bat)나 휴대폰 앱처럼 일반 인터넷 회선에서 실행할 때만 동작할 수 있다.
// - 비공식 경로이며 이용약관 확인 전 단계(정의서 7장 미결 사항)
const { fetchRaw } = require('./http');
const { SourceError } = require('./errors');
const { toIsin } = require('./funetf');

const NAME = 'TIGER ETF (미래에셋자산운용)';
const URL = 'https://investments.miraeasset.com/tigeretf/ko/product/search/detail/refDivAjax.ajax';

const num = (s) => {
  const t = String(s || '').replace(/[,\s원]/g, '');
  return t === '' || t === '-' || Number.isNaN(Number(t)) ? null : Number(t);
};
const date = (s) => {
  const m = /(\d{4})[-.](\d{2})[-.](\d{2})/.exec(String(s || ''));
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
};
const text = (html) => html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();

/** 응답 HTML의 행을 회차 목록으로 바꾼다. 셀이 4개가 아닌 행(‘내역 없음’ 등)은 건너뛴다. */
function parseRows(html) {
  const events = [];
  let total = null;
  for (const tr of String(html).match(/<tr[\s\S]*?<\/tr>/gi) || []) {
    const t = /data-tot-cnt="(\d+)"/.exec(tr);
    if (t) total = Number(t[1]);
    const cells = (tr.match(/<td[\s\S]*?<\/td>/gi) || []).map(text);
    if (cells.length < 4) continue;
    const recordDate = date(cells[0]);
    if (!recordDate) continue;
    events.push({ recordDate, payDate: date(cells[1]), amount: num(cells[2]), taxBase: num(cells[3]) });
  }
  return { events, total };
}

async function loadEtfTaxBase(code, name) {
  const res = await fetchRaw(URL, {
    form: { pageIndex: '1', listCnt: '200', ksdFund: toIsin(code), jongName: name || '' },
  });
  if (res.status === 403) {
    throw new SourceError('미래에셋 홈페이지가 접속을 거절했습니다(HTTP 403). 클라우드 서버 등 일부 환경에서는 차단되며, 사용자 PC나 휴대폰에서 실행하면 동작할 수 있습니다.');
  }
  if (!res.ok) throw new SourceError(`TIGER 홈페이지 응답 오류 (HTTP ${res.status})`);
  const html = new TextDecoder('utf-8').decode(await res.arrayBuffer());
  return { source: NAME, ...parseRows(html) };
}

module.exports = { NAME, loadEtfTaxBase, parseRows };
