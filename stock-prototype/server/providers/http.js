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

// 일반 요청 (v0.27.0, 구글 드라이브용): 메서드·헤더·본문(text)을 자유롭게. 응답은 { ok, status, text }
async function request(url, { method = 'GET', headers = {}, body, timeoutMs = 20000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, method, headers, body });
    return { ok: r.ok, status: r.status, text: await r.text() };
  } catch (e) {
    throw new SourceError(e.name === 'AbortError' ? '응답 시간이 초과되었습니다.' : '인터넷에 연결할 수 없습니다. 연결을 확인해 주세요.');
  } finally {
    clearTimeout(t);
  }
}
module.exports = { fetchRaw, request };
