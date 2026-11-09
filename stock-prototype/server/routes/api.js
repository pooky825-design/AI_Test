const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db');
const auth = require('../auth');
const market = require('../services/market');
const portfolio = require('../services/portfolio');
const excel = require('../services/excel');
const { ValidationError } = market;

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
    db.run('DELETE FROM user_settings WHERE user_id = ?', [user.id]);
    db.run('DELETE FROM holding_groups WHERE user_id = ?', [user.id]);
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
  res.json(await market.getQuote(req.params.code, { force: req.query.refresh === '1' }));
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

// 그 해의 매수·매도 기록 (그룹 선택 가능) + 연말 보유 종목 합계(배당 화면 종목 목록 등에 사용)
router.get('/holdings', (req, res) => {
  const ty = thisYear();
  const year = Math.min(Number(req.query.year) || ty, ty);
  const groups = positions.groupsOf(req.user.id);
  const gid = groups.some((g) => g.id === Number(req.query.group)) ? Number(req.query.group) : null;
  const gname = new Map(groups.map((g) => [g.id, g.name]));
  const list = positions.totalsAt(req.user.id, year).map((p) => ({
    code: p.code, quantity: p.quantity, avg_price: p.avgPrice, ...instInfo(p.code),
  }));
  const trades = db.all(
    `SELECT * FROM holding_trades WHERE user_id = ? AND year = ? ${gid ? 'AND group_id = ?' : ''} ORDER BY id`,
    gid ? [req.user.id, year, gid] : [req.user.id, year]
  ).map((t) => ({ ...t, group_name: gname.get(t.group_id) || '-', ...instInfo(t.code) }));
  const range = positions.tradeYearRange(req.user.id);
  res.json({ year, groupId: gid, groups, yearRange: { min: Math.min(range.min || ty, ty - 9), max: ty }, holdings: list, trades });
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
    ...g, tradeCount: db.get('SELECT COUNT(*) AS n FROM holding_trades WHERE user_id = ? AND group_id = ?', [req.user.id, g.id]).n,
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
  const n = db.get('SELECT COUNT(*) AS n FROM holding_trades WHERE user_id = ? AND group_id = ?', [req.user.id, g.id]).n;
  if (n) {
    return res.status(400).json({ error: `‘${g.name}’ 그룹에 매수·매도 기록이 ${n}건 있어 삭제할 수 없습니다. 기록을 다른 그룹으로 옮기거나 삭제한 뒤 다시 시도해 주세요.`, code: 'VALIDATION' });
  }
  if (db.get('SELECT COUNT(*) AS n FROM holding_groups WHERE user_id = ?', [req.user.id]).n <= 1) {
    return res.status(400).json({ error: '그룹은 하나 이상 있어야 합니다.', code: 'VALIDATION' });
  }
  db.run('DELETE FROM holding_groups WHERE id = ? AND user_id = ?', [g.id, req.user.id]);
  res.json({ ok: true });
});

async function validateTrade(body, userId, excludeId) {
  let code = null;
  let codeErr = null;
  try {
    code = market.validateCode(body.code).code;
  } catch (e) {
    codeErr = e.fields.code;
  }
  const year = Number(body.year);
  const yearErr = Number.isInteger(year) && year >= MIN_YEAR && year <= thisYear() ? null : `연도는 ${MIN_YEAR}년부터 올해까지 선택할 수 있습니다.`;
  const side = body.side === 'SELL' ? 'SELL' : body.side === 'BUY' ? 'BUY' : null;
  const q = positiveNumber(body.quantity, { maxDecimals: 6 });
  const p = side === 'BUY' || String(body.price ?? '').trim() ? positiveNumber(body.price) : { value: null };
  const memo = String(body.memo || '');
  const groupId = Number(body.groupId);
  const group = db.get('SELECT id, name FROM holding_groups WHERE id = ? AND user_id = ?', [groupId, userId]);
  fieldErrors({
    groupId: group ? null : '그룹을 선택해 주세요.',
    code: codeErr,
    year: yearErr,
    side: side ? null : '매수 또는 매도를 선택해 주세요.',
    quantity: q.error,
    price: p.error,
    memo: memo.length > 200 ? '메모는 200자 이내로 입력해 주세요.' : null,
  });
  const inst = await market.ensureInstrument(code); // 없는 코드면 NOT_FOUND
  // 매도 수량이 그 시점 보유 수량을 넘지 않는지 (같은 그룹·종목, 모든 연도 말 기준)
  // 기록을 다른 그룹으로 옮기는 경우 원래 그룹도 확인
  const others = db.all('SELECT * FROM holding_trades WHERE user_id = ? AND code = ?', [userId, inst.code]).filter((t) => t.id !== excludeId);
  const next = [...others, { id: Number.MAX_SAFE_INTEGER, code: inst.code, group_id: groupId, year, side, quantity: q.value, price: p.value }];
  const prev = excludeId ? db.get('SELECT group_id FROM holding_trades WHERE id = ?', [excludeId]) : null;
  for (const g of new Set([groupId, prev && prev.group_id].filter(Boolean))) {
    const short = positions.findShortfall(next, inst.code, g);
    if (short) {
      const gname = (db.get('SELECT name FROM holding_groups WHERE id = ?', [g]) || {}).name || '';
      const msg = `‘${gname}’ 그룹의 ${short.year}년 말 보유 수량(${+short.held.toFixed(6)})보다 많이 매도할 수 없습니다.`;
      throw new ValidationError(msg, { quantity: msg });
    }
  }
  return { code: inst.code, groupId, year, side, quantity: q.value, price: p.value, memo: memo || null };
}

router.post('/trades', async (req, res) => {
  const v = await validateTrade(req.body, req.user.id);
  const { lastId } = db.run(
    'INSERT INTO holding_trades (user_id, group_id, code, year, side, quantity, price, memo, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [req.user.id, v.groupId, v.code, v.year, v.side, v.quantity, v.price, v.memo, now(), now()]
  );
  res.json({ id: lastId });
});

router.put('/trades/:id', async (req, res) => {
  const t = db.get('SELECT * FROM holding_trades WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  if (!t) return res.status(404).json({ error: '매수·매도 기록을 찾을 수 없습니다.', code: 'NOT_FOUND' });
  const v = await validateTrade({ ...req.body, code: t.code }, req.user.id, t.id);
  db.run('UPDATE holding_trades SET group_id = ?, year = ?, side = ?, quantity = ?, price = ?, memo = ?, updated_at = ? WHERE id = ? AND user_id = ?', [
    v.groupId, v.year, v.side, v.quantity, v.price, v.memo, now(), t.id, req.user.id,
  ]);
  res.json({ ok: true });
});

router.delete('/trades/:id', (req, res) => {
  const t = db.get('SELECT * FROM holding_trades WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  if (!t) return res.status(404).json({ error: '매수·매도 기록을 찾을 수 없습니다.', code: 'NOT_FOUND' });
  // 매수 기록을 지우면 이후 매도가 보유 수량을 넘을 수 있음 → 확인
  const rest = db.all('SELECT * FROM holding_trades WHERE user_id = ? AND code = ? AND id <> ?', [req.user.id, t.code, t.id]);
  const short = positions.findShortfall(rest, t.code, t.group_id);
  if (short) {
    return res.status(400).json({
      error: `이 기록을 지우면 ${short.year}년 매도 수량이 보유 수량보다 많아집니다. 매도 기록을 먼저 고쳐 주세요.`,
      code: 'VALIDATION',
    });
  }
  db.run('DELETE FROM holding_trades WHERE id = ? AND user_id = ?', [t.id, req.user.id]);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// 화면 설정: 마지막 조회 기간·선택 연도를 회원별로 저장 (v0.5)
// ---------------------------------------------------------------------------
const SETTING_KEYS = ['stock.period', 'yearly.range', 'dividends.filter', 'assets.year', 'holdings.year', 'assets.group', 'holdings.group'];

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
  res.json(await portfolio.getAssets(req.user.id, req.query.year, req.query.group));
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
  const data = await portfolio.getAssets(req.user.id, req.query.year, req.query.group);
  sendXlsx(res, await excel.assetsWorkbook(data), data.ongoing ? `자산현황_${today()}.xlsx` : `자산현황_${data.year}년말.xlsx`);
});

router.get('/export/yearly.xlsx', async (req, res) => {
  const { from, to } = yearRange(req.query);
  const data = await portfolio.getYearly(req.user.id, from, to);
  sendXlsx(res, await excel.yearlyWorkbook(data), `연도별조회_${from}-${to}.xlsx`);
});

module.exports = router;
