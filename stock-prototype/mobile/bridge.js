// 안드로이드 MainActivity 의 JavaScript 브리지 (window.AndroidBridge)
// 브리지가 없으면(데스크톱 브라우저에서 테스트할 때) 브라우저 기능으로 대신한다.
const Native = typeof window !== 'undefined' ? window.AndroidBridge || null : null;

function toBase64(bytes) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(s);
}

function fromBase64(b64) {
  const s = atob(b64);
  const a = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
  return a;
}

// 외부 HTTP 요청은 CORS 제약이 없는 네이티브(Java)에서 처리
let seq = 0;
const pending = new Map();
if (typeof window !== 'undefined') {
  window.__mobileHttpDone = (id, status, b64, error) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (error) p.reject(new Error(error));
    else p.resolve({ status, bytes: b64 ? fromBase64(b64) : new Uint8Array(0) });
  };
}

function httpGet(url) {
  if (!Native) {
    return fetch(url).then(async (r) => ({ status: r.status, bytes: new Uint8Array(await r.arrayBuffer()) }));
  }
  return new Promise((resolve, reject) => {
    const id = String(++seq);
    pending.set(id, { resolve, reject });
    Native.httpGet(id, url);
  });
}

function httpPost(url, body) {
  if (!Native) {
    return fetch(url, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })
      .then(async (r) => ({ status: r.status, bytes: new Uint8Array(await r.arrayBuffer()) }));
  }
  return new Promise((resolve, reject) => {
    const id = String(++seq);
    pending.set(id, { resolve, reject });
    Native.httpPost(id, url, body);
  });
}

// 일반 요청 (v0.27.0): 메서드·헤더·본문 지정 (구글 드라이브 API)
function httpRequest(method, url, headers, body) {
  if (!Native || !Native.httpRequest) {
    return fetch(url, { method, headers, body }).then(async (r) => ({ status: r.status, bytes: new Uint8Array(await r.arrayBuffer()) }));
  }
  return new Promise((resolve, reject) => {
    const id = String(++seq);
    pending.set(id, { resolve, reject });
    const b64 = body == null ? '' : toBase64(new TextEncoder().encode(String(body)));
    Native.httpRequest(id, method, url, JSON.stringify(headers || {}), b64);
  });
}

module.exports = { Native, toBase64, fromBase64, httpGet, httpPost, httpRequest };
