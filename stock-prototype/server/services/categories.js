// 종목 분류 (v0.7): 국내 / 해외 / 해외추종
// - 회원이 종목을 등록할 때 고르며, 회원별·종목별로 하나만 저장한다.
// - 저장한 적 없는 종목은 추천 규칙으로 정한다:
//   미국 종목 → 해외, 해외 지수·자산을 따라가는 국내 ETF·ETN(이름 기준) → 해외추종, 그 밖 → 국내
const db = require('../db');

const CATEGORIES = [
  { id: 'DOMESTIC', label: '국내' },
  { id: 'OVERSEAS', label: '해외' },
  { id: 'OVERSEAS_TRACK', label: '해외추종' },
];
const LABEL = Object.fromEntries(CATEGORIES.map((c) => [c.id, c.label]));
const IDS = CATEGORIES.map((c) => c.id);

const OVERSEAS_WORDS = /(미국|S&P|나스닥|NASDAQ|다우|필라델피아|글로벌|해외|선진국|신흥국|MSCI|차이나|중국|홍콩|항셍|일본|니케이|인도|베트남|유럽|독일|대만|브라질|월드|WORLD|GLOBAL|CHINA|JAPAN|INDIA|USA?\b|US\s|빅테크|테슬라|애플|엔비디아)/i;

function guess(inst) {
  if (!inst) return 'DOMESTIC';
  if (inst.currency === 'USD') return 'OVERSEAS';
  if (inst.type !== '주식' && OVERSEAS_WORDS.test(String(inst.name || ''))) return 'OVERSEAS_TRACK';
  return 'DOMESTIC';
}

function savedMap(userId) {
  return new Map(db.all('SELECT code, category FROM stock_categories WHERE user_id = ?', [userId]).map((r) => [r.code, r.category]));
}

/** 회원의 종목 분류 (저장값이 없으면 추천값). { id, label, saved } */
function categoryOf(userId, code, inst, saved = null) {
  const map = saved || savedMap(userId);
  const id = map.get(code) || guess(inst);
  return { id, label: LABEL[id], saved: map.has(code) };
}

function setCategory(userId, code, category) {
  db.run(
    `INSERT INTO stock_categories (user_id, code, category, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, code) DO UPDATE SET category = excluded.category, updated_at = excluded.updated_at`,
    [userId, code, category, new Date().toISOString()]
  );
}

module.exports = { CATEGORIES, LABEL, IDS, guess, savedMap, categoryOf, setCategory };
