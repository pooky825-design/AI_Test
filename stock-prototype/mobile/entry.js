// 안드로이드 앱 진입점
// PC 버전의 서버 코드(server/)를 그대로 묶어 WebView 안에서 실행한다.
// public/app.js 가 호출하는 fetch('/api/...') 를 가로채 앱 안의 라우터로 처리하므로 화면 코드는 PC와 동일하다.
const db = require('../server/db');
const auth = require('../server/auth');
const router = require('../server/routes/api');
const market = require('../server/services/market');
const { seedDemo } = require('../server/seed');
const { createResponse } = require('./express-shim');
const bridge = require('./bridge');

const ready = (async () => {
  const { isNew } = await db.init();
  if (isNew) await seedDemo();
})();

// 세션 쿠키 보관 (PC 버전의 브라우저 쿠키 역할)
const COOKIE_KEY = 'stock_cookie';
let cookieMem = '';
const jar = {
  get() { try { return localStorage.getItem(COOKIE_KEY) || ''; } catch (_) { return cookieMem; } },
  set(v) { cookieMem = v; try { localStorage.setItem(COOKIE_KEY, v); } catch (_) { /* ignore */ } },
};

function applySetCookie(header) {
  if (!header) return;
  const [pair, ...attrs] = String(header).split(';').map((x) => x.trim());
  const expired = attrs.some((a) => /^max-age=0$/i.test(a));
  jar.set(expired ? '' : pair);
}

async function request(method, url, body) {
  await ready;
  const u = new URL(url, 'http://app.local/api');
  const req = {
    method: method.toUpperCase(),
    path: u.pathname.replace(/^\/api/, '') || '/',
    query: Object.fromEntries(u.searchParams.entries()),
    body: body || {},
    headers: { cookie: jar.get() },
    params: {},
  };
  const res = createResponse();
  try {
    auth.loadUser(req, res, () => {});
    const handled = await router.handle(req, res);
    if (!handled) res.status(404).json({ error: '없는 API입니다.', code: 'NOT_FOUND' });
  } catch (err) {
    const status = { VALIDATION: 400, NOT_FOUND: 404, SOURCE_ERROR: 502 }[err.code];
    if (!status) {
      console.error(err);
      res.status(500).json({ error: '앱 내부 오류가 발생했습니다.', code: 'SERVER_ERROR' });
    } else {
      res.status(status).json({ error: err.message, code: err.code, fields: err.fields });
    }
  }
  applySetCookie(res.headers['set-cookie']);
  const out = { status: res.statusCode, contentType: res.headers['content-type'] || 'application/json' };
  if (out.contentType.includes('json')) out.json = res.body;
  else {
    const b = res.body;
    out.bytes = b instanceof Uint8Array ? b : new Uint8Array(b);
    const m = /filename\*=UTF-8''([^;]+)/.exec(res.headers['content-disposition'] || '');
    out.filename = m ? decodeURIComponent(m[1]) : 'export.xlsx';
  }
  return out;
}

// 엑셀 파일 저장: 앱은 기기의 다운로드 폴더, 브라우저는 일반 다운로드
async function saveFile(name, bytes, mime) {
  if (bridge.Native) return bridge.Native.saveFile(name, bridge.toBase64(bytes), mime);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes], { type: mime }));
  a.download = name;
  a.click();
  return `${name} 파일을 내려받았습니다.`;
}

window.MobileApp = { request, saveFile, ready };

const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  if (!url.startsWith('/api/')) return nativeFetch(input, init);
  const r = await request(init.method || 'GET', url, init.body ? JSON.parse(init.body) : undefined);
  return new Response(JSON.stringify(r.json ?? {}), { status: r.status, headers: { 'Content-Type': 'application/json' } });
};

// FR-DATA-01: 앱이 켜져 있는 동안 1시간마다 장 마감 후 종가 수집
ready.then(() => setInterval(() => market.collectDaily().catch(() => {}), 60 * 60 * 1000));
