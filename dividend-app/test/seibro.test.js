import { test } from "node:test";
import assert from "node:assert/strict";
import { shortCodeToIsin, isValidIsin, classifyQuery, parseResponse, groupByStock, createClient, upcomingEvents, SeibroError } from "../src/seibro.js";

test("단축코드 → ISIN (실제 ISIN과 일치)", () => {
  assert.equal(shortCodeToIsin("005930"), "KR7005930003"); // 삼성전자
  assert.equal(shortCodeToIsin("005935"), "KR7005935002"); // 삼성전자우
  assert.equal(shortCodeToIsin("000660"), "KR7000660001"); // SK하이닉스
  assert.equal(shortCodeToIsin("035420"), "KR7035420009"); // NAVER
  assert.equal(shortCodeToIsin("A005930"), "KR7005930003");
  assert.equal(shortCodeToIsin("12345"), null);
});

test("ISIN 검증", () => {
  assert.ok(isValidIsin("KR7005930003"));
  assert.ok(isValidIsin("US0378331005")); // Apple
  assert.ok(!isValidIsin("KR7005930004"));
});

test("검색어 분류", () => {
  assert.deepEqual(classifyQuery("005930"), { type: "code", isinCd: "KR7005930003", code: "005930" });
  assert.deepEqual(classifyQuery("kr7005930003"), { type: "isin", isinCd: "KR7005930003" });
  assert.deepEqual(classifyQuery("삼성전자"), { type: "name", name: "삼성전자" });
  assert.equal(classifyQuery("  "), null);
});

const okBody = (items, totalCount = items.length) =>
  JSON.stringify({ response: { header: { resultCode: "00", resultMsg: "NORMAL SERVICE." }, body: { totalCount, items: { item: items } } } });

test("정상 응답 / 단건 응답 / 빈 응답 파싱", () => {
  assert.equal(parseResponse(okBody([{ a: 1 }, { a: 2 }])).items.length, 2);
  const single = JSON.stringify({ response: { header: { resultCode: "00" }, body: { totalCount: 1, items: { item: { a: 1 } } } } });
  assert.deepEqual(parseResponse(single).items, [{ a: 1 }]);
  const empty = JSON.stringify({ response: { header: { resultCode: "00" }, body: { totalCount: 0, items: "" } } });
  assert.deepEqual(parseResponse(empty).items, []);
});

test("서비스키 오류(XML) 해석", () => {
  const xml = `<OpenAPI_ServiceResponse><cmmMsgHeader><errMsg>SERVICE ERROR</errMsg><returnAuthMsg>SERVICE_KEY_IS_NOT_REGISTERED_ERROR</returnAuthMsg><returnReasonCode>30</returnReasonCode></cmmMsgHeader></OpenAPI_ServiceResponse>`;
  assert.throws(() => parseResponse(xml), (e) => e instanceof SeibroError && e.status === 401 && /활용신청/.test(e.message));
});

test("중복 제거·종목별 묶기·정렬", () => {
  const raw = [
    { basDt: "20240301", isinCd: "KR7005930003", isinCdNm: "삼성전자", stckDvdnRcdNm: "현금배당", dvdnBasDt: "20231231", cashDvdnPayDt: "20240419", stckGenrDvdnAmt: "350" },
    { basDt: "20240310", isinCd: "KR7005930003", isinCdNm: "삼성전자", stckDvdnRcdNm: "현금배당", dvdnBasDt: "20231231", cashDvdnPayDt: "20240419", stckGenrDvdnAmt: "361" },
    { basDt: "20240501", isinCd: "KR7005930003", isinCdNm: "삼성전자", stckDvdnRcdNm: "현금배당", dvdnBasDt: "20240331", cashDvdnPayDt: "20240517", stckGenrDvdnAmt: "361" },
    { basDt: "20240501", isinCd: "KR7005935002", isinCdNm: "삼성전자우", stckDvdnRcdNm: "현금배당", dvdnBasDt: "20240331", cashDvdnPayDt: "20240517", stckGenrDvdnAmt: "361" },
    { basDt: "20240501", isinCd: "", dvdnBasDt: "20240331" }, // ISIN 없는 레코드는 제외
  ];
  const stocks = groupByStock(raw);
  assert.equal(stocks.length, 2);
  const common = stocks.find((s) => s.isinCd === "KR7005930003");
  assert.equal(common.code, "005930");
  assert.deepEqual(common.dividends.map((d) => [d.recordDate, d.dps]), [["20240331", 361], ["20231231", 361]]);

  const ev = upcomingEvents(stocks, "20240401");
  assert.deepEqual(ev.map((e) => [e.date, e.type]), [["20240419", "pay"], ["20240517", "pay"], ["20240517", "pay"]]);
});

test("클라이언트: 요청 파라미터", async () => {
  const calls = [];
  const client = createClient({
    serviceKey: "abc%2Bdef%3D%3D",
    fetchImpl: async (url) => {
      calls.push(Object.fromEntries(new URL(url).searchParams));
      return new Response(okBody([{ n: 1 }], 1));
    },
  });
  const got = await client.byIsin("KR7005930003");
  assert.equal(got.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].isinCd, "KR7005930003");
  assert.equal(calls[0].resultType, "json");
  assert.equal(calls[0].serviceKey, "abc+def=="); // 인코딩된 키는 디코딩 후 한 번만 인코딩
  assert.equal(calls[0].numOfRows, "1000");
});

test("클라이언트: 여러 페이지 모두 수집", async () => {
  const client = createClient({
    serviceKey: "k",
    fetchImpl: async (url) => {
      const p = new URL(url).searchParams;
      const page = Number(p.get("pageNo"));
      const size = Number(p.get("numOfRows"));
      const total = 2500;
      const n = Math.max(0, Math.min(size, total - (page - 1) * size));
      return new Response(okBody(Array.from({ length: n }, (_, i) => ({ i })), total));
    },
  });
  assert.equal((await client.byCompanyName("삼성")).length, 2500);
});
