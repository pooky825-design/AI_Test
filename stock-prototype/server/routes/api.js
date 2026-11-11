const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db');
const auth = require('../auth');
const market = require('../services/market');
const portfolio = require('../services/portfolio');
const excel = require('../services/excel');
const { ValidationError } = market;
const categories = require('../services/categories');
const config = require('../config');
const { limiter, clientIp } = require('../security');

// 요청 횟수 제한 (v0.25): 로그인 실패는 이메일+IP 5회/15분, IP 30회/15분 · 가입·재설정은 IP 10회/시간
const loginFail = limiter({ windowMs: 15 * 60 * 1000, max: 5 });
const loginFailIp = limiter({ windowMs: 15 * 60 * 1000, max: 30 });
const signupLimit = limiter({ windowMs: 60 * 60 * 1000, max: 10 });
const tooMany = (res, sec) => res.status(429).json({ error: `시도 횟수가 너무 많습니다. ${Math.ceil(sec / 60)}분 뒤에 다시 시도해 주세요.`, code: 'TOO_MANY' });

const router = express.Router();
const now = () => new Date().toISOString();
const today = () => market.dateInTz(new Date(), 'Asia/Seoul');

// ---------------------------------------------------------------------------
// 입력 검증 (4.2)
// ---------------------------------------------------------------------------
// 실현손익 (선택): 비우면 null, 음수·0 허용, 소수 둘째 자리까지 (v0.10)
function signedAmount(v) {
  const s = String(v ?? '').trim().replace(/,/g, '').replace(/^\+/, '');
  if (!s) return { value: null };
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return { error: '숫자만 입력할 수 있습니다(손실은 - 부호, 소수 둘째 자리까지).' };
  return { value: Number(s) };
}

function positiveNumber(v, { maxDecimals } = {}) {
  const s = String(v ?? '').trim().replace(/,/g, '');
  if (!s) return { error: '필수 입력 항목입니다.' };
  if (/^-\d+(\.\d+)?$/.test(s)) return { error: '0보다 큰 숫자를 입력해 주세요.' };
  if (!/^\d+(\.\d+)?$/.test(s)) return { error: '숫자만 입력할 수 있습니다.' };
  const n = Number(s);
  if (!(n > 0)) return { error: '0보다 큰 숫자를 입력해 주세요.' };
  if (maxDecimals != null && (s.split('.')[1] || '').length > maxDecimals) {
    return { error: `소수점 ${maxDecimals}자리까지 입력할 수 있습니다.` };
  }
  return { value: n };
}

function validatePassword(pw) {
  if (!pw || String(pw).length < 8) return '비밀번호는 8자 이상이어야 합니다.';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return '비밀번호는 영문과 숫자를 모두 포함해야 합니다.';
  return null;
}

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '')) ? null : '올바른 이메일 형식이 아닙니다.';
}

function fieldErrors(fields) {
  const f = Object.fromEntries(Object.entries(fields).filter(([, v]) => v));
  if (Object.keys(f).length) throw new ValidationError('입력값을 확인해 주세요.', f);
}

// ---------------------------------------------------------------------------
// 회원·인증 (3.1)
// ---------------------------------------------------------------------------
router.post('/auth/signup', async (req, res) => {
  const ip = clientIp(req);
  const wait = signupLimit.blocked(ip);
  if (wait) return tooMany(res, wait);
  signupLimit.hit(ip);
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  // 공개 서버에 가입 코드가 있으면 그 코드를 알아야 가입 (v0.25)
  const codeErr = config.SIGNUP_CODE && String(req.body.signupCode || '').trim() !== config.SIGNUP_CODE ? '가입 코드가 올바르지 않습니다. 서버 관리자에게 받은 코드를 입력하세요.' : null;
  fieldErrors({ email: validateEmail(email), password: validatePassword(password), signupCode: codeErr });
  if (db.get('SELECT 1 FROM users WHERE email = ?', [email])) {
    throw new ValidationError('이미 가입된 이메일입니다.', { email: '이미 가입된 이메일입니다.' });
  }
  const hash = await bcrypt.hash(password, 10); // NFR-SEC-01 단방향 해시
  // 프로토타입: 이메일 인증 절차 생략 → 가입 즉시 활성화
  const { lastId } = db.run('INSERT INTO users (email, password_hash, email_verified, created_at) VALUES (?, ?, 1, ?)', [email, hash, now()]);
  auth.createSession(res, lastId);
  res.json({ user: { id: lastId, email } });
});

router.post('/auth/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const ip = clientIp(req);
  const key = `${ip}|${email}`;
  const wait = loginFail.blocked(key) || loginFailIp.blocked(ip);
  if (wait) return tooMany(res, wait);
  const user = db.get('SELECT * FROM users WHERE email = ?', [email]);
  const ok = user && (await bcrypt.compare(String(req.body.password || ''), user.password_hash));
  if (!ok) {
    loginFail.hit(key);
    loginFailIp.hit(ip);
    return res.status(401).json({ error: '이메일 또는 비밀번호가 올바르지 않습니다.', code: 'LOGIN_FAILED' });
  }
  loginFail.clear(key);
  auth.createSession(res, user.id);
  res.json({ user: { id: user.id, email: user.email } });
});

router.post('/auth/logout', (req, res) => {
  auth.destroySession(req, res);
  res.json({ ok: true });
});

router.get('/auth/me', (req, res) => {
  res.json({ user: req.user || null });
});

// 비밀번호 재설정: 실제 서비스에서는 메일로 링크를 보내지만, 프로토타입은 화면에 링크를 보여준다.
router.post('/auth/reset-request', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  fieldErrors({ email: validateEmail(email) });
  // 공개 서버: 메일 발송 기능이 없으므로 링크를 화면에 보여주면 누구나 남의 비밀번호를 바꿀 수 있다 → 관리자 도구로만 재설정 (v0.25)
  if (config.CLOUD) {
    return res.json({ message: '이 서버는 비밀번호 재설정 메일을 보내지 않습니다. 서버 관리자에게 재설정을 요청하세요(관리자는 서버에서 kstock-admin reset-password 명령으로 임시 비밀번호를 발급합니다).', demoLink: null });
  }
  const user = db.get('SELECT id FROM users WHERE email = ?', [email]);
  let demoLink = null;
  if (user) {
    const token = crypto.randomBytes(24).toString('hex');
    db.run('INSERT INTO reset_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)', [
      auth.sha256(token), user.id, new Date(Date.now() + 30 * 60000).toISOString(),
    ]);
    demoLink = `#/reset?token=${token}`;
  }
  res.json({ message: '가입된 이메일이면 재설정 링크를 보냈습니다.', demoLink });
});

router.post('/auth/reset', async (req, res) => {
  const t = db.get('SELECT * FROM reset_tokens WHERE token_hash = ? AND used = 0 AND expires_at > ?', [
    auth.sha256(String(req.body.token || '')), now(),
  ]);
  if (!t) return res.status(400).json({ error: '재설정 링크가 만료되었거나 올바르지 않습니다.', code: 'BAD_TOKEN' });
  fieldErrors({ password: validatePassword(req.body.password) });
  const hash = await bcrypt.hash(String(req.body.password), 10);
  db.tx(() => {
    db.run('UPDATE users SET password_hash = ? WHERE id = ?', [hash, t.user_id]);
    db.run('UPDATE reset_tokens SET used = 1 WHERE token_hash = ?', [t.token_hash]);
    db.run('DELETE FROM sessions WHERE user_id = ?', [t.user_id]);
  });
  res.json({ ok: true });
});

// 이하 로그인 필요 ------------------------------------------------------------
router.use(auth.requireAuth);

// ---------------------------------------------------------------------------
// 화면 공유·권한 (v0.16)
// 공유받은 사용자는 요청에 ?as=<소유자 id> 를 붙여 소유자의 데이터로 화면을 연다.
// 요청 경로를 화면에 대응시켜, 그 화면에 권한(view: 조회, edit: 조회+수정)이 있을 때만 통과시킨다.
// ---------------------------------------------------------------------------
const SHARE_SCREENS = [
  { id: 'assets', label: '나의 자산', edit: false },
  { id: 'stock', label: '종목 조회', edit: false },
  { id: 'holdings', label: '보유 종목 관리', edit: true },
  { id: 'divmgmt', label: '배당 관리', edit: true },
  { id: 'yearly', label: '연도별 자산 · 배당', edit: false },
];
const ALL_SCREENS = SHARE_SCREENS.map((s) => s.id);
const SHARE_RULES = [
  { m: ['GET'], re: /^\/(assets|export\/assets\.xlsx)$/, s: ['assets'] },
  { m: ['GET'], re: /^\/(yearly|export\/yearly\.xlsx|dividends\/yearly|divmgmt\/history)$/, s: ['yearly'] },
  { m: ['GET'], re: /^\/(holdings|groups)$/, s: ALL_SCREENS },
  { m: ['GET'], re: /^\/stocks\//, s: ALL_SCREENS },
  { m: ['GET'], re: /^\/search\/stocks$/, s: ALL_SCREENS },
  { m: ['GET'], re: /^\/holdings\/carry-candidates$/, s: ['holdings'] },
  { m: ['GET'], re: /^\/divmgmt(\/rounds)?$/, s: ['divmgmt'] },
  { m: ['POST', 'PUT', 'DELETE'], re: /^\/holdings\/(items|carry)$/, s: ['holdings'], edit: true },
  { m: ['POST', 'PUT', 'DELETE'], re: /^\/groups(\/\d+)?$/, s: ['holdings'], edit: true },
  { m: ['POST'], re: /^\/divmgmt\/rounds$/, s: ['divmgmt'], edit: true },
];

function cleanPerms(input) {
  const out = {};
  for (const sc of SHARE_SCREENS) {
    const v = input && input[sc.id];
    if (v === 'view' || (v === 'edit' && sc.edit)) out[sc.id] = v;
    else if (v === 'edit') out[sc.id] = 'view';
  }
  return out;
}
function sharePerms(ownerId, viewerId) {
  const row = db.get('SELECT perms FROM screen_shares WHERE owner_id = ? AND viewer_id = ?', [ownerId, viewerId]);
  if (!row) return null;
  try { return cleanPerms(JSON.parse(row.perms)); } catch (_) { return {}; }
}

router.use((req, res, next) => {
  const as = req.query && req.query.as;
  if (as == null || as === '') return next();
  const ownerId = Number(as);
  if (ownerId === req.user.id) return next();
  const perms = Number.isInteger(ownerId) ? sharePerms(ownerId, req.user.id) : null;
  if (!perms) return res.status(403).json({ error: '공유받지 않은 사용자의 데이터입니다.', code: 'FORBIDDEN' });
  const rule = SHARE_RULES.find((r) => r.m.includes(req.method) && r.re.test(req.path));
  const ok = rule && rule.s.some((sc) => (rule.edit ? perms[sc] === 'edit' : perms[sc] === 'view' || perms[sc] === 'edit'));
  if (!ok) {
    return res.status(403).json({ error: rule && rule.edit ? '이 화면은 조회 권한만 공유받았습니다.' : '공유받지 않은 화면입니다.', code: 'FORBIDDEN' });
  }
  const owner = db.get('SELECT id, email, created_at FROM users WHERE id = ?', [ownerId]);
  if (!owner) return res.status(403).json({ error: '공유한 사용자를 찾을 수 없습니다.', code: 'FORBIDDEN' });
  req.viewer = req.user;
  req.user = owner;
  next();
});

const shareOut = (r, emailKey) => {
  let perms = {};
  try { perms = cleanPerms(JSON.parse(r.perms)); } catch (_) { /* 무시 */ }
  return { id: r.id, user_id: r.uid, email: r[emailKey], perms, updated_at: r.updated_at };
};

router.get('/shares', (req, res) => {
  const given = db.all(
    `SELECT s.id, s.perms, s.updated_at, u.id AS uid, u.email FROM screen_shares s JOIN users u ON u.id = s.viewer_id
     WHERE s.owner_id = ? ORDER BY u.email`, [req.user.id]).map((r) => shareOut(r, 'email'));
  const received = db.all(
    `SELECT s.id, s.perms, s.updated_at, u.id AS uid, u.email FROM screen_shares s JOIN users u ON u.id = s.owner_id
     WHERE s.viewer_id = ? ORDER BY u.email`, [req.user.id]).map((r) => shareOut(r, 'email'))
    .filter((r) => Object.keys(r.perms).length);
  res.json({ screens: SHARE_SCREENS, given, received });
});

router.post('/shares', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const emailErr = validateEmail(email);
  if (emailErr) return res.status(400).json({ error: emailErr, code: 'VALIDATION', fields: { email: emailErr } });
  const viewer = db.get('SELECT id FROM users WHERE lower(email) = ?', [email]);
  if (!viewer) return res.status(400).json({ error: '등록되지 않은 이메일입니다. 상대방을 먼저 사용자로 추가해야 공유할 수 있습니다.', code: 'VALIDATION', fields: { email: '가입하지 않은 이메일입니다.' } });
  if (viewer.id === req.user.id) return res.status(400).json({ error: '본인에게는 공유할 수 없습니다.', code: 'VALIDATION', fields: { email: '본인 이메일입니다.' } });
  const perms = cleanPerms(req.body.perms);
  if (!Object.keys(perms).length) return res.status(400).json({ error: '공유할 화면을 하나 이상 고르세요.', code: 'VALIDATION' });
  db.run(
    `INSERT INTO screen_shares (owner_id, viewer_id, perms, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(owner_id, viewer_id) DO UPDATE SET perms = excluded.perms, updated_at = excluded.updated_at`,
    [req.user.id, viewer.id, JSON.stringify(perms), now(), now()]
  );
  res.json({ ok: true });
});

router.put('/shares/:id', (req, res) => {
  const row = db.get('SELECT id FROM screen_shares WHERE id = ? AND owner_id = ?', [Number(req.params.id), req.user.id]);
  if (!row) return res.status(404).json({ error: '공유 정보를 찾을 수 없습니다.', code: 'NOT_FOUND' });
  const perms = cleanPerms(req.body.perms);
  if (!Object.keys(perms).length) {
    db.run('DELETE FROM screen_shares WHERE id = ?', [row.id]);
    return res.json({ ok: true, removed: true });
  }
  db.run('UPDATE screen_shares SET perms = ?, updated_at = ? WHERE id = ?', [JSON.stringify(perms), now(), row.id]);
  res.json({ ok: true });
});

// 소유자는 준 공유를, 공유받은 사람은 받은 공유를 해제할 수 있다
router.delete('/shares/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = db.get('SELECT id FROM screen_shares WHERE id = ? AND (owner_id = ? OR viewer_id = ?)', [id, req.user.id, req.user.id]);
  if (!row) return res.status(404).json({ error: '공유 정보를 찾을 수 없습니다.', code: 'NOT_FOUND' });
  db.run('DELETE FROM screen_shares WHERE id = ?', [id]);
  res.json({ ok: true });
});

router.post('/auth/change-password', async (req, res) => {
  const user = db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
  if (!(await bcrypt.compare(String(req.body.current || ''), user.password_hash))) {
    throw new ValidationError('현재 비밀번호가 올바르지 않습니다.', { current: '현재 비밀번호가 올바르지 않습니다.' });
  }
  fieldErrors({ next: validatePassword(req.body.next) });
  db.run('UPDATE users SET password_hash = ? WHERE id = ?', [await bcrypt.hash(String(req.body.next), 10), user.id]);
  res.json({ ok: true });
});

// 사용자 삭제(회원 탈퇴): 계정·보유 종목·배당 내역 삭제 (FR-AUTH-04, NFR-PRI-01)
router.delete('/auth/account', async (req, res) => {
  const user = db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
  if (!(await bcrypt.compare(String(req.body.password || ''), user.password_hash))) {
    throw new ValidationError('비밀번호가 올바르지 않습니다.', { password: '비밀번호가 올바르지 않습니다.' });
  }
  db.tx(() => {
    db.run('DELETE FROM holdings WHERE user_id = ?', [user.id]);
    db.run('DELETE FROM holding_trades WHERE user_id = ?', [user.id]);
    db.run('DELETE FROM holding_items WHERE user_id = ?', [user.id]);
    db.run('DELETE FROM holding_dividends WHERE user_id = ?', [user.id]);
    db.run('DELETE FROM user_settings WHERE user_id = ?', [user.id]);
    db.run('DELETE FROM holding_groups WHERE user_id = ?', [user.id]);
    db.run('DELETE FROM stock_categories WHERE user_id = ?', [user.id]);
    db.run('DELETE FROM dividends WHERE user_id = ?', [user.id]);
    db.run('DELETE FROM screen_shares WHERE owner_id = ? OR viewer_id = ?', [user.id, user.id]);
    db.run('DELETE FROM sessions WHERE user_id = ?', [user.id]);
    db.run('DELETE FROM reset_tokens WHERE user_id = ?', [user.id]);
    db.run('DELETE FROM users WHERE id = ?', [user.id]);
  });
  auth.destroySession(req, res);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// 종목 조회 (3.2)
// ---------------------------------------------------------------------------
// 종목명·종목코드 검색 (v0.21): 네이버 자동완성 → (영문이면) 야후 검색 → 이미 저장된 종목 순으로 합친다
const providers = require('../providers');
const searchCache = new Map();
router.get('/search/stocks', async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 40);
  if (!q) return res.json({ items: [] });
  const key = q.toLowerCase();
  const hit = searchCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return res.json({ items: hit.items, cached: true });
  const seen = new Set();
  const items = [];
  const add = (list) => list.forEach((it) => { if (!seen.has(it.code) && items.length < 12) { seen.add(it.code); items.push(it); } });
  let remote = 0;
  let failed = 0;
  const fns = providers.search || [];
  for (const fn of fns) {
    if (items.length >= 8) break;
    let term = q;
    if (fn !== fns[0] && /[가-힣]/.test(q)) {
      // 한글은 네이버가 담당. 네이버가 안 되면 영문·숫자 부분(예: ‘BNK금융지주’ → BNK)만 야후로 찾아 본다
      if (remote) continue;
      term = (q.match(/[A-Za-z0-9&]{2,}/g) || []).join(' ');
      if (!term) continue;
    }
    try { const r = await fn(term); remote += r.length; add(r); } catch (_) { failed += 1; }
  }
  const like = `%${q.replace(/[%_]/g, '')}%`;
  add(db.all('SELECT code, name, market, currency FROM instruments WHERE name LIKE ? OR code LIKE ? ORDER BY name LIMIT 12', [like, `${q.toUpperCase()}%`])
    .map((r) => ({ code: r.code, name: r.name, market: r.market, nation: r.currency === 'USD' ? 'US' : 'KR', source: 'local' })));
  if (remote) searchCache.set(key, { at: Date.now(), items });
  if (searchCache.size > 300) searchCache.delete(searchCache.keys().next().value);
  // 외부 검색 출처에 하나도 연결되지 않았으면 알려 준다(저장된 종목에서만 찾은 결과)
  res.json({ items, offline: fns.length > 0 && failed >= 1 && !remote });
});

router.get('/stocks/:code', async (req, res) => {
  const q = await market.getQuote(req.params.code, { force: req.query.refresh === '1' });
  // 회원의 종목 분류 (등록 화면 기본값). 저장값이 없으면 추천값
  res.json({ ...q, category: categories.categoryOf(req.user.id, q.instrument.code, q.instrument) });
});

router.get('/stocks/:code/prices', async (req, res) => {
  const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : today();
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : to;
  if (from > to) throw new ValidationError('시작일이 종료일보다 늦습니다.', { from: '시작일이 종료일보다 늦습니다.' });
  res.json({ from, to, ...(await market.getPeriod(req.params.code, from, to)) });
});

// 투자지표·분기 실적 (v0.26.6, FR-STK-09): 국내 상장 기업만. 6시간 캐시
const fundCache = new Map();
router.get('/stocks/:code/fundamentals', async (req, res) => {
  const code = String(req.params.code || '').toUpperCase();
  if (!/^[0-9][0-9A-Z]{5}$/.test(code) || !providers.fundamentals) return res.json({ available: false, reason: 'notDomestic' });
  const hit = fundCache.get(code);
  if (hit && Date.now() - hit.at < 6 * 3600 * 1000 && req.query.refresh !== '1') return res.json(hit.data);
  let data;
  try {
    const f = await providers.fundamentals(code);
    const hasFin = f.quarters.length || f.annual.length;
    data = { available: true, ...f, reason: hasFin ? null : 'noFinance', fetchedAt: new Date().toISOString() };
  } catch (e) {
    if (hit) return res.json({ ...hit.data, stale: true });
    return res.json({ available: false, reason: 'source', message: e.message });
  }
  if (fundCache.size > 300) fundCache.delete(fundCache.keys().next().value);
  fundCache.set(code, { at: Date.now(), data });
  res.json(data);
});

// 배당금 지급내역 팝업 (FR-STK-08)
router.get('/stocks/:code/dividends', async (req, res) => {
  res.json(await portfolio.getStockDividends(req.user.id, req.params.code, { force: req.query.refresh === '1' }));
});

// ---------------------------------------------------------------------------
// 보유 종목 (3.3) — 연도별 매수·매도 기록 (v0.5). 모든 쿼리에 user_id 조건 (FR-AUTH-05)
// ---------------------------------------------------------------------------
const positions = require('../services/positions');
const thisYear = () => new Date().getFullYear();
const MIN_YEAR = 1990;

function instInfo(code) {
  return db.get('SELECT name, market, type, currency FROM instruments WHERE code = ?', [code]) || {};
}

// 그 해의 주식 항목 (그룹 선택 가능) + 연말 보유 종목 합계(배당 화면 종목 목록 등에 사용) (v0.8)
// 각 항목: 수량·평균 매입단가(그 해 말), 이월 여부(전년 말에도 보유), 평가금액(올해 현재가 / 지난 연도 연말 종가)
// 그 해 항목에 저장한 숫자 칸 계산식 (v0.26.7)
function parseFormulas(userId, groupId, code, year) {
  const r = db.get('SELECT formulas FROM holding_items WHERE user_id = ? AND group_id = ? AND code = ? AND year = ?', [userId, groupId, code, year]);
  if (!r || !r.formulas) return null;
  try { return JSON.parse(r.formulas); } catch (_) { return null; }
}
router.get('/holdings', async (req, res) => {
  const ty = thisYear();
  const year = Math.min(Number(req.query.year) || ty, ty);
  const groups = positions.groupsOf(req.user.id);
  const gid = groups.some((g) => g.id === Number(req.query.group)) ? Number(req.query.group) : null;
  const gname = new Map(groups.map((g) => [g.id, g.name]));
  const order = new Map(groups.map((g, i) => [g.id, i]));
  const list = positions.totalsAt(req.user.id, year).map((p) => ({ code: p.code, quantity: p.quantity, avg_price: p.avgPrice, ...instInfo(p.code) }));
  const saved = categories.savedMap(req.user.id);
  const pos = positions.positionsAt(req.user.id, year, { groupId: gid })
    .sort((a, b) => (order.get(a.groupId) ?? 99) - (order.get(b.groupId) ?? 99));

  // 종목 정보(이름·구분)를 적재한 뒤 표시. 매입금액 = 수량 × 평균 매입단가 (거래 통화)
  const allItems = positions.itemsOf(req.user.id);
  const items = await portfolio.mapLimit(pos, 5, async (p) => {
    let inst = instInfo(p.code);
    try { inst = market.publicInstrument(await market.ensureInstrument(p.code)); } catch (_) { /* 저장된 정보로 표시 */ }
    const c = categories.categoryOf(req.user.id, p.code, inst, saved);
    // 1월 1일 기준 매입금액(이월분은 전년 마지막 종가) · 올해 실현손익 (v0.10)
    const sc = market.yearEndClose(p.code, year - 1);
    const yb = positions.yearBase(allItems, p.groupId, p.code, year, sc ? sc.close : null);
    const pp = positions.pnlParts(allItems, p.groupId, p.code, year, null);
    return {
      // 이월액 (v0.11): 고정값(일괄이월·등록·수정 때 저장) 또는 전년 말 수량 × 전년 종가
      carry_amount: yb.carry, carry_fixed: yb.fixed, carry_auto: yb.autoCarry ?? null, new_buys: yb.newBuys, carry_has_prev: !!yb.hasPrev, carry_mode_saved: p.carryMode,
      basis_carried_qty: yb.carriedQty, basis_start_close: yb.carriedQty > 0 && sc ? sc.close : null, basis_start_date: sc ? sc.date : null,
      realized_pnl: p.itemYear === year ? p.realized : null, realized_cum: pp.realizedCum,
      group_id: p.groupId, group_name: gname.get(p.groupId) || '-', code: p.code,
      name: inst.name, market: inst.market, type: inst.type, currency: inst.currency,
      quantity: p.quantity, avg_price: p.avgPrice, purchase_amount: p.quantity * p.avgPrice,
      memo: p.memo, created_at: p.createdAt, updated_at: p.lastTradeAt,
      formulas: p.itemYear === year ? parseFormulas(req.user.id, p.groupId, p.code, year) : null,
      carried: p.carried, carry_mode: p.carryMode, item_year: p.itemYear, category: c.id, category_label: c.label,
    };
  });
  const range = positions.tradeYearRange(req.user.id);
  res.json({ year, groupId: gid, groups, yearRange: { min: Math.min(range.min || ty, ty - 9), max: ty }, holdings: list, items });
});

// ---------------------------------------------------------------------------
// 배당금 관리 (v0.13, SC-08): 그룹별 보유 종목의 배당 회차를 선택해 저장하고 연간 누적
// ---------------------------------------------------------------------------
function divYear(q) {
  const ty = thisYear();
  const y = Number(q);
  return Number.isInteger(y) && y >= MIN_YEAR && y <= ty ? y : ty;
}

router.get('/divmgmt', async (req, res) => {
  const ty = thisYear();
  const year = divYear(req.query.year);
  // 월 기간 (v0.13.6): 기본 1월 ~ (올해는 이번 달, 지난 연도는 12월). 배당락일 기준
  const curMonth = Number(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul', month: 'numeric' }));
  const mClamp = (v, d) => { const n = Number(v); return Number.isInteger(n) && n >= 1 && n <= 12 ? n : d; };
  let fromM = mClamp(req.query.from, 1);
  let toM = mClamp(req.query.to, year >= ty ? curMonth : 12);
  if (fromM > toM) [fromM, toM] = [toM, fromM];
  const mm = (n) => String(n).padStart(2, '0');
  const dFrom = `${year}-${mm(fromM)}-01`;
  const dTo = `${year}-${mm(toM)}-31`;
  const groups = positions.groupsOf(req.user.id);
  const gid = groups.some((g) => g.id === Number(req.query.group)) ? Number(req.query.group) : null;
  const gname = new Map(groups.map((g) => [g.id, g.name]));
  const order = new Map(groups.map((g, i) => [g.id, i]));
  const pos = positions.positionsAt(req.user.id, year, { groupId: gid })
    .sort((a, b) => (order.get(a.groupId) ?? 99) - (order.get(b.groupId) ?? 99));
  // 소계·합계용 원화 환산 환율 (v0.13.5): 올해는 현재 환율, 지난 연도는 연말 환율
  let fxRate = null;
  try { const fx = await market.getCurrentFx(); fxRate = fx ? fx.rate : null; } catch (_) { /* 저장된 환율 사용 */ }
  if (year < ty || fxRate == null) { const r = market.fxOn(`${year}-12-31`); if (r && (year < ty || fxRate == null)) fxRate = r.rate; }
  const items = await portfolio.mapLimit(pos, 5, async (p) => {
    let inst = instInfo(p.code);
    let price = null;
    let priceTime = null;
    try {
      if (year >= ty) {
        const q = await market.getQuote(p.code);
        inst = q.instrument; price = q.price; priceTime = q.priceTime;
      } else {
        inst = market.publicInstrument(await market.ensureInstrument(p.code));
        const c = market.yearEndClose(p.code, year);
        if (c) { price = c.close; priceTime = c.date; }
      }
    } catch (_) { /* 시세 없으면 '-' */ }
    const last = db.get(
      'SELECT ex_date, amount, tax_amount, quantity FROM holding_dividends WHERE user_id = ? AND group_id = ? AND code = ? AND ex_date BETWEEN ? AND ? ORDER BY ex_date DESC LIMIT 1',
      [req.user.id, p.groupId, p.code, dFrom, dTo]
    );
    const ytd = db.get(
      'SELECT COUNT(*) AS n, SUM(amount) AS amount, SUM(tax_amount) AS tax, SUM(CASE WHEN tax_amount IS NULL THEN 1 ELSE 0 END) AS taxMissing FROM holding_dividends WHERE user_id = ? AND group_id = ? AND code = ? AND ex_date BETWEEN ? AND ?',
      [req.user.id, p.groupId, p.code, dFrom, dTo]
    );
    const rate = inst.currency === 'USD' ? fxRate : 1;
    const k = (v) => (v == null || rate == null ? null : v * rate);
    const value = price == null ? null : price * p.quantity;
    const ytdTax = ytd.n ? (ytd.taxMissing ? null : ytd.tax) : 0;
    return {
      group_id: p.groupId, group_name: gname.get(p.groupId) || '-', code: p.code,
      name: inst.name, type: inst.type, currency: inst.currency, market: inst.market,
      quantity: p.quantity, price, price_time: priceTime, value,
      last: last ? { ex_date: last.ex_date, amount: last.amount, tax: last.tax_amount, quantity: last.quantity } : null,
      ytd_count: ytd.n, ytd_amount: ytd.n ? ytd.amount : 0, ytd_tax: ytdTax,
      // 원화 환산 (소계·합계용)
      fx_rate: rate,
      krw: { value: k(value), last: last ? k(last.amount) : null, last_tax: last ? k(last.tax_amount) : null, ytd: k(ytd.n ? ytd.amount : 0), ytd_tax: k(ytdTax) },
    };
  });
  res.json({ year, ongoing: year >= ty, fromMonth: fromM, toMonth: toM, groupId: gid, groups, yearRange: { min: ty - 9, max: ty }, fxRate, items });
});

// 배당 회차 목록: 종목 배당 내역(최근 10년)을 불러와 선택 연도의 회차를 보여 주고, 저장한 회차는 표시
router.get('/divmgmt/rounds', async (req, res) => {
  const year = divYear(req.query.year);
  const groupId = Number(req.query.group);
  const code = market.normalizeCode(req.query.code);
  const d = await portfolio.getStockDividends(req.user.id, code, {});
  const held = positions.positionsAt(req.user.id, year, { groupId }).find((p) => p.code === code);
  const saved = new Map(db.all('SELECT * FROM holding_dividends WHERE user_id = ? AND group_id = ? AND code = ?', [req.user.id, groupId, code]).map((r) => [r.ex_date, r]));
  const evs = d.events.slice().sort((a, b) => (a.exDate < b.exDate ? -1 : 1));
  const seq = {};
  const rounds = evs.map((e) => {
    const y = Number(e.exDate.slice(0, 4));
    seq[y] = (seq[y] || 0) + 1;
    const ref = market.closeBefore(d.instrument.code, e.exDate);
    const s0 = saved.get(e.exDate);
    return {
      year: y, seq: seq[y], ex_date: e.exDate, pay_date: e.payDate || null, per_share: e.amount, tax_per_share: e.taxBase ?? null,
      ref_close: ref ? ref.close : null, ref_date: ref ? ref.date : null, yield_pct: ref && ref.close ? e.amount / ref.close : null,
      saved: s0 ? { quantity: s0.quantity, amount: s0.amount, tax: s0.tax_amount } : null,
    };
  });
  const years = [...new Set(rounds.map((r) => r.year))].sort((a, b) => b - a);
  res.json({
    instrument: d.instrument, year, groupId, quantity: held ? held.quantity : 0, years,
    rounds: rounds.filter((r) => r.year === year).reverse(), taxBaseNote: d.taxBaseNote, taxError: d.taxError,
    source: d.source, loadedAt: d.loadedAt, stale: d.stale, staleReason: d.staleReason,
  });
});

// 배당 내역 조회 (v0.14): 배당금 관리에서 저장한 회차를 지급일(없으면 배당락일) 기간으로 조회
router.get('/divmgmt/history', (req, res) => {
  const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
  const ty = thisYear();
  const from = isDate(req.query.from) ? req.query.from : `${ty}-01-01`;
  const to = isDate(req.query.to) ? req.query.to : new Date().toISOString().slice(0, 10);
  const code = req.query.code ? market.normalizeCode(req.query.code) : null;
  const groups = new Map(positions.groupsOf(req.user.id).map((g) => [g.id, g.name]));
  const rows = db.all(
    `SELECT h.*, COALESCE(h.pay_date, h.ex_date) AS paid, i.name, i.type, i.currency FROM holding_dividends h
     LEFT JOIN instruments i ON i.code = h.code
     WHERE h.user_id = ? AND COALESCE(h.pay_date, h.ex_date) BETWEEN ? AND ? ${code ? 'AND h.code = ?' : ''}
     ORDER BY paid DESC, h.code`,
    [req.user.id, from, to, ...(code ? [code] : [])]
  ).map((r) => {
    const fx = r.currency === 'USD' ? market.fxOn(r.paid) : null;
    const rate = r.currency === 'USD' ? (fx ? fx.rate : null) : 1;
    const k = (v) => (v == null || rate == null ? null : v * rate);
    return {
      id: r.id, paid: r.paid, pay_date: r.pay_date, ex_date: r.ex_date, code: r.code, name: r.name || r.code, type: r.type, currency: r.currency || 'KRW',
      group_name: groups.get(r.group_id) || '-', quantity: r.quantity, per_share: r.per_share, amount: r.amount, tax_amount: r.tax_amount,
      fx_rate: rate, amount_krw: k(r.amount), tax_krw: k(r.tax_amount),
    };
  });
  res.json({ from, to, code, rows });
});

// 선택 회차 저장: 그 연도의 저장 내역을 선택한 회차로 바꾼다 (주당 금액은 서버의 배당 내역 값 사용)
router.post('/divmgmt/rounds', async (req, res) => {
  const year = divYear(req.body.year);
  const groupId = Number(req.body.groupId);
  const code = market.normalizeCode(req.body.code);
  if (!db.get('SELECT id FROM holding_groups WHERE id = ? AND user_id = ?', [groupId, req.user.id])) {
    return res.status(400).json({ error: '그룹을 확인해 주세요.', code: 'VALIDATION' });
  }
  const list = Array.isArray(req.body.rounds) ? req.body.rounds : [];
  const d = await portfolio.getStockDividends(req.user.id, code, {});
  const byDate = new Map(d.events.map((e) => [e.exDate, e]));
  const rows = [];
  const fields = {};
  for (const r of list) {
    const e = byDate.get(String(r.exDate));
    if (!e || Number(e.exDate.slice(0, 4)) !== year) continue;
    const q = positiveNumber(r.quantity, { maxDecimals: 6 });
    if (q.error) { fields[`qty_${e.exDate}`] = q.error; continue; }
    const tax = e.taxBase ?? null;
    rows.push([req.user.id, groupId, d.instrument.code, e.exDate, e.payDate || null, e.amount, tax, q.value, q.value * e.amount, tax == null ? null : q.value * tax, now(), now()]);
  }
  if (Object.keys(fields).length) return res.status(400).json({ error: '보유수량을 확인해 주세요.', code: 'VALIDATION', fields });
  db.tx(() => {
    db.run('DELETE FROM holding_dividends WHERE user_id = ? AND group_id = ? AND code = ? AND ex_date BETWEEN ? AND ?', [req.user.id, groupId, d.instrument.code, `${year}-01-01`, `${year}-12-31`]);
    for (const r of rows) {
      db.run(`INSERT INTO holding_dividends (user_id, group_id, code, ex_date, pay_date, per_share, tax_per_share, quantity, amount, tax_amount, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, r);
    }
  });
  res.json({ ok: true, saved: rows.length, amount: rows.reduce((a, r) => a + r[8], 0) });
});

// 주식 항목 등록·수정 (v0.8): 매수·매도 구분 없이 그 해 말 보유 수량·평균 매입단가를 바로 저장
async function validateItem(body, userId) {
  let code = null;
  let codeErr = null;
  try {
    code = market.validateCode(body.code).code;
  } catch (e) {
    codeErr = e.fields.code;
  }
  const year = Number(body.year);
  const yearErr = Number.isInteger(year) && year >= MIN_YEAR && year <= thisYear() ? null : `연도는 ${MIN_YEAR}년부터 올해까지 선택할 수 있습니다.`;
  const groupId = Number(body.groupId);
  const group = db.get('SELECT id FROM holding_groups WHERE id = ? AND user_id = ?', [groupId, userId]);
  const category = categories.IDS.includes(body.category) ? body.category : null;
  const q = positiveNumber(body.quantity, { maxDecimals: 6 });
  // 매입금액을 받으면 평균 매입단가 = 매입금액 ÷ 수량 (v0.8.1). 매입금액이 없으면 평균 매입단가를 그대로 받는다
  const hasAmount = String(body.purchaseAmount ?? '').trim() !== '';
  const amt = hasAmount ? positiveNumber(body.purchaseAmount) : { value: null };
  const p = hasAmount ? { value: amt.value && q.value ? amt.value / q.value : null } : positiveNumber(body.avgPrice);
  const carryMode = body.carryMode === 'CARRIED' || body.carryMode === 'NEW' ? body.carryMode : null;
  // 실현손익: 요청에 칸이 없으면(수정 화면에서 제외, v0.12) 기존 값 유지
  const realized = body.realizedPnl === undefined ? { value: undefined } : signedAmount(body.realizedPnl);
  // 이월액 (선택, v0.11): 0 이상, 비우면 기존 고정값 유지(없으면 저장 때 한 번 계산해 고정)
  const carryRaw = String(body.carryAmount ?? '').trim().replace(/,/g, '');
  // 칸이 아예 없으면(undefined, 예: 일괄이월) 기존 고정값 유지, 칸을 비워 보내면(null) 이월 수량 × 전년 종가로 다시 계산
  const carry = body.carryAmount === undefined ? { value: undefined } : !carryRaw ? { value: null } : /^\d+(\.\d{1,4})?$/.test(carryRaw) ? { value: Number(carryRaw) } : { error: '0 이상의 숫자를 입력해 주세요.' };
  // 이월 수량 (선택, v0.12.3): 전년 항목 없이 이월로 등록할 때만 사용 (‘-’·빈 값은 미입력)
  const cqRaw = String(body.carriedQty ?? '').trim().replace(/,/g, '');
  const cq = !cqRaw || cqRaw === '-' ? { value: null } : /^\d+(\.\d{1,6})?$/.test(cqRaw) ? { value: Number(cqRaw) } : { error: '0 이상의 숫자를 입력해 주세요(소수 6자리까지).' };
  const memo = String(body.memo || '');
  // 숫자 칸 계산식 (v0.26.7): '=' 로 시작하고 숫자·사칙연산·괄호만, 칸마다 100자 이내. 계산은 화면에서 하고 결과값을 함께 보낸다
  const FORMULA_FIELDS = ['quantity', 'purchaseAmount', 'carryAmount', 'carriedQty'];
  const formulas = {};
  if (body.formulas && typeof body.formulas === 'object') {
    for (const k of FORMULA_FIELDS) {
      const f = String(body.formulas[k] ?? '').trim();
      if (/^=[\d\s.,+\-*/()×÷]{1,99}$/.test(f)) formulas[k] = f;
    }
  }
  fieldErrors({
    groupId: group ? null : '그룹을 선택해 주세요.',
    code: codeErr,
    category: category ? null : '국내·해외·해외추종 중 하나를 선택해 주세요.',
    year: yearErr,
    quantity: q.error,
    purchaseAmount: hasAmount ? amt.error : null,
    avgPrice: hasAmount ? null : p.error,
    carryMode: carryMode ? null : '이월 또는 신규를 선택해 주세요.',
    realizedPnl: realized.error || null,
    carryAmount: carry.error || null,
    carriedQty: cq.error || null,
    memo: memo.length > 200 ? '메모는 200자 이내로 입력해 주세요.' : null,
  });
  const inst = await market.ensureInstrument(code); // 없는 코드면 NOT_FOUND
  return { code: inst.code, groupId, category, carryMode, year, quantity: q.value, avgPrice: p.value, memo: memo || null, realizedPnl: realized.value, carryAmount: carry.value, carryQty: cq.value, formulas: Object.keys(formulas).length ? JSON.stringify(formulas) : null };
}

// 이월액 결정 (v0.11): 이월이면 입력값 → 기존 고정값 → (처음) 전년 말 수량 × 전년 마지막 종가로 계산해 고정. 신규면 없음
function resolveCarry(userId, v) {
  if (v.carryMode !== 'CARRIED') return null;
  if (v.carryAmount != null) return v.carryAmount;
  if (v.carryAmount === undefined) {
    const ex = db.get('SELECT carry_amount FROM holding_items WHERE user_id = ? AND group_id = ? AND code = ? AND year = ?', [userId, v.groupId, v.code, v.year]);
    if (ex && ex.carry_amount != null) return ex.carry_amount;
  }
  const prev = positions.stateAt(positions.itemsOf(userId), v.year - 1).get(`${v.groupId}|${v.code}`);
  const sc = market.yearEndClose(v.code, v.year - 1);
  if (prev && prev.quantity > 0) return sc ? prev.quantity * sc.close : prev.cost;
  const cq = v.carryQty != null ? v.carryQty : v.quantity;
  return sc ? cq * sc.close : cq * v.avgPrice;
}

// 이월 수량 저장 (v0.12.3): 전년 말 보유가 없을 때만 입력값 → 기존 값. 전년 보유가 있으면 전년 말 수량을 쓰므로 저장하지 않음
function resolveCarryQty(userId, v) {
  if (v.carryMode !== 'CARRIED') return null;
  const prev = positions.stateAt(positions.itemsOf(userId), v.year - 1).get(`${v.groupId}|${v.code}`);
  if (prev && prev.quantity > 0) return null;
  if (v.carryQty != null) return v.carryQty;
  const ex = db.get('SELECT carry_qty FROM holding_items WHERE user_id = ? AND group_id = ? AND code = ? AND year = ?', [userId, v.groupId, v.code, v.year]);
  return ex ? ex.carry_qty : null;
}

function upsertItem(userId, v) {
  const carry = resolveCarry(userId, v);
  const carryQty = resolveCarryQty(userId, v);
  let realized = v.realizedPnl ?? null;
  if (v.realizedPnl === undefined) {
    const ex = db.get('SELECT realized_pnl FROM holding_items WHERE user_id = ? AND group_id = ? AND code = ? AND year = ?', [userId, v.groupId, v.code, v.year]);
    realized = ex ? ex.realized_pnl : null;
  }
  db.run(
    `INSERT INTO holding_items (user_id, group_id, code, year, quantity, avg_price, memo, carry_mode, realized_pnl, carry_amount, carry_qty, formulas, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, group_id, code, year) DO UPDATE SET quantity = excluded.quantity, avg_price = excluded.avg_price,
       memo = excluded.memo, carry_mode = excluded.carry_mode, realized_pnl = excluded.realized_pnl, carry_amount = excluded.carry_amount, carry_qty = excluded.carry_qty, formulas = excluded.formulas, updated_at = excluded.updated_at`,
    [userId, v.groupId, v.code, v.year, v.quantity, v.avgPrice, v.memo, v.carryMode, realized, carry, carryQty, v.formulas ?? null, now(), now()]
  );
  categories.setCategory(userId, v.code, v.category); // 종목 분류는 회원·종목별로 하나
}

// 등록: 같은 그룹에 이미 보유 중(그 해 등록 또는 이월)이면 수정하도록 안내 (FR-HLD-03)
router.post('/holdings/items', async (req, res) => {
  const v = await validateItem(req.body, req.user.id);
  const cur = positions.positionsAt(req.user.id, v.year, { groupId: v.groupId }).find((p) => p.code === v.code);
  if (cur) {
    return res.status(409).json({
      error: `이미 ${v.year}년에 보유 중인 종목입니다${cur.carried ? '(이월)' : ''}. 목록에서 수정을 눌러 수량을 바꿔 주세요.`,
      code: 'DUPLICATE', fields: { code: '이미 보유 중인 종목입니다.' },
    });
  }
  upsertItem(req.user.id, v);
  res.json({ ok: true });
});

// 수정: 그 해 말 수량·평균 매입단가를 바로 바꾼다 (그룹·종목은 바꾸지 않음)
router.put('/holdings/items', async (req, res) => {
  const v = await validateItem(req.body, req.user.id);
  upsertItem(req.user.id, v);
  res.json({ ok: true });
});

// 삭제: 그 해부터 보유하지 않음. 그 해에 처음 등록한 종목이면 항목을 지우고, 이월 종목이면 수량 0 항목을 남긴다
router.delete('/holdings/items', (req, res) => {
  const year = Number(req.query.year);
  const groupId = Number(req.query.groupId);
  const code = market.normalizeCode(req.query.code);
  const cur = positions.positionsAt(req.user.id, year, { groupId }).find((p) => p.code === code);
  if (!cur) return res.status(404).json({ error: '주식 항목을 찾을 수 없습니다.', code: 'NOT_FOUND' });
  // 전량 매도의 실현손익 (선택, v0.10): 입력하면 수량 0 항목에 남겨 올해·전체기간 손익에 반영
  const realized = signedAmount(req.query.realizedPnl);
  fieldErrors({ realizedPnl: realized.error || null });
  // 이월 표시와 관계없이, 실제로 전년 말 보유 항목이 있으면 수량 0 항목을 남겨야 그 해부터 보유하지 않게 된다
  const prevHeld = positions.stateAt(positions.itemsOf(req.user.id), year - 1).get(`${groupId}|${code}`);
  if ((prevHeld && prevHeld.quantity > 0) || realized.value != null) {
    db.run(
      `INSERT INTO holding_items (user_id, group_id, code, year, quantity, avg_price, memo, realized_pnl, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, NULL, '전량 매도', ?, ?, ?)
       ON CONFLICT(user_id, group_id, code, year) DO UPDATE SET quantity = 0, avg_price = NULL, memo = '전량 매도', formulas = NULL, realized_pnl = excluded.realized_pnl, updated_at = excluded.updated_at`,
      [req.user.id, groupId, code, year, realized.value, now(), now()]
    );
  } else {
    db.run('DELETE FROM holding_items WHERE user_id = ? AND group_id = ? AND code = ? AND year = ?', [req.user.id, groupId, code, year]);
  }
  res.json({ ok: true });
});

// 전년도 일괄 이월 (v0.9): 전년 말 보유 종목 목록과 올해 상태
//  - status REGISTERED: 올해 항목을 이미 등록함(선택 불가)
//  - status AUTO: 올해 항목은 없고 전년 보유가 자동으로 이어지는 중
//  - status REMOVED: 올해 삭제(전량 매도) 처리됨
router.get('/holdings/carry-candidates', async (req, res) => {
  const year = Number(req.query.year);
  if (!Number.isInteger(year) || year <= MIN_YEAR || year > thisYear()) {
    return res.status(400).json({ error: '연도를 확인해 주세요.', code: 'VALIDATION' });
  }
  const groups = positions.groupsOf(req.user.id);
  const gid = groups.some((g) => g.id === Number(req.query.group)) ? Number(req.query.group) : null;
  const gname = new Map(groups.map((g) => [g.id, g.name]));
  const order = new Map(groups.map((g, i) => [g.id, i]));
  const cur = positions.stateAt(positions.itemsOf(req.user.id), year);
  const saved = categories.savedMap(req.user.id);
  const prev = positions.positionsAt(req.user.id, year - 1, { groupId: gid })
    .sort((a, b) => (order.get(a.groupId) ?? 99) - (order.get(b.groupId) ?? 99));
  const items = await portfolio.mapLimit(prev, 5, async (p) => {
    let inst = instInfo(p.code);
    try { inst = market.publicInstrument(await market.ensureInstrument(p.code)); } catch (_) { /* 저장된 정보로 표시 */ }
    const c = categories.categoryOf(req.user.id, p.code, inst, saved);
    const now_ = cur.get(`${p.groupId}|${p.code}`);
    const status = now_ && now_.itemYear === year ? (now_.quantity > 0 ? 'REGISTERED' : 'REMOVED') : 'AUTO';
    return {
      group_id: p.groupId, group_name: gname.get(p.groupId) || '-', code: p.code,
      name: inst.name, type: inst.type, currency: inst.currency, category: c.id, category_label: c.label,
      quantity: p.quantity, avg_price: p.avgPrice, purchase_amount: p.quantity * p.avgPrice, memo: p.memo, status,
    };
  });
  res.json({ year, fromYear: year - 1, groupId: gid, items });
});

// 선택한 전년도 종목을 올해 이월 종목으로 일괄 등록: 전년 말 수량·평균 매입단가·메모를 그대로 올해 항목으로 저장
router.post('/holdings/carry', (req, res) => {
  const year = Number(req.body.year);
  const list = Array.isArray(req.body.items) ? req.body.items : [];
  if (!Number.isInteger(year) || year <= MIN_YEAR || year > thisYear()) {
    return res.status(400).json({ error: '연도를 확인해 주세요.', code: 'VALIDATION' });
  }
  if (!list.length) return res.status(400).json({ error: '이월할 종목을 하나 이상 선택해 주세요.', code: 'VALIDATION' });
  const all = positions.itemsOf(req.user.id);
  const prev = positions.stateAt(all, year - 1);
  const cur = positions.stateAt(all, year);
  const saved = categories.savedMap(req.user.id);
  let added = 0;
  const skipped = [];
  for (const x of list) {
    const code = market.normalizeCode(x.code);
    const k = `${Number(x.groupId)}|${code}`;
    const p = prev.get(k);
    if (!p || !(p.quantity > 0)) { skipped.push({ code, reason: '전년 말 보유 종목이 아닙니다.' }); continue; }
    const c = cur.get(k);
    if (c && c.itemYear === year && c.quantity > 0) { skipped.push({ code, reason: '이미 등록된 종목입니다.' }); continue; }
    const category = categories.categoryOf(req.user.id, code, instInfo(code), saved).id;
    upsertItem(req.user.id, { groupId: p.groupId, code, year, quantity: p.quantity, avgPrice: p.avgPrice, memo: p.memo || null, carryMode: 'CARRIED', category });
    added++;
  }
  res.json({ ok: true, added, skipped });
});

// ---------------------------------------------------------------------------
// 보유 종목 그룹 (v0.6): ISA·연금·일반 등 회원이 직접 만드는 그룹
// ---------------------------------------------------------------------------
function validateGroupName(raw, userId, excludeId) {
  const name = String(raw || '').trim();
  let err = null;
  if (!name) err = '그룹 이름을 입력해 주세요.';
  else if (name.length > 20) err = '그룹 이름은 20자 이내로 입력해 주세요.';
  else if (db.get('SELECT id FROM holding_groups WHERE user_id = ? AND name = ? AND id <> ?', [userId, name, excludeId || 0])) err = '이미 있는 그룹 이름입니다.';
  fieldErrors({ name: err });
  return name;
}

router.get('/groups', (req, res) => {
  const groups = positions.groupsOf(req.user.id).map((g) => ({
    ...g, tradeCount: db.get('SELECT COUNT(*) AS n FROM holding_items WHERE user_id = ? AND group_id = ? AND quantity > 0', [req.user.id, g.id]).n,
  }));
  res.json({ groups });
});

router.post('/groups', (req, res) => {
  const name = validateGroupName(req.body.name, req.user.id);
  const max = db.get('SELECT COALESCE(MAX(sort_order), -1) AS m FROM holding_groups WHERE user_id = ?', [req.user.id]).m;
  const { lastId } = db.run('INSERT INTO holding_groups (user_id, name, sort_order, created_at) VALUES (?, ?, ?, ?)', [req.user.id, name, max + 1, now()]);
  res.json({ id: lastId });
});

router.put('/groups/:id', (req, res) => {
  const g = db.get('SELECT * FROM holding_groups WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  if (!g) return res.status(404).json({ error: '그룹을 찾을 수 없습니다.', code: 'NOT_FOUND' });
  const name = validateGroupName(req.body.name, req.user.id, g.id);
  db.run('UPDATE holding_groups SET name = ? WHERE id = ? AND user_id = ?', [name, g.id, req.user.id]);
  res.json({ ok: true });
});

router.delete('/groups/:id', (req, res) => {
  const g = db.get('SELECT * FROM holding_groups WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  if (!g) return res.status(404).json({ error: '그룹을 찾을 수 없습니다.', code: 'NOT_FOUND' });
  const n = db.get('SELECT COUNT(*) AS n FROM holding_items WHERE user_id = ? AND group_id = ? AND quantity > 0', [req.user.id, g.id]).n;
  if (n) {
    return res.status(400).json({ error: `‘${g.name}’ 그룹에 주식 항목이 ${n}건 있어 삭제할 수 없습니다. 항목을 삭제한 뒤 다시 시도해 주세요.`, code: 'VALIDATION' });
  }
  db.run('DELETE FROM holding_items WHERE user_id = ? AND group_id = ?', [req.user.id, g.id]); // 수량 0 항목 정리
  if (db.get('SELECT COUNT(*) AS n FROM holding_groups WHERE user_id = ?', [req.user.id]).n <= 1) {
    return res.status(400).json({ error: '그룹은 하나 이상 있어야 합니다.', code: 'VALIDATION' });
  }
  db.run('DELETE FROM holding_dividends WHERE user_id = ? AND group_id = ?', [req.user.id, g.id]);
  db.run('DELETE FROM holding_groups WHERE id = ? AND user_id = ?', [g.id, req.user.id]);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// 화면 설정: 마지막 조회 기간·선택 연도를 회원별로 저장 (v0.5)
// ---------------------------------------------------------------------------
const SETTING_KEYS = ['ui.theme', 'ui.lang', 'ui.reqcodes', 'stock.recent', 'stock.collapsed', 'yearly.collapsed', 'holdings.collapsed', 'me.collapsed', 'stock.period', 'yearly.range', 'dividends.filter', 'assets.year', 'holdings.year', 'assets.group', 'holdings.group', 'assets.merged', 'assets.collapsed', 'divmgmt.year', 'divmgmt.group'];

router.get('/settings', (req, res) => {
  const out = {};
  for (const r of db.all('SELECT key, value FROM user_settings WHERE user_id = ?', [req.user.id])) {
    try { out[r.key] = JSON.parse(r.value); } catch (_) { /* 무시 */ }
  }
  res.json({ settings: out });
});

router.put('/settings/:key', (req, res) => {
  const key = req.params.key;
  if (!SETTING_KEYS.includes(key)) return res.status(400).json({ error: '저장할 수 없는 설정입니다.', code: 'VALIDATION' });
  const value = JSON.stringify(req.body.value ?? null);
  if (value.length > 2000) return res.status(400).json({ error: '설정 값이 너무 큽니다.', code: 'VALIDATION' });
  db.run(
    `INSERT INTO user_settings (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [req.user.id, key, value, now()]
  );
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// 자산 현황 (3.4) / 연도별 조회 (3.5)
// ---------------------------------------------------------------------------
router.get('/assets', async (req, res) => {
  res.json(await portfolio.getAssets(req.user.id, req.query.year, req.query.group, req.query.merged === '1'));
});

function yearRange(q) {
  const thisYear = new Date().getFullYear();
  const to = Number(q.to) || thisYear;
  const from = Number(q.from) || to - 4; // 기본 최근 5년
  if (to > thisYear) throw new ValidationError('종료 연도는 올해 이후일 수 없습니다.', { to: '종료 연도는 올해 이후일 수 없습니다.' });
  if (from > to) throw new ValidationError('시작 연도가 종료 연도보다 늦습니다.', { from: '시작 연도가 종료 연도보다 늦습니다.' });
  if (to - from + 1 > 10) throw new ValidationError('조회 기간은 최대 10년입니다.', { from: '조회 기간은 최대 10년입니다.' });
  return { from, to };
}

router.get('/yearly', async (req, res) => {
  const { from, to } = yearRange(req.query);
  res.json(await portfolio.getYearly(req.user.id, from, to));
});

// ---------------------------------------------------------------------------
// 배당금 (3.6)
// ---------------------------------------------------------------------------
async function validateDividend(body) {
  let code = null;
  let codeErr = null;
  try {
    code = market.validateCode(body.code).code;
  } catch (e) {
    codeErr = e.fields.code;
  }
  const payDate = String(body.payDate || '');
  let dateErr = null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(payDate)) dateErr = '지급일을 입력해 주세요.';
  else if (payDate > today()) dateErr = '지급일은 오늘 또는 과거 날짜여야 합니다.';
  const a = positiveNumber(body.amount);
  const currency = ['KRW', 'USD'].includes(body.currency) ? body.currency : null;
  const memo = String(body.memo || '');
  fieldErrors({
    code: codeErr,
    payDate: dateErr,
    amount: a.error,
    currency: currency ? null : '통화를 선택해 주세요.',
    memo: memo.length > 200 ? '메모는 200자 이내로 입력해 주세요.' : null,
  });
  // 보유 종목에서 삭제된 종목도 기록할 수 있어야 하므로, 코드 존재 확인은 저장된 종목 또는 출처 조회로
  await market.ensureInstrument(code);
  return { code, payDate, amount: a.value, currency, memo: memo || null };
}

router.get('/dividends', (req, res) => {
  const where = ['d.user_id = ?'];
  const params = [req.user.id];
  if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '')) { where.push('d.pay_date >= ?'); params.push(req.query.from); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '')) { where.push('d.pay_date <= ?'); params.push(req.query.to); }
  if (req.query.code) { where.push('d.code = ?'); params.push(market.normalizeCode(req.query.code)); }
  const list = db.all(
    `SELECT d.*, i.name, i.type FROM dividends d LEFT JOIN instruments i ON i.code = d.code
     WHERE ${where.join(' AND ')} ORDER BY d.pay_date DESC, d.id DESC`,
    params
  ).map((d) => ({ ...d, ...portfolio.dividendKrw(d) }));
  res.json({ dividends: list });
});

router.get('/dividends/yearly', (req, res) => {
  const { from, to } = yearRange({ from: req.query.from || new Date().getFullYear() - 9, to: req.query.to });
  res.json({ years: portfolio.dividendsByYear(req.user.id, from, to) });
});

router.post('/dividends', async (req, res) => {
  const v = await validateDividend(req.body);
  const { lastId } = db.run(
    'INSERT INTO dividends (user_id, code, pay_date, amount, currency, memo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [req.user.id, v.code, v.payDate, v.amount, v.currency, v.memo, now()]
  );
  res.json({ id: lastId });
});

router.put('/dividends/:id', async (req, res) => {
  const d = db.get('SELECT id FROM dividends WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  if (!d) return res.status(404).json({ error: '배당 내역을 찾을 수 없습니다.', code: 'NOT_FOUND' });
  const v = await validateDividend(req.body);
  db.run('UPDATE dividends SET code = ?, pay_date = ?, amount = ?, currency = ?, memo = ? WHERE id = ? AND user_id = ?', [
    v.code, v.payDate, v.amount, v.currency, v.memo, d.id, req.user.id,
  ]);
  res.json({ ok: true });
});

router.delete('/dividends/:id', (req, res) => {
  const r = db.run('DELETE FROM dividends WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  if (!r.changes) return res.status(404).json({ error: '배당 내역을 찾을 수 없습니다.', code: 'NOT_FOUND' });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// 엑셀 내보내기 (3.8)
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 데이터 백업·복원 (v0.15): 회원의 모든 데이터를 JSON 파일 하나로 내려받고, 그 파일로 되살린다.
// 시세·환율·배당 이벤트 같은 공통 데이터는 다시 받아오므로 넣지 않는다.
// ---------------------------------------------------------------------------
const BACKUP_FORMAT = 'stock-manager-backup';
const BACKUP_VERSION = 1;
const pick = (row, cols) => Object.fromEntries(cols.map((c) => [c, row[c] ?? null]));
const COLS = {
  groups: ['id', 'name', 'sort_order', 'created_at'],
  items: ['group_id', 'code', 'year', 'quantity', 'avg_price', 'memo', 'carry_mode', 'realized_pnl', 'carry_amount', 'carry_qty', 'formulas', 'created_at', 'updated_at'],
  categories: ['code', 'category', 'updated_at'],
  settings: ['key', 'value', 'updated_at'],
  dividends: ['code', 'pay_date', 'amount', 'currency', 'memo', 'created_at'],
  holdingDividends: ['group_id', 'code', 'ex_date', 'pay_date', 'per_share', 'tax_per_share', 'quantity', 'amount', 'tax_amount', 'created_at', 'updated_at'],
};

router.get('/backup', (req, res) => {
  const uid = req.user.id;
  const data = {
    groups: db.all('SELECT * FROM holding_groups WHERE user_id = ? ORDER BY sort_order, id', [uid]).map((r) => pick(r, COLS.groups)),
    items: db.all('SELECT * FROM holding_items WHERE user_id = ? ORDER BY year, id', [uid]).map((r) => pick(r, COLS.items)),
    categories: db.all('SELECT * FROM stock_categories WHERE user_id = ?', [uid]).map((r) => pick(r, COLS.categories)),
    settings: db.all('SELECT * FROM user_settings WHERE user_id = ?', [uid]).map((r) => pick(r, COLS.settings)),
    dividends: db.all('SELECT * FROM dividends WHERE user_id = ? ORDER BY pay_date, id', [uid]).map((r) => pick(r, COLS.dividends)),
    holdingDividends: db.all('SELECT * FROM holding_dividends WHERE user_id = ? ORDER BY ex_date, id', [uid]).map((r) => pick(r, COLS.holdingDividends)),
  };
  const counts = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v.length]));
  res.json({ format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: now(), account: req.user.email, counts, data });
});

// 복원: 지금 회원의 데이터를 모두 지우고 백업 파일의 데이터로 바꾼다 (그룹 번호는 새로 매기고 연결을 다시 맞춤)
router.post('/restore', (req, res) => {
  const b = req.body && req.body.backup;
  const bad = (msg) => res.status(400).json({ error: msg, code: 'VALIDATION' });
  if (!b || b.format !== BACKUP_FORMAT || !b.data || typeof b.data !== 'object') return bad('주식 관리시스템 백업 파일이 아닙니다.');
  if (Number(b.version) > BACKUP_VERSION) return bad('더 새로운 버전에서 만든 백업 파일입니다. 앱을 업데이트한 뒤 복원해 주세요.');
  const d = b.data;
  const arr = (k) => (Array.isArray(d[k]) ? d[k] : []);
  const groups = arr('groups');
  if (!groups.length && arr('items').length) return bad('백업 파일에 그룹 정보가 없습니다.');
  const uid = req.user.id;
  const t = now();
  const counts = {};
  db.tx(() => {
    for (const tbl of ['holding_items', 'holding_dividends', 'stock_categories', 'user_settings', 'dividends', 'holding_groups', 'holdings', 'holding_trades']) {
      db.run(`DELETE FROM ${tbl} WHERE user_id = ?`, [uid]);
    }
    const gmap = new Map();
    groups.forEach((g, i) => {
      const name = String(g.name || `그룹${i + 1}`).slice(0, 20);
      const { lastId } = db.run('INSERT INTO holding_groups (user_id, name, sort_order, created_at) VALUES (?, ?, ?, ?)', [uid, name, Number(g.sort_order) || i, g.created_at || t]);
      gmap.set(Number(g.id), lastId);
    });
    const gid = (v) => gmap.get(Number(v));
    let n = 0;
    for (const r of arr('items')) {
      if (!gid(r.group_id) || !r.code || !Number.isInteger(Number(r.year))) continue;
      db.run(`INSERT OR REPLACE INTO holding_items (user_id, group_id, code, year, quantity, avg_price, memo, carry_mode, realized_pnl, carry_amount, carry_qty, formulas, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [uid, gid(r.group_id), String(r.code), Number(r.year), Number(r.quantity) || 0, r.avg_price, r.memo, r.carry_mode, r.realized_pnl, r.carry_amount, r.carry_qty, typeof r.formulas === 'string' && r.formulas.length <= 600 ? r.formulas : null, r.created_at || t, r.updated_at || t]);
      n++;
    }
    counts.items = n;
    n = 0;
    for (const r of arr('holdingDividends')) {
      if (!gid(r.group_id) || !r.code || !r.ex_date) continue;
      db.run(`INSERT OR REPLACE INTO holding_dividends (user_id, group_id, code, ex_date, pay_date, per_share, tax_per_share, quantity, amount, tax_amount, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [uid, gid(r.group_id), String(r.code), String(r.ex_date), r.pay_date, Number(r.per_share) || 0, r.tax_per_share, Number(r.quantity) || 0, Number(r.amount) || 0, r.tax_amount, r.created_at || t, r.updated_at || t]);
      n++;
    }
    counts.holdingDividends = n;
    n = 0;
    for (const r of arr('categories')) {
      if (!r.code || !categories.IDS.includes(r.category)) continue;
      db.run('INSERT OR REPLACE INTO stock_categories (user_id, code, category, updated_at) VALUES (?, ?, ?, ?)', [uid, String(r.code), r.category, r.updated_at || t]);
      n++;
    }
    counts.categories = n;
    n = 0;
    for (const r of arr('settings')) {
      if (!SETTING_KEYS.includes(r.key)) continue;
      db.run('INSERT OR REPLACE INTO user_settings (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)', [uid, r.key, String(r.value), r.updated_at || t]);
      n++;
    }
    counts.settings = n;
    n = 0;
    for (const r of arr('dividends')) {
      if (!r.code || !r.pay_date) continue;
      db.run('INSERT INTO dividends (user_id, code, pay_date, amount, currency, memo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [uid, String(r.code), String(r.pay_date), Number(r.amount) || 0, r.currency === 'USD' ? 'USD' : 'KRW', r.memo, r.created_at || t]);
      n++;
    }
    counts.dividends = n;
    counts.groups = groups.length;
  });
  res.json({ ok: true, counts, account: b.account || null, exportedAt: b.exportedAt || null });
});

function sendXlsx(res, buf, name) {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  // Node에서는 Buffer, 앱(WebView)에서는 ArrayBuffer 그대로 전달
  res.send(typeof Buffer !== 'undefined' ? Buffer.from(buf) : buf);
}

router.get('/export/assets.xlsx', async (req, res) => {
  const data = await portfolio.getAssets(req.user.id, req.query.year, req.query.group, req.query.merged === '1');
  sendXlsx(res, await excel.assetsWorkbook(data), data.ongoing ? `자산현황_${today()}.xlsx` : `자산현황_${data.year}년말.xlsx`);
});

router.get('/export/yearly.xlsx', async (req, res) => {
  const { from, to } = yearRange(req.query);
  const data = await portfolio.getYearly(req.user.id, from, to);
  sendXlsx(res, await excel.yearlyWorkbook(data), `연도별조회_${from}-${to}.xlsx`);
});

module.exports = router;
