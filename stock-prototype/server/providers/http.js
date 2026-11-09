const { SourceError } = require('./errors');

// 외부 호출 공통: 타임아웃 + 오류 변환
// form: POST로 보낼 폼 값 (application/x-www-form-urlencoded). 없으면 GET
async function fetchRaw(url, { timeoutMs = 12000, form } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: ctrl.signal,
      method: form ? 'POST' : 'GET',
      body: form ? new URLSearchParams(form).toString() : undefined,
      headers: {
        'User-Agent': 'Mozilla/5.0 (stock-manager-prototype)',
        ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
    });
  } catch (e) {
    throw new SourceError(
      e.name === 'AbortError'
        ? '외부 출처 응답 시간이 초과되었습니다.'
        : '외부 출처에 연결할 수 없습니다. 인터넷 연결을 확인해 주세요.'
    );
  } finally {
    clearTimeout(t);
  }
}
module.exports = { fetchRaw };
