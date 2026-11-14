// 데모 모드: 서비스키 없이 화면을 확인할 수 있도록 가상의 회사로 만든 예시 응답입니다.
// 실제 종목 데이터가 아닙니다. (화면에도 "예시 데이터"로 표시됩니다)
import { shortCodeToIsin, kstToday } from "./seibro.js";

const COMPANIES = [
  { name: "예시전자", code: "900010", crno: "1101110000001", dps: [361, 361, 361, 361], quarterly: true },
  { name: "예시전자우", code: "900015", crno: "1101110000001", dps: [362, 362, 362, 362], quarterly: true, company: "예시전자", pref: true },
  { name: "샘플금융지주", code: "900020", crno: "1101110000002", dps: [600, 600, 600, 1200], quarterly: true },
  { name: "테스트화학", code: "900030", crno: "1101110000003", dps: [2500], quarterly: false },
];

function shift(ymd, months) {
  const d = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1 + months, 1));
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}
const endOfMonth = (ym) => {
  const d = new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(4, 6), 0));
  return d.toISOString().slice(0, 10).replace(/-/g, "");
};

function itemsFor(c, today) {
  const items = [];
  const year = +today.slice(0, 4);
  for (let y = year - 2; y <= year; y++) {
    const months = c.quarterly ? ["03", "06", "09", "12"] : ["12"];
    months.forEach((m, i) => {
      const record = endOfMonth(`${y}${m}01`);
      const pay = shift(record, m === "12" ? 4 : 2).slice(0, 6) + "18";
      items.push({
        basDt: shift(record, 1).slice(0, 6) + "05",
        crno: c.crno,
        stckIssuCmpyNm: c.company || c.name,
        isinCd: shortCodeToIsin(c.code),
        isinCdNm: c.name,
        scrsItmsKcdNm: c.pref ? "우선주" : "보통주",
        stckDvdnRcdNm: "현금배당",
        dvdnBasDt: record,
        cashDvdnPayDt: pay,
        stckGenrDvdnAmt: String(c.dps[i % c.dps.length] + (y - year) * 10),
        stckGrdnDvdnAmt: "0",
        stckGenrCashDvdnRt: String(((c.dps[i % c.dps.length] / 5000) * 100).toFixed(2)),
        stckParPrc: "5000",
        trsnmDptyDcdNm: "한국예탁결제원",
      });
    });
  }
  return items;
}

/** fetch 대신 쓰는 가짜 API — 실제 API와 같은 JSON 형식으로 응답합니다. */
export async function demoFetch(url) {
  const p = new URL(url).searchParams;
  const today = kstToday();
  let items = COMPANIES.flatMap((c) => itemsFor(c, today));
  if (p.get("isinCd")) items = items.filter((r) => r.isinCd === p.get("isinCd"));
  if (p.get("stckIssuCmpyNm")) items = items.filter((r) => r.stckIssuCmpyNm.includes(p.get("stckIssuCmpyNm")));
  if (p.get("crno")) items = items.filter((r) => r.crno === p.get("crno"));
  if (p.get("basDt")) items = items.filter((r) => r.basDt === p.get("basDt"));
  const body = { numOfRows: items.length, pageNo: 1, totalCount: items.length, items: { item: items } };
  return new Response(JSON.stringify({ response: { header: { resultCode: "00", resultMsg: "NORMAL SERVICE." }, body } }));
}

export const DEMO_HINT = "예시전자, 샘플금융지주, 테스트화학, 900010";
