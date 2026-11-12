// 종목명 언어 (v0.30.37): 종목마다 한글명(ko)·영문명(en)을 저장해 두고, 화면 언어에 맞는 이름으로 바꿔 보낸다
//  - 국내 종목: 한글명은 네이버, 영문명은 야후(longName/shortName)
//  - 미국 종목: 영문명은 야후, 한글명은 네이버 자동완성(예: AAPL → 애플)
//  - 검색 결과에서 알게 된 이름도 저장(네이버 → ko, 야후 → en)
//  - 없는 이름은 필요할 때 한 번 찾아 두고(실패하면 7일 뒤 다시), 그동안은 원래 이름 그대로
const db = require('../db');
const providers = require('../providers');

const RETRY_MS = 7 * 24 * 3600 * 1000;
let cache = null; // code → { ko, en, tried }
function load() {
  if (cache) return cache;
  cache = new Map();
  for (const r of db.all('SELECT code, ko, en, tried_at FROM stock_names')) cache.set(r.code, { ko: r.ko || null, en: r.en || null, tried: r.tried_at || null });
  return cache;
}
const clean = (s) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t && t.length <= 120 ? t : null;
};
const hasHangul = (s) => /[가-힣]/.test(s || '');

// 이름 저장. ko 는 한글이 들어간 이름만, en 은 한글이 없는 이름만 받는다
function learn(code, { ko, en } = {}) {
  code = String(code || '').toUpperCase();
  if (!code) return;
  const c = load();
  const cur = c.get(code) || { ko: null, en: null, tried: null };
  const k = clean(ko);
  const e = clean(en);
  const next = { ko: k && hasHangul(k) ? k : cur.ko, en: e && !hasHangul(e) ? e : cur.en, tried: cur.tried };
  if (next.ko === cur.ko && next.en === cur.en && c.has(code)) return;
  c.set(code, next);
  db.run(`INSERT INTO stock_names (code, ko, en, tried_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(code) DO UPDATE SET ko = excluded.ko, en = excluded.en`, [code, next.ko, next.en, next.tried]);
}

// 빠진 이름을 한 번 찾아 둔다 (기다리지 않음)
const filling = new Set();
function ensure(code) {
  code = String(code || '').toUpperCase();
  const c = load();
  const cur = c.get(code);
  if (cur && cur.ko && cur.en) return;
  if (cur && cur.tried && Date.now() - Date.parse(cur.tried) < RETRY_MS) return;
  if (filling.has(code) || filling.size > 20) return;
  const inst = db.get('SELECT name, currency FROM instruments WHERE code = ?', [code]);
  if (!inst) return;
  filling.add(code);
  (async () => {
    const kr = inst.currency !== 'USD';
    learn(code, hasHangul(inst.name) ? { ko: inst.name } : { en: inst.name });
    const [naverSearch, yahooSearch] = providers.search || [];
    try {
      const now = c.get(code) || {};
      if (!now.ko && naverSearch) {
        const hit = (await naverSearch(code)).find((it) => it.code === code && it.nation === (kr ? 'KR' : 'US'));
        if (hit) learn(code, { ko: hit.name });
      }
      if (!(c.get(code) || {}).en && yahooSearch) {
        const hit = (await yahooSearch(code)).find((it) => it.code === code && it.nation === (kr ? 'KR' : 'US'));
        if (hit) learn(code, { en: hit.name });
      }
    } catch (_) { /* 다음에 다시 */ }
    const t = new Date().toISOString();
    const v = c.get(code) || { ko: null, en: null };
    c.set(code, { ...v, tried: t });
    db.run(`INSERT INTO stock_names (code, ko, en, tried_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(code) DO UPDATE SET tried_at = excluded.tried_at`, [code, v.ko, v.en, t]);
  })().finally(() => filling.delete(code));
}

// 응답 안의 { code, name } 들을 화면 언어의 이름으로 바꾼다 (모르는 이름은 그대로)
function localize(obj, lang) {
  const c = load();
  const seen = new Set();
  const walk = (o, depth) => {
    if (!o || typeof o !== 'object' || depth > 8 || seen.has(o)) return;
    seen.add(o);
    if (Array.isArray(o)) { for (const x of o) walk(x, depth + 1); return; }
    if (typeof o.code === 'string' && typeof o.name === 'string' && /^[0-9A-Z][0-9A-Z.-]{0,9}$/.test(o.code)) {
      let n = c.get(o.code);
      // 아직 모르는 언어의 이름이 이 기기에 저장된 종목명이면 바로 쓴다 (예: 미국 종목의 영문명)
      if (!(n && (lang === 'en' ? n.en : n.ko))) {
        const inst = db.get('SELECT name FROM instruments WHERE code = ?', [o.code]);
        if (inst && inst.name) { learn(o.code, hasHangul(inst.name) ? { ko: inst.name } : { en: inst.name }); n = c.get(o.code); }
      }
      const want = n && (lang === 'en' ? n.en : n.ko);
      if (want) o.name = want;
      else if (n === undefined || (lang === 'en' ? !n.en : !n.ko)) ensure(o.code);
    }
    for (const k of Object.keys(o)) { const v = o[k]; if (v && typeof v === 'object') walk(v, depth + 1); }
  };
  walk(obj, 0);
  return obj;
}

module.exports = { learn, ensure, localize };
