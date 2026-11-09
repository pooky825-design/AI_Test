// Node crypto 중 이 프로젝트가 쓰는 부분만 브라우저(WebView)용으로 구현
const { sha256 } = require('js-sha256');

function hex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function randomBytes(n) {
  const a = new Uint8Array(n);
  globalThis.crypto.getRandomValues(a);
  a.toString = (enc) => (enc === 'hex' ? hex(a) : Uint8Array.prototype.toString.call(a));
  return a;
}

function createHash(alg) {
  if (alg !== 'sha256') throw new Error(`지원하지 않는 해시: ${alg}`);
  let data = '';
  return {
    update(s) { data += s; return this; },
    digest() { return sha256(data); },
  };
}

module.exports = { randomBytes, createHash };
