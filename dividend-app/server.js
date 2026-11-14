// 주식 배당 일정 조회 앱 - 웹 서버 (외부 패키지 없이 Node.js 내장 기능만 사용)
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { SeibroError, DEFAULT_ENDPOINT } from "./src/seibro.js";
import { createService } from "./src/service.js";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
try {
  process.loadEnvFile(join(ROOT, ".env"));
} catch {
  // .env 파일이 없으면 환경변수만 사용
}

const PORT = Number(process.env.PORT) || 3100;
const service = createService({
  serviceKey: process.env.SEIBRO_SERVICE_KEY || "",
  endpoint: process.env.SEIBRO_ENDPOINT || DEFAULT_ENDPOINT,
  demo: process.env.SEIBRO_DEMO === "1",
});

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

function sendJson(res, status, data) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname === "/api/config") return sendJson(res, 200, service.config());
    if (url.pathname === "/api/dividends") return sendJson(res, 200, await service.search(url.searchParams.get("q") || ""));
    if (url.pathname === "/api/dividends/by-date") return sendJson(res, 200, await service.byDate(url.searchParams.get("date") || ""));
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
  if (service.demo) console.log("※ SEIBRO_SERVICE_KEY가 없어 데모 모드(가상의 예시 데이터)로 실행합니다.");
});
