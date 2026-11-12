// 홈 화면 보유 종목 주요 키워드 (v0.29.0)
// 종목별 최근 기사 제목에서 자주 나오는 단어를 골라(최대 4개) 그 단어가 들어간 최근 기사로 연결한다.
//  - 국내 종목: 네이버 증권 모바일 종목 뉴스(m.stock.naver.com, 한국어)
//  - 미국 종목: 야후 파이낸스 검색 뉴스 중 그 티커가 관련 종목으로 붙은 기사(영어)
//  - 기사 본문은 가져오지 않고 제목·링크만 쓴다. 종목별 1시간 캐시
const { fetchRaw } = require('../providers/http');

const TTL = 60 * 60 * 1000;
const cache = new Map();
const MAX_KW = 4;

const KO_STOP = new Set(('주가 주식 종목 상승 하락 상승세 하락세 마감 시황 증시 개장 장중 장마감 오전 오후 오늘 이번 이날 전일 전날 어제 내일 '
  + '기자 특징주 종합 속보 단독 포토 영상 사진 인터뷰 칼럼 사설 분석 전망 발표 관련 이유 기대 우려 대비 만에 최대 최고 최저 '
  + '억원 조원 만원 달러 돌파 급등 급락 강세 약세 주목 투자 투자자 시장 기업 국내 해외 올해 내년 지난 주간 분기 연간 '
  + '외국인 기관 개인 매수 매도 순매수 순매도 거래 거래량 시가총액 목표가 목표주가 증권 증권사 리포트 보고서 추천 '
  + '오른 내린 올라 내려 대해 위해 통해 따라 지금 다시 계속 가장 이상 이하 미만 확대 축소 기록 수준 '
  + '코스피 코스닥 지수 상장 공시 뉴스 정보 소식 이슈 체크 브리핑 마켓 글로벌 한국 미국 중국 일본 '
  + '하는 했다 한다 있다 없다 된다 됐다 보다 있는 없는 같은 가운데 이후 이전 앞두고 속에 넘어 넘게 만의 '
  + 'ETF ETN 상품 펀드 운용 운용사 자산운용 수익률 순자산 목표 보합 약보합 강보합 혼조 혼조세 몰렸다 몰려 몰린 붕괴 회복 반등 폭락 폭등').split(/\s+/));
const KO_SUFFIX = /(에서는|에서도|으로는|으로도|에게서|까지는|부터는|에서|으로|에게|까지|부터|보다|처럼|이며|이고|이나|라도|마저|조차|은|는|이|가|을|를|의|에|로|와|과|도|만|엔|서)$/;
const EN_STOP = new Set(('the a an to of in on for and or is are was were be been with as at by from its it this that these those '
  + 'stock stocks share shares market markets today inc corp corporation company co ltd plc nyse nasdaq why what how who which '
  + 'buy sell hold up down vs after before says said new will could should would may might can more most than top best worst '
  + 'report reports here heres just now still big key amid over under into out about against your you our we they their his her '
  + 'week weeks day days year years month months quarter time first last next one two three million billion trillion percent '
  + 'price prices trading trade trades investors investor analyst analysts rating ratings target stake fund funds etf etfs '
  + 'rises rise rose falls fall fell gains gain jumps jump drops drop surges surge slips slip higher lower record high low '
  + 'monday tuesday wednesday thursday friday saturday sunday jan feb mar apr may jun jul aug sep sept oct nov dec january february march april june july august september october november december '
  + 'announces announced launches launched unveils unveiled adds added buying selling recognized winner partner partners update updates news daily weekly '
  + 'inc. corp. us u.s. ceo cfo bought add open opens close closes since equity').split(/\s+/));
// 제목의 HTML 엔티티(&quot; 등) 풀기
const decode = (t) => String(t || '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, '&');

const nameParts = (name) => String(name || '').split(/[\s()·.,&-]+/).map((x) => x.trim().toLowerCase()).filter((x) => x.length >= 2);

function koTokens(title, skip) {
  const t = String(title).replace(/\[[^\]]*\]/g, ' ').replace(/\([^)]*\)/g, ' ');
  const out = new Set();
  for (let w of t.split(/[^0-9A-Za-z가-힣]+/)) {
    if (!w) continue;
    if (/[가-힣]/.test(w) && w.length >= 3) w = w.replace(KO_SUFFIX, '');
    if (w.length < 2 || /^\d+$/.test(w) || /^\d+[가-힣]+$/.test(w)) continue; // 숫자, 12일·3분기 같은 것
    const low = w.toLowerCase();
    if (KO_STOP.has(w) || KO_STOP.has(w.toUpperCase()) || skip.some((s) => low === s || (s.length >= 2 && low.includes(s)) || (low.length >= 2 && s.includes(low)))) continue;
    out.add(w);
  }
  return [...out];
}

function enTokens(title, skip) {
  const out = new Map();
  for (const w of String(title).split(/[^A-Za-z0-9'.+-]+/)) {
    const clean = w.replace(/^[.'+-]+|[.'+-]+$/g, '').replace(/'s$/i, '');
    if (clean.length < 2 || /^\d/.test(clean)) continue;
    const low = clean.toLowerCase();
    if (EN_STOP.has(low) || skip.includes(low)) continue;
    // 대문자로 시작하는 고유명사·약어 위주 (AI, Azure, OpenAI …). 소문자 일반 단어는 4글자 이상만
    if (!/^[A-Z]/.test(clean) && clean.length < 4) continue;
    if (!out.has(low)) out.set(low, /^[A-Z0-9]+$/.test(clean) || /[a-z][A-Z]/.test(clean) ? clean : clean[0].toUpperCase() + clean.slice(1));
  }
  return [...out.entries()]; // [소문자, 표시형]
}

async function koNews(code) {
  const r = await fetchRaw(`https://m.stock.naver.com/api/news/stock/${encodeURIComponent(code)}?pageSize=20&page=1`);
  if (!r.ok) throw new Error(`네이버 뉴스 응답 오류 (HTTP ${r.status})`);
  const j = await r.json();
  const list = (Array.isArray(j) ? j : []).flatMap((g) => (g && Array.isArray(g.items) ? g.items : []));
  return list.map((x) => ({
    title: decode(x.titleFull || x.title),
    url: x.mobileNewsUrl || (x.officeId && x.articleId ? `https://n.news.naver.com/mnews/article/${x.officeId}/${x.articleId}` : null),
    time: /^\d{12}$/.test(String(x.datetime)) ? `${x.datetime.slice(0, 4)}-${x.datetime.slice(4, 6)}-${x.datetime.slice(6, 8)}T${x.datetime.slice(8, 10)}:${x.datetime.slice(10, 12)}:00+09:00` : null,
    press: x.officeName || null,
  })).filter((x) => x.title && x.url);
}

async function usNews(code) {
  const r = await fetchRaw(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(code)}&newsCount=25&quotesCount=0`);
  if (!r.ok) throw new Error(`야후 뉴스 응답 오류 (HTTP ${r.status})`);
  const j = await r.json();
  const sym = String(code).toUpperCase();
  return (j.news || [])
    .filter((n) => Array.isArray(n.relatedTickers) && n.relatedTickers.map((x) => String(x).toUpperCase()).includes(sym))
    .map((n) => ({ title: decode(n.title), url: n.link || null, time: n.providerPublishTime ? new Date(n.providerPublishTime * 1000).toISOString() : null, press: n.publisher || null }))
    .filter((x) => x.title && x.url);
}

function pickKeywords(articles, lang, skip) {
  const count = new Map(); // key → { label, n, articles: [] }
  articles.forEach((a, idx) => {
    const toks = lang === 'ko' ? koTokens(a.title, skip).map((w) => [w.toLowerCase(), w]) : enTokens(a.title, skip);
    for (const [key, label] of toks) {
      if (!count.has(key)) count.set(key, { label, n: 0, articles: [], first: idx });
      const c = count.get(key);
      c.n += 1;
      c.articles.push(a);
    }
  });
  const ranked = [...count.values()].sort((a, b) => b.n - a.n || a.first - b.first);
  const strong = ranked.filter((c) => c.n >= 2);
  const pick = (strong.length ? strong : ranked).slice(0, MAX_KW);
  return pick.map((c) => {
    const latest = c.articles.slice().sort((a, b) => String(b.time || '').localeCompare(String(a.time || '')))[0];
    return { word: c.label, count: c.n, url: latest.url, title: latest.title, press: latest.press, time: latest.time };
  });
}

async function keywordsFor(code, name) {
  const key = String(code).toUpperCase();
  const c = cache.get(key);
  if (c && Date.now() - c.at < TTL) return c.v;
  const kr = /^[0-9][0-9A-Z]{5}$/.test(key);
  const skip = [...new Set([...nameParts(name), key.toLowerCase()])];
  let v;
  try {
    const arts = kr ? await koNews(key) : await usNews(key);
    v = { code: key, lang: kr ? 'ko' : 'en', articles: arts.length, keywords: pickKeywords(arts, kr ? 'ko' : 'en', skip), source: kr ? '네이버 증권' : 'Yahoo Finance' };
  } catch (e) {
    v = { code: key, keywords: [], error: e.message || '가져오지 못했습니다.' };
  }
  if (!v.error) cache.set(key, { at: Date.now(), v });
  return v;
}

module.exports = { keywordsFor, koTokens, enTokens, pickKeywords };
