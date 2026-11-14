// SEIBro(한국예탁결제원) 주식 배당정보 클라이언트
//
// 한국예탁결제원이 SEIBro에 보유한 배당 데이터는 공공데이터포털의
// 「금융위원회_주식배당정보」 Open API(GetStocDiviInfoService_V2 / getDiviInfo_V2)로 제공됩니다.
//   - 데이터 출처: 한국예탁결제원(SEIBro), 하루 1회 갱신
//   - 활용신청: https://www.data.go.kr/data/15043284/openapi.do
// 서비스키는 서버에서만 사용하고 브라우저로 내보내지 않습니다.

export const DEFAULT_ENDPOINT = "https://apis.data.go.kr/1160100/GetStocDiviInfoService_V2";
export const OPERATION = "getDiviInfo_V2";

export class SeibroError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// 종목코드 → ISIN
// 국내 주식 ISIN = "KR7" + 단축코드 6자리 + "00" + 검사숫자 (예: 005930 → KR7005930003)
// ---------------------------------------------------------------------------

/** ISIN 검사숫자 (ISO 6166: 문자를 숫자로 바꾼 뒤 Luhn) */
export function isinCheckDigit(body11) {
  const digits = body11
    .toUpperCase()
    .split("")
    .map((c) => (/[0-9]/.test(c) ? c : String(c.charCodeAt(0) - 55)))
    .join("");
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return String((10 - (sum % 10)) % 10);
}

export function isValidIsin(isin) {
  return /^[A-Z]{2}[0-9A-Z]{9}[0-9]$/.test(isin) && isinCheckDigit(isin.slice(0, 11)) === isin[11];
}

/** 6자리 단축코드(예: 005930, 0001A0)를 ISIN으로 변환 */
export function shortCodeToIsin(code) {
  const c = code.trim().toUpperCase().replace(/^A(?=[0-9A-Z]{6}$)/, ""); // "A005930" 형식 허용
  if (!/^[0-9A-Z]{6}$/.test(c)) return null;
  const body = `KR7${c}00`;
  return body + isinCheckDigit(body);
}

/** 사용자가 입력한 검색어 종류 판별 */
export function classifyQuery(q) {
  const s = String(q || "").trim();
  if (!s) return null;
  const up = s.toUpperCase();
  if (isValidIsin(up)) return { type: "isin", isinCd: up };
  if (/^A?[0-9][0-9A-Z]{5}$/i.test(s) && /\d{4}/.test(s)) return { type: "code", isinCd: shortCodeToIsin(s), code: up.replace(/^A/, "") };
  return { type: "name", name: s };
}

// ---------------------------------------------------------------------------
// API 호출
// ---------------------------------------------------------------------------

function xmlTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return m ? m[1].trim() : "";
}

const KEY_HINTS = {
  "30": "등록되지 않은 서비스키입니다. 공공데이터포털에서 「금융위원회_주식배당정보」 활용신청 후 승인된 키인지 확인하세요 (승인 후 반영까지 1~2시간 걸릴 수 있습니다).",
  "31": "서비스키 활용기간이 만료되었습니다.",
  "22": "일일 호출 한도를 초과했습니다. 내일 다시 시도하세요.",
  "20": "서비스 접근이 거부되었습니다.",
  "12": "해당 API 서비스가 없거나 폐기되었습니다. SEIBRO_ENDPOINT 설정을 확인하세요.",
};

/** 응답 본문(JSON 또는 XML 오류)을 해석해 { items, totalCount } 반환 */
export function parseResponse(text, httpStatus = 200) {
  const trimmed = text.trim();
  // 서비스키 오류 등은 resultType=json이어도 XML로 옵니다.
  if (trimmed.startsWith("<")) {
    const code = xmlTag(trimmed, "returnReasonCode") || xmlTag(trimmed, "resultCode");
    const msg = xmlTag(trimmed, "returnAuthMsg") || xmlTag(trimmed, "errMsg") || xmlTag(trimmed, "resultMsg");
    throw new SeibroError(KEY_HINTS[code] || `API 오류: ${msg || "알 수 없는 응답"} (${code || httpStatus})`, code === "30" || code === "31" ? 401 : 502);
  }
  let json;
  try {
    json = JSON.parse(trimmed);
  } catch {
    throw new SeibroError(`API 응답을 해석할 수 없습니다 (HTTP ${httpStatus}): ${trimmed.slice(0, 150)}`);
  }
  if (json.OpenAPI_ServiceResponse) {
    const h = json.OpenAPI_ServiceResponse.cmmMsgHeader || {};
    throw new SeibroError(KEY_HINTS[h.returnReasonCode] || `API 오류: ${h.returnAuthMsg || h.errMsg} (${h.returnReasonCode})`);
  }
  const header = json.response?.header;
  if (header?.resultCode !== "00") {
    throw new SeibroError(`API 오류: ${header?.resultMsg || "알 수 없는 응답"} (${header?.resultCode ?? httpStatus})`);
  }
  const body = json.response.body || {};
  let items = body.items?.item ?? [];
  if (!Array.isArray(items)) items = [items];
  return { items, totalCount: Number(body.totalCount) || 0 };
}

export function createClient({ serviceKey, endpoint = DEFAULT_ENDPOINT, fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  if (!serviceKey) throw new SeibroError("SEIBRO_SERVICE_KEY가 설정되지 않았습니다.", 500);
  const url = `${endpoint.replace(/\/$/, "")}/${OPERATION}`;

  async function request(params) {
    // 일반 인증키(Decoding)를 넣으면 URLSearchParams가 한 번만 인코딩합니다.
    // 인코딩된 키(%2B 등 포함)를 넣었다면 디코딩해서 이중 인코딩을 막습니다.
    const key = /%[0-9A-F]{2}/i.test(serviceKey) ? decodeURIComponent(serviceKey) : serviceKey;
    const qs = new URLSearchParams({ serviceKey: key, resultType: "json" });
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") qs.set(k, String(v));
    let res;
    try {
      res = await fetchImpl(`${url}?${qs}`, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw new SeibroError(e?.name === "TimeoutError" ? "배당정보 API 응답 시간 초과" : `배당정보 API 연결 실패: ${e?.message}`, 504);
    }
    return parseResponse(await res.text(), res.status);
  }

  /** 조건에 맞는 배당 레코드를 모두 가져옵니다 (페이지 자동 순회) */
  async function fetchAll(params, { pageSize = 1000, maxPages = 10 } = {}) {
    const rows = [];
    for (let page = 1; page <= maxPages; page++) {
      const { items, totalCount } = await request({ ...params, numOfRows: pageSize, pageNo: page });
      rows.push(...items);
      if (items.length === 0 || page * pageSize >= totalCount) break;
    }
    return rows;
  }

  return {
    /** ISIN으로 조회 (명세의 공식 조건은 아니지만 지원되며 가장 정확) */
    byIsin: (isinCd) => fetchAll({ isinCd }),
    /** 주식발행회사명(부분일치)으로 조회 */
    byCompanyName: (stckIssuCmpyNm) => fetchAll({ stckIssuCmpyNm }),
    /** 법인등록번호로 조회 */
    byCorpNo: (crno) => fetchAll({ crno }),
    /** 기준일자(데이터 등록일, YYYYMMDD)로 조회 — 그날 공시된 배당 일정 전체 */
    byDate: (basDt) => fetchAll({ basDt }),
  };
}

// ---------------------------------------------------------------------------
// 응답 정리
// ---------------------------------------------------------------------------

const num = (v) => (v === undefined || v === null || v === "" ? null : Number(String(v).replace(/,/g, "")));
const ymd = (v) => (/^\d{8}$/.test(String(v || "")) ? String(v) : "");

/** API 원본 레코드 → 화면용 레코드 */
export function normalizeItem(r) {
  return {
    basDt: ymd(r.basDt), // 데이터 기준일(등록일)
    crno: r.crno || "",
    company: r.stckIssuCmpyNm || "",
    isinCd: r.isinCd || "",
    itemName: r.isinCdNm || r.stckIssuCmpyNm || "",
    stockKind: r.scrsItmsKcdNm || "", // 보통주/우선주
    dividendKind: r.stckDvdnRcdNm || "", // 현금배당/주식배당/현물배당 등
    recordDate: ymd(r.dvdnBasDt), // 배당기준일
    payDate: ymd(r.cashDvdnPayDt), // 현금배당 지급일
    stockDeliveryDate: ymd(r.stckHndvDt), // 주식배당 교부일
    dps: num(r.stckGenrDvdnAmt), // 주당 일반배당금(원)
    dpsDiff: num(r.stckGrdnDvdnAmt), // 주당 차등배당금(원)
    cashRate: num(r.stckGenrCashDvdnRt), // 일반 현금배당률(%) — 액면가 대비
    stockRate: num(r.stckGenrDvdnRt), // 일반 주식배당률(%)
    parValue: num(r.stckParPrc), // 액면가
    agent: r.trsnmDptyDcdNm || "", // 명의개서대리인
  };
}

/**
 * 같은 종목·같은 배당기준일·같은 배당종류는 가장 최근에 등록된(basDt) 것만 남기고,
 * 종목별로 묶어서 배당기준일 내림차순으로 정렬합니다.
 */
export function groupByStock(rawItems) {
  const latest = new Map();
  for (const raw of rawItems) {
    const r = normalizeItem(raw);
    if (!r.recordDate || !r.isinCd) continue;
    const key = `${r.isinCd}|${r.recordDate}|${r.dividendKind}`;
    const prev = latest.get(key);
    if (!prev || r.basDt > prev.basDt) latest.set(key, r);
  }
  const stocks = new Map();
  for (const r of latest.values()) {
    if (!stocks.has(r.isinCd)) {
      stocks.set(r.isinCd, { isinCd: r.isinCd, code: r.isinCd.startsWith("KR7") ? r.isinCd.slice(3, 9) : "", name: r.itemName, company: r.company, stockKind: r.stockKind, dividends: [] });
    }
    stocks.get(r.isinCd).dividends.push(r);
  }
  const out = [...stocks.values()];
  for (const s of out) s.dividends.sort((a, b) => b.recordDate.localeCompare(a.recordDate) || b.payDate.localeCompare(a.payDate));
  // 최근 배당이 있는 종목, 보통주 먼저
  out.sort((a, b) => (b.dividends[0]?.recordDate || "").localeCompare(a.dividends[0]?.recordDate || "") || a.isinCd.localeCompare(b.isinCd));
  return out;
}

/** 다가오는 일정(오늘 이후 배당기준일 또는 지급일) */
export function upcomingEvents(stocks, todayYmd) {
  const events = [];
  for (const s of stocks) {
    for (const d of s.dividends) {
      if (d.recordDate >= todayYmd) events.push({ date: d.recordDate, type: "record", stock: s.name, isinCd: s.isinCd, dps: d.dps });
      if (d.payDate && d.payDate >= todayYmd) events.push({ date: d.payDate, type: "pay", stock: s.name, isinCd: s.isinCd, dps: d.dps });
    }
  }
  return events.sort((a, b) => a.date.localeCompare(b.date));
}

/** KST 기준 YYYYMMDD */
export function kstToday(now = Date.now()) {
  return new Date(now + 9 * 3600_000).toISOString().slice(0, 10).replace(/-/g, "");
}
