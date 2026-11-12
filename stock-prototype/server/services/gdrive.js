// 구글 드라이브 직접 연결 (v0.27.0)
// 동기화 파일을 구글 드라이브 앱(파일 선택 창)을 거치지 않고 Google Drive API 로 직접 읽고 쓴다.
//  - 로그인: OAuth 2.0 (데스크톱 앱 클라이언트 + 루프백 주소 + PKCE). 사용자가 만든 클라이언트 ID·보안 비밀을 기기마다 입력
//  - 권한: drive.file (이 앱이 만든 파일만 볼 수 있음, 드라이브의 다른 파일은 못 봄)
//  - 토큰은 기기·사용자별로 이 기기 DB(gdrive_auth)에만 저장. 백업·동기화 파일에는 넣지 않는다
const crypto = require('crypto');
const db = require('../db');
const { request } = require('../providers/http');

const env = typeof process !== 'undefined' && process.env ? process.env : {};
// 시험용으로 바꿀 수 있는 주소 (기본: 구글)
const AUTH_URL = env.GDRIVE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = env.GDRIVE_TOKEN_URL || 'https://oauth2.googleapis.com/token';
const API = env.GDRIVE_API || 'https://www.googleapis.com';
const REVOKE_URL = env.GDRIVE_REVOKE_URL || 'https://oauth2.googleapis.com/revoke';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
// v0.30.42: 동기화 파일은 암호화한 바이너리(kstock-sync.kst). 예전 파일(kstock-sync.json, 암호화 안 됨)은 읽기만 하고,
// 새 파일을 저장하면 지운다(드라이브에 암호화 안 된 자료가 남지 않게)
const FILE_NAME = 'kstock-sync.kst';
const OLD_NAME = 'kstock-sync.json';
const toB64 = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); };
const fromB64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const concat = (...parts) => { const n = parts.reduce((a, p) => a + p.length, 0); const out = new Uint8Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };

class DriveError extends Error {
  constructor(message, status = 400, code = 'GDRIVE') { super(message); this.status = status; this.code = code; }
}

const now = () => new Date().toISOString();
const row = (uid) => db.get('SELECT * FROM gdrive_auth WHERE user_id = ?', [uid]) || null;
function save(uid, fields) {
  const cur = row(uid) || {};
  const v = { ...cur, ...fields };
  db.run(`INSERT OR REPLACE INTO gdrive_auth (user_id, client_id, client_secret, refresh_token, access_token, expires_at, account, file_id, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [uid, v.client_id || null, v.client_secret || null, v.refresh_token || null, v.access_token || null, v.expires_at || null, v.account || null, v.file_id || null, now()]);
}

function status(uid) {
  const r = row(uid);
  return {
    configured: !!(r && r.client_id),
    connected: !!(r && r.refresh_token),
    clientId: r ? r.client_id : null,
    hasSecret: !!(r && r.client_secret),
    account: r ? r.account : null,
    fileId: r ? r.file_id : null,
  };
}

function setClient(uid, clientId, clientSecret) {
  const id = String(clientId || '').trim();
  const secret = String(clientSecret || '').trim();
  if (!/^[0-9]+-[0-9a-z]+\.apps\.googleusercontent\.com$/i.test(id)) throw new DriveError('클라이언트 ID 형식이 아닙니다. “숫자-영문.apps.googleusercontent.com” 형태입니다.');
  if (secret && !/^[\w-]{10,100}$/.test(secret)) throw new DriveError('클라이언트 보안 비밀 형식이 아닙니다.');
  const cur = row(uid);
  const changed = !cur || cur.client_id !== id;
  // 클라이언트가 바뀌면 예전 토큰·파일은 쓸 수 없다
  save(uid, changed
    ? { client_id: id, client_secret: secret || null, refresh_token: null, access_token: null, expires_at: null, account: null, file_id: null }
    : { client_secret: secret || cur.client_secret });
  return status(uid);
}

// 로그인 시작: state·PKCE 값은 메모리에 10분 보관
const pending = new Map();
const b64url = (buf) => {
  const bytes = typeof buf === 'string' ? Uint8Array.from(buf.match(/../g).map((h) => parseInt(h, 16))) : new Uint8Array(buf);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
function startAuth(uid, redirectUri) {
  const r = row(uid);
  if (!r || !r.client_id) throw new DriveError('먼저 클라이언트 ID를 저장해 주세요.');
  if (!/^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d{1,5}(\/[\w./-]*)?$/.test(String(redirectUri || ''))) {
    throw new DriveError('구글 로그인은 이 기기 안의 주소(localhost)에서만 받을 수 있습니다. PC에서는 http://localhost:포트 로 열어 주세요.');
  }
  const state = crypto.randomBytes(16).toString('hex');
  const verifier = crypto.randomBytes(32).toString('hex');
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  for (const [k, v] of pending) if (v.at < Date.now() - 600000) pending.delete(k);
  pending.set(state, { uid, verifier, redirectUri, at: Date.now() });
  const q = new URLSearchParams({
    client_id: r.client_id, redirect_uri: redirectUri, response_type: 'code', scope: SCOPE,
    access_type: 'offline', prompt: 'consent', state, code_challenge: challenge, code_challenge_method: 'S256',
  });
  return { authUrl: `${AUTH_URL}?${q}`, state };
}

async function tokenCall(form) {
  const r = await request(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() });
  let j = {};
  try { j = JSON.parse(r.text); } catch (_) { /* 아래에서 처리 */ }
  if (!r.ok) {
    const why = j.error_description || j.error || `HTTP ${r.status}`;
    if (j.error === 'invalid_grant') throw new DriveError(`구글 로그인이 만료되었거나 취소되었습니다. 다시 연결해 주세요. (${why})`, 409, 'GDRIVE_AUTH');
    if (j.error === 'invalid_client') throw new DriveError(`클라이언트 ID 또는 보안 비밀이 맞지 않습니다. (${why})`, 400, 'GDRIVE_AUTH');
    throw new DriveError(`구글 토큰 요청 실패: ${why}`, 502);
  }
  return j;
}

async function finishAuth(uid, code, state) {
  const p = pending.get(String(state || ''));
  if (!p || p.uid !== uid) throw new DriveError('로그인 요청이 만료되었습니다. 다시 연결해 주세요.');
  pending.delete(state);
  const r = row(uid);
  const form = { code: String(code || ''), client_id: r.client_id, redirect_uri: p.redirectUri, grant_type: 'authorization_code', code_verifier: p.verifier };
  if (r.client_secret) form.client_secret = r.client_secret;
  const j = await tokenCall(form);
  if (!j.refresh_token) throw new DriveError('구글이 갱신 토큰을 주지 않았습니다. 구글 계정 → 보안 → 타사 앱 연결에서 이 앱을 삭제한 뒤 다시 연결해 주세요.', 502);
  save(uid, { refresh_token: j.refresh_token, access_token: j.access_token, expires_at: Date.now() + (Number(j.expires_in) || 3600) * 1000, file_id: null });
  // 연결한 구글 계정 이메일 (표시용)
  try {
    const a = await api(uid, 'GET', '/drive/v3/about?fields=user(emailAddress)');
    save(uid, { account: (a.user && a.user.emailAddress) || null });
  } catch (_) { /* 표시만 못 함 */ }
  return status(uid);
}

async function accessToken(uid, force) {
  const r = row(uid);
  if (!r || !r.refresh_token) throw new DriveError('구글 드라이브가 연결되어 있지 않습니다.', 400, 'GDRIVE_AUTH');
  if (!force && r.access_token && r.expires_at > Date.now() + 60000) return r.access_token;
  const form = { client_id: r.client_id, refresh_token: r.refresh_token, grant_type: 'refresh_token' };
  if (r.client_secret) form.client_secret = r.client_secret;
  let j;
  try {
    j = await tokenCall(form);
  } catch (e) {
    if (e.code === 'GDRIVE_AUTH') save(uid, { refresh_token: null, access_token: null, expires_at: null });
    throw e;
  }
  save(uid, { access_token: j.access_token, expires_at: Date.now() + (Number(j.expires_in) || 3600) * 1000 });
  return j.access_token;
}

// 휴대폰 앱의 기기 구글 계정 방식 (v0.27.1): 앱이 휴대폰에 로그인된 구글 계정으로 받은 접근 토큰을
// 요청마다 넘겨준다 (클라이언트 ID·갱신 토큰 없음). 토큰이 만료되면 GDRIVE_TOKEN 으로 알려 앱이 새로 받는다.
function checkToken(token) {
  if (token == null || token === '') return null;
  if (typeof token !== 'string' || token.length > 4096 || /\s/.test(token)) throw new DriveError('토큰 형식이 올바르지 않습니다.');
  return token;
}

// Drive API 호출 (토큰 만료면 한 번 갱신 후 재시도). raw=true 면 본문 text 그대로
async function api(uid, method, path, { headers = {}, body, raw = false, token: dev = null } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = dev || await accessToken(uid, attempt > 0);
    const r = await request(API + path, { method, headers: { ...headers, Authorization: `Bearer ${token}` }, body });
    if (r.status === 401 && dev) throw new DriveError('구글 계정 토큰이 만료되었습니다.', 409, 'GDRIVE_TOKEN');
    if (r.status === 401 && attempt === 0) continue;
    if (!r.ok) {
      let msg = `HTTP ${r.status}`;
      try { const j = JSON.parse(r.text); msg = (j.error && (j.error.message || j.error)) || msg; } catch (_) { /* text 그대로 */ }
      if (r.status === 404) throw new DriveError('구글 드라이브에서 동기화 파일을 찾을 수 없습니다.', 404, 'GDRIVE_NOTFOUND');
      if (r.status === 403 && /has not been used|disabled/i.test(msg)) throw new DriveError(`Google Drive API가 사용 설정되어 있지 않습니다. 구글 클라우드 콘솔에서 Google Drive API를 사용 설정해 주세요. (${msg})`, 502);
      throw new DriveError(`구글 드라이브 오류: ${msg}`, 502);
    }
    if (raw === 'bytes') return r.bytes || new TextEncoder().encode(r.text || '');
    return raw ? r.text : (r.text ? JSON.parse(r.text) : {});
  }
  throw new DriveError('구글 드라이브 인증에 실패했습니다.', 409, 'GDRIVE_AUTH');
}

// 동기화 파일 찾기: 저장한 파일 ID → 없으면 이 앱이 만든 같은 이름 파일 중 최근 것
async function findFile(uid, token) {
  const r = row(uid) || {};
  if (r.file_id) {
    try {
      const m = await api(uid, 'GET', `/drive/v3/files/${encodeURIComponent(r.file_id)}?fields=id,name,modifiedTime,trashed`, { token });
      if (!m.trashed) return m;
    } catch (e) { if (e.code !== 'GDRIVE_NOTFOUND') throw e; }
  }
  let f = null;
  for (const name of [FILE_NAME, OLD_NAME]) {
    const q = encodeURIComponent(`name = '${name}' and trashed = false`);
    const list = await api(uid, 'GET', `/drive/v3/files?q=${q}&orderBy=modifiedTime desc&pageSize=5&fields=files(id,name,modifiedTime)&spaces=drive`, { token });
    f = (list.files || [])[0] || null;
    if (f) break;
  }
  save(uid, { file_id: f ? f.id : null });
  return f;
}

// 파일 내용은 base64 로 주고받는다(화면 ↔ 서버). b64 = 파일 그대로의 바이트
async function readFile(uid, token = null) {
  const f = await findFile(uid, token);
  if (!f) return { b64: '', file: null };
  const bytes = await api(uid, 'GET', `/drive/v3/files/${encodeURIComponent(f.id)}?alt=media`, { raw: 'bytes', token });
  return { b64: toB64(bytes), file: f };
}

async function writeFile(uid, b64, token = null) {
  const bytes = fromB64(b64);
  const f = await findFile(uid, token);
  let m;
  if (f && f.name !== OLD_NAME) {
    // 내용만 바꿈 (HttpURLConnection 은 PATCH 를 못 보내므로 앱에서는 X-HTTP-Method-Override 로 보냄)
    m = await api(uid, 'PATCH', `/upload/drive/v3/files/${encodeURIComponent(f.id)}?uploadType=media&fields=id,name,modifiedTime`, {
      headers: { 'Content-Type': 'application/octet-stream' }, body: bytes, token,
    });
  } else {
    const boundary = `kstock${crypto.randomBytes(8).toString('hex')}`;
    const enc = new TextEncoder();
    const body = concat(
      enc.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: FILE_NAME, mimeType: 'application/octet-stream' })}\r\n`
        + `--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`),
      bytes,
      enc.encode(`\r\n--${boundary}--`),
    );
    m = await api(uid, 'POST', '/upload/drive/v3/files?uploadType=multipart&fields=id,name,modifiedTime', {
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body, token,
    });
    // 예전 암호화 안 된 파일은 지운다
    if (f && f.name === OLD_NAME) {
      try { await api(uid, 'DELETE', `/drive/v3/files/${encodeURIComponent(f.id)}`, { raw: true, token }); } catch (_) { /* 못 지워도 새 파일은 저장됨 */ }
    }
  }
  save(uid, { file_id: m.id });
  return m;
}

async function disconnect(uid) {
  const r = row(uid);
  if (r && r.refresh_token) {
    try { await request(`${REVOKE_URL}?token=${encodeURIComponent(r.refresh_token)}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: '' }); } catch (_) { /* 연결만 끊음 */ }
  }
  save(uid, { refresh_token: null, access_token: null, expires_at: null, account: null, file_id: null });
  return status(uid);
}

// 기기 계정 방식: 이 사용자가 쓰는 파일 ID 만 기억 (클라이언트 방식 정보는 건드리지 않음)
const readFileWith = (uid, token) => readFile(uid, checkToken(token));
const writeFileWith = (uid, token, b64) => writeFile(uid, b64, checkToken(token));

module.exports = { status, setClient, startAuth, finishAuth, readFile, writeFile, readFileWith, writeFileWith, disconnect, DriveError, FILE_NAME };
