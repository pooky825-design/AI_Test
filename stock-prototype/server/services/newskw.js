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
const KO_FILLER = new Set('등 및 첫 새 더 또 각 약 전 후 중 위 땐 때 곳 수 것 듯 뒤 앞 간 만 단 왜 총 올 내 외 대 상 하 시 분 초 년 월 일 원 개 명 건 배 측 곧 늘 꼭 차 별 겸 와 과 의 도 를 을 는 은 이 가 에 로'.split(' '));
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

// 제목을 순서대로 단어로 나누되, 뺄 단어·숫자 자리는 null 로 남겨 '붙어 있는 단어 묶음'을 찾는 데 쓴다 (v0.29.1)
function koSeq(title, skip) {
  const t = String(title).replace(/\[[^\]]*\]/g, ' | ').replace(/\([^)]*\)/g, ' | ').replace(/[…·,"'“”‘’!?:;]/g, ' | ');
  const out = [];
  for (const raw of t.split(/\s+/)) {
    if (!raw || raw === '|') { out.push(null); continue; }
    for (let w of raw.split(/[^0-9A-Za-z가-힣]+/)) {
      if (!w) continue;
      if (/[가-힣]/.test(w) && w.length >= 3) w = w.replace(KO_SUFFIX, '');
      const low = w.toLowerCase();
      // 한 글자 한글(젠슨 '황' 등)은 묶음 안에서만 쓴다 (단독 키워드 X). 등·및·전 같은 군더더기는 제외
      if (w.length === 1 && /[가-힣]/.test(w) && !KO_FILLER.has(w)) { out.push([low, w, 'weak']); continue; }
      const bad = w.length < 2 || /^\d+$/.test(w) || /^\d+[가-힣]+$/.test(w) || KO_STOP.has(w) || KO_STOP.has(w.toUpperCase())
        || skip.some((x) => low === x || (x.length >= 2 && low.includes(x)) || (low.length >= 2 && x.includes(low)));
      out.push(bad ? null : [low, w]);
    }
  }
  return out;
}
function enSeq(title, skip) {
  const out = [];
  for (const raw of String(title).replace(/[,:;!?"“”()|]/g, ' | ').split(/\s+/)) {
    if (!raw || raw === '|') { out.push(null); continue; }
    const clean = raw.replace(/^[.'+-]+|[.'+-]+$/g, '').replace(/'s$/i, '');
    const low = clean.toLowerCase();
    const bad = clean.length < 2 || /^\d/.test(clean) || EN_STOP.has(low) || skip.includes(low) || (!/^[A-Z]/.test(clean) && clean.length < 4);
    out.push(bad ? null : [low, /^[A-Z0-9]+$/.test(clean) || /[a-z][A-Z]/.test(clean) ? clean : clean[0].toUpperCase() + clean.slice(1)]);
  }
  return out;
}
// 연속된 2~3단어 묶음 (n-gram)
function phrasesOf(seq) {
  const out = new Map();
  for (let n = 3; n >= 2; n--) {
    for (let i = 0; i + n <= seq.length; i++) {
      const g = seq.slice(i, i + n);
      if (g.some((x) => !x) || g.every((x) => x[2] === 'weak')) continue;
      const key = g.map((x) => x[0]).join(' ');
      if (new Set(g.map((x) => x[0])).size < n) continue; // 같은 단어 반복
      if (!out.has(key)) out.set(key, { label: g.map((x) => x[1]).join(' '), n: g.length });
    }
  }
  return out;
}

async function koNews(code) {
  const r = await fetchRaw(`https://m.stock.naver.com/api/news/stock/${encodeURIComponent(code)}?pageSize=30&page=1`);
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

// 키워드 고르기 (v0.29.1): ① 여러 기사에 붙어서 나온 2~3단어 묶음(예: 방산 수요 증가) ② 모자라면 자주 나온 단어
function pickKeywords(articles, lang, skip) {
  const latestOf = (arts) => arts.slice().sort((a, b) => String(b.time || '').localeCompare(String(a.time || '')))[0];
  const phrases = new Map(); // key → { label, words, n, articles, first }
  const words = new Map();
  articles.forEach((a, idx) => {
    const seq = lang === 'ko' ? koSeq(a.title, skip) : enSeq(a.title, skip);
    for (const [key, v] of phrasesOf(seq)) {
      if (!phrases.has(key)) phrases.set(key, { label: v.label, words: v.n, n: 0, articles: [], first: idx });
      const c = phrases.get(key); c.n += 1; c.articles.push(a);
    }
    const seen = new Set();
    for (const t of seq) {
      if (!t || t[2] === 'weak' || seen.has(t[0])) continue;
      seen.add(t[0]);
      if (!words.has(t[0])) words.set(t[0], { label: t[1], n: 0, articles: [], first: idx });
      const c = words.get(t[0]); c.n += 1; c.articles.push(a);
    }
  });
  // 묶음: 2번 이상, 같은 횟수면 긴 묶음 먼저. 이미 고른 묶음에 들어 있는 짧은 묶음은 뺀다
  const picked = [];
  const covered = (key) => picked.some((p) => (` ${p.key} `).includes(` ${key} `));
  [...phrases.entries()].filter(([, c]) => c.n >= 2)
    .sort((a, b) => b[1].n - a[1].n || b[1].words - a[1].words || a[1].first - b[1].first)
    .forEach(([key, c]) => {
      if (picked.length >= MAX_KW || covered(key)) return;
      // 긴 묶음이 짧은 묶음을 품으면 짧은 것 제거
      for (let i = picked.length - 1; i >= 0; i--) if ((` ${key} `).includes(` ${picked[i].key} `)) picked.splice(i, 1);
      picked.push({ key, ...c });
    });
  // 단어로 채우기: 고른 묶음에 이미 들어 있는 단어는 빼고, 2번 이상 나온 것 위주
  const rankedWords = [...words.entries()].sort((a, b) => b[1].n - a[1].n || a[1].first - b[1].first);
  const strongWords = rankedWords.filter(([, c]) => c.n >= 2);
  for (const [key, c] of (strongWords.length || picked.length ? strongWords : rankedWords)) {
    if (picked.length >= MAX_KW) break;
    if (covered(key)) continue;
    picked.push({ key, ...c });
  }
  return picked.map((c) => {
    const latest = latestOf(c.articles);
    return { word: c.label, count: c.n, phrase: c.key.includes(' '), url: latest.url, title: latest.title, press: latest.press, time: latest.time };
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
    const all = kr ? await koNews(key) : await usNews(key);
    // 최근 1일(24시간) 이내 기사만 (v0.29.1)
    const since = Date.now() - 24 * 60 * 60 * 1000;
    const arts = all.filter((a) => a.time && Date.parse(a.time) >= since);
    v = { code: key, lang: kr ? 'ko' : 'en', articles: arts.length, keywords: pickKeywords(arts, kr ? 'ko' : 'en', skip), source: kr ? '네이버 증권' : 'Yahoo Finance' };
  } catch (e) {
    v = { code: key, keywords: [], error: e.message || '가져오지 못했습니다.' };
  }
  if (!v.error) cache.set(key, { at: Date.now(), v });
  return v;
}

module.exports = { keywordsFor, koTokens, enTokens, koSeq, enSeq, pickKeywords };
