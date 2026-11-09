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

const router = express.Router();
const now = () => new Date().toISOString();
const today = () => market.dateInTz(new Date(), 'Asia/Seoul');

// ---------------------------------------------------------------------------
// 입력 검증 (4.2)
// ---------------------------------------------------------------------------
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
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  fieldErrors({ email: validateEmail(email), password: validatePassword(password) });
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
  const user = db.get('SELECT * FROM users WHERE email = ?', [email]);
  const ok = user && (await bcrypt.compare(String(req.body.password || ''), user.password_hash));
  if (!ok) return res.status(401).json({ error: '이메일 또는 비밀번호가 올바르지 않습니다.', code: 'LOGIN_FAILED' });
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

router.post('/auth/change-password', async (req, res) => {
  const user = db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
  if (!(await bcrypt.compare(String(req.body.current || ''), user.password_hash))) {
    throw new ValidationError('현재 비밀번호가 올바르지 않습니다.', { current: '현재 비밀번호가 올바르지 않습니다.' });
  }
  fieldErrors({ next: validatePassword(req.body.next) });
  db.run('UPDATE users SET password_hash = ? WHERE id = ?', [await bcrypt.hash(String(req.body.next), 10), user.id]);
  res.json({ ok: true });
});

// 회원 탈퇴: 계정·보유 종목·배당 내역 삭제 (FR-AUTH-04, NFR-PRI-01)
router.delete('/auth/account', async (req, res) => {
  const user = db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
  if (!(await bcrypt.compare(String(req.body.password || ''), user.password_hash))) {
    throw new ValidationError('비밀번호가 올바르지 않습니다.', { password: '비밀번호가 올바르지 않습니다.' });
  }
  db.tx(() => {
    db.run('DELETE FROM holdings WHERE user_id = ?', [user.id]);
    db.run('DELETE FROM holding_trades WHERE user_id = ?', [user.id]);
    db.run('DELETE FROM holding_items WHERE user_id = ?', [user.id]);
    db.run('DELETE FROM user_settings WHERE user_id = ?', [user.id]);
    db.run('DELETE FROM holding_groups WHERE user_id = ?', [user.id]);
    db.run('DELETE FROM stock_categories WHERE user_id = ?', [user.id]);
    db.run('DELETE FROM dividends WHERE user_id = ?', [user.id]);
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

  // 평가금액
  let rate = null;
  try {
    const cur = await market.getCurrentFx(); // 환율 이력 적재도 함께 보장
    rate = year >= ty ? cur.rate : (market.fxOn(`${year}-12-31`) || {}).rate || null;
  } catch (_) { /* 환율 없으면 외화 종목 평가금액 '-' */ }
  const items = await portfolio.mapLimit(pos, 5, async (p) => {
    const info = instInfo(p.code);
    const c = categories.categoryOf(req.user.id, p.code, info, saved);
    const item = {
      group_id: p.groupId, group_name: gname.get(p.groupId) || '-', code: p.code, ...info,
      quantity: p.quantity, avg_price: p.avgPrice, memo: p.memo, updated_at: p.lastTradeAt,
      carried: p.carried, carry_mode: p.carryMode, purchase_amount: p.quantity * p.avgPrice,
      item_year: p.itemYear, category: c.id, category_label: c.label,
    };
    try {
      let price = null;
      let inst = info;
      if (year >= ty) {
        const q = await market.getQuote(p.code);
        price = q.price;
        inst = q.instrument;
      } else {
        inst = market.publicInstrument(await market.ensureInstrument(p.code));
        const yc = market.yearEndClose(p.code, year);
        price = yc ? yc.close : null;
      }
      // 종목 정보가 처음 적재된 경우를 위해 이름·구분·분류를 적재 후 값으로 다시 채운다
      item.name = inst.name;
      item.market = inst.market;
      item.type = inst.type;
      const cat = categories.categoryOf(req.user.id, p.code, inst, saved);
      item.category = cat.id;
      item.category_label = cat.label;
      const r = inst.currency === 'USD' ? rate : 1;
      item.price = price;
      item.value = price == null ? null : price * p.quantity;
      item.value_krw = price == null || r == null ? null : price * p.quantity * r;
      item.fx_rate = r;
      item.currency = inst.currency;
    } catch (e) {
      item.value_error = e.message;
    }
    return item;
  });
  const range = positions.tradeYearRange(req.user.id);
  res.json({ year, groupId: gid, groups, yearRange: { min: Math.min(range.min || ty, ty - 9), max: ty }, holdings: list, items });
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
  const memo = String(body.memo || '');
  fieldErrors({
    groupId: group ? null : '그룹을 선택해 주세요.',
    code: codeErr,
    category: category ? null : '국내·해외·해외추종 중 하나를 선택해 주세요.',
    year: yearErr,
    quantity: q.error,
    purchaseAmount: hasAmount ? amt.error : null,
    avgPrice: hasAmount ? null : p.error,
    carryMode: carryMode ? null : '이월 또는 신규를 선택해 주세요.',
    memo: memo.length > 200 ? '메모는 200자 이내로 입력해 주세요.' : null,
  });
  const inst = await market.ensureInstrument(code); // 없는 코드면 NOT_FOUND
  return { code: inst.code, groupId, category, carryMode, year, quantity: q.value, avgPrice: p.value, memo: memo || null };
}

function upsertItem(userId, v) {
  db.run(
    `INSERT INTO holding_items (user_id, group_id, code, year, quantity, avg_price, memo, carry_mode, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, group_id, code, year) DO UPDATE SET quantity = excluded.quantity, avg_price = excluded.avg_price,
       memo = excluded.memo, carry_mode = excluded.carry_mode, updated_at = excluded.updated_at`,
    [userId, v.groupId, v.code, v.year, v.quantity, v.avgPrice, v.memo, v.carryMode, now(), now()]
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
  // 이월 표시와 관계없이, 실제로 전년 말 보유 항목이 있으면 수량 0 항목을 남겨야 그 해부터 보유하지 않게 된다
  const prevHeld = positions.stateAt(positions.itemsOf(req.user.id), year - 1).get(`${groupId}|${code}`);
  if (prevHeld && prevHeld.quantity > 0) {
    db.run(
      `INSERT INTO holding_items (user_id, group_id, code, year, quantity, avg_price, memo, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, NULL, '전량 매도', ?, ?)
       ON CONFLICT(user_id, group_id, code, year) DO UPDATE SET quantity = 0, avg_price = NULL, memo = '전량 매도', updated_at = excluded.updated_at`,
      [req.user.id, groupId, code, year, now(), now()]
    );
  } else {
    db.run('DELETE FROM holding_items WHERE user_id = ? AND group_id = ? AND code = ? AND year = ?', [req.user.id, groupId, code, year]);
  }
  res.json({ ok: true });
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
  db.run('DELETE FROM holding_groups WHERE id = ? AND user_id = ?', [g.id, req.user.id]);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// 화면 설정: 마지막 조회 기간·선택 연도를 회원별로 저장 (v0.5)
// ---------------------------------------------------------------------------
const SETTING_KEYS = ['stock.period', 'yearly.range', 'dividends.filter', 'assets.year', 'holdings.year', 'assets.group', 'holdings.group', 'assets.merged', 'assets.collapsed'];

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
  if (value.length > 1000) return res.status(400).json({ error: '설정 값이 너무 큽니다.', code: 'VALIDATION' });
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
