// 안드로이드 앱용 진입점: 서버 없이 앱 안에서 배당정보 API를 직접 호출합니다.
// esbuild로 번들되어 APK 안의 www/dividend-bundle.js 가 됩니다.
// window.LocalDividend 가 있으면 public/app.js 는 서버 대신 이것을 사용합니다.
import { createService } from "../src/service.js";

const Native = window.AndroidBridge || null;
const KEY_STORAGE = "seibro_service_key";

// WebView(file://)에서 fetch로 data.go.kr을 부르면 CORS에 막히므로
// 안드로이드 쪽(HttpURLConnection)에서 요청하고 결과를 콜백으로 받습니다.
const pending = new Map();
let seq = 0;
window.__nativeHttp = (id, status, body) => {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  if (Number(status) <= 0) p.reject(new Error(body || "네트워크 오류"));
  else p.resolve(new Response(body, { status: Number(status) >= 200 && Number(status) <= 599 ? Number(status) : 200 }));
};

function nativeFetch(url) {
  if (!Native) return fetch(url);
  return new Promise((resolve, reject) => {
    const id = String(++seq);
    pending.set(id, { resolve, reject });
    Native.httpGet(id, url);
    setTimeout(() => {
      if (pending.delete(id)) reject(Object.assign(new Error("timeout"), { name: "TimeoutError" }));
    }, 20000);
  });
}

function getKey() {
  if (Native) return Native.getServiceKey() || "";
  try {
    return localStorage.getItem(KEY_STORAGE) || "";
  } catch {
    return "";
  }
}

let service = createService({ serviceKey: getKey(), fetchImpl: nativeFetch });

window.LocalDividend = {
  getServiceKey: getKey,
  setServiceKey(key) {
    const k = String(key || "").trim();
    if (Native) Native.setServiceKey(k);
    else
      try {
        localStorage.setItem(KEY_STORAGE, k);
      } catch {}
    service = createService({ serviceKey: k, fetchImpl: nativeFetch });
  },
  config: () => service.config(),
  search: (q) => service.search(q),
  byDate: (date) => service.byDate(date),
};
