const $ = (s) => document.querySelector(s);
const statusEl = $("#status");
const resultsEl = $("#results");
let today = "";

// ---------- 유틸 ----------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmtDate = (d) => (d ? `${d.slice(0, 4)}.${d.slice(4, 6)}.${d.slice(6, 8)}` : "-");
const fmtWon = (n) => (n === null || n === undefined || Number.isNaN(n) ? "-" : `${Math.round(n).toLocaleString("ko-KR")}원`);
const fmtPct = (n) => (n === null || n === undefined || Number.isNaN(n) ? "-" : `${n}%`);
const toUtc = (d) => Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8));
const daysBetween = (a, b) => Math.round((toUtc(b) - toUtc(a)) / 86400000);
const shiftDays = (d, n) => new Date(toUtc(d) + n * 86400000).toISOString().slice(0, 10).replace(/-/g, "");
const dday = (d) => {
  const n = daysBetween(today, d);
  return n === 0 ? "D-Day" : n > 0 ? `D-${n}` : `D+${-n}`;
};

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle("error", isError);
}

async function api(path) {
  const res = await fetch(path);
  const data = await res.json().catch(() => ({ error: `서버 응답 오류 (HTTP ${res.status})` }));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ---------- 최근 검색 (이 브라우저에만 저장) ----------
const RECENT_KEY = "dividend-recent";
function loadRecent() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY)) || [];
  } catch {
    return [];
  }
}
function saveRecent(q) {
  const list = [q, ...loadRecent().filter((x) => x !== q)].slice(0, 8);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {}
  renderRecent();
}
function renderRecent(extra = []) {
  const items = [...new Set([...loadRecent(), ...extra])];
  $("#recent").innerHTML = items.map((q) => `<button class="chip" type="button" data-q="${esc(q)}">${esc(q)}</button>`).join("");
}
$("#recent").addEventListener("click", (e) => {
  const q = e.target.dataset?.q;
  if (!q) return;
  switchTab("stock");
  $("#q").value = q;
  searchStock(q);
});

// ---------- 탭 ----------
function switchTab(name) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  $("#stockForm").classList.toggle("hidden", name !== "stock");
  $("#dateForm").classList.toggle("hidden", name !== "date");
}
document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => switchTab(t.dataset.tab)));

// ---------- 렌더링 ----------
function summarize(stock) {
  const divs = stock.dividends;
  const latest = divs.find((d) => d.recordDate <= today) || divs[divs.length - 1];
  const yearAgo = shiftDays(today, -365);
  const lastYear = divs.filter((d) => d.recordDate > yearAgo && d.recordDate <= today && d.dps);
  const nextPay = divs.filter((d) => d.payDate && d.payDate >= today).sort((a, b) => a.payDate.localeCompare(b.payDate))[0];
  const nextRecord = divs.filter((d) => d.recordDate >= today).sort((a, b) => a.recordDate.localeCompare(b.recordDate))[0];
  return {
    latest,
    yearSum: lastYear.reduce((s, d) => s + (d.dps || 0), 0),
    yearCount: lastYear.length,
    nextPay,
    nextRecord,
  };
}

function rowStatus(d) {
  if (d.recordDate >= today) return `<span class="badge soon">${dday(d.recordDate)} 기준일</span>`;
  if (d.payDate && d.payDate >= today) return `<span class="badge soon">${dday(d.payDate)} 지급</span>`;
  if (d.payDate) return `<span class="badge paid">지급완료</span>`;
  return "";
}

const INITIAL_ROWS = 8;

function stockCard(stock, idx) {
  const s = summarize(stock);
  const rows = stock.dividends
    .map(
      (d, i) => `<tr class="${d.recordDate >= today || (d.payDate && d.payDate >= today) ? "future" : ""} ${i >= INITIAL_ROWS ? "extra hidden" : ""}">
        <td>${fmtDate(d.recordDate)}</td>
        <td>${fmtDate(d.payDate || d.stockDeliveryDate)}</td>
        <td>${esc(d.dividendKind || "-")}</td>
        <td class="num">${d.dps !== null ? fmtWon(d.dps) : d.stockRate !== null ? fmtPct(d.stockRate) : "-"}</td>
        <td class="num">${d.dpsDiff ? fmtWon(d.dpsDiff) : "-"}</td>
        <td class="num">${fmtPct(d.cashRate)}</td>
        <td>${rowStatus(d)}</td>
      </tr>`,
    )
    .join("");
  const more = stock.dividends.length > INITIAL_ROWS ? `<button class="link-btn more" data-more="${idx}">전체 ${stock.dividends.length}건 보기</button>` : "";
  return `<article class="card" data-idx="${idx}">
    <div class="card-head">
      <div>
        <h3>${esc(stock.name)} ${stock.stockKind ? `<span class="muted">${esc(stock.stockKind)}</span>` : ""}</h3>
        <div class="ids">${stock.code ? `${esc(stock.code)} · ` : ""}${esc(stock.isinCd)}${stock.company && stock.company !== stock.name ? ` · ${esc(stock.company)}` : ""}</div>
      </div>
      <button class="link-btn" data-csv="${idx}">CSV 저장</button>
    </div>
    <div class="stats">
      <div class="stat"><div class="label">최근 주당배당금</div><div class="value">${fmtWon(s.latest?.dps)}</div><div class="muted">${fmtDate(s.latest?.recordDate)} 기준</div></div>
      <div class="stat"><div class="label">최근 1년 합계</div><div class="value">${fmtWon(s.yearSum)}</div><div class="muted">${s.yearCount}회 배당</div></div>
      <div class="stat"><div class="label">다음 배당기준일</div><div class="value">${s.nextRecord ? fmtDate(s.nextRecord.recordDate) : "-"}</div><div class="muted">${s.nextRecord ? dday(s.nextRecord.recordDate) : "공시 전"}</div></div>
      <div class="stat"><div class="label">다음 지급일</div><div class="value">${s.nextPay ? fmtDate(s.nextPay.payDate) : "-"}</div><div class="muted">${s.nextPay ? `${dday(s.nextPay.payDate)} · ${fmtWon(s.nextPay.dps)}` : "예정 없음"}</div></div>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>배당기준일</th><th>지급일</th><th>구분</th><th class="num">주당배당금</th><th class="num">차등배당</th><th class="num">배당률(액면)</th><th>상태</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    ${more}
  </article>`;
}

function renderUpcoming(events) {
  const soon = events.slice(0, 8);
  $("#upcomingWrap").classList.toggle("hidden", soon.length === 0);
  $("#upcoming").innerHTML = soon
    .map(
      (e) => `<li><span class="dday">${dday(e.date)}</span>
        <div class="when">${fmtDate(e.date)} ${e.type === "pay" ? "지급" : "배당기준일"}</div>
        <div>${esc(e.stock)}</div>
        <div class="muted">주당 ${fmtWon(e.dps)}${e.type === "record" ? " · 기준일 2영업일 전까지 매수해야 받을 수 있어요" : ""}</div></li>`,
    )
    .join("");
}

let currentStocks = [];
function renderStocks(stocks) {
  currentStocks = stocks;
  resultsEl.innerHTML = stocks.map(stockCard).join("");
}

resultsEl.addEventListener("click", (e) => {
  const more = e.target.dataset?.more;
  if (more !== undefined) {
    resultsEl.querySelectorAll(`.card[data-idx="${more}"] tr.extra`).forEach((tr) => tr.classList.remove("hidden"));
    e.target.remove();
  }
  const csv = e.target.dataset?.csv;
  if (csv !== undefined) downloadCsv(currentStocks[csv]);
});

function downloadCsv(stock) {
  const header = ["종목명", "종목코드", "ISIN", "배당기준일", "현금배당지급일", "주식교부일", "배당구분", "주당일반배당금", "주당차등배당금", "현금배당률(%)", "주식배당률(%)", "액면가", "데이터기준일"];
  const lines = stock.dividends.map((d) => [stock.name, stock.code, stock.isinCd, d.recordDate, d.payDate, d.stockDeliveryDate, d.dividendKind, d.dps, d.dpsDiff, d.cashRate, d.stockRate, d.parValue, d.basDt]);
  const csv = [header, ...lines].map((r) => r.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }); // 엑셀 한글 깨짐 방지 BOM
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `배당_${stock.name}_${stock.code || stock.isinCd}.csv` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- 검색 ----------
async function withLoading(form, fn) {
  const btn = form.querySelector("button");
  btn.disabled = true;
  resultsEl.innerHTML = "";
  $("#upcomingWrap").classList.add("hidden");
  setStatus("조회 중…");
  try {
    await fn();
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    btn.disabled = false;
  }
}

async function searchStock(q) {
  await withLoading($("#stockForm"), async () => {
    const data = await api(`/api/dividends?q=${encodeURIComponent(q)}`);
    if (!data.stocks.length) {
      setStatus(data.query.type === "name" ? `"${q}"(으)로 등록된 배당 내역이 없습니다. 회사명은 공시상 정식 명칭(예: NAVER → 네이버)으로 검색해 보세요.` : "배당 내역이 없습니다.");
      return;
    }
    saveRecent(q);
    setStatus(`${data.stocks.length}개 종목, 배당 ${data.stocks.reduce((s, x) => s + x.dividends.length, 0)}건`);
    renderUpcoming(data.upcoming);
    renderStocks(data.stocks);
  });
}

$("#stockForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = $("#q").value.trim();
  if (q) searchStock(q);
});

$("#dateForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const date = $("#date").value.replace(/-/g, "");
  withLoading($("#dateForm"), async () => {
    const data = await api(`/api/dividends/by-date?date=${date}`);
    if (!data.stocks.length) {
      setStatus(`${fmtDate(date)}에 등록된 배당 공시가 없습니다. (주말·공휴일에는 데이터가 없습니다)`);
      return;
    }
    setStatus(`${fmtDate(date)} 등록된 배당 공시 ${data.stocks.length}개 종목`);
    renderStocks(data.stocks);
  });
});

// ---------- 시작 ----------
(async () => {
  try {
    const cfg = await api("/api/config");
    today = cfg.today;
    $("#date").value = `${today.slice(0, 4)}-${today.slice(4, 6)}-${today.slice(6, 8)}`;
    if (cfg.demo) {
      const b = $("#demoBanner");
      b.textContent = `데모 모드: 서비스키가 설정되지 않아 가상의 예시 데이터를 보여줍니다. 예시 검색어: ${cfg.demoHint}`;
      b.classList.remove("hidden");
      renderRecent(cfg.demoHint.split(", "));
    } else {
      renderRecent();
    }
  } catch (err) {
    setStatus(`서버에 연결할 수 없습니다: ${err.message}`, true);
  }
})();
