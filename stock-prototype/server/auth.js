// 세션 기반 인증 + 요청마다 소유자 확인 (FR-AUTH, NFR-SEC-02)
const crypto = require('crypto');
const db = require('./db');
const config = require('./config');
// 공개 서버(HTTPS)에서는 Secure 쿠키 (v0.25)
const SECURE = config.CLOUD ? '; Secure' : '';

const COOKIE = 'sid';
const SESSION_DAYS = 7;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000);
  db.run('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)', [
    sha256(token), userId, new Date().toISOString(), expires.toISOString(),
  ]);
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Expires=${expires.toUTCString()}${SECURE}`);
}

function destroySession(req, res) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) db.run('DELETE FROM sessions WHERE token_hash = ?', [sha256(token)]);
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${SECURE}`);
}

function loadUser(req, _res, next) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) {
    const row = db.get(
      `SELECT u.id, u.email, u.created_at, u.nickname, u.avatar FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
      [sha256(token), new Date().toISOString()]
    );
    if (row) req.user = row;
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다.', code: 'UNAUTHORIZED' });
  next();
}

module.exports = { createSession, destroySession, loadUser, requireAuth, sha256 };
