// 검색 로직 (웹 서버와 안드로이드 앱이 함께 사용)
import { createClient, classifyQuery, groupByStock, upcomingEvents, kstToday, SeibroError, DEFAULT_ENDPOINT } from "./seibro.js";
import { demoFetch, DEMO_HINT } from "./demo.js";

// 배당정보는 하루 1회 갱신되므로 6시간 캐시
const CACHE_MS = 6 * 3600_000;

/**
 * @param {object} opts
 * @param {string} [opts.serviceKey]  비어 있으면 데모 모드
 * @param {Function} [opts.fetchImpl] 실제 API 호출에 쓸 fetch
 */
export function createService({ serviceKey = "", endpoint = DEFAULT_ENDPOINT, fetchImpl = fetch, demo = false } = {}) {
  const isDemo = demo || !serviceKey;
  const client = createClient({ serviceKey: serviceKey || "demo", endpoint, fetchImpl: isDemo ? demoFetch : fetchImpl });
  const cache = new Map();

  async function cached(key, fn) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
    const value = await fn();
    cache.set(key, { at: Date.now(), value });
    if (cache.size > 500) cache.delete(cache.keys().next().value);
    return value;
  }

  return {
    demo: isDemo,
    config: () => ({ demo: isDemo, demoHint: isDemo ? DEMO_HINT : "", today: kstToday() }),

    async search(q) {
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
    },

    async byDate(date) {
      if (!/^\d{8}$/.test(date)) throw new SeibroError("날짜는 YYYYMMDD 형식이어야 합니다.", 400);
      const raw = await cached(`d:${date}`, () => client.byDate(date));
      return { date, stocks: groupByStock(raw) };
    },
  };
}
