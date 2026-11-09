// providers/http.js 의 앱용 버전: 네이티브 브리지로 외부 출처를 호출
const { SourceError } = require('../server/providers/errors');
const bridge = require('./bridge');

async function fetchRaw(url, { timeoutMs = 12000 } = {}) {
  let r;
  try {
    r = await Promise.race([
      bridge.httpGet(url),
      new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('timeout'), { name: 'AbortError' })), timeoutMs + 2000)),
    ]);
  } catch (e) {
    throw new SourceError(
      e.name === 'AbortError'
        ? '외부 출처 응답 시간이 초과되었습니다.'
        : '외부 출처에 연결할 수 없습니다. 인터넷 연결을 확인해 주세요.'
    );
  }
  const bytes = r.bytes;
  return {
    ok: r.status >= 200 && r.status < 300,
    status: r.status,
    async json() { return JSON.parse(new TextDecoder('utf-8').decode(bytes)); },
    async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
  };
}

module.exports = { fetchRaw };
