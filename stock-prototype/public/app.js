/* 주식 관리시스템 프로토타입 — 화면 SC-01 ~ SC-07 */
(() => {
  'use strict';

  const $app = document.getElementById('app');
  const state = { user: null, charts: [] };

  // ---------------------------------------------------------------------------
  // 공통 도우미
  // ---------------------------------------------------------------------------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function api(method, path, body) {
    const res = await fetch(`/api${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    let data = {};
    try { data = await res.json(); } catch (_) { /* empty */ }
    if (!res.ok) {
      const err = new Error(data.error || `요청 실패 (HTTP ${res.status})`);
      Object.assign(err, { status: res.status, code: data.code, fields: data.fields || {}, data });
      if (res.status === 401 && state.user) { state.user = null; go('#/login'); }
      throw err;
    }
    return data;
  }

  // 표시 형식 (4.3): 원 정수 / 달러 소수 2자리 / 비율 소수 1자리. 표시할 때만 반올림
  const nf0 = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 0 });
  const nf2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const nfq = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 6 });
  const krw = (n) => (n == null ? '-' : `${nf0.format(Math.round(n))}원`);
  const usd = (n) => (n == null ? '-' : `${n < 0 ? '-' : ''}$${nf2.format(Math.abs(n))}`);
  const money = (n, cur) => (cur === 'USD' ? usd(n) : krw(n));
  const signed = (s, n) => (n > 0 ? `+${s}` : s);
  const sKrw = (n) => (n == null ? '-' : signed(krw(n), Math.round(n)));
  const sMoney = (n, cur) => (n == null ? '-' : cur === 'USD' ? signed(usd(n), n) : sKrw(n));
  const pct = (r) => (r == null ? '-' : signed(`${(r * 100).toFixed(1)}%`, Number((r * 100).toFixed(1))));
  const qty = (n) => nfq.format(n);
  const rate = (n) => (n == null ? '-' : `${nf2.format(n)}원`);
  const cls = (n) => (n == null ? '' : n > 0 ? 'up' : n < 0 ? 'down' : '');
  const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '-');
  const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
  const badge = (type) => (type ? `<span class="badge t-${esc(type)}">${esc(type)}</span>` : '');
  const req = (ids) => `<span class="req">${esc(ids)}</span>`;

  function toast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (t.hidden = true), 2600);
  }

  function destroyCharts() {
    state.charts.forEach((c) => c.destroy());
    state.charts = [];
  }

  function showFieldErrors(form, fields) {
    form.querySelectorAll('.err').forEach((e) => (e.textContent = ''));
    form.querySelectorAll('.invalid').forEach((e) => e.classList.remove('invalid'));
    Object.entries(fields || {}).forEach(([k, v]) => {
      const input = form.querySelector(`[name="${k}"]`);
      if (input) input.classList.add('invalid');
      const slot = form.querySelector(`[data-err="${k}"]`);
      if (slot) slot.textContent = v;
    });
  }

  const formData = (form) => Object.fromEntries(new FormData(form).entries());

  function parseHash() {
    const h = location.hash || '#/';
    const [path, qs] = h.slice(1).split('?');
    return { path: path || '/', query: Object.fromEntries(new URLSearchParams(qs || '')) };
  }
  const go = (hash) => { if (location.hash === hash) render(); else location.hash = hash; };

  const DISCLAIMER = '시세는 지연되거나 부정확할 수 있으며, 이 화면의 정보는 투자 권유가 아닌 참고용입니다. (NFR-LGL-01)';

  // ---------------------------------------------------------------------------
  // 레이아웃
  // ---------------------------------------------------------------------------
  const NAV = [
    ['#/assets', '자산 현황', 'SC-02'],
    ['#/stock', '종목 조회', 'SC-03'],
    ['#/holdings', '보유 종목 관리', 'SC-04'],
    ['#/yearly', '연도별 조회', 'SC-05'],
    ['#/dividends', '배당금 관리', 'SC-06'],
    ['#/me', '내 정보', 'SC-07'],
  ];

  function shell(active, inner) {
    const links = NAV.map(([h, label, sc]) => `<a href="${h}" class="${active === h ? 'active' : ''}">${label}<span class="sc">${sc}</span></a>`).join('');
    const mlinks = NAV.map(([h, label]) => `<a href="${h}" class="${active === h ? 'active' : ''}">${label}</a>`).join('');
    $app.innerHTML = `
      <div class="shell">
        <aside class="side">
          <div class="brand">주식 관리시스템<small>요구사항 v0.2 프로토타입</small></div>
          ${links}
          <div class="spacer"></div>
          <div class="who">${esc(state.user.email)}</div>
          <button class="linkish" data-logout>로그아웃</button>
        </aside>
        <div>
          <div class="mobile-top">
            <div class="bar"><span>주식 관리시스템</span><button class="linkish" data-logout>로그아웃</button></div>
            <nav>${mlinks}</nav>
          </div>
          <main class="main"><div class="content">${inner}</div><div class="footer-note">${DISCLAIMER}</div></main>
        </div>
      </div>`;
    $app.querySelectorAll('[data-logout]').forEach((b) => b.addEventListener('click', async () => {
      await api('POST', '/auth/logout');
      state.user = null;
      go('#/login');
    }));
    return $app.querySelector('main .content');
  }

  function loading(main, text = '불러오는 중…') {
    main.insertAdjacentHTML('beforeend', `<div class="card empty" data-loading>${esc(text)}</div>`);
  }

  // ---------------------------------------------------------------------------
  // SC-01 로그인·회원가입·비밀번호 재설정
  // ---------------------------------------------------------------------------
  function authPage(title, sub, body) {
    $app.innerHTML = `
      <div class="auth-wrap"><div class="auth-card">
        <div class="card">
          <h1>${title}</h1>
          <p class="muted" style="margin:4px 0 0">${sub}</p>
          ${body}
        </div>
        <p class="footer-note" style="text-align:center;border:none">${DISCLAIMER}</p>
      </div></div>`;
    return $app.querySelector('form');
  }

  function viewLogin() {
    const form = authPage('주식 관리시스템', '로그인 <span class="req">SC-01 · FR-AUTH-02</span>', `
      <form class="stack" novalidate>
        <div class="field"><label>이메일</label><input name="email" type="email" autocomplete="username" required /><span class="err" data-err="email"></span></div>
        <div class="field"><label>비밀번호</label><input name="password" type="password" autocomplete="current-password" required /><span class="err" data-err="password"></span></div>
        <div class="notice error" data-msg hidden></div>
        <button type="submit">로그인</button>
      </form>
      <div class="links"><a href="#/signup">회원가입</a><a href="#/forgot">비밀번호를 잊으셨나요?</a></div>
      <div class="demo-box">데모 계정: <b>demo@example.com</b> / <b>demo1234</b><br/>보유 종목 5개와 배당 내역이 미리 들어 있습니다.</div>`);
    form.email.focus();
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const msg = form.querySelector('[data-msg]');
      try {
        const r = await api('POST', '/auth/login', formData(form));
        state.user = r.user;
        go('#/assets');
      } catch (err) {
        msg.hidden = false;
        msg.textContent = err.message;
      }
    });
  }

  function viewSignup() {
    const form = authPage('회원가입', '이메일과 비밀번호로 가입합니다. <span class="req">FR-AUTH-01</span>', `
      <div class="notice info small" style="margin-top:14px">프로토타입에서는 이메일 인증 절차를 생략하고 가입 즉시 계정이 활성화됩니다.</div>
      <form class="stack" novalidate style="margin-top:4px">
        <div class="field"><label>이메일</label><input name="email" type="email" autocomplete="username" /><span class="err" data-err="email"></span></div>
        <div class="field"><label>비밀번호</label><input name="password" type="password" autocomplete="new-password" /><span class="hint">8자 이상, 영문과 숫자 포함</span><span class="err" data-err="password"></span></div>
        <div class="field"><label>비밀번호 확인</label><input name="password2" type="password" autocomplete="new-password" /><span class="err" data-err="password2"></span></div>
        <button type="submit">가입하기</button>
      </form>
      <div class="links"><a href="#/login">← 로그인으로</a></div>`);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const d = formData(form);
      if (d.password !== d.password2) return showFieldErrors(form, { password2: '비밀번호가 일치하지 않습니다.' });
      try {
        const r = await api('POST', '/auth/signup', { email: d.email, password: d.password });
        state.user = r.user;
        toast('가입이 완료되었습니다.');
        go('#/assets');
      } catch (err) {
        showFieldErrors(form, err.fields);
      }
    });
  }

  function viewForgot() {
    const form = authPage('비밀번호 재설정', '가입한 이메일로 재설정 링크를 보냅니다. <span class="req">FR-AUTH-03</span>', `
      <form class="stack" novalidate>
        <div class="field"><label>이메일</label><input name="email" type="email" /><span class="err" data-err="email"></span></div>
        <button type="submit">재설정 링크 받기</button>
        <div data-result></div>
      </form>
      <div class="links"><a href="#/login">← 로그인으로</a></div>`);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const r = await api('POST', '/auth/reset-request', formData(form));
        showFieldErrors(form, {});
        form.querySelector('[data-result]').innerHTML = `
          <div class="notice ok">${esc(r.message)}</div>
          ${r.demoLink ? `<div class="demo-box"><b>[프로토타입] 발송된 메일 미리보기</b><br/>아래 링크를 눌러 새 비밀번호를 설정하세요.<br/><a href="${esc(r.demoLink)}">비밀번호 재설정하기 →</a></div>` : ''}`;
      } catch (err) {
        showFieldErrors(form, err.fields);
      }
    });
  }

  function viewReset(query) {
    const form = authPage('새 비밀번호 설정', '새로 사용할 비밀번호를 입력하세요.', `
      <form class="stack" novalidate>
        <div class="field"><label>새 비밀번호</label><input name="password" type="password" autocomplete="new-password" /><span class="hint">8자 이상, 영문과 숫자 포함</span><span class="err" data-err="password"></span></div>
        <div class="notice error" data-msg hidden></div>
        <button type="submit">변경하기</button>
      </form>`);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('POST', '/auth/reset', { token: query.token, password: form.password.value });
        toast('비밀번호가 변경되었습니다. 다시 로그인해 주세요.');
        go('#/login');
      } catch (err) {
        showFieldErrors(form, err.fields);
        if (!Object.keys(err.fields).length) {
          const m = form.querySelector('[data-msg]');
          m.hidden = false;
          m.textContent = err.message;
        }
      }
    });
  }

  // ---------------------------------------------------------------------------
  // SC-02 자산 현황 (로그인 후 첫 화면)
  // ---------------------------------------------------------------------------
  async function viewAssets() {
    const main = shell('#/assets', `
      <div class="page-head">
        <div><h1>자산 현황 ${req('SC-02 · FR-AST · FR-XLS-01')}</h1><p>보유 종목의 현재 평가금액과 손익을 원화 기준으로 보여줍니다.</p></div>
        <div class="field-row">
          <button class="secondary" data-refresh>새로고침</button>
          <button data-export="/export/assets.xlsx">엑셀 내보내기</button>
        </div>
      </div>`);
    loading(main, '시세와 환율을 불러오는 중… (처음 조회하는 종목은 10년치 종가를 적재해 시간이 걸릴 수 있습니다)');
    main.querySelector('[data-refresh]').addEventListener('click', () => render());
    let d;
    try {
      d = await api('GET', '/assets');
    } catch (err) {
      main.querySelector('[data-loading]').outerHTML = `<div class="notice error"><div class="grow">${esc(err.message)}</div><button class="sm" onclick="location.reload()">재시도</button></div>`;
      return;
    }
    const ok = d.rows.filter((r) => !r.error);
    const html = [];
    if (d.basis.anyStale || d.basis.fxError) {
      html.push(`<div class="notice warn"><div><b>최신 시세가 아닐 수 있습니다.</b> 외부 출처에서 일부 시세·환율을 가져오지 못해 마지막 저장값을 표시합니다. ${req('FR-DATA-06')}<br/><span class="small">${esc(d.basis.fxError || ok.filter((r) => r.stale).map((r) => `${r.code}: ${r.staleReason}`).join(' / '))}</span></div></div>`);
    }
    d.rows.filter((r) => r.splitNotice).forEach((r) => {
      html.push(`<div class="notice warn"><div class="grow"><b>${esc(r.instrument.name)}</b>에 액면분할·병합(${esc(r.splitNotice.ratio)}, ${esc(r.splitNotice.date)})이 발생했습니다. 과거 종가는 다시 수집했으며, 보유 수량은 자동으로 바꾸지 않으니 확인 후 수정해 주세요. ${req('FR-DATA-03')}</div><a href="#/holdings"><button class="sm secondary">수량 수정</button></a></div>`);
    });
    d.rows.filter((r) => r.error).forEach((r) => {
      html.push(`<div class="notice error"><div class="grow"><b>${esc(r.code)}</b> 시세를 가져오지 못해 합계에서 제외했습니다: ${esc(r.error)}</div><button class="sm" data-refresh2>재시도</button></div>`);
    });

    if (!d.rows.length) {
      html.push(`<div class="card empty">등록한 보유 종목이 없습니다.<br/><br/><a href="#/stock"><button>종목 조회하러 가기</button></a> <a href="#/holdings"><button class="secondary">보유 종목 등록</button></a></div>`);
    } else {
      const t = d.total;
      html.push(`
        <div class="grid k4" style="margin-bottom:16px">
          <div class="kpi"><div class="label">총자산 (원화) ${req('FR-AST-02')}</div><div class="value">${krw(t.valueKrw)}</div><div class="sub">매입금액 ${krw(t.costKrw)}</div></div>
          <div class="kpi"><div class="label">평가손익 ${req('FR-AST-03')}</div><div class="value ${cls(t.pnlKrw)}">${sKrw(t.pnlKrw)}</div><div class="sub">평균 매입단가 기준</div></div>
          <div class="kpi"><div class="label">수익률</div><div class="value ${cls(t.returnPct)}">${pct(t.returnPct)}</div><div class="sub">전체 손익 ÷ 전체 매입금액</div></div>
          <div class="kpi"><div class="label">적용 환율 (USD/KRW) ${req('FR-AST-04')}</div><div class="value">${rate(d.basis.fxRate)}</div><div class="sub">${fmtTime(d.basis.fxTime)} 기준</div></div>
        </div>
        <div class="card">
          <h2>종목별 평가금액 ${req('FR-AST-01 · FR-STK-06')}</h2>
          <div class="table-wrap"><table>
            <thead><tr>
              <th>종목</th><th>구분</th><th class="num">보유 수량</th><th class="num">평균 매입단가</th><th class="num">현재가</th><th class="num">전일 대비</th>
              <th class="num">평가금액</th><th class="num">원화 평가금액</th><th class="num">원화 평가손익</th><th class="num">수익률</th>
            </tr></thead>
            <tbody>${ok.map((r) => {
              const c = r.instrument.currency;
              return `<tr>
                <td><div class="name-cell"><a href="#/stock?code=${encodeURIComponent(r.code)}">${esc(r.instrument.name)}</a><small>${esc(r.code)} · ${esc(r.instrument.market)}${r.stale ? ' · <span class="up">지연</span>' : ''}</small></div></td>
                <td>${badge(r.instrument.type)}</td>
                <td class="num">${qty(r.quantity)}</td>
                <td class="num">${money(r.avgPrice, c)}</td>
                <td class="num">${money(r.price, c)}</td>
                <td class="num ${cls(r.change)}">${sMoney(r.change, c)}<br/><small>${pct(r.changePct)}</small></td>
                <td class="num">${money(r.value, c)}${c === 'USD' ? `<br/><small class="muted">× ${rate(r.fxRate)}</small>` : ''}</td>
                <td class="num"><b>${krw(r.valueKrw)}</b></td>
                <td class="num ${cls(r.pnlKrw)}">${sKrw(r.pnlKrw)}</td>
                <td class="num ${cls(r.returnPct)}">${pct(r.returnPct)}</td>
              </tr>`;
            }).join('')}</tbody>
            <tfoot><tr><td colspan="7">합계 (원화)</td><td class="num">${krw(t.valueKrw)}</td><td class="num ${cls(t.pnlKrw)}">${sKrw(t.pnlKrw)}</td><td class="num ${cls(t.returnPct)}">${pct(t.returnPct)}</td></tr></tfoot>
          </table></div>
          <div class="basis">
            <span>시세 기준 시각 <b>${fmtTime(d.basis.priceTimeOldest)} ~ ${fmtTime(d.basis.priceTimeLatest)}</b></span>
            <span>환율 <b>${rate(d.basis.fxRate)}</b> (${fmtTime(d.basis.fxTime)}, ${esc(d.basis.fxSource || '-')})</span>
            <span>현재가는 5분간 캐시 ${req('FR-DATA-05')}</span>
          </div>
          <p class="small muted" style="margin:10px 0 0">원화 평가금액 = 현재가 × 보유 수량 × 현재 환율(국내 1) · 수익률 = (현재가 − 평균 매입단가) ÷ 평균 매입단가 · 미국 종목 손익은 매입·평가 모두 현재 환율 적용(환차손익 미반영)</p>
        </div>`);
    }
    main.querySelector('[data-loading]').outerHTML = html.join('');
    main.querySelectorAll('[data-refresh2]').forEach((b) => b.addEventListener('click', () => render()));
  }

  // ---------------------------------------------------------------------------
  // SC-03 종목 조회
  // ---------------------------------------------------------------------------
  function periodRange(p) {
    const to = new Date();
    const from = new Date();
    if (p === '1M') from.setMonth(from.getMonth() - 1);
    if (p === '3M') from.setMonth(from.getMonth() - 3);
    if (p === '1Y') from.setFullYear(from.getFullYear() - 1);
    if (p === '5Y') from.setFullYear(from.getFullYear() - 5);
    const f = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(d);
    return { from: f(from), to: f(to) };
  }

  async function viewStock(query) {
    const main = shell('#/stock', `
      <div class="page-head"><div><h1>종목 조회 ${req('SC-03 · FR-STK · FR-CHT-01')}</h1><p>국내(KOSPI·KOSDAQ) 주식·ETF·ETN, 미국 주식·ETF의 종목코드를 입력하세요.</p></div></div>
      <div class="card">
        <form class="inline" data-search novalidate>
          <div class="field" style="flex:1;min-width:220px">
            <input name="code" placeholder="예: 005930, 069500, 0080G0, 530036(ETN), AAPL, SPY" value="${esc(query.code || '')}" autocomplete="off" />
            <span class="err" data-err="code"></span>
          </div>
          <button type="submit">조회</button>
        </form>
        <div class="small muted" style="margin-top:8px">코드 형식으로 시장을 자동 판별합니다: 숫자로 시작하는 6자리 → 국내, 영문 티커 → 미국 ${req('FR-STK-02')}</div>
      </div>
      <div data-result></div>`);
    const form = main.querySelector('[data-search]');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const code = form.code.value.trim().toUpperCase();
      go(`#/stock?code=${encodeURIComponent(code)}`);
    });
    if (!query.code) {
      form.code.focus();
      main.querySelector('[data-result]').innerHTML = `<div class="card empty">종목코드를 입력해 조회하세요.<br/><span class="small">예시: <a href="#/stock?code=005930">005930</a> · <a href="#/stock?code=0080G0">0080G0</a> · <a href="#/stock?code=530036">530036</a> · <a href="#/stock?code=AAPL">AAPL</a> · <a href="#/stock?code=SPY">SPY</a></span></div>`;
      return;
    }
    await loadStock(main, query.code, query.refresh === '1');
  }

  async function loadStock(main, code, refresh) {
    const box = main.querySelector('[data-result]');
    const form = main.querySelector('[data-search]');
    box.innerHTML = `<div class="card empty">${esc(code)} 조회 중… (처음 조회하는 종목은 최근 10년 종가를 적재합니다 ${req('FR-DATA-02')})</div>`;
    let q;
    try {
      q = await api('GET', `/stocks/${encodeURIComponent(code)}${refresh ? '?refresh=1' : ''}`);
    } catch (err) {
      // FR-STK-05: 없는 코드 / 형식 오류 → 오류 메시지, 시세 수집 실패 → 원인 안내 + 재시도
      if (err.code === 'SOURCE_ERROR' || err.status >= 500) {
        box.innerHTML = `<div class="notice error"><div class="grow"><b>시세를 가져오지 못했습니다.</b><br/>${esc(err.message)}<br/><span class="small">외부 시세 출처의 일시적 장애이거나 인터넷 연결 문제일 수 있습니다. ${req('FR-STK-05')}</span></div><button data-retry>재시도</button></div>`;
        box.querySelector('[data-retry]').addEventListener('click', () => loadStock(main, code, true));
      } else {
        showFieldErrors(form, { code: err.message });
        box.innerHTML = `<div class="notice error"><div><b>${esc(code)}</b>: ${esc(err.message)} ${req('FR-STK-05')}</div></div>`;
      }
      return;
    }
    const i = q.instrument;
    const c = i.currency;
    box.innerHTML = `
      ${q.stale ? `<div class="notice warn"><div><b>최신 시세가 아닙니다.</b> 외부 출처 오류로 마지막 저장값(${fmtTime(q.priceTime)} 기준)을 표시합니다. ${req('FR-DATA-06')}<br/><span class="small">${esc(q.staleReason)}</span></div></div>` : ''}
      <div class="card">
        <div class="quote">
          <div>
            <div class="title"><h2>${esc(i.name)}</h2>${badge(i.type)}<span class="badge mk">${esc(i.market)}</span></div>
            <div class="muted">${esc(i.code)} · ${esc(c)}</div>
          </div>
          <div style="text-align:right">
            <span class="price">${money(q.price, c)}</span>
            <span class="chg ${cls(q.change)}">${sMoney(q.change, c)} (${pct(q.changePct)})</span>
            <div class="small muted">시세 기준 ${fmtTime(q.priceTime)} · 출처 ${esc(q.source)} ${req('FR-STK-03')}</div>
          </div>
        </div>
        <dl class="meta-list">
          <dt>시장</dt><dd>${esc(i.market)}</dd>
          <dt>구분</dt><dd>${esc(i.type)}</dd>
          <dt>통화</dt><dd>${esc(c)}</dd>
          <dt>상장일</dt><dd>${esc(i.listedDate || '-')}</dd>
          <dt>전일 종가</dt><dd>${money(q.prevClose, c)}</dd>
          <dt>과거 종가 출처</dt><dd>${esc(i.historySource || '-')}${i.historySource && i.historySource !== i.priceSource ? ' <span class="small muted">(예비 출처 · FR-DATA-08)</span>' : ''}</dd>
        </dl>
        <div style="margin-top:14px" class="field-row">
          <a href="#/holdings?code=${encodeURIComponent(i.code)}"><button>보유 종목으로 등록</button></a>
          <button class="secondary" data-divs>배당금 지급내역</button>
          <button class="secondary" data-refresh>현재가 새로고침</button>
        </div>
      </div>
      <div class="card">
        <h2>날짜별 종가 ${req('FR-STK-04 · FR-CHT-01')}</h2>
        <div class="field-row" style="margin-bottom:12px">
          <div class="btn-group" data-periods>
            ${['1M', '3M', '1Y', '5Y'].map((p) => `<button type="button" data-p="${p}" class="${p === '3M' ? 'on' : ''}">${{ '1M': '1개월', '3M': '3개월', '1Y': '1년', '5Y': '5년' }[p]}</button>`).join('')}
          </div>
          <div class="field-row" style="gap:6px">
            <input type="date" name="from" /> <span class="muted">~</span> <input type="date" name="to" />
            <button type="button" class="secondary" data-custom>직접 지정 조회</button>
          </div>
        </div>
        <div class="period-ret" data-ret></div>
        <div class="chart-box"><canvas></canvas></div>
        <div class="table-wrap scroll-y" style="margin-top:14px" data-table></div>
        <p class="small muted" style="margin:8px 0 0">수정 종가: 액면분할·병합을 반영해 현재 주식 수 기준으로 환산한 과거 종가 (배당 미반영) ${req('FR-DATA-03')}</p>
      </div>`;
    box.querySelector('[data-refresh]').addEventListener('click', () => loadStock(main, i.code, true));
    box.querySelector('[data-divs]').addEventListener('click', () => openDividendModal(i.code));
    const fromI = box.querySelector('input[name=from]');
    const toI = box.querySelector('input[name=to]');
    const loadPeriod = async (from, to) => {
      fromI.value = from;
      toI.value = to;
      const r = await api('GET', `/stocks/${encodeURIComponent(i.code)}/prices?from=${from}&to=${to}`);
      drawPriceChart(box.querySelector('canvas'), r.prices, c);
      // FR-STK-07 기간 수익률: 시작일 직전 거래일 종가(없으면 기간 첫 종가) 대비 기간 마지막 종가
      box.querySelector('[data-ret]').innerHTML = r.returnPct == null ? '' : `
        <span class="label">기간 수익률 ${req('FR-STK-07')}</span>
        <b class="${cls(r.returnPct)}">${pct(r.returnPct)}</b>
        <span class="small muted">${esc(r.base.date)} 종가 ${money(r.base.close, c)}${r.base.kind === 'first' ? ' (기간 첫 종가)' : ' (시작일 직전 거래일)'} → ${esc(r.end.date)} 종가 ${money(r.end.close, c)} · 배당·환율 변동 미포함</span>`;
      const rows = r.prices.slice().reverse();
      box.querySelector('[data-table]').innerHTML = rows.length
        ? `<table><thead><tr><th>거래일</th><th class="num">종가</th><th class="num">전일 대비</th><th>출처</th></tr></thead><tbody>${rows.map((p, idx) => {
          const prev = rows[idx + 1];
          const ch = prev ? p.close - prev.close : null;
          return `<tr><td>${p.date}</td><td class="num">${money(p.close, c)}</td><td class="num ${cls(ch)}">${ch == null ? '-' : `${sMoney(ch, c)} (${pct(ch / prev.close)})`}</td><td class="small muted">${esc(p.source)}</td></tr>`;
        }).join('')}</tbody></table>`
        : '<div class="empty">선택한 기간에 종가 데이터가 없습니다.</div>';
    };
    box.querySelectorAll('[data-p]').forEach((b) => b.addEventListener('click', () => {
      box.querySelectorAll('[data-p]').forEach((x) => x.classList.toggle('on', x === b));
      const r = periodRange(b.dataset.p);
      loadPeriod(r.from, r.to);
    }));
    box.querySelector('[data-custom]').addEventListener('click', () => {
      if (!fromI.value || !toI.value) return toast('시작일과 종료일을 선택해 주세요.');
      if (fromI.value > toI.value) return toast('시작일이 종료일보다 늦습니다.');
      box.querySelectorAll('[data-p]').forEach((x) => x.classList.remove('on'));
      loadPeriod(fromI.value, toI.value);
    });
    const r = periodRange('3M');
    loadPeriod(r.from, r.to);
  }

  function drawPriceChart(canvas, prices, cur) {
    destroyCharts();
    const first = prices[0];
    const last = prices[prices.length - 1];
    const color = first && last && last.close < first.close ? '#1e63c7' : '#d63031';
    state.charts.push(new Chart(canvas, {
      type: 'line',
      data: {
        labels: prices.map((p) => p.date),
        datasets: [{ data: prices.map((p) => p.close), borderColor: color, backgroundColor: color + '18', fill: true, pointRadius: 0, borderWidth: 1.8, tension: 0.15 }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => money(ctx.parsed.y, cur) } } },
        scales: {
          x: { ticks: { maxTicksLimit: 8, autoSkip: true }, grid: { display: false } },
          y: { ticks: { callback: (v) => (cur === 'USD' ? `$${v}` : nf0.format(v)) } },
        },
      },
    }));
  }

  // ---------------------------------------------------------------------------
  // SC-04 보유 종목 관리
  // ---------------------------------------------------------------------------
  async function viewHoldings(query) {
    const main = shell('#/holdings', `
      <div class="page-head"><div><h1>보유 종목 관리 ${req('SC-04 · FR-HLD')}</h1><p>종목코드, 보유 수량, 평균 매입단가를 등록·수정·삭제합니다.</p></div></div>
      <div class="card">
        <h2>보유 종목 등록 ${req('FR-HLD-01 · FR-HLD-04')}</h2>
        <form class="inline" data-add novalidate>
          <div class="field" style="width:180px"><label>종목코드</label><input name="code" value="${esc(query.code || '')}" placeholder="005930 / AAPL" autocomplete="off" /><span class="hint" data-hint></span><span class="err" data-err="code"></span></div>
          <div class="field" style="width:160px"><label>보유 수량</label><input name="quantity" inputmode="decimal" placeholder="예: 10 또는 0.5" /><span class="hint">소수 6자리까지</span><span class="err" data-err="quantity"></span></div>
          <div class="field" style="width:180px"><label>평균 매입단가 <span data-cur></span></label><input name="avgPrice" inputmode="decimal" placeholder="거래 통화 기준" /><span class="hint">국내 원 · 미국 달러</span><span class="err" data-err="avgPrice"></span></div>
          <div class="field"><label>&nbsp;</label><button type="submit">등록</button></div>
        </form>
        <div data-dup></div>
      </div>
      <div class="card"><h2>내 보유 종목 ${req('FR-HLD-02')}</h2><div data-list><div class="empty">불러오는 중…</div></div></div>`);

    const form = main.querySelector('[data-add]');
    const hint = form.querySelector('[data-hint]');
    const curLabel = form.querySelector('[data-cur]');
    const lookup = async () => {
      const code = form.code.value.trim();
      hint.textContent = '';
      curLabel.textContent = '';
      if (!code) return;
      hint.textContent = '확인 중…';
      try {
        const q = await api('GET', `/stocks/${encodeURIComponent(code)}`);
        hint.innerHTML = `${esc(q.instrument.name)} ${badge(q.instrument.type)} · 현재가 ${money(q.price, q.instrument.currency)}`;
        curLabel.textContent = `(${q.instrument.currency === 'USD' ? '달러' : '원'})`;
        showFieldErrors(form, {});
      } catch (err) {
        hint.textContent = '';
        showFieldErrors(form, { code: err.message });
      }
    };
    form.code.addEventListener('change', lookup);
    if (query.code) { lookup(); form.quantity.focus(); }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const dupBox = main.querySelector('[data-dup]');
      dupBox.innerHTML = '';
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        await api('POST', '/holdings', formData(form));
        toast('보유 종목을 등록했습니다.');
        form.reset();
        hint.textContent = '';
        curLabel.textContent = '';
        showFieldErrors(form, {});
        loadList();
      } catch (err) {
        showFieldErrors(form, err.fields);
        if (err.code === 'DUPLICATE') {
          // FR-HLD-03: 기존 항목 수정 안내
          dupBox.innerHTML = `<div class="notice warn" style="margin:12px 0 0"><div class="grow">${esc(err.message)} ${req('FR-HLD-03')}</div><button class="sm" data-edit-dup="${err.data.holdingId}">기존 항목 수정</button></div>`;
          dupBox.querySelector('[data-edit-dup]').addEventListener('click', () => {
            const row = main.querySelector(`tr[data-id="${err.data.holdingId}"] [data-edit]`);
            if (row) { row.click(); row.scrollIntoView({ block: 'center' }); }
          });
        } else if (err.code === 'SOURCE_ERROR') {
          dupBox.innerHTML = `<div class="notice error" style="margin:12px 0 0">${esc(err.message)}</div>`;
        }
      } finally {
        btn.disabled = false;
      }
    });

    async function loadList() {
      const list = main.querySelector('[data-list]');
      const { holdings } = await api('GET', '/holdings');
      if (!holdings.length) {
        list.innerHTML = '<div class="empty">등록한 종목이 없습니다.</div>';
        return;
      }
      list.innerHTML = `<div class="table-wrap"><table>
        <thead><tr><th>종목</th><th>구분</th><th>시장</th><th class="num">보유 수량</th><th class="num">평균 매입단가</th><th>수정일</th><th></th></tr></thead>
        <tbody>${holdings.map((h) => `
          <tr data-id="${h.id}">
            <td><div class="name-cell">${esc(h.name || h.code)}<small>${esc(h.code)}</small></div></td>
            <td>${badge(h.type)}</td><td>${esc(h.market || '-')}</td>
            <td class="num">${qty(h.quantity)}</td>
            <td class="num">${money(h.avg_price, h.currency)}</td>
            <td class="small muted">${fmtTime(h.updated_at)}</td>
            <td class="num"><button class="sm secondary" data-edit>수정</button> <button class="sm danger" data-del>삭제</button></td>
          </tr>`).join('')}</tbody></table></div>`;
      list.querySelectorAll('tr[data-id]').forEach((tr) => {
        const h = holdings.find((x) => String(x.id) === tr.dataset.id);
        tr.querySelector('[data-del]').addEventListener('click', async () => {
          if (!confirm(`${h.name || h.code} 종목을 보유 목록에서 삭제할까요?\n(배당 내역은 유지됩니다)`)) return;
          await api('DELETE', `/holdings/${h.id}`);
          toast('삭제했습니다.');
          loadList();
        });
        tr.querySelector('[data-edit]').addEventListener('click', () => {
          tr.innerHTML = `
            <td><div class="name-cell">${esc(h.name || h.code)}<small>${esc(h.code)}</small></div></td>
            <td>${badge(h.type)}</td><td>${esc(h.market || '-')}</td>
            <td class="num"><input name="quantity" value="${h.quantity}" style="width:110px;text-align:right" /><div class="err small" data-err="quantity"></div></td>
            <td class="num"><input name="avgPrice" value="${h.avg_price}" style="width:120px;text-align:right" /><div class="err small" data-err="avgPrice"></div></td>
            <td></td>
            <td class="num"><button class="sm" data-save>저장</button> <button class="sm secondary" data-cancel>취소</button></td>`;
          tr.querySelector('[data-cancel]').addEventListener('click', loadList);
          tr.querySelector('[data-save]').addEventListener('click', async () => {
            try {
              await api('PUT', `/holdings/${h.id}`, { quantity: tr.querySelector('[name=quantity]').value, avgPrice: tr.querySelector('[name=avgPrice]').value });
              toast('수정했습니다.');
              loadList();
            } catch (err) {
              showFieldErrors(tr, err.fields);
            }
          });
        });
      });
    }
    loadList();
  }

  // ---------------------------------------------------------------------------
  // SC-05 연도별 조회
  // ---------------------------------------------------------------------------
  async function viewYearly(query) {
    const thisYear = new Date().getFullYear();
    const to = Number(query.to) || thisYear;
    const from = Number(query.from) || to - 4;
    const opts = (sel) => Array.from({ length: 10 }, (_, k) => thisYear - 9 + k).map((y) => `<option ${y === sel ? 'selected' : ''}>${y}</option>`).join('');
    const main = shell('#/yearly', `
      <div class="page-head">
        <div><h1>연도별 조회 ${req('SC-05 · FR-YR · FR-DIV-04 · FR-XLS-02')}</h1><p>현재 보유 수량으로 연도별 자산금액을 비교합니다.</p></div>
        <button data-export="/export/yearly.xlsx?from=${from}&to=${to}">엑셀 내보내기</button>
      </div>
      <div class="notice warn"><div><b>해석 주의:</b> 현재 보유 수량 기준의 가정 금액이며 실제 과거 자산이 아닙니다. 연도 중 수량 변화는 반영되지 않고, 보유 목록에서 삭제한 종목은 과거 연도에서도 제외됩니다. ${req('FR-YR-07')}</div></div>
      <div class="card">
        <form class="field-row" data-range>
          <div class="field"><label>시작 연도</label><select name="from">${opts(from)}</select></div>
          <div class="field"><label>종료 연도</label><select name="to">${opts(to)}</select></div>
          <button type="submit">조회</button>
          <span class="small muted">기본 최근 5년 · 최대 10년 ${req('FR-YR-04')}</span>
        </form>
        <div class="err small" data-err="range" style="color:var(--error-text);margin-top:6px"></div>
      </div>`);
    const form = main.querySelector('[data-range]');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const f = Number(form.from.value);
      const t = Number(form.to.value);
      if (f > t) { main.querySelector('[data-err=range]').textContent = '시작 연도가 종료 연도보다 늦습니다.'; return; }
      go(`#/yearly?from=${f}&to=${t}`);
    });
    loading(main, '연도별 자산을 계산하는 중…');
    let d;
    try {
      d = await api('GET', `/yearly?from=${from}&to=${to}`);
    } catch (err) {
      main.querySelector('[data-loading]').outerHTML = `<div class="notice error">${esc(err.message)}</div>`;
      return;
    }
    const years = d.years;
    const hasHoldings = years[0] && years[0].items.length;
    main.querySelector('[data-loading]').outerHTML = !hasHoldings
      ? '<div class="card empty">보유 종목이 없습니다. 보유 종목을 먼저 등록하세요.</div>'
      : `
      <div class="grid c2">
        <div class="card"><h2>연도별 자산금액 ${req('FR-CHT-02')}</h2><div class="chart-box"><canvas data-c1></canvas></div></div>
        <div class="card"><h2>연도별 실제 수령 배당 ${req('FR-DIV-04 · 자산금액 미포함')}</h2><div class="chart-box"><canvas data-c2></canvas></div></div>
      </div>
      <div class="card">
        <h2>연도별 자산금액 · 전년 대비 ${req('FR-YR-01 · 02 · 03 · 05 · 06')}</h2>
        <div class="table-wrap"><table>
          <thead><tr><th>연도</th><th class="num">연말 환율</th><th class="num">자산금액</th><th class="num">전년 대비</th><th class="num">증감률</th><th class="num">실제 수령 배당<br/><small>(자산금액 미포함)</small></th><th>비고</th></tr></thead>
          <tbody>${years.map((y) => `
            <tr class="clickable" data-y="${y.year}">
              <td><b>${y.year}</b> ${y.ongoing ? '<span class="badge ongoing">진행 중</span>' : ''} <span class="small muted">▾</span></td>
              <td class="num">${rate(y.fxRate)}</td>
              <td class="num"><b>${krw(y.valueKrw)}</b></td>
              <td class="num ${cls(y.diffKrw)}">${y.diffKrw == null ? '-' : sKrw(y.diffKrw)}</td>
              <td class="num ${cls(y.diffPct)}">${pct(y.diffPct)}</td>
              <td class="num">${y.dividendCount ? krw(y.dividendKrw) : '-'}</td>
              <td class="small">${y.excludedCount ? `<span class="up">제외 종목 ${y.excludedCount}개 (합계 미포함)</span>` : ''}${y.ongoing ? '<span class="muted">최신 시세·현재 환율로 계산</span>' : ''}</td>
            </tr>
            <tr class="detail" data-detail="${y.year}" hidden><td colspan="7"><div class="inner">
              <table><thead><tr><th>종목</th><th>구분</th><th class="num">현재 보유 수량</th><th class="num">${y.ongoing ? '현재가' : '연말 종가'}</th><th>종가 기준일</th><th class="num">적용 환율</th><th class="num">원화 금액</th></tr></thead>
              <tbody>${y.items.map((i) => `<tr>
                <td><div class="name-cell">${esc(i.name)}<small>${esc(i.code)}</small></div></td><td>${badge(i.type)}</td>
                <td class="num">${qty(i.quantity)}</td>
                <td class="num">${i.close == null ? '-' : money(i.close, i.currency)}</td>
                <td class="small muted">${i.closeDate ? (y.ongoing ? fmtTime(i.closeDate) : esc(i.closeDate)) : '-'}</td>
                <td class="num">${i.excluded ? '-' : i.currency === 'USD' ? rate(i.fxRate) : '1'}</td>
                <td class="num">${i.excluded ? `- <span class="small up">(${esc(i.reason)} · 합계 제외)</span>` : krw(i.valueKrw)}</td>
              </tr>`).join('')}</tbody></table>
            </div></td></tr>`).join('')}</tbody>
        </table></div>
        <p class="small muted" style="margin:10px 0 0">연도별 자산금액 = Σ (연말 수정 종가 × 현재 보유 수량 × 해당 연도 말 환율) · 행을 누르면 종목별 내역이 펼쳐집니다 · 상장 전 연도는 ‘-’로 표시하고 합계에서 제외</p>
      </div>`;
    if (!hasHoldings) return;
    main.querySelectorAll('tr[data-y]').forEach((tr) => tr.addEventListener('click', () => {
      const det = main.querySelector(`tr[data-detail="${tr.dataset.y}"]`);
      det.hidden = !det.hidden;
    }));
    destroyCharts();
    const labels = years.map((y) => (y.ongoing ? `${y.year} (진행 중)` : String(y.year)));
    const baseOpts = {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => krw(ctx.parsed.y) } } },
      scales: { y: { beginAtZero: true, ticks: { callback: (v) => (v >= 1e8 ? `${(v / 1e8).toFixed(1)}억` : v >= 1e4 ? `${nf0.format(v / 1e4)}만` : nf0.format(v)) } }, x: { grid: { display: false } } },
    };
    state.charts.push(new Chart(main.querySelector('[data-c1]'), {
      type: 'bar',
      data: { labels, datasets: [{ data: years.map((y) => y.valueKrw), backgroundColor: years.map((y) => (y.ongoing ? '#f0b44c' : '#2b6cb0')), borderRadius: 4 }] },
      options: baseOpts,
    }));
    state.charts.push(new Chart(main.querySelector('[data-c2]'), {
      type: 'bar',
      data: { labels, datasets: [{ data: years.map((y) => y.dividendKrw), backgroundColor: '#2e9e5b', borderRadius: 4 }] },
      options: baseOpts,
    }));
  }

  // ---------------------------------------------------------------------------
  // SC-06 배당금 관리
  // ---------------------------------------------------------------------------
  async function viewDividends(query) {
    const main = shell('#/dividends', `
      <div class="page-head"><div><h1>배당금 관리 ${req('SC-06 · FR-DIV · FR-CHT-03')}</h1><p>실제 수령한 배당금(세후)과 ETF 분배금을 기록합니다. 보유 종목을 삭제해도 내역은 유지됩니다.</p></div></div>
      <div class="card">
        <h2 data-form-title>배당 내역 등록 ${req('FR-DIV-01')}</h2>
        <form class="inline" data-form novalidate>
          <input type="hidden" name="id" />
          <div class="field" style="width:150px"><label>종목코드</label><input name="code" placeholder="005930 / AAPL" autocomplete="off" list="hcodes" /><span class="hint" data-hint></span><span class="err" data-err="code"></span></div>
          <div class="field" style="width:160px"><label>지급일</label><input name="payDate" type="date" max="${today()}" /><span class="err" data-err="payDate"></span></div>
          <div class="field" style="width:150px"><label>실제 수령 금액</label><input name="amount" inputmode="decimal" placeholder="세후 금액" /><span class="err" data-err="amount"></span></div>
          <div class="field" style="width:100px"><label>통화</label><select name="currency"><option value="KRW">KRW</option><option value="USD">USD</option></select><span class="err" data-err="currency"></span></div>
          <div class="field" style="flex:1;min-width:180px"><label>메모 (선택, 200자)</label><input name="memo" maxlength="200" /><span class="err" data-err="memo"></span></div>
          <div class="field"><label>&nbsp;</label><div class="field-row"><button type="submit" data-submit>등록</button><button type="button" class="secondary" data-cancel hidden>취소</button></div></div>
        </form>
        <datalist id="hcodes"></datalist>
        <div data-form-msg></div>
      </div>
      <div class="card"><h2>연도별 배당 합계 ${req('FR-DIV-03 · FR-CHT-03')}</h2>
        <div class="grid c2"><div class="chart-box" style="height:220px"><canvas></canvas></div><div data-yearly class="table-wrap"></div></div>
      </div>
      <div>
        <div class="card">
          <h2>배당 내역 조회 ${req('FR-DIV-02')}</h2>
          <form class="field-row" data-filter style="margin-bottom:12px">
            <div class="field"><label>시작일</label><input type="date" name="from" value="${esc(query.from || '')}" /></div>
            <div class="field"><label>종료일</label><input type="date" name="to" value="${esc(query.to || '')}" /></div>
            <div class="field" style="width:110px"><label>종목코드</label><input name="code" value="${esc(query.code || '')}" list="hcodes" /></div>
            <button type="submit" class="secondary">검색</button>
          </form>
          <div data-list></div>
        </div>
      </div>`);

    const form = main.querySelector('[data-form]');
    const hint = form.querySelector('[data-hint]');
    form.payDate.value = today();

    api('GET', '/holdings').then(({ holdings }) => {
      main.querySelector('#hcodes').innerHTML = holdings.map((h) => `<option value="${esc(h.code)}">${esc(h.name || '')}</option>`).join('');
    });

    form.code.addEventListener('change', async () => {
      const code = form.code.value.trim();
      hint.textContent = '';
      if (!code) return;
      try {
        const q = await api('GET', `/stocks/${encodeURIComponent(code)}`);
        hint.innerHTML = `${esc(q.instrument.name)} ${badge(q.instrument.type)}`;
        form.currency.value = q.instrument.currency;
        showFieldErrors(form, {});
      } catch (err) {
        showFieldErrors(form, { code: err.message });
      }
    });

    const resetForm = () => {
      form.reset();
      form.id.value = '';
      form.payDate.value = today();
      hint.textContent = '';
      showFieldErrors(form, {});
      main.querySelector('[data-form-title]').innerHTML = `배당 내역 등록 ${req('FR-DIV-01')}`;
      form.querySelector('[data-submit]').textContent = '등록';
      form.querySelector('[data-cancel]').hidden = true;
    };
    form.querySelector('[data-cancel]').addEventListener('click', resetForm);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const d = formData(form);
      const msg = main.querySelector('[data-form-msg]');
      msg.innerHTML = '';
      try {
        if (d.id) await api('PUT', `/dividends/${d.id}`, d);
        else await api('POST', '/dividends', d);
        toast(d.id ? '수정했습니다.' : '등록했습니다.');
        resetForm();
        refresh();
      } catch (err) {
        showFieldErrors(form, err.fields);
        if (!Object.keys(err.fields).length) msg.innerHTML = `<div class="notice error" style="margin:10px 0 0">${esc(err.message)}</div>`;
      }
    });

    const filter = main.querySelector('[data-filter]');
    filter.addEventListener('submit', (e) => {
      e.preventDefault();
      const f = formData(filter);
      if (f.from && f.to && f.from > f.to) return toast('시작일이 종료일보다 늦습니다.');
      const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
      go(`#/dividends${qs ? `?${qs}` : ''}`);
    });

    async function refresh() {
      const qs = new URLSearchParams(Object.entries({ from: query.from, to: query.to, code: query.code }).filter(([, v]) => v)).toString();
      const [{ dividends }, { years }] = await Promise.all([api('GET', `/dividends?${qs}`), api('GET', '/dividends/yearly')]);
      const list = main.querySelector('[data-list]');
      list.innerHTML = dividends.length
        ? `<div class="table-wrap scroll-y"><table><thead><tr><th>지급일</th><th>종목</th><th class="num">수령 금액</th><th class="num">원화 환산</th><th>메모</th><th></th></tr></thead><tbody>
          ${dividends.map((d) => `<tr data-id="${d.id}">
            <td>${esc(d.pay_date)}</td>
            <td><div class="name-cell"><span>${esc(d.name || d.code)} ${badge(d.type)}</span><small>${esc(d.code)}</small></div></td>
            <td class="num">${money(d.amount, d.currency)}</td>
            <td class="num">${krw(d.krw)}${d.currency === 'USD' ? `<br/><small class="muted">× ${rate(d.fxRate)}</small>` : ''}</td>
            <td class="small">${esc(d.memo || '')}</td>
            <td class="num"><button class="sm secondary" data-edit>수정</button> <button class="sm danger" data-del>삭제</button></td>
          </tr>`).join('')}</tbody></table></div>
          <div class="small muted" style="margin-top:6px">${dividends.length}건 · 원화 합계 ${krw(dividends.reduce((s, d) => s + (d.krw || 0), 0))} (지급일 환율 적용)</div>`
        : '<div class="empty">조건에 맞는 배당 내역이 없습니다.</div>';
      list.querySelectorAll('tr[data-id]').forEach((tr) => {
        const d = dividends.find((x) => String(x.id) === tr.dataset.id);
        tr.querySelector('[data-del]').addEventListener('click', async () => {
          if (!confirm('이 배당 내역을 삭제할까요?')) return;
          await api('DELETE', `/dividends/${d.id}`);
          toast('삭제했습니다.');
          refresh();
        });
        tr.querySelector('[data-edit]').addEventListener('click', () => {
          form.id.value = d.id;
          form.code.value = d.code;
          form.payDate.value = d.pay_date;
          form.amount.value = d.amount;
          form.currency.value = d.currency;
          form.memo.value = d.memo || '';
          main.querySelector('[data-form-title]').innerHTML = `배당 내역 수정 ${req('FR-DIV-01')}`;
          form.querySelector('[data-submit]').textContent = '저장';
          form.querySelector('[data-cancel]').hidden = false;
          form.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
      });

      const shown = years.filter((y, i) => y.count || i >= years.length - 5);
      main.querySelector('[data-yearly]').innerHTML = `<table><thead><tr><th>연도</th><th class="num">건수</th><th class="num">원화 합계</th></tr></thead><tbody>${shown.slice().reverse().map((y) => `<tr><td>${y.year}</td><td class="num">${y.count}</td><td class="num">${krw(y.krw)}</td></tr>`).join('')}</tbody></table>`;
      destroyCharts();
      state.charts.push(new Chart(main.querySelector('canvas'), {
        type: 'bar',
        data: { labels: shown.map((y) => String(y.year)), datasets: [{ data: shown.map((y) => y.krw), backgroundColor: '#2e9e5b', borderRadius: 4 }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => krw(c.parsed.y) } } }, scales: { y: { beginAtZero: true, ticks: { callback: (v) => nf0.format(v) } }, x: { grid: { display: false } } } },
      }));
    }
    refresh();
  }

  // ---------------------------------------------------------------------------
  // SC-07 내 정보
  // ---------------------------------------------------------------------------
  function viewMe() {
    const main = shell('#/me', `
      <div class="page-head"><div><h1>내 정보 ${req('SC-07 · FR-AUTH-03 · FR-AUTH-04')}</h1><p>${esc(state.user.email)} · 가입일 ${fmtTime(state.user.created_at)}</p></div></div>
      <div class="grid c2">
        <div class="card">
          <h2>비밀번호 변경</h2>
          <form data-pw novalidate style="display:flex;flex-direction:column;gap:12px;max-width:360px">
            <div class="field"><label>현재 비밀번호</label><input type="password" name="current" autocomplete="current-password" /><span class="err" data-err="current"></span></div>
            <div class="field"><label>새 비밀번호</label><input type="password" name="next" autocomplete="new-password" /><span class="hint">8자 이상, 영문과 숫자 포함</span><span class="err" data-err="next"></span></div>
            <div><button type="submit">변경</button></div>
          </form>
        </div>
        <div class="card">
          <h2>회원 탈퇴</h2>
          <div class="notice warn"><div>탈퇴하면 계정, 보유 종목, 배당 내역이 모두 삭제되며 복구할 수 없습니다. ${req('NFR-PRI-01')}</div></div>
          <form data-del novalidate style="display:flex;flex-direction:column;gap:12px;max-width:360px">
            <div class="field"><label>비밀번호 확인</label><input type="password" name="password" autocomplete="current-password" /><span class="err" data-err="password"></span></div>
            <div><button type="submit" class="danger">회원 탈퇴</button></div>
          </form>
        </div>
      </div>`);
    const pw = main.querySelector('[data-pw]');
    pw.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('POST', '/auth/change-password', formData(pw));
        pw.reset();
        showFieldErrors(pw, {});
        toast('비밀번호를 변경했습니다.');
      } catch (err) {
        showFieldErrors(pw, err.fields);
      }
    });
    const del = main.querySelector('[data-del]');
    del.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!confirm('정말 탈퇴하시겠습니까? 모든 데이터가 삭제됩니다.')) return;
      try {
        await api('DELETE', '/auth/account', formData(del));
        state.user = null;
        toast('탈퇴가 완료되었습니다.');
        go('#/login');
      } catch (err) {
        showFieldErrors(del, err.fields);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // 엑셀 내보내기: PC 브라우저는 바로 다운로드, 안드로이드 앱은 기기의 다운로드 폴더에 저장
  // ---------------------------------------------------------------------------
  async function download(path) {
    if (!window.MobileApp) {
      location.href = `/api${path}`;
      return;
    }
    try {
      toast('엑셀 파일을 만드는 중…');
      const r = await window.MobileApp.request('GET', path);
      if (r.status !== 200) throw new Error((r.json && r.json.error) || '내보내기에 실패했습니다.');
      const msg = await window.MobileApp.saveFile(r.filename, r.bytes, r.contentType);
      toast(msg);
    } catch (e) {
      toast(e.message);
    }
  }

  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-export]');
    if (b) download(b.dataset.export);
  });

  // ---------------------------------------------------------------------------
  // 배당금 지급내역 팝업 (FR-STK-08, FR-DATA-09)
  // ---------------------------------------------------------------------------
  function closeModal() {
    const m = document.querySelector('.modal-back');
    if (m) m.remove();
    document.body.classList.remove('modal-open');
  }

  async function openDividendModal(code, refresh) {
    closeModal();
    document.body.classList.add('modal-open');
    document.body.insertAdjacentHTML('beforeend', `
      <div class="modal-back"><div class="modal" role="dialog" aria-modal="true">
        <div class="modal-head"><h2>배당금 지급내역 ${req('FR-STK-08')}</h2><button class="linkish close" aria-label="닫기">✕</button></div>
        <div class="modal-body"><div class="empty">최근 10년 배당 내역을 불러오는 중…</div></div>
      </div></div>`);
    const back = document.querySelector('.modal-back');
    back.addEventListener('click', (e) => { if (e.target === back || e.target.closest('.close')) closeModal(); });
    const body = back.querySelector('.modal-body');
    let d;
    try {
      d = await api('GET', `/stocks/${encodeURIComponent(code)}/dividends${refresh ? '?refresh=1' : ''}`);
    } catch (err) {
      body.innerHTML = `<div class="notice error"><div class="grow">${esc(err.message)}</div><button class="sm" data-retry>재시도</button></div>`;
      body.querySelector('[data-retry]').addEventListener('click', () => openDividendModal(code, true));
      return;
    }
    const i = d.instrument;
    const c = i.currency;
    const held = d.quantity != null;
    const parts = [];
    parts.push(`<div class="modal-title"><b>${esc(i.name)}</b> ${badge(i.type)} <span class="muted small">${esc(i.code)}</span></div>`);
    if (d.stale) {
      parts.push(`<div class="notice warn"><div class="grow"><b>최신 배당 내역이 아닐 수 있습니다.</b> ${d.neverLoaded ? '배당 내역을 가져오지 못했습니다.' : `마지막 저장값(${fmtTime(d.loadedAt)} 기준)을 표시합니다.`} ${req('FR-DATA-09')}<br/><span class="small">${esc(d.staleReason)}</span></div><button class="sm" data-retry>재시도</button></div>`);
    }
    if (!d.events.length) {
      parts.push(`<div class="empty">${d.neverLoaded ? '' : '최근 10년간 배당(분배금) 지급 내역이 없습니다.'}${d.source && d.source.includes('Naver') ? '<br/><span class="small">예비 출처(네이버 차트)는 배당 정보를 제공하지 않습니다.</span>' : ''}</div>`);
    } else {
      if (held) parts.push(`<div class="notice info small"><div>현재 <b>${qty(d.quantity)}주</b> 보유 중입니다. 세전 추정액 = 주당 배당금 × 현재 보유 수량 (과거 보유 수량·세금 미반영)</div></div>`);
      parts.push(`
        <h3 style="margin:6px 0 8px">연도별 합계·배당수익률</h3>
        <div class="table-wrap"><table>
          <thead><tr><th>연도</th><th class="num">횟수</th><th class="num">주당 배당 합계</th><th class="num">기준 종가</th><th class="num">배당수익률</th>${held ? '<th class="num">세전 추정액</th>' : ''}</tr></thead>
          <tbody>${d.years.map((y) => `<tr>
            <td>${y.year} ${y.ongoing ? '<span class="badge ongoing">진행 중</span>' : ''}</td>
            <td class="num">${y.count}</td>
            <td class="num">${money(y.perShare, c)}</td>
            <td class="num">${y.refClose == null ? '-' : money(y.refClose, c)}</td>
            <td class="num">${y.yieldPct == null ? '-' : `${(y.yieldPct * 100).toFixed(1)}%`}</td>
            ${held ? `<td class="num">${money(y.estimate, c)}${c === 'USD' && y.estimateKrw != null ? `<br/><small class="muted">≈ ${krw(y.estimateKrw)}</small>` : ''}</td>` : ''}
          </tr>`).join('')}</tbody>
        </table></div>
        <p class="small muted" style="margin:6px 0 14px">배당수익률 = 연간 주당 배당 합계 ÷ 연말 종가 (올해는 현재가 기준)</p>
        <h3 style="margin:0 0 8px">배당락일별 주당 배당금</h3>
        <div class="table-wrap scroll-y" style="max-height:260px"><table>
          <thead><tr><th>배당락일</th><th class="num">주당 배당금</th>${held ? '<th class="num">세전 추정액</th>' : ''}</tr></thead>
          <tbody>${d.events.map((e) => `<tr><td>${esc(e.exDate)}</td><td class="num">${money(e.amount, c)}</td>${held ? `<td class="num">${money(e.estimate, c)}${c === 'USD' && e.estimateKrw != null ? ` <small class="muted">≈ ${krw(e.estimateKrw)}</small>` : ''}</td>` : ''}</tr>`).join('')}</tbody>
        </table></div>`);
    }
    parts.push(`<p class="small muted" style="margin:12px 0 0">출처 ${esc(d.source || '-')} · 저장 ${fmtTime(d.loadedAt)} (1일 동안 재사용) · 출처가 배당락일만 제공해 실제 지급일은 표시하지 않습니다. 실제 수령액은 배당금 관리 화면에 기록하세요.</p>`);
    body.innerHTML = parts.join('');
    const retry = body.querySelector('[data-retry]');
    if (retry) retry.addEventListener('click', () => openDividendModal(code, true));
  }

  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

  // ---------------------------------------------------------------------------
  // 라우터
  // ---------------------------------------------------------------------------
  const PUBLIC = { '/login': viewLogin, '/signup': viewSignup, '/forgot': viewForgot, '/reset': viewReset };
  const PRIVATE = { '/assets': viewAssets, '/stock': viewStock, '/holdings': viewHoldings, '/yearly': viewYearly, '/dividends': viewDividends, '/me': viewMe };

  async function render() {
    destroyCharts();
    closeModal();
    const { path, query } = parseHash();
    if (PUBLIC[path]) {
      if (state.user && path !== '/reset') return go('#/assets');
      return PUBLIC[path](query);
    }
    if (!state.user) return go('#/login');
    (PRIVATE[path] || (() => go('#/assets')))(query);
    window.scrollTo(0, 0);
  }

  window.addEventListener('hashchange', render);
  api('GET', '/auth/me').then((r) => {
    state.user = r.user;
    render();
  }).catch(() => render());
})();
