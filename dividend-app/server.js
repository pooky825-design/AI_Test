// 주식 배당 일정 조회 앱 - 웹 서버 (외부 패키지 없이 Node.js 18+ 내장 기능만 사용)
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, classifyQuery, groupByStock, upcomingEvents, kstToday, SeibroError, DEFAULT_ENDPOINT } from "./src/seibro.js";
import { demoFetch, DEMO_HINT } from "./src/demo.js";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
try {
  process.loadEnvFile(join(ROOT, ".env"));
} catch {
  // .env 파일이 없으면 환경변수만 사용
}

const PORT = Number(process.env.PORT) || 3100;
const DEMO = !process.env.SEIBRO_SERVICE_KEY || process.env.SEIBRO_DEMO === "1";
const client = createClient({
  serviceKey: process.env.SEIBRO_SERVICE_KEY || "demo",
  endpoint: process.env.SEIBRO_ENDPOINT || DEFAULT_ENDPOINT,
  fetchImpl: DEMO ? demoFetch : fetch,
});

// 배당정보는 하루 1회 갱신되므로 6시간 캐시
const CACHE_MS = 6 * 3600_000;
const cache = new Map();
async function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return value;
}

async function search(q) {
  const kind = classifyQuery(q);
  if (!kind) throw new SeibroError("종목명, 종목코드(6자리) 또는 ISIN을 입력하세요.", 400);
  let raw;
  if (kind.type === "name") {
    if (kind.name.length < 2) throw new SeibroError("회사명은 2글자 이상 입력하세요.", 400);
    raw = await cached(`n:${kind.name}`, () => client.byCompanyName(kind.name));
  } else {
    raw = await cached(`i:${kind.isinCd}`, () => client.byIsin(kind.isinCd));
  }
  const stocks = groupByStock(raw).slice(0, 30);
  return { query: kind, stocks, upcoming: upcomingEvents(stocks, kstToday()) };
}

async function byDate(date) {
  if (!/^\d{8}$/.test(date)) throw new SeibroError("날짜는 YYYYMMDD 형식이어야 합니다.", 400);
  const raw = await cached(`d:${date}`, () => client.byDate(date));
  return { date, stocks: groupByStock(raw) };
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

function sendJson(res, status, data) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname === "/api/config") {
      return sendJson(res, 200, { demo: DEMO, demoHint: DEMO ? DEMO_HINT : "", today: kstToday() });
    }
    if (url.pathname === "/api/dividends") {
      return sendJson(res, 200, await search(url.searchParams.get("q") || ""));
    }
    if (url.pathname === "/api/dividends/by-date") {
      return sendJson(res, 200, await byDate(url.searchParams.get("date") || ""));
    }
    if (url.pathname.startsWith("/api/")) return sendJson(res, 404, { error: "없는 API입니다." });

    // 정적 파일
    const path = normalize(url.pathname === "/" ? "/index.html" : url.pathname).replace(/^(\.\.[/\\])+/, "");
    const file = join(ROOT, "public", path);
    if (!file.startsWith(join(ROOT, "public"))) return sendJson(res, 403, { error: "forbidden" });
    const body = await readFile(file).catch(() => null);
    if (!body) return sendJson(res, 404, { error: "not found" });
    res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch (err) {
    const status = err instanceof SeibroError ? err.status : 500;
    if (status >= 500) console.error(err);
    sendJson(res, status, { error: err.message || "서버 오류" });
  }
});

server.listen(PORT, () => {
  console.log(`배당 일정 조회 앱 실행 중: http://localhost:${PORT}`);
  if (DEMO) console.log("※ SEIBRO_SERVICE_KEY가 없어 데모 모드(가상의 예시 데이터)로 실행합니다.");
});
