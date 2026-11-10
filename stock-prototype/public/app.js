/* 주식 관리시스템 프로토타입 — 화면 SC-01 ~ SC-07 */
(() => {
  'use strict';

  const $app = document.getElementById('app');
  const state = { user: null, charts: [], settings: null };

  // 회원별 화면 설정: 마지막 조회 기간·선택 연도 (서버에 저장 → PC·앱 어디서나 이어짐)
  const settings = {
    get(key) { return (state.settings || {})[key]; },
    set(key, value) {
      state.settings = { ...(state.settings || {}), [key]: value };
      api('PUT', `/settings/${encodeURIComponent(key)}`, { value }).catch(() => {});
    },
  };
  async function loadSettings() {
    try { state.settings = (await api('GET', '/settings')).settings || {}; } catch (_) { state.settings = {}; }
  }
  const THIS_YEAR = new Date().getFullYear();
  const yearOptions = (sel, min = THIS_YEAR - 15, max = THIS_YEAR) =>
    Array.from({ length: max - min + 1 }, (_, k) => max - k).map((y) => `<option value="${y}" ${y === sel ? 'selected' : ''}>${y}년</option>`).join('');

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
  const pct = (r) => {
    if (r == null) return '-';
    const v = Number((r * 100).toFixed(1));
    return signed(`${(v === 0 ? 0 : v).toFixed(1)}%`, v); // 반올림해 0이면 -0.0% 대신 0.0%
  };
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
  // 표 안의 수정·삭제 아이콘 버튼
  const ICON_EDIT = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
  const ICON_DEL = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/></svg>';

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
    ['#/dividends', '배당금 조회(요약)', 'SC-06'],
    ['#/divmgmt', '배당금 관리', 'SC-08'],
    ['#/me', '내 정보', 'SC-07'],
  ];

  function shell(active, inner) {
    const links = NAV.map(([h, label, sc]) => `<a href="${h}" class="${active === h ? 'active' : ''}">${label}<span class="sc">${sc}</span></a>`).join('');
    const mlinks = NAV.map(([h, label]) => `<a href="${h}" class="${active === h ? 'active' : ''}">${label}</a>`).join('');
    $app.innerHTML = `
      <div class="shell">
        <aside class="side">
          <div class="brand">주식 관리시스템<small>요구사항 정의서 기반 프로토타입</small></div>
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
        state.settings = null;
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
  async function viewAssets(query) {
    const year = Math.min(Number(query.year) || Number(settings.get('assets.year')) || THIS_YEAR, THIS_YEAR);
    const ongoing = year >= THIS_YEAR;
    const groupParam = query.group !== undefined ? query.group : (settings.get('assets.group') || '');
    // 통합: ‘전체’에서 그룹 구분 없이 종목별로 수량 합산 (마지막 선택 기억)
    const merged = !groupParam && (query.merged !== undefined ? query.merged === '1' : !!settings.get('assets.merged'));
    const groupQs = (groupParam ? `&group=${encodeURIComponent(groupParam)}` : '') + (merged ? '&merged=1' : '');
    const main = shell('#/assets', `
      <div class="page-head">
        <div><h1>자산 현황 ${req('SC-02 · FR-AST · FR-XLS-01')}</h1><p>${ongoing ? '선택한 연도 말 보유 종목의 현재 평가금액과 손익을 원화 기준으로 보여줍니다.' : `${year}년 말 보유 종목을 그해 연말 종가·연말 환율로 평가합니다.`}</p></div>
        <div class="field-row">
          <div class="field"><label>기준 연도</label><select data-year>${yearOptions(year)}</select></div>
          <button class="secondary" data-refresh>새로고침</button>
          <button data-export="/export/assets.xlsx?year=${year}${groupQs}">엑셀 내보내기</button>
        </div>
      </div>
      <div class="card"><div class="group-bar"><div class="group-tabs" data-tabs><span class="small muted">그룹 불러오는 중…</span></div><div class="field-row" style="gap:14px;align-items:center"><label class="merge-toggle" data-merge-wrap hidden><input type="checkbox" data-merge ${merged ? 'checked' : ''} /> 통합 <span class="muted small">(그룹 구분 없이 종목별 합산)</span></label><a href="#/holdings" class="small">그룹 관리 →</a></div></div></div>`);
    main.querySelector('[data-year]').addEventListener('change', (e) => {
      settings.set('assets.year', Number(e.target.value));
      go(`#/assets?year=${e.target.value}${groupQs}`);
    });

    loading(main, '시세와 환율을 불러오는 중… (처음 조회하는 종목은 10년치 종가를 적재해 시간이 걸릴 수 있습니다)');
    main.querySelector('[data-refresh]').addEventListener('click', () => render());
    let d;
    try {
      d = await api('GET', `/assets?year=${year}${groupQs}`);
    } catch (err) {
      main.querySelector('[data-loading]').outerHTML = `<div class="notice error"><div class="grow">${esc(err.message)}</div><button class="sm" onclick="location.reload()">재시도</button></div>`;
      return;
    }
    // 그룹 탭 (보유 종목 관리와 같은 방식)
    const tabs = main.querySelector('[data-tabs]');
    tabs.innerHTML = [`<button class="${d.groupId ? '' : 'on'}" data-g="">전체</button>`]
      .concat(d.groups.map((g) => `<button class="${d.groupId === g.id ? 'on' : ''}" data-g="${g.id}">${esc(g.name)}</button>`)).join('');
    tabs.querySelectorAll('[data-g]').forEach((b) => b.addEventListener('click', () => {
      settings.set('assets.group', b.dataset.g);
      go(`#/assets?year=${year}&group=${b.dataset.g}`);
    }));
    // ‘전체’일 때만 통합 체크박스 표시
    const mergeWrap = main.querySelector('[data-merge-wrap]');
    mergeWrap.hidden = !!d.groupId;
    mergeWrap.querySelector('[data-merge]').addEventListener('change', (e) => {
      settings.set('assets.merged', e.target.checked);
      go(`#/assets?year=${year}&group=&merged=${e.target.checked ? 1 : 0}`);
    });
    const showGroup = !d.groupId && !d.merged && d.groups.length > 1;
    const ok = d.rows.filter((r) => !r.error);
    const html = [];
    if (!d.ongoing) {
      html.push(`<div class="notice info"><div><b>${d.year}년 말 기준</b>: 보유 종목 관리에 입력한 ${d.year}년 말 보유 수량을 ${d.year}년 마지막 거래일 종가와 연말 환율로 평가했습니다. 평균 매입단가도 ${d.year}년 말 기준입니다.</div></div>`);
    }
    if (d.basis.anyStale || d.basis.fxError) {
      html.push(`<div class="notice warn"><div><b>${d.ongoing ? '최신 시세가 아닐 수 있습니다.' : '일부 값을 계산하지 못했습니다.'}</b> ${d.ongoing ? `외부 출처에서 일부 시세·환율을 가져오지 못해 마지막 저장값을 표시합니다. ${req('FR-DATA-06')}` : ''}<br/><span class="small">${esc(d.basis.fxError || ok.filter((r) => r.stale).map((r) => `${r.code}: ${r.staleReason}`).join(' / '))}</span></div></div>`);
    }
    d.rows.filter((r) => r.splitNotice).forEach((r) => {
      html.push(`<div class="notice warn"><div class="grow"><b>${esc(r.instrument.name)}</b>에 액면분할·병합(${esc(r.splitNotice.ratio)}, ${esc(r.splitNotice.date)})이 발생했습니다. 과거 종가는 다시 수집했으며, 보유 수량은 자동으로 바꾸지 않으니 확인 후 보유 수량을 고쳐 주세요. ${req('FR-DATA-03')}</div><a href="#/holdings?year=${THIS_YEAR}"><button class="sm secondary">종목 수정</button></a></div>`);
    });
    d.rows.filter((r) => r.error).forEach((r) => {
      html.push(`<div class="notice error"><div class="grow"><b>${esc(r.instrument ? r.instrument.name : r.code)}</b> 합계에서 제외했습니다: ${esc(r.error)}</div>${d.ongoing ? '<button class="sm" data-refresh2>재시도</button>' : ''}</div>`);
    });

    if (!d.rows.length) {
      html.push(`<div class="card empty">${d.year}년 말 ${d.groupId ? `‘${esc((d.groups.find((g) => g.id === d.groupId) || {}).name)}’ 그룹의 ` : ''}보유 종목이 없습니다.<br/><br/><a href="#/stock"><button>종목 조회하러 가기</button></a> <a href="#/holdings?year=${d.year}"><button class="secondary">${d.year}년 종목 등록</button></a></div>`);
    } else {
      const t = d.total;
      const priceLabel = d.ongoing ? '현재가' : '연말 종가';
      // 소계·합계 행의 현재가(·전일 대비) 칸: 전일 대비 칸에는 보유 종목 전체의 오늘 손익 합계
      // 소계·합계 행의 이월금액(·전일 대비) 칸
      // 소계·합계 행 (v0.12.6 열 순서): 손익 기준액 · 현 평가금액 · 전일 대비
      const gapCells = (x) => `<td class="num">${krw(x.costKrw)}</td><td class="num">${krw(x.valueKrw)}</td>${d.ongoing ? `<td class="num ${cls(x.todayPnlKrw)}">${sKrw(x.todayPnlKrw)}<br/><small>${pct(x.todayPct)}</small></td>` : ''}`;
      // 오늘 손익·손익률 열 (올해만: 전일 종가 대비)
      const todayHead = d.ongoing ? '<th class="num today-col">오늘 손익</th><th class="num today-col">오늘 손익률</th>' : '';
      const todayCells = (x) => (d.ongoing
        ? `<td class="num today-col ${cls(x.todayPnlKrw)}">${x.todayPnlKrw == null ? '-' : sKrw(x.todayPnlKrw)}</td><td class="num today-col ${cls(x.todayPct)}">${x.todayPct == null ? '-' : pct(x.todayPct)}</td>`
        : '');
      // 올해 손익(1월 1일 기준 + 올해 실현손익)과 전체기간 손익(원래 매입금액 기준 + 누적 실현손익) (v0.10)
      const pnlCells = (x) => `<td class="num ${cls(x.pnlKrw)}">${sKrw(x.pnlKrw)}</td><td class="num ${cls(x.returnPct)}">${pct(x.returnPct)}</td><td class="num ${cls(x.totalPnlKrw)}">${sKrw(x.totalPnlKrw)}</td><td class="num ${cls(x.totalPct)}">${pct(x.totalPct)}</td>`;
      const pnlHead = '<th class="num">금년 손익</th><th class="num">금년 수익률</th><th class="num">전체 손익</th><th class="num">전체 수익률</th>';
      const todayNote = d.ongoing ? `<p class="small muted" style="margin:8px 0 0">오늘 손익 = 전일 대비 가격 변동 × 보유 수량 × 현재 환율 · 오늘 손익률 = 오늘 손익 ÷ 전일 종가 기준 평가금액 (환율 변동은 반영하지 않음) · 합계 오늘 손익 ${sKrw(t.todayPnlKrw)} (${pct(t.todayPct)})</p>` : '';
      html.push(`
        <div class="card fold-card" data-ckey="summary"><h2>요약</h2>
        <div class="grid k4">
          <div class="kpi"><div class="label">총자산 (원화) ${req('FR-AST-02')}</div><div class="value">${krw(t.valueKrw)}</div><div class="sub">매입금액 ${krw(t.origCostKrw)} · 손익 기준액 ${krw(t.costKrw)}</div></div>
          <div class="kpi"><div class="label">${d.ongoing ? '금년' : `${d.year}년`} 손익 ${req('FR-AST-03')}</div><div class="value ${cls(t.pnlKrw)}">${sKrw(t.pnlKrw)}</div><div class="sub">수익률 <b class="${cls(t.returnPct)}">${pct(t.returnPct)}</b> · 평가금액 − 손익 기준액(금년)</div></div>
          <div class="kpi"><div class="label">전체기간 손익 ${req('FR-AST-11')}</div><div class="value ${cls(t.totalPnlKrw)}">${sKrw(t.totalPnlKrw)}</div><div class="sub">수익률 <b class="${cls(t.totalPct)}">${pct(t.totalPct)}</b> · 매입금액 ${krw(t.origCostKrw)} 기준</div></div>
          <div class="kpi"><div class="label">${d.ongoing ? '적용 환율' : '연말 환율'} (USD/KRW) ${req('FR-AST-04')}</div><div class="value">${rate(d.basis.fxRate)}${d.basis.fxChangePct == null ? '' : ` <span class="kpi-chg ${cls(d.basis.fxChangePct)}">${pct(d.basis.fxChangePct)}</span>`}</div><div class="sub">${d.basis.fxChangePct == null ? '' : `전일 대비 ${sMoney(d.basis.fxRate - d.basis.fxPrev, 'KRW')} (${esc(String(d.basis.fxPrevDate || ''))} ${rate(d.basis.fxPrev)}) · `}${d.ongoing ? `${fmtTime(d.basis.fxTime)} 기준` : `${esc(String(d.basis.fxTime || '').slice(0, 10))} 기준`}</div></div>
        </div></div>
        ${showGroup && d.groupTotals.length > 1 ? `<div class="card" data-ckey="group">
          <h2>그룹별 합계</h2>
          <div class="table-wrap"><table>
            <thead><tr><th>그룹</th><th class="num">종목 수</th><th class="num">원화 평가금액</th><th class="num">비중</th>${pnlHead}${todayHead}</tr></thead>
            <tbody>${d.groupTotals.map((g) => `<tr>
              <td><a href="#/assets?year=${d.year}&group=${g.groupId}">${esc(g.name)}</a></td><td class="num">${g.count}${g.soldCount ? `<br/><small class="muted">매도 ${g.soldCount}</small>` : ''}</td>
              <td class="num"><b>${krw(g.valueKrw)}</b></td><td class="num">${pct(t.valueKrw ? g.valueKrw / t.valueKrw : null).replace('+', '')}</td>
              ${pnlCells(g)}${todayCells(g)}
            </tr>`).join('')}</tbody>
            <tfoot><tr class="sum-row">
              <td>소계</td><td class="num">${d.groupTotals.reduce((n, g) => n + g.count, 0)}</td>
              <td class="num">${krw(t.valueKrw)}</td><td class="num">100.0%</td>
              ${pnlCells(t)}${todayCells(t)}
            </tr></tfoot>
          </table></div>
        </div>` : ''}
        ${(d.categoryTotals || []).some((c) => c.count || c.soldCount) ? `<div class="card" data-ckey="category">
          <h2>분류별 합계${d.groupId ? ` · ${esc((d.groups.find((g) => g.id === d.groupId) || {}).name)}` : ''}</h2>
          <div class="table-wrap"><table>
            <thead><tr><th>분류</th><th class="num">종목 수</th><th class="num">원화 평가금액</th><th class="num">비중</th>${pnlHead}${todayHead}</tr></thead>
            <tbody>${d.categoryTotals.map((c) => `<tr>
              <td><span class="cat cat-${c.id}">${esc(c.label)}</span></td><td class="num">${c.count}</td>
              <td class="num"><b>${c.count ? krw(c.valueKrw) : '-'}</b></td><td class="num">${c.count ? pct(t.valueKrw ? c.valueKrw / t.valueKrw : null).replace('+', '') : '-'}</td>
              ${c.count || c.soldCount ? pnlCells(c) : '<td class="num">-</td><td class="num">-</td><td class="num">-</td><td class="num">-</td>'}${c.count ? todayCells(c) : (d.ongoing ? '<td class="num today-col">-</td><td class="num today-col">-</td>' : '')}
            </tr>`).join('')}</tbody>
            <tfoot><tr class="sum-row">
              <td>소계</td><td class="num">${d.categoryTotals.reduce((n, c) => n + c.count, 0)}</td>
              <td class="num">${krw(t.valueKrw)}</td><td class="num">100.0%</td>
              ${pnlCells(t)}${todayCells(t)}
            </tr></tfoot>
          </table></div>
          ${todayNote}
          <p class="small muted" style="margin:4px 0 0">분류는 보유 종목 관리에서 종목을 등록할 때 고릅니다(국내 · 해외 · 해외추종: 해외 자산을 따라가는 국내 상장 ETF 등).</p>
        </div>` : ''}
        <div class="card" data-ckey="stocks">
          <h2>${d.year}년${d.ongoing ? '' : ' 말'} 종목별 평가금액${d.groupId ? ` · ${esc((d.groups.find((g) => g.id === d.groupId) || {}).name)}` : d.merged ? ' · 전체 통합' : ''} ${req('FR-AST-01 · FR-STK-06')}</h2>
          ${d.merged ? '<p class="small muted" style="margin:-4px 0 10px">그룹 구분 없이 같은 종목의 보유 수량과 매입금액을 합쳤습니다. 평균 매입단가 = 합계 매입금액 ÷ 합계 수량</p>' : ''}
          <div class="table-wrap"><table class="stock-table">
            <thead><tr>
              <th>종목</th><th class="num">보유수량</th><th class="num">매입단가</th><th class="num">매입금액</th><th class="num">손익 기준액(금년)</th><th class="num">현 평가금액</th>${d.ongoing ? '<th class="num">전일 대비</th>' : ''}
              <th class="num">금년 손익</th><th class="num">전체 손익</th>
            </tr></thead>
            <tbody>${(() => {
              const cols = d.ongoing ? 9 : 8;
              // 외화 종목: 원화 금액을 누르면 외화 금액을 툴팁으로 보여준다
              const fxTip = (r, amount) => (r.instrument.currency === 'USD' ? `${usd(amount)} × ${rate(r.fxRate)}` : '');
              const krwCell = (r, krwVal, amount, bold) => {
                const txt = bold ? `<b>${krw(krwVal)}</b>` : krw(krwVal);
                const tip = fxTip(r, amount);
                return tip ? `<span class="tip" data-tip="${esc(tip)}" tabindex="0">${txt}</span>` : txt;
              };
              // 이월금액(1월 1일 기준 금액) 계산 근거
              const basisTip = (r) => {
                const c = r.instrument.currency;
                const parts = [];
                if (r.carryFixed) parts.push('보유 종목 관리에 저장한 이월액(수량을 바꿔도 그대로)');
                else if (r.carriedQty > 0) parts.push(r.basisFallback ? `이월 ${qty(r.carriedQty)}주: 전년 종가가 없어 실제 매입금액 적용` : `이월 ${qty(r.carriedQty)}주 × ${esc(r.startClose ? r.startClose.date : '')} 종가 ${money(r.startClose ? r.startClose.close : null, c)}`);
                else parts.push(`${d.year}년 신규 매수(이월 없음)`);
                if (c === 'USD' && r.carry) parts.push(`${usd(r.carry)} × ${rate(r.fxRate)}`);
                if (r.newBuysKrw) parts.push(`${d.year}년 매수금액 ${krw(r.newBuysKrw)}은 별도(올해 손익에서 차감)`);
                return parts.join(' · ');
              };
              // 평가금액: 현재가(지난 연도는 연말 종가) × 보유 수량 (× 환율)
              const valueTip = (r) => {
                const c = r.instrument.currency;
                return `${priceLabel} ${money(r.price, c)}${d.ongoing ? '' : ` (${String(r.priceTime).slice(0, 10)})`} × ${qty(r.quantity)}주${c === 'USD' ? ` = ${usd(r.value)} × ${rate(r.fxRate)}` : ''}`;
              };
              // 전일 대비: 1주당 가격 변동 × 보유 수량 전체 (원화). 툴팁에 1주당 변동(외화 종목은 외화 금액도)
              const todayCell = (r) => {
                if (r.todayPnlKrw == null) return sMoney(r.change, r.instrument.currency);
                const c = r.instrument.currency;
                const tip = `1주당 ${sMoney(r.change, c)} × ${qty(r.quantity)}주${c === 'USD' ? ` = ${sMoney(r.change * r.quantity, c)} × ${rate(r.fxRate)}` : ''}`;
                return `<span class="tip" data-tip="${esc(tip)}" tabindex="0">${sKrw(r.todayPnlKrw)}</span>`;
              };
              // 올해 손익·전체기간 손익 칸 (v0.10): 금액 + 수익률, 누르면 계산 근거
              const yearCell = (r) => {
                // 금년 손익 = 평가금액(원화) − 손익 기준액(금년) (v0.12.5)
                if (r.pnlKrw == null) return '<td class="num muted">-</td>';
                const tip = `현 평가금액 ${krw(r.valueKrw)} − 손익 기준액 ${krw(r.costKrw)}`;
                return `<td class="num ${cls(r.pnlKrw)}"><span class="tip" data-tip="${esc(tip)}" tabindex="0">${sKrw(r.pnlKrw)}</span>${r.returnPct == null ? '' : `<br/><small>${pct(r.returnPct)}</small>`}</td>`;
              };
              const totalCell = (r) => {
                const c = r.instrument.currency;
                const parts = [];
                if (r.origCostKrw != null) parts.push(`매입금액 ${krw(r.origCostKrw)} (평균 ${money(r.origAvgPrice, c)})`, `평가손익 ${sKrw(r.valueKrw - r.origCostKrw)}`);
                if (r.realizedCumKrw || r.totalPnlKrw && r.valueKrw == null) parts.push(`누적 실현손익 ${sKrw(r.realizedCumKrw != null ? r.realizedCumKrw : r.totalPnlKrw)}`);
                return `<td class="num ${cls(r.totalPnlKrw)}"><span class="tip" data-tip="${esc(parts.join(' · '))}" tabindex="0">${sKrw(r.totalPnlKrw)}</span>${r.totalPct == null ? '' : `<br/><small>${pct(r.totalPct)}</small>`}</td>`;
              };
              const sumCells = (x) => `<td class="num ${cls(x.pnlKrw)}">${sKrw(x.pnlKrw)}<br/><small>${pct(x.returnPct)}</small></td><td class="num ${cls(x.totalPnlKrw)}">${sKrw(x.totalPnlKrw)}<br/><small>${pct(x.totalPct)}</small></td>`;
              // 그 해 전량 매도한 종목 행: 보유 수량 0, 손익만 표시
              const soldHtml = (r) => `<tr class="sold-row">
                <td class="left"><div class="name-cell"><a href="#/stock?code=${encodeURIComponent(r.code)}" data-stock-popup="${esc(r.code)}" title="종목 조회 팝업 열기">${esc(r.instrument.name)}</a><small>${esc(r.code)} · <span class="cat cat-${esc(r.category)}">${esc(r.categoryLabel)}</span> ${badge(r.instrument.type)} · <span class="badge sold">${d.year}년 전량 매도${r.soldQty > 1e-9 ? ` ${qty(r.soldQty)}주` : ''}</span>${r.mergedGroups && r.mergedGroups.length ? ` · ${r.mergedGroups.map(esc).join('·')}` : ''}</small></div></td>
                <td class="num">0</td><td class="num muted">-</td><td class="num muted">-</td><td class="num muted">-</td><td class="num muted">-</td>${d.ongoing ? '<td class="num muted">-</td>' : ''}
                ${yearCell(r)}${totalCell(r)}
              </tr>`;
              const rowHtml = (r) => {
                const c = r.instrument.currency;
                return `<tr>
                <td class="left"><div class="name-cell"><a href="#/stock?code=${encodeURIComponent(r.code)}" data-stock-popup="${esc(r.code)}" title="종목 조회 팝업 열기">${esc(r.instrument.name)}</a><small>${esc(r.code)} · ${esc(r.instrument.market)} · <span class="cat cat-${esc(r.category)}">${esc(r.categoryLabel)}</span> ${badge(r.instrument.type)}${r.stale ? ' · <span class="up">지연</span>' : ''}${r.mergedGroups && r.mergedGroups.length > 1 ? ` · <span class="badge grp">${r.mergedGroups.map(esc).join('·')} 합산</span>` : ''}</small></div></td>
                <td class="num">${qty(r.quantity)}</td>
                <td class="num">${money(r.origAvgPrice, c)}</td>
                <td class="num">${krwCell(r, r.origCostKrw, r.origCost, false)}</td>
                <td class="num"><span class="tip" data-tip="${esc(r.carryKrw > 0 ? `이월 금액(전년) 기준 · ${basisTip(r)}` : '이월 금액이 없어 총 매입금액 기준')}" tabindex="0">${krw(r.costKrw)}</span></td>
                <td class="num"><span class="tip" data-tip="${esc(valueTip(r))}" tabindex="0"><b>${krw(r.valueKrw)}</b></span></td>
                ${d.ongoing ? `<td class="num ${cls(r.change)}">${todayCell(r)}<br/><small>${pct(r.changePct)}</small></td>` : ''}
                ${yearCell(r)}${totalCell(r)}
              </tr>`;
              };
              const sold = d.soldRows || [];
              if (!showGroup) return ok.map(rowHtml).join('') + sold.map(soldHtml).join('');
              // 전체: 그룹별 구역(그룹 제목 행 + 종목 + 그룹 소계 행)
              return d.groups.filter((g) => ok.some((r) => r.groupId === g.id) || sold.some((r) => r.groupId === g.id)).map((g) => {
                const gt = d.groupTotals.find((x) => x.groupId === g.id) || {};
                return `<tr class="group-row"><td colspan="${cols}"><a href="#/assets?year=${d.year}&group=${g.id}">${esc(g.name)}</a> <span class="muted" style="font-weight:400">${gt.count || 0}종목${gt.soldCount ? ` · 전량 매도 ${gt.soldCount}` : ''}</span></td></tr>
                  ${ok.filter((r) => r.groupId === g.id).map(rowHtml).join('')}${sold.filter((r) => r.groupId === g.id).map(soldHtml).join('')}
                  <tr class="group-sub"><td colspan="3">${esc(g.name)} 소계</td><td class="num">${krw(gt.origCostKrw)}</td>${gapCells(gt)}${sumCells(gt)}</tr>`;
              }).join('');
            })()}</tbody>
            <tfoot><tr><td colspan="3">합계 (원화)</td><td class="num">${krw(t.origCostKrw)}</td>${gapCells(t)}${(() => `<td class="num ${cls(t.pnlKrw)}">${sKrw(t.pnlKrw)}<br/><small>${pct(t.returnPct)}</small></td><td class="num ${cls(t.totalPnlKrw)}">${sKrw(t.totalPnlKrw)}<br/><small>${pct(t.totalPct)}</small></td>`)()}</tr></tfoot>
          </table></div>
          <div class="basis">
            <span>시세 기준 <b>${d.ongoing ? `${fmtTime(d.basis.priceTimeOldest)} ~ ${fmtTime(d.basis.priceTimeLatest)}` : `${d.year}년 마지막 거래일 종가`}</b></span>
            <span>환율 <b>${rate(d.basis.fxRate)}</b> (${d.ongoing ? fmtTime(d.basis.fxTime) : esc(String(d.basis.fxTime || '').slice(0, 10))}, ${esc(d.basis.fxSource || '-')})</span>
            ${d.ongoing ? `<span>현재가는 5분간 캐시 ${req('FR-DATA-05')}</span>` : ''}
          </div>
          <p class="small muted" style="margin:10px 0 0">매입단가·매입금액 = 실제로 산 평균 단가·금액(원화)(보유 종목 관리에 입력) · <b>손익 기준액(금년)</b> = 이월 금액(전년)이 있으면 이월 금액, 없으면 매입금액(보유 종목 관리와 같음, 누르면 근거) · 외화 종목은 원화 금액을 누르면 외화 금액, 현 평가금액을 누르면 ${priceLabel} × 수량이 보입니다${d.ongoing ? " · 전일 대비 = 1주당 가격 변동 × 보유 수량 전체 × 현재 환율(원화, 금액을 누르면 1주당 변동 표시)" : ""} · 현 평가금액 = ${priceLabel} × ${d.year}년 말 보유수량 × 환율(국내 1, 원화) · <b>금년 손익</b> = 현 평가금액 − 손익 기준액(금년) · <b>전체 손익</b> = 현 평가금액 − 매입금액 + 누적 실현손익 · 금년 수익률 = 금년 손익 ÷ 손익 기준액, 전체 수익률 = 전체 손익 ÷ 매입금액 · 전량 매도 종목은 평가금액이 없어 금년 손익 없이 전체 손익(실현손익)만 표시 · 미국 종목 손익은 매입·평가 모두 같은 환율 적용(환차손익 미반영) · 보유 수량은 <a href="#/holdings?year=${d.year}">보유 종목 관리</a>에 입력한 연도별 보유 수량(주식 항목)으로 계산</p>
        </div>`);
    }
    main.querySelector('[data-loading]').outerHTML = html.join('');
    main.querySelectorAll('[data-refresh2]').forEach((b) => b.addEventListener('click', () => render()));
    makeFoldable(main, 'assets.collapsed');
  }

  // 상자(카드) 접기·펴기: 제목 오른쪽 −/+ 버튼. 접은 상자는 settingKey 에 저장해 다음에도 유지
  function makeFoldable(root, settingKey) {
    const folded = new Set(settings.get(settingKey) || []);
    root.querySelectorAll('.card[data-ckey]').forEach((card) => {
      const h2 = card.querySelector(':scope > h2');
      if (!h2 || h2.querySelector('.fold-btn')) return;
      const key = card.dataset.ckey;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'fold-btn';
      const apply = () => {
        const on = folded.has(key);
        card.classList.toggle('collapsed', on);
        btn.textContent = on ? '+' : '−';
        btn.title = on ? '펴기' : '접기';
        btn.setAttribute('aria-expanded', String(!on));
      };
      btn.addEventListener('click', () => {
        if (folded.has(key)) folded.delete(key); else folded.add(key);
        apply();
        settings.set(settingKey, [...folded]);
      });
      h2.appendChild(btn);
      apply();
    });
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
      const box = main.querySelector('[data-result]');
      const samples = '<a href="#/stock?code=005930">005930</a> · <a href="#/stock?code=0080G0">0080G0</a> · <a href="#/stock?code=530036">530036</a> · <a href="#/stock?code=AAPL">AAPL</a> · <a href="#/stock?code=SPY">SPY</a>';
      box.innerHTML = '<div class="card empty">종목코드를 입력해 조회하세요.</div>';
      // 내가 보유한 모든 종목(올해 말 기준, 전 그룹 합산)을 바로 조회할 수 있는 링크로 보여준다
      let held = [];
      try { held = (await api('GET', `/holdings?year=${THIS_YEAR}`)).holdings || []; } catch (_) { /* 예시만 표시 */ }
      held.sort((a, b) => String(a.name || a.code).localeCompare(String(b.name || b.code), 'ko'));
      box.innerHTML = held.length
        ? `<div class="card">
            <h2>내 보유 종목 <span class="small muted" style="font-weight:400">${held.length}개 · 눌러서 조회</span></h2>
            <div class="stock-chips">${held.map((h) => `<a class="stock-chip" href="#/stock?code=${encodeURIComponent(h.code)}">${badge(h.type)} ${esc(h.name || h.code)}<span class="muted">(${esc(h.code)})</span></a>`).join('')}</div>
            <p class="small muted" style="margin:10px 0 0">보유 종목은 <a href="#/holdings">보유 종목 관리</a>에 입력한 올해 보유 수량 기준이며, 모든 그룹을 합쳐 보여줍니다. 다른 종목은 위에 종목코드를 입력하세요.</p>
          </div>`
        : `<div class="card empty">종목코드를 입력해 조회하세요.<br/><span class="small">보유 종목이 없어 예시를 보여줍니다: ${samples}</span></div>`;
      return;
    }
    await loadStock(main.querySelector('[data-result]'), query.code, query.refresh === '1', main.querySelector('[data-search]'));
  }

  // 종목 정보·날짜별 종가를 box 안에 그린다. 종목 조회 화면과 자산 현황의 종목 팝업에서 함께 사용
  async function loadStock(box, code, refresh, form) {
    box.innerHTML = `<div class="card empty">${esc(code)} 조회 중… (처음 조회하는 종목은 최근 10년 종가를 적재합니다 ${req('FR-DATA-02')})</div>`;
    let q;
    try {
      q = await api('GET', `/stocks/${encodeURIComponent(code)}${refresh ? '?refresh=1' : ''}`);
    } catch (err) {
      // FR-STK-05: 없는 코드 / 형식 오류 → 오류 메시지, 시세 수집 실패 → 원인 안내 + 재시도
      if (err.code === 'SOURCE_ERROR' || err.status >= 500) {
        box.innerHTML = `<div class="notice error"><div class="grow"><b>시세를 가져오지 못했습니다.</b><br/>${esc(err.message)}<br/><span class="small">외부 시세 출처의 일시적 장애이거나 인터넷 연결 문제일 수 있습니다. ${req('FR-STK-05')}</span></div><button data-retry>재시도</button></div>`;
        box.querySelector('[data-retry]').addEventListener('click', () => loadStock(box, code, true, form));
      } else {
        if (form) showFieldErrors(form, { code: err.message });
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
    box.querySelector('[data-refresh]').addEventListener('click', () => loadStock(box, i.code, true, form));
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
      settings.set('stock.period', { p: b.dataset.p }); // 마지막 조회 기간 기억
      loadPeriod(r.from, r.to);
    }));
    box.querySelector('[data-custom]').addEventListener('click', () => {
      if (!fromI.value || !toI.value) return toast('시작일과 종료일을 선택해 주세요.');
      if (fromI.value > toI.value) return toast('시작일이 종료일보다 늦습니다.');
      box.querySelectorAll('[data-p]').forEach((x) => x.classList.remove('on'));
      settings.set('stock.period', { p: 'custom', from: fromI.value, to: toI.value });
      loadPeriod(fromI.value, toI.value);
    });
    // 마지막으로 조회한 기간으로 시작 (없으면 3개월)
    const saved = settings.get('stock.period') || { p: '3M' };
    box.querySelectorAll('[data-p]').forEach((x) => x.classList.toggle('on', x.dataset.p === saved.p));
    if (saved.p === 'custom' && saved.from && saved.to) loadPeriod(saved.from, saved.to);
    else {
      const r = periodRange(['1M', '3M', '1Y', '5Y'].includes(saved.p) ? saved.p : '3M');
      loadPeriod(r.from, r.to);
    }
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
    // 종목 조회에서 ‘보유 종목으로 등록’으로 들어오면 올해, 아니면 마지막으로 본 연도·그룹
    const year = Math.min(Number(query.year) || (query.code ? THIS_YEAR : Number(settings.get('holdings.year')) || THIS_YEAR), THIS_YEAR);
    const groupParam = query.group !== undefined ? query.group : settings.get('holdings.group');
    const yy = `'${String(year).slice(2)}`; // 예: '26 (이월액 라벨)
    const main = shell('#/holdings', `
      <div class="page-head">
        <div><h1>보유 종목 관리 ${req('SC-04 · FR-HLD')}</h1><p>그룹(ISA·연금·일반 등)과 연도를 골라 주식 항목을 관리합니다. 보유 수량은 목록의 <b>수정</b>에서 매수·매도 구분 없이 바로 바꾸면 됩니다. 손대지 않은 연도는 직전 연도 보유가 그대로 이어집니다(이월).</p></div>
        <div class="field-row"><div class="field"><label>관리 연도</label><select data-year>${yearOptions(year)}</select></div></div>
      </div>
      <div class="card">
        <div class="group-bar"><div class="group-tabs" data-tabs></div><button class="sm secondary" data-manage>그룹 관리</button></div>
        <div data-group-panel hidden></div>
      </div>
      <div class="card">
        <h2 data-form-title></h2>
        <form class="inline edit-mode" data-add novalidate>
          <input type="hidden" name="id" />
          <div class="field" data-f="group" style="width:120px"><label>그룹</label><select name="groupId"></select><span class="err" data-err="groupId"></span></div>
          <div class="field" data-f="code" style="width:150px"><label>종목코드</label><input name="code" value="${esc(query.code || '')}" placeholder="005930 / AAPL" autocomplete="off" /><span class="hint" data-hint></span><span class="err" data-err="code"></span></div>
          <div class="field" data-f="category" style="width:110px"><label>분류</label><select name="category"><option value="">선택</option><option value="DOMESTIC">국내</option><option value="OVERSEAS">해외</option><option value="OVERSEAS_TRACK">해외추종</option></select><span class="hint">종목별로 하나</span><span class="err" data-err="category"></span></div>
          <div class="field" data-f="carryMode" style="width:100px"><label>이월 여부</label><select name="carryMode"><option value="NEW">신규</option><option value="CARRIED">이월</option></select><span class="hint">이월: 전년도부터 보유</span><span class="err" data-err="carryMode"></span></div>
          <div class="field" data-f="cqty" style="width:120px"><label>이월 수량</label><input name="carriedQty" inputmode="decimal" placeholder="전년부터 보유 시" /><span class="hint" data-cqty-hint>전년부터 보유 시 입력</span><span class="err" data-err="carriedQty"></span></div>
          <div class="field" data-f="qty" style="width:110px"><label>총 수량</label><input name="quantity" inputmode="decimal" placeholder="예: 10" /><span class="hint">그 해 말 수량</span><span class="err" data-err="quantity"></span></div>
          <div class="field" data-f="amount" style="width:150px"><label>총 매입금액 <span data-cur></span></label><input name="purchaseAmount" inputmode="decimal" placeholder="총 매입금액" /><span class="hint">거래 통화 기준</span><span class="err" data-err="purchaseAmount"></span></div>
          <div class="field" data-f="avg" style="width:140px"><label>매입단가(평균)</label><input name="avgPrice" class="auto-calc" readonly tabindex="-1" placeholder="자동 계산" /><span class="hint">매입금액 ÷ 보유 수량</span><span class="err" data-err="avgPrice"></span></div>
          <div class="field" data-f="carry" style="width:160px" data-basis-field><label>이월 금액(전년) <span data-cur2></span></label><input name="carryAmount" inputmode="decimal" placeholder="비우면 자동 계산" /><span class="hint" data-basis-hint>비우면 이월 수량 × 전년 종가</span><span class="err" data-err="carryAmount"></span></div>
          <div class="field" data-f="memo" style="flex:1;min-width:120px"><label>메모 (선택)</label><input name="memo" maxlength="200" /><span class="err" data-err="memo"></span></div>
          <div class="field" data-f="buttons"><label>&nbsp;</label><div class="field-row"><button type="submit" data-submit>등록</button><button type="button" class="secondary" data-carry title="${year - 1}년 말 보유 종목을 골라 ${year}년 이월 종목으로 한 번에 등록">전년도 일괄이월</button><button type="button" class="secondary" data-cancel hidden>취소</button></div></div>
        </form>
        <div data-msg></div>
      </div>
      <div class="card"><h2 data-list-title></h2><div data-trades><div class="empty">불러오는 중…</div></div></div>`);

    main.querySelector('[data-year]').addEventListener('change', (e) => {
      settings.set('holdings.year', Number(e.target.value));
      go(`#/holdings?year=${e.target.value}${groupParam ? `&group=${groupParam}` : ''}`);
    });
    if (!query.code) settings.set('holdings.year', year);

    const form = main.querySelector('[data-add]');
    const hint = form.querySelector('[data-hint]');
    const curLabel = form.querySelector('[data-cur]');
    let groups = [];
    let groupId = null; // null = 전체
    const groupName = () => (groupId ? (groups.find((g) => g.id === groupId) || {}).name : '전체 그룹');

    let lookedUp = ''; // 마지막으로 확인한 종목코드
    const clearCodeError = () => {
      form.code.classList.remove('invalid');
      form.querySelector('[data-err="code"]').textContent = '';
    };
    const lookup = async () => {
      const code = form.code.value.trim();
      lookedUp = code.toUpperCase();
      hint.textContent = '';
      curLabel.textContent = '';
      if (!code) return;
      hint.textContent = '확인 중…';
      try {
        const q = await api('GET', `/stocks/${encodeURIComponent(code)}`);
        hint.innerHTML = `${esc(q.instrument.name)} ${badge(q.instrument.type)}`;
        curLabel.textContent = `(${q.instrument.currency === 'USD' ? '달러' : '원'})`;
        main.querySelector('[data-cur2]').textContent = curLabel.textContent;
        // 분류: 이 종목에 저장한 분류, 없으면 추천값을 미리 선택 (바꿀 수 있음)
        if (q.category && (!form.category.value || !form.id.value)) form.category.value = q.category.id;
        clearCodeError(); // 다른 항목의 오류는 그대로 둔다
      } catch (err) {
        hint.textContent = '';
        clearCodeError();
        form.code.classList.add('invalid');
        form.querySelector('[data-err="code"]').textContent = err.message;
      }
    };
    form.code.addEventListener('change', lookup);
    // 평균 매입단가 자동 계산 = 매입금액 ÷ 보유 수량
    const calcAvg = () => {
      const q = Number(String(form.quantity.value).replace(/,/g, ''));
      const a = Number(String(form.purchaseAmount.value).replace(/,/g, ''));
      form.avgPrice.value = q > 0 && a > 0 ? String(Number((a / q).toFixed(4))) : '';
    };
    form.quantity.addEventListener('input', calcAvg);
    form.purchaseAmount.addEventListener('input', calcAvg);
    // 이월 여부 (v0.12.3): 화면에 칸을 두지 않고, 이월 금액 또는 (입력 가능한) 이월 수량이 있으면 이월, 없으면 신규
    const decideCarryMode = () => {
      const num = (v) => Number(String(v || '').replace(/,/g, ''));
      const qtyTyped = !form.carriedQty.readOnly && num(form.carriedQty.value) > 0;
      form.carryMode.value = num(form.carryAmount.value) > 0 || qtyTyped ? 'CARRIED' : 'NEW';
    };
    const carryHintPlain = (it) => (it.basis_carried_qty > 1e-9 && it.basis_start_close != null
      ? `자동값 ${money(it.carry_auto, it.currency)} = ${qty(it.basis_carried_qty)}주 × ${money(it.basis_start_close, it.currency)}`
      : '전년 종가 기준 자동값 없음');

    const setTitles = () => {
      main.querySelector('[data-list-title]').innerHTML = `${year}년 주식 항목 · ${esc(groupName())} ${req('FR-HLD-02')}`;
      if (!form.id.value) main.querySelector('[data-form-title]').innerHTML = `${year}년 종목 등록 ${req('FR-HLD-01 · FR-HLD-04')}`;
    };
    const resetForm = () => {
      form.reset();
      // 등록 화면: 수정 화면과 같은 배치, 이월 수량·이월 금액은 전년부터 보유한 종목만 입력
      form.carriedQty.readOnly = false;
      form.carriedQty.classList.remove('auto-calc');
      main.querySelector('[data-cqty-hint]').textContent = '전년부터 보유 시 입력';
      main.querySelector('[data-basis-hint]').textContent = '비우면 이월 수량 × 전년 종가';
      form.querySelector('[data-carry]').hidden = false;
      form.id.value = '';
      form.code.disabled = false;
      form.groupId.disabled = false;
      hint.textContent = '';
      curLabel.textContent = '';
      showFieldErrors(form, {});
      if (groups.length) form.groupId.value = String(groupId || groups[0].id);
      form.querySelector('[data-submit]').textContent = '등록';
      form.querySelector('[data-cancel]').hidden = true;
      setTitles();
    };
    form.querySelector('[data-cancel]').addEventListener('click', resetForm);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const msg = main.querySelector('[data-msg]');
      msg.innerHTML = '';
      // 종목코드를 입력하고 바로 등록을 누른 경우: 종목 확인(분류 추천값 채우기)을 먼저 끝낸다
      if (!form.code.disabled && form.code.value.trim() && form.code.value.trim().toUpperCase() !== lookedUp) await lookup();
      decideCarryMode();
      const d = { ...formData(form), code: form.code.value, groupId: form.groupId.value, year };
      const btn = form.querySelector('[data-submit]');
      btn.disabled = true;
      try {
        if (d.id) await api('PUT', '/holdings/items', d);
        else await api('POST', '/holdings/items', d);
        toast(d.id ? '종목을 수정했습니다.' : `${year}년 종목을 등록했습니다.`);
        resetForm();
        loadTrades();
      } catch (err) {
        showFieldErrors(form, err.fields);
        if (!Object.keys(err.fields || {}).length) msg.innerHTML = `<div class="notice error" style="margin:12px 0 0">${esc(err.message)}</div>`;
      } finally {
        btn.disabled = false;
      }
    });

    // ---- 그룹 탭·관리
    function renderTabs() {
      const tabs = main.querySelector('[data-tabs]');
      tabs.innerHTML = [`<button class="${groupId ? '' : 'on'}" data-g="">전체</button>`]
        .concat(groups.map((g) => `<button class="${groupId === g.id ? 'on' : ''}" data-g="${g.id}">${esc(g.name)}</button>`)).join('');
      tabs.querySelectorAll('[data-g]').forEach((b) => b.addEventListener('click', () => {
        settings.set('holdings.group', b.dataset.g);
        go(`#/holdings?year=${year}&group=${b.dataset.g}`);
      }));
      form.groupId.innerHTML = groups.map((g) => `<option value="${g.id}">${esc(g.name)}</option>`).join('');
      if (!form.id.value) form.groupId.value = String(groupId || groups[0].id);
    }

    async function loadGroups() {
      groups = (await api('GET', '/groups')).groups;
      const want = Number(groupParam);
      groupId = groups.some((g) => g.id === want) ? want : null;
      renderTabs();
      renderGroupPanel();
      setTitles();
    }

    function renderGroupPanel() {
      const panel = main.querySelector('[data-group-panel]');
      panel.innerHTML = `
        <div class="group-panel">
          <table><thead><tr><th>그룹 이름</th><th class="num">보유 항목</th><th></th></tr></thead><tbody>
          ${groups.map((g) => `<tr data-gid="${g.id}">
            <td><input name="name" value="${esc(g.name)}" maxlength="20" style="width:100%;max-width:220px" /><div class="err small" data-err="name"></div></td>
            <td class="num">${g.tradeCount}건</td>
            <td class="num"><button class="sm" data-rename>이름 저장</button> <button class="sm danger" data-gdel ${g.tradeCount ? 'disabled title="보유 종목이 있는 그룹은 삭제할 수 없습니다"' : ''}>삭제</button></td>
          </tr>`).join('')}
          </tbody></table>
          <form class="field-row" data-gadd novalidate style="margin-top:10px">
            <div class="field" style="min-width:200px"><label>새 그룹</label><input name="name" maxlength="20" placeholder="예: ISA, 연금저축, IRP, 해외" /><span class="err" data-err="name"></span></div>
            <button type="submit">그룹 추가</button>
          </form>
          <p class="small muted" style="margin:8px 0 0">같은 종목이라도 그룹이 다르면 수량과 평균 매입단가를 따로 관리합니다. 보유 종목이 있는 그룹은 종목을 삭제한 뒤 지울 수 있습니다.</p>
        </div>`;
      panel.querySelectorAll('tr[data-gid]').forEach((tr) => {
        const id = tr.dataset.gid;
        tr.querySelector('[data-rename]').addEventListener('click', async () => {
          try {
            await api('PUT', `/groups/${id}`, { name: tr.querySelector('[name=name]').value });
            toast('그룹 이름을 바꿨습니다.');
            await loadGroups();
            main.querySelector('[data-group-panel]').hidden = false;
            loadTrades();
          } catch (err) { showFieldErrors(tr, err.fields); if (!err.fields || !err.fields.name) toast(err.message); }
        });
        tr.querySelector('[data-gdel]').addEventListener('click', async () => {
          if (!confirm('이 그룹을 삭제할까요?')) return;
          try {
            await api('DELETE', `/groups/${id}`);
            toast('그룹을 삭제했습니다.');
            if (String(groupId) === id) settings.set('holdings.group', '');
            await loadGroups();
            main.querySelector('[data-group-panel]').hidden = false;
          } catch (err) { toast(err.message); }
        });
      });
      const add = panel.querySelector('[data-gadd]');
      add.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          await api('POST', '/groups', { name: add.name.value });
          toast('그룹을 추가했습니다.');
          await loadGroups();
          main.querySelector('[data-group-panel]').hidden = false;
        } catch (err) { showFieldErrors(add, err.fields); }
      });
    }
    main.querySelector('[data-manage]').addEventListener('click', () => {
      const p = main.querySelector('[data-group-panel]');
      p.hidden = !p.hidden;
    });

    // ---- 주식 항목 목록
    async function loadTrades() {
      const d = await api('GET', `/holdings?year=${year}${groupId ? `&group=${groupId}` : ''}`);
      const tbox = main.querySelector('[data-trades]');
      if (!d.items.length) {
        tbox.innerHTML = `<div class="empty">${year}년 ${esc(groupName())}에 보유한 종목이 없습니다.<br/><span class="small">위에서 종목을 등록하세요.</span></div>`;
        return;
      }
      const cols = 9;
      let lastGroup = null;
      // 이월액 (v0.11): 일괄이월·등록 때 고정, 수량을 바꿔도 다시 계산하지 않음(수정 화면에서 직접 변경). 누르면 근거
      const carryHint = (it) => {
        const c = it.currency;
        const auto = it.basis_carried_qty > 1e-9
          ? (it.basis_start_close != null ? `전년 말 ${qty(it.basis_carried_qty)}주 × ${esc(it.basis_start_date || '')} 종가 ${money(it.basis_start_close, c)}` : `전년 말 ${qty(it.basis_carried_qty)}주: 전년 종가가 없어 매입금액 적용`)
          : '이월 없음(신규)';
        return it.carry_fixed ? `고정 이월액 · 자동 계산값 ${money(it.carry_auto, c)}(${auto})` : `자동: ${auto}`;
      };
      const basisCell = (it) => {
        const parts = [carryHint(it)];
        if (it.new_buys > 1e-9) parts.push(`${year}년 매수금액 ${money(it.new_buys, it.currency)}은 별도`);
        return `<span class="tip" data-tip="${esc(parts.join(' · '))}" tabindex="0">${money(it.carry_amount, it.currency)}</span>`;
      };
      const hasCarry = (it) => it.carry_amount > 1e-9 && it.basis_carried_qty > 1e-9;
      // 손익 기준액 = 이월액이 있으면 이월액, 없으면 매입금액
      const baseCell = (it) => (hasCarry(it)
        ? `<span class="tip" data-tip="이월 금액(전년) 기준" tabindex="0">${money(it.carry_amount, it.currency)}</span>`
        : `<span class="tip" data-tip="이월 금액이 없어 총 매입금액 기준" tabindex="0">${money(it.purchase_amount, it.currency)}</span>`);
      const dash = '<span class="muted">-</span>';
      const rows = d.items.map((it, idx) => {
        let head = '';
        if (!groupId && it.group_id !== lastGroup) {
          lastGroup = it.group_id;
          head = `<tr class="group-row"><td colspan="${cols}">${esc(it.group_name)}</td></tr>`;
        }
        return `${head}<tr data-idx="${idx}">
          <td class="left"><div class="name-cell"><span>${esc(it.name || it.code)}</span><small>${esc(it.code)} · <span class="cat cat-${esc(it.category)}">${esc(it.category_label)}</span> ${badge(it.type)}</small></div></td>
          <td class="right">${hasCarry(it) ? qty(it.basis_carried_qty) : dash}</td>
          <td class="right">${hasCarry(it) ? basisCell(it) : dash}</td>
          <td class="right">${qty(it.quantity)}</td>
          <td class="right">${money(it.purchase_amount, it.currency)}</td>
          <td class="right">${it.quantity > 0 ? money(it.purchase_amount / it.quantity, it.currency) : dash}</td>
          <td class="right"><b>${baseCell(it)}</b></td>
          <td class="small">${esc(it.memo || '')}</td>
          <td class="icon-actions"><button class="icon-btn" data-edit title="수정" aria-label="수정">${ICON_EDIT}</button><button class="icon-btn danger" data-del title="삭제" aria-label="삭제">${ICON_DEL}</button></td>
        </tr>`;
      }).join('');
      tbox.innerHTML = `<div class="table-wrap"><table>
        <thead><tr><th>종목</th><th>이월 수량</th><th>이월 금액(전년)</th><th>총 수량</th><th>총 매입금액</th><th>매입단가(평균)</th><th>손익 기준액(금년)</th><th>메모</th><th></th></tr></thead>
        <tbody>${rows}</tbody></table></div>
        <p class="small muted" style="margin:8px 0 0">이월 수량·이월 금액(전년) = 전년 말부터 가져온 수량과 그 1월 1일 평가액(전년 말 수량 × 전년 마지막 종가, 일괄이월·등록 때 고정, 수정에서 변경 가능) · 총 수량 = ${year}년 말 보유 수량 · 총 매입금액 = 실제로 산 금액 · 매입단가(평균) = 총 매입금액 ÷ 총 수량 · 손익 기준액(금년) = 이월 금액이 있으면 이월 금액, 없으면 총 매입금액 · 삭제하면 ${year}년부터 보유하지 않은 것으로 처리됩니다.</p>`;
      tbox.querySelectorAll('tr[data-idx]').forEach((tr) => {
        const it = d.items[Number(tr.dataset.idx)];
        tr.querySelector('[data-del]').addEventListener('click', () => {
          // 삭제 = 그 해 전량 매도: 실현손익(선택)을 함께 입력하면 올해·전체기간 손익에 반영 (v0.10)
          const body = openModal(`종목 삭제 (전량 매도) · ${year}년`);
          body.innerHTML = `<p style="margin:0 0 10px">[${esc(it.group_name)}] <b>${esc(it.name || it.code)}</b> 종목을 ${year}년 보유 목록에서 삭제합니다. ${year}년부터 보유하지 않은 것으로 처리되며, 배당 내역은 유지됩니다.</p>
            <form data-delform novalidate>
              <div class="field" style="max-width:300px"><label>${year}년 실현손익 (선택, ${it.currency === 'USD' ? '달러' : '원'})</label><input name="realizedPnl" inputmode="decimal" placeholder="예: 150000 / 손실은 -50000" value="${it.realized_pnl == null ? '' : esc(String(it.realized_pnl))}" /><span class="hint">매도금액 − 매입금액 ${money(it.purchase_amount, it.currency)}. 비우면 손익에 반영하지 않습니다.</span><span class="err" data-err="realizedPnl"></span></div>
              <div class="field-row" style="justify-content:flex-end;margin-top:12px"><button type="button" class="secondary" data-close>취소</button><button type="submit" class="danger">삭제</button></div>
            </form>`;
          const f = body.querySelector('[data-delform]');
          body.querySelector('[data-close]').addEventListener('click', closeModal);
          f.realizedPnl.focus();
          f.addEventListener('submit', async (ev) => {
            ev.preventDefault();
            try {
              await api('DELETE', `/holdings/items?year=${year}&groupId=${it.group_id}&code=${encodeURIComponent(it.code)}&realizedPnl=${encodeURIComponent(f.realizedPnl.value.trim())}`);
              closeModal();
              toast('삭제했습니다.');
              loadTrades();
              loadGroups();
            } catch (err) {
              if (Object.keys(err.fields || {}).length) showFieldErrors(f, err.fields);
              else toast(err.message);
            }
          });
        });
        tr.querySelector('[data-edit]').addEventListener('click', () => {
          resetForm();
          form.id.value = '1';
          form.groupId.value = String(it.group_id);
          form.groupId.disabled = true;
          form.code.value = it.code;
          form.code.disabled = true;
          form.category.value = it.category || '';
          form.carryMode.value = it.carry_mode || (it.carried ? 'CARRIED' : 'NEW');
          form.quantity.value = it.quantity;
          form.purchaseAmount.value = String(Number(it.purchase_amount.toFixed(it.currency === 'USD' ? 2 : 0)));
          calcAvg();
          form.memo.value = it.memo || '';
          // 수정 시 이월액 입력 칸 (v0.11): 저장된 고정값(없으면 자동 계산값)을 채워 두고, 수량을 바꿔도 다시 계산하지 않는다
          form.carryAmount.value = it.carry_amount ? String(Number(it.carry_amount.toFixed(it.currency === 'USD' ? 2 : 0))) : '';
          main.querySelector('[data-cur2]').textContent = `(${it.currency === 'USD' ? '달러' : '원'})`;
          main.querySelector('[data-basis-hint]').textContent = `수량을 바꿔도 그대로 · ${carryHintPlain(it)}`;
          // 이월 수량: 전년 말 보유가 있으면 전년 말 수량(고칠 수 없음), 없으면 입력값(고칠 수 있음)
          const carriedNow = it.basis_carried_qty > 1e-9 && it.carry_amount > 1e-9;
          form.carriedQty.readOnly = !!it.carry_has_prev;
          form.carriedQty.classList.toggle('auto-calc', !!it.carry_has_prev);
          form.carriedQty.value = carriedNow ? String(it.basis_carried_qty) : (it.carry_has_prev ? '-' : '');
          main.querySelector('[data-cqty-hint]').textContent = it.carry_has_prev ? '전년 말 보유 수량' : '전년부터 보유 시 입력';
          form.querySelector('[data-carry]').hidden = true;
          lookup();
          main.querySelector('[data-form-title]').innerHTML = `${year}년 종목 수정 · ${esc(it.group_name)} ${req('FR-HLD-02')}`;
          form.querySelector('[data-submit]').textContent = '저장';
          form.querySelector('[data-cancel]').hidden = false;
          form.scrollIntoView({ behavior: 'smooth', block: 'center' });
          form.quantity.focus();
        });
      });
    }

    // ---- 전년도 일괄 이월: 전년 말 보유 종목을 팝업에 보여 주고, 선택한 종목만 올해 이월 종목으로 등록
    main.querySelector('[data-carry]').addEventListener('click', openCarryModal);
    async function openCarryModal() {
      const scope = groupId ? `‘${esc(groupName())}’ 그룹` : '전체 그룹';
      const body = openModal(`전년도 일괄이월 · ${year - 1}년 → ${year}년 ${req('FR-HLD-05')}`, { wide: true, loadingText: `${year - 1}년 말 보유 종목을 불러오는 중…` });
      let d;
      try {
        d = await api('GET', `/holdings/carry-candidates?year=${year}${groupId ? `&group=${groupId}` : ''}`);
      } catch (err) {
        body.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
        return;
      }
      if (!d.items.length) {
        body.innerHTML = `<div class="empty">${year - 1}년 말 ${scope}에 보유한 종목이 없습니다.</div>`;
        return;
      }
      const STATUS = { REGISTERED: '<span class="muted small">이미 등록됨</span>', AUTO: '<span class="badge carry">자동 이어짐</span>', REMOVED: '<span class="small down">올해 삭제됨</span>' };
      const showGroup = !groupId;
      let lastGroup = null;
      const rows = d.items.map((it, idx) => {
        let head = '';
        if (showGroup && it.group_id !== lastGroup) {
          lastGroup = it.group_id;
          head = `<tr class="group-row"><td colspan="7">${esc(it.group_name)}</td></tr>`;
        }
        const dis = it.status === 'REGISTERED';
        return `${head}<tr data-ci="${idx}" class="${dis ? 'muted' : ''}">
          <td><input type="checkbox" data-pick ${dis ? 'disabled' : 'checked'} aria-label="${esc(it.name || it.code)} 선택" /></td>
          <td class="left"><div class="name-cell"><span>${esc(it.name || it.code)}</span><small>${esc(it.code)} · <span class="cat cat-${esc(it.category)}">${esc(it.category_label)}</span> ${badge(it.type)}</small></div></td>
          <td class="right">${qty(it.quantity)}</td>
          <td class="right">${money(it.avg_price, it.currency)}</td>
          <td class="right">${money(it.purchase_amount, it.currency)}</td>
          <td class="small">${esc(it.memo || '')}</td>
          <td>${STATUS[it.status] || ''}</td>
        </tr>`;
      }).join('');
      body.innerHTML = `
        <p class="small muted" style="margin:0 0 10px">${year - 1}년 말 ${scope} 보유 종목입니다. 선택한 종목은 ${year - 1}년 말 수량·평균 매입단가·메모 그대로 <b>${year}년 이월 종목</b>으로 등록됩니다. 이미 ${year}년에 등록한 종목은 선택할 수 없습니다.</p>
        <div class="table-wrap"><table class="carry-table">
          <thead><tr><th><input type="checkbox" data-all aria-label="전체 선택" /></th><th class="left">종목</th><th class="right">수량</th><th class="right">평균 매입단가</th><th class="right">매입금액</th><th>메모</th><th>${year}년 상태</th></tr></thead>
          <tbody>${rows}</tbody></table></div>
        <div class="carry-foot"><span class="small" data-count></span><div class="field-row"><button type="button" class="secondary" data-close>취소</button><button type="button" data-go>선택 종목 이월 등록</button></div></div>`;
      const picks = [...body.querySelectorAll('[data-pick]:not(:disabled)')];
      const all = body.querySelector('[data-all]');
      const go = body.querySelector('[data-go]');
      const sync = () => {
        const n = picks.filter((c) => c.checked).length;
        body.querySelector('[data-count]').textContent = `${n}개 선택 / 이월 가능 ${picks.length}개`;
        all.checked = picks.length > 0 && n === picks.length;
        all.indeterminate = n > 0 && n < picks.length;
        all.disabled = !picks.length;
        go.disabled = n === 0;
      };
      picks.forEach((c) => c.addEventListener('change', sync));
      all.addEventListener('change', () => { picks.forEach((c) => (c.checked = all.checked)); sync(); });
      body.querySelectorAll('tr[data-ci]').forEach((tr) => tr.addEventListener('click', (e) => {
        const c = tr.querySelector('[data-pick]');
        if (e.target === c || c.disabled) return;
        c.checked = !c.checked; sync();
      }));
      body.querySelector('[data-close]').addEventListener('click', closeModal);
      sync();
      go.addEventListener('click', async () => {
        const items = [...body.querySelectorAll('tr[data-ci]')].filter((tr) => { const c = tr.querySelector('[data-pick]'); return !c.disabled && c.checked; })
          .map((tr) => { const it = d.items[Number(tr.dataset.ci)]; return { groupId: it.group_id, code: it.code }; });
        go.disabled = true; go.textContent = '등록 중…';
        try {
          const r = await api('POST', '/holdings/carry', { year, items });
          closeModal();
          toast(`${r.added}개 종목을 ${year}년 이월 종목으로 등록했습니다.${r.skipped.length ? ` (${r.skipped.length}개 건너뜀)` : ''}`);
          loadTrades();
          loadGroups();
        } catch (err) {
          toast(err.message);
          go.textContent = '선택 종목 이월 등록';
          sync();
        }
      });
    }

    await loadGroups();
    if (query.code) { lookup(); form.quantity.focus(); }
    loadTrades();
  }

  // ---------------------------------------------------------------------------
  // SC-05 연도별 조회
  // ---------------------------------------------------------------------------
  async function viewYearly(query) {
    const thisYear = new Date().getFullYear();
    const savedRange = settings.get('yearly.range') || {};
    const to = Number(query.to) || Number(savedRange.to) || thisYear;
    const from = Number(query.from) || Number(savedRange.from) || to - 4;
    const opts = (sel) => Array.from({ length: 10 }, (_, k) => thisYear - 9 + k).map((y) => `<option ${y === sel ? 'selected' : ''}>${y}</option>`).join('');
    const main = shell('#/yearly', `
      <div class="page-head">
        <div><h1>연도별 조회 ${req('SC-05 · FR-YR · FR-DIV-04 · FR-XLS-02')}</h1><p>보유 종목 관리에 연도별로 입력한 연말 보유 수량으로 연도별 자산금액을 비교합니다.</p></div>
        <button data-export="/export/yearly.xlsx?from=${from}&to=${to}">엑셀 내보내기</button>
      </div>
      <div class="notice warn"><div><b>해석 주의:</b> 연도별로 입력한 연말 보유 수량 기준 금액입니다. 연도 중 매매 시점의 가격 변동은 반영하지 않으며, 종목을 입력하지 않은 연도는 직전 연도 보유 수량이 그대로 이어집니다. ${req('FR-YR-07')}</div></div>
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
      settings.set('yearly.range', { from: f, to: t }); // 마지막 조회 기간 기억
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
    const hasHoldings = years.some((y) => y.items.length); // 연도별 보유가 다르므로 한 해라도 있으면 표시
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
              <table><thead><tr><th>종목</th><th>구분</th><th class="num">연말 보유 수량</th><th class="num">${y.ongoing ? '현재가' : '연말 종가'}</th><th>종가 기준일</th><th class="num">적용 환율</th><th class="num">원화 금액</th></tr></thead>
              <tbody>${y.items.map((i) => `<tr>
                <td><div class="name-cell">${esc(i.name)}<small>${esc(i.code)}${i.tradedThisYear ? ' · 이 해 매매 있음' : ' · 이전 연도 수량 이어 씀'}</small></div></td><td>${badge(i.type)}</td>
                <td class="num">${qty(i.quantity)}</td>
                <td class="num">${i.close == null ? '-' : money(i.close, i.currency)}</td>
                <td class="small muted">${i.closeDate ? (y.ongoing ? fmtTime(i.closeDate) : esc(i.closeDate)) : '-'}</td>
                <td class="num">${i.excluded ? '-' : i.currency === 'USD' ? rate(i.fxRate) : '1'}</td>
                <td class="num">${i.excluded ? `- <span class="small up">(${esc(i.reason)} · 합계 제외)</span>` : krw(i.valueKrw)}</td>
              </tr>`).join('')}</tbody></table>
            </div></td></tr>`).join('')}</tbody>
        </table></div>
        <p class="small muted" style="margin:10px 0 0">연도별 자산금액 = Σ (연말 수정 종가 × 그 해 말 보유 수량 × 해당 연도 말 환율) · 행을 누르면 종목별 내역이 펼쳐집니다 · 상장 전 연도는 ‘-’로 표시하고 합계에서 제외</p>
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
      scales: { y: { beginAtZero: true, suggestedMax: 1, ticks: { precision: 0, callback: (v) => (v >= 1e8 ? `${(v / 1e8).toFixed(1)}억` : v >= 1e4 ? `${nf0.format(v / 1e4)}만` : nf0.format(v)) } }, x: { grid: { display: false } } },
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
    // 검색 조건이 없으면 마지막으로 검색한 조건으로 시작
    if (!query.from && !query.to && !query.code) query = { ...query, ...(settings.get('dividends.filter') || {}) };
    const main = shell('#/dividends', `
      <div class="page-head"><div><h1>배당금 조회(요약) ${req('SC-06 · FR-DIV · FR-CHT-03')}</h1><p>연도별 배당 합계와 배당 내역을 조회합니다. 배당 회차 입력은 <a href="#/divmgmt">배당금 관리</a>에서 합니다. 보유 종목을 삭제해도 내역은 유지됩니다.</p></div></div>
      <div class="card"><h2>연도별 배당 합계 ${req('FR-DIV-03 · FR-CHT-03')}</h2>
        <div class="grid c2"><div class="chart-box" style="height:260px"><canvas></canvas></div><div data-yearly class="table-wrap"></div></div>
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
          <datalist id="hcodes"></datalist>
          <div data-list></div>
        </div>
      </div>`);

    api('GET', '/holdings').then(({ holdings }) => {
      main.querySelector('#hcodes').innerHTML = holdings.map((h) => `<option value="${esc(h.code)}">${esc(h.name || '')}</option>`).join('');
    });

    const filter = main.querySelector('[data-filter]');
    filter.addEventListener('submit', (e) => {
      e.preventDefault();
      const f = formData(filter);
      if (f.from && f.to && f.from > f.to) return toast('시작일이 종료일보다 늦습니다.');
      const kept = Object.fromEntries(Object.entries(f).filter(([, v]) => v));
      settings.set('dividends.filter', kept); // 마지막 검색 조건 기억
      const qs = new URLSearchParams(kept).toString();
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
            <td class="num"><button class="sm danger" data-del>삭제</button></td>
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
      });

      // 연도별 배당 합계 (v0.13.7): 수령액(기존 기록) + 배당·과세표준액(배당금 관리에 저장한 회차)
      const shown = years.filter((y, i) => y.count || y.divCount || i >= years.length - 5);
      main.querySelector('[data-yearly]').innerHTML = `<table><thead><tr><th>연도</th><th class="num">배당</th><th class="num">과세표준액</th><th class="num">수령액</th></tr></thead><tbody>${shown.slice().reverse().map((y) => `<tr><td>${y.year}</td>
        <td class="num">${y.divCount ? `<b>${krw(y.divKrw)}</b><br/><small class="muted">${y.divCount}회</small>` : '<span class="muted">-</span>'}</td>
        <td class="num">${y.divCount ? (y.taxMissing ? `<span class="tip" data-tip="과세표준이 없는 회차 ${y.taxMissing}개 제외" tabindex="0">${krw(y.taxKrw)}*</span>` : krw(y.taxKrw)) : '<span class="muted">-</span>'}</td>
        <td class="num">${y.count ? `${krw(y.krw)}<br/><small class="muted">${y.count}건</small>` : '<span class="muted">-</span>'}</td></tr>`).join('')}</tbody></table>
        <p class="small muted" style="margin:6px 0 0">배당·과세표준액 = 배당금 관리에 저장한 회차 합계(배당락일 연도, 미국 종목은 지급일 환율로 원화 환산) · 수령액 = 아래 배당 내역(실제 수령 기록) 합계</p>`;
      destroyCharts();
      state.charts.push(new Chart(main.querySelector('canvas'), {
        type: 'bar',
        data: {
          labels: shown.map((y) => String(y.year)),
          datasets: [
            { label: '배당', data: shown.map((y) => y.divKrw), backgroundColor: '#1f4e79', borderRadius: 4 },
            { label: '과세표준액', data: shown.map((y) => y.taxKrw), backgroundColor: '#e8a33d', borderRadius: 4 },
            { label: '수령액', data: shown.map((y) => y.krw), backgroundColor: '#2e9e5b', borderRadius: 4 },
          ],
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: true, position: 'bottom', labels: { boxWidth: 12 } }, tooltip: { callbacks: { label: (c) => `${c.dataset.label} ${krw(c.parsed.y)}` } } }, scales: { y: { beginAtZero: true, ticks: { callback: (v) => nf0.format(v) } }, x: { grid: { display: false } } } },
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
  // 팝업은 겹쳐 열 수 있다 (예: 종목 팝업 위에 배당금 지급내역 팝업). 닫기는 맨 위 팝업부터
  function closeModal() {
    const all = document.querySelectorAll('.modal-back');
    if (all.length) all[all.length - 1].remove();
    if (all.length <= 1) document.body.classList.remove('modal-open');
  }
  function closeAllModals() {
    document.querySelectorAll('.modal-back').forEach((m) => m.remove());
    document.body.classList.remove('modal-open');
  }
  function openModal(titleHtml, { wide = false, loadingText = '불러오는 중…' } = {}) {
    document.body.classList.add('modal-open');
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `<div class="modal${wide ? ' wide' : ''}" role="dialog" aria-modal="true">
        <div class="modal-head"><h2>${titleHtml}</h2><button class="linkish close" aria-label="닫기">✕</button></div>
        <div class="modal-body"><div class="empty">${esc(loadingText)}</div></div>
      </div>`;
    document.body.appendChild(back);
    back.addEventListener('click', (e) => {
      if (e.target === back || (e.target.closest('.close') && e.target.closest('.modal-back') === back)) {
        back.remove();
        if (!document.querySelector('.modal-back')) document.body.classList.remove('modal-open');
      }
    });
    // 팝업 안의 화면 이동 링크(예: 보유 종목으로 등록)를 누르면 팝업을 모두 닫는다
    back.addEventListener('click', (e) => { if (e.target.closest('a[href^="#/"]')) closeAllModals(); });
    return back.querySelector('.modal-body');
  }

  // 종목 조회 팝업 (자산 현황에서 종목을 누를 때)
  function openStockModal(code) {
    const body = openModal(`종목 조회 ${req('SC-03')}`, { wide: true, loadingText: `${code} 조회 중…` });
    body.classList.add('stock-modal');
    loadStock(body, code, false, null);
  }

  async function openDividendModal(code, refresh) {
    const body = openModal(`배당금 지급내역 ${req('FR-STK-08')}`, { loadingText: '최근 10년 배당 내역을 불러오는 중…' });
    let d;
    try {
      d = await api('GET', `/stocks/${encodeURIComponent(code)}/dividends${refresh ? '?refresh=1' : ''}`);
    } catch (err) {
      body.innerHTML = `<div class="notice error"><div class="grow">${esc(err.message)}</div><button class="sm" data-retry>재시도</button></div>`;
      body.querySelector('[data-retry]').addEventListener('click', () => { closeModal(); openDividendModal(code, true); });
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
          <thead><tr><th>연도</th><th class="num">횟수</th><th class="num">주당 배당 합계</th><th class="num">주당 과세표준 합계</th><th class="num">기준 종가</th><th class="num">배당수익률</th>${held ? '<th class="num">세전 추정액</th>' : ''}</tr></thead>
          <tbody>${d.years.map((y) => `<tr>
            <td>${y.year} ${y.ongoing ? '<span class="badge ongoing">진행 중</span>' : ''}</td>
            <td class="num">${y.count}</td>
            <td class="num">${money(y.perShare, c)}</td>
            <td class="num">${y.taxBase == null ? '-' : money(y.taxBase, c)}</td>
            <td class="num">${y.refClose == null ? '-' : money(y.refClose, c)}</td>
            <td class="num">${y.yieldPct == null ? '-' : `${(y.yieldPct * 100).toFixed(1)}%`}</td>
            ${held ? `<td class="num">${money(y.estimate, c)}${c === 'USD' && y.estimateKrw != null ? `<br/><small class="muted">≈ ${krw(y.estimateKrw)}</small>` : ''}</td>` : ''}
          </tr>`).join('')}</tbody>
        </table></div>
        <p class="small muted" style="margin:6px 0 14px">배당수익률 = 연간 주당 배당 합계 ÷ 연말 종가 (올해는 현재가 기준)</p>
        <div class="notice ${d.taxBaseKnown || d.taxCount ? 'info' : 'warn'} small"><div><b>주당과세표준액</b>: ${esc(d.taxBaseNote)}${d.isKrEtf ? `<br/>표시된 회차 ${d.taxCount}건 / 전체 ${d.events.length}건${d.taxSource ? ` · 출처 ${esc(d.taxSource)}` : ''}` : ''}${d.taxError ? `<br/><b>최신 값이 아닐 수 있습니다.</b> 과세표준 갱신 실패: ${esc(d.taxError)}` : ''}</div></div>
        <h3 style="margin:0 0 8px">배당락일별 주당 배당금</h3>
        <div class="table-wrap scroll-y" style="max-height:260px"><table>
          <thead><tr><th>배당락일</th>${d.hasPayDate ? '<th>실지급일</th>' : ''}<th class="num">주당 배당금</th><th class="num">주당과세표준액</th>${held ? '<th class="num">세전 추정액</th>' : ''}</tr></thead>
          <tbody>${d.events.map((e) => `<tr><td>${esc(e.exDate)}</td>${d.hasPayDate ? `<td>${esc(e.payDate || '-')}</td>` : ''}<td class="num">${money(e.amount, c)}</td><td class="num">${e.taxBase == null ? '-' : money(e.taxBase, c)}</td>${held ? `<td class="num">${money(e.estimate, c)}${c === 'USD' && e.estimateKrw != null ? ` <small class="muted">≈ ${krw(e.estimateKrw)}</small>` : ''}</td>` : ''}</tr>`).join('')}</tbody>
        </table></div>`);
    }
    parts.push(`<p class="small muted" style="margin:12px 0 0">출처 ${esc(d.source || '-')} · 저장 ${fmtTime(d.loadedAt)} (1일 동안 재사용) · 실지급일은 운용사·FunETF가 제공하는 국내 ETF 회차만 표시합니다. 실제 수령액은 배당금 관리 화면에서 회차를 선택해 저장하거나 배당금 조회(요약) 화면에 기록하세요.</p>`);
    body.innerHTML = parts.join('');
    const retry = body.querySelector('[data-retry]');
    if (retry) retry.addEventListener('click', () => { closeModal(); openDividendModal(code, true); });
  }

  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeTip(); closeModal(); } });

  // 툴팁: data-tip 요소를 누르면 말풍선으로 보여주고, 다른 곳을 누르면 닫는다 (휴대폰에서도 동작)
  let tipEl = null;
  let tipOwner = null;
  function closeTip() {
    if (tipEl) tipEl.remove();
    tipEl = null;
    tipOwner = null;
  }
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-tip]');
    if (!t || t === tipOwner) { closeTip(); return; }
    closeTip();
    tipOwner = t;
    tipEl = document.createElement('div');
    tipEl.className = 'tip-bubble';
    tipEl.textContent = t.dataset.tip;
    document.body.appendChild(tipEl);
    const r = t.getBoundingClientRect();
    const w = tipEl.offsetWidth;
    const left = Math.max(8, Math.min(window.scrollX + r.right - w, window.scrollX + document.documentElement.clientWidth - w - 8));
    tipEl.style.left = `${left}px`;
    // 툴팁은 글자 위쪽에 표시 (위쪽 공간이 모자라면 아래쪽)
    const h = tipEl.offsetHeight;
    tipEl.style.top = `${r.top - h - 6 >= 4 ? window.scrollY + r.top - h - 6 : window.scrollY + r.bottom + 6}px`;
  });
  window.addEventListener('hashchange', closeTip);
  document.addEventListener('click', (e) => {
    const a = e.target.closest('[data-stock-popup]');
    if (!a) return;
    e.preventDefault();
    openStockModal(a.dataset.stockPopup);
  });

  // ---------------------------------------------------------------------------
  // 라우터
  // ---------------------------------------------------------------------------
  const PUBLIC = { '/login': viewLogin, '/signup': viewSignup, '/forgot': viewForgot, '/reset': viewReset };
  // ---------------------------------------------------------------------------
  // SC-08 배당금 관리 (v0.13): 그룹별 보유 종목의 배당 회차를 선택·저장해 연간 누적
  // ---------------------------------------------------------------------------
  async function viewDivMgmt(query) {
    const year = Math.min(Number(query.year) || Number(settings.get('divmgmt.year')) || THIS_YEAR, THIS_YEAR);
    const groupParam = query.group !== undefined ? query.group : settings.get('divmgmt.group');
    settings.set('divmgmt.year', year);
    // 월 기간 (v0.13.6): 기본 1월 ~ 이번 달(지난 연도는 12월)
    const curMonth = new Date().getMonth() + 1;
    let fromM = Number(query.from) || 1;
    let toM = Number(query.to) || (year >= THIS_YEAR ? curMonth : 12);
    if (fromM > toM) [fromM, toM] = [toM, fromM];
    const monthOpts = (sel) => Array.from({ length: 12 }, (_, i) => i + 1).map((m) => `<option value="${m}" ${m === sel ? 'selected' : ''}>${m}월</option>`).join('');
    const qsOf = (o = {}) => {
      const g = o.group !== undefined ? o.group : groupParam;
      const f = o.from !== undefined ? o.from : fromM;
      const t = o.to !== undefined ? o.to : toM;
      return `year=${o.year || year}&group=${g || ''}${f ? `&from=${f}` : ''}${t ? `&to=${t}` : ''}`; // 전체(빈 값)도 넘겨 저장된 그룹으로 바뀌지 않게
    };
    const main = shell('#/divmgmt', `
      <div class="page-head">
        <div><h1>배당금 관리 ${req('SC-08')}</h1><p>그룹별 보유 종목의 배당 회차를 골라 저장하면 그 해 누적 배당액과 누적 과세표준액에 반영됩니다. 오른쪽 <b>연필 아이콘(입력)</b>을 누르면 종목의 배당 내역을 자동으로 불러옵니다.</p></div>
        <div class="field-row" style="align-items:flex-end">
          <div class="field"><label>연도</label><select data-year>${yearOptions(year, THIS_YEAR - 9)}</select></div>
          <div class="field"><label>기간</label><div class="field-row" style="align-items:center;gap:6px"><select data-from>${monthOpts(fromM)}</select><span>~</span><select data-to>${monthOpts(toM)}</select></div></div>
        </div>
      </div>
      <div class="card"><div class="group-bar"><div class="group-tabs" data-tabs><span class="small muted">그룹 불러오는 중…</span></div><a href="#/holdings" class="small">그룹 관리 →</a></div></div>
      <div class="card"><h2 data-title>${year}년 ${fromM}~${toM}월 배당금</h2><div data-list><div class="empty">불러오는 중…</div></div></div>`);
    main.querySelector('[data-year]').addEventListener('change', (e) => {
      settings.set('divmgmt.year', Number(e.target.value));
      go(`#/divmgmt?${qsOf({ year: e.target.value, from: '', to: '' })}`); // 연도를 바꾸면 기간은 기본값
    });
    const onMonth = () => {
      let f = Number(main.querySelector('[data-from]').value);
      let t = Number(main.querySelector('[data-to]').value);
      if (f > t) [f, t] = [t, f];
      go(`#/divmgmt?${qsOf({ from: f, to: t })}`);
    };
    main.querySelector('[data-from]').addEventListener('change', onMonth);
    main.querySelector('[data-to]').addEventListener('change', onMonth);
    const dash = '<span class="muted">-</span>';

    async function load() {
      const d = await api('GET', `/divmgmt?${qsOf()}`);
      const tabs = main.querySelector('[data-tabs]');
      tabs.innerHTML = [`<button class="${d.groupId ? '' : 'on'}" data-g="">전체</button>`]
        .concat(d.groups.map((g) => `<button class="${d.groupId === g.id ? 'on' : ''}" data-g="${g.id}">${esc(g.name)}</button>`)).join('');
      tabs.querySelectorAll('[data-g]').forEach((b) => b.addEventListener('click', () => {
        settings.set('divmgmt.group', b.dataset.g);
        go(`#/divmgmt?${qsOf({ group: b.dataset.g })}`);
      }));
      const gname = d.groupId ? (d.groups.find((g) => g.id === d.groupId) || {}).name : '전체 그룹';
      main.querySelector('[data-title]').innerHTML = `${year}년 ${d.fromMonth}~${d.toMonth}월 배당금 · ${esc(gname)} ${req('FR-DIV-06')}`;
      const box = main.querySelector('[data-list]');
      if (!d.items.length) {
        box.innerHTML = `<div class="empty">${year}년 ${esc(gname)}에 보유한 종목이 없습니다.<br/><a href="#/holdings?year=${year}">보유 종목 관리</a>에서 종목을 등록하세요.</div>`;
        return;
      }
      const cols = 9;
      // 소계·합계 (원화 환산): 과세표준이 없는 회차가 있으면 과세표준 합계는 '-'
      const sumOf = (list) => {
        const add = (f) => list.reduce((a, x) => a + (x.krw[f] || 0), 0);
        const withLast = list.filter((x) => x.last);
        const withYtd = list.filter((x) => x.ytd_count);
        return {
          value: add('value'),
          last: withLast.length ? add('last') : null,
          last_tax: withLast.length ? (withLast.some((x) => x.krw.last_tax == null) ? NaN : add('last_tax')) : null,
          ytd: withYtd.length ? add('ytd') : null,
          ytd_tax: withYtd.length ? (withYtd.some((x) => x.krw.ytd_tax == null) ? NaN : add('ytd_tax')) : null,
        };
      };
      const sumCell = (v) => (v == null ? dash : Number.isNaN(v) ? '<span class="tip" data-tip="과세표준이 없는 회차가 있어 합계를 표시하지 않습니다" tabindex="0">-</span>' : krw(v));
      const sumRow = (label, x, tag = 'tr class="group-sub"') => `<${tag}><td colspan="3">${label}</td><td class="right">${krw(x.value)}</td><td class="right"><b>${sumCell(x.last)}</b></td><td class="right">${sumCell(x.last_tax)}</td><td class="right"><b>${sumCell(x.ytd)}</b></td><td class="right">${sumCell(x.ytd_tax)}</td><td></td></tr>`;
      let lastGroup = null;
      const rows = d.items.map((it, idx) => {
        let head = '';
        if (!d.groupId && it.group_id !== lastGroup) {
          // 앞 그룹의 소계
          if (lastGroup != null) {
            const prev = d.items.filter((x) => x.group_id === lastGroup);
            head += sumRow(`${esc(prev[0].group_name)} 소계`, sumOf(prev));
          }
          lastGroup = it.group_id;
          head += `<tr class="group-row"><td colspan="${cols}">${esc(it.group_name)}</td></tr>`;
        }
        const c = it.currency;
        return `${head}<tr data-idx="${idx}">
          <td class="left"><div class="name-cell"><span>${esc(it.name || it.code)}</span><small>${esc(it.code)} ${badge(it.type)}</small></div></td>
          <td class="right">${qty(it.quantity)}</td>
          <td class="right">${it.price == null ? dash : money(it.price, c)}</td>
          <td class="right">${it.value == null ? dash : money(it.value, c)}</td>
          <td class="right">${it.last ? `<b>${money(it.last.amount, c)}</b><br/><small class="muted">${esc(it.last.ex_date)}</small>` : dash}</td>
          <td class="right">${it.last ? (it.last.tax == null ? dash : money(it.last.tax, c)) : dash}</td>
          <td class="right"><b>${it.ytd_count ? money(it.ytd_amount, c) : dash}</b>${it.ytd_count ? `<br/><small class="muted">${it.ytd_count}회</small>` : ''}</td>
          <td class="right">${it.ytd_count ? (it.ytd_tax == null ? `<span class="tip" data-tip="과세표준이 없는 회차가 있어 합계를 표시하지 않습니다" tabindex="0">-</span>` : money(it.ytd_tax, c)) : dash}</td>
          <td class="right icon-actions"><button class="icon-btn" data-input title="입력" aria-label="월 배당금 입력">${ICON_EDIT}</button></td>
        </tr>`;
      }).join('');
      const lastSub = !d.groupId && lastGroup != null ? sumRow(`${esc(d.items.filter((x) => x.group_id === lastGroup)[0].group_name)} 소계`, sumOf(d.items.filter((x) => x.group_id === lastGroup))) : '';
      const hasUsd = d.items.some((x) => x.currency === 'USD');
      box.innerHTML = `<div class="table-wrap"><table class="divm-table">
        <thead><tr><th>종목</th><th>보유수량</th><th>${d.ongoing ? '현재 단가' : '연말 종가'}</th><th>평가금액</th><th>월 배당액(최근)</th><th>월 과세표준액</th><th>누적 배당액(${d.fromMonth}~${d.toMonth}월)</th><th>누적 과세표준액(${d.fromMonth}~${d.toMonth}월)</th><th></th></tr></thead>
        <tbody>${rows}${lastSub}</tbody>
        <tfoot>${sumRow('합계 (원화)', sumOf(d.items), 'tr')}</tfoot></table></div>
        <p class="small muted" style="margin:8px 0 0">소계·합계는 원화 환산${hasUsd ? `(미국 종목 × ${d.ongoing ? '현재' : '연말'} 환율 ${rate(d.fxRate)})` : ''} · 월 배당액(최근)·월 과세표준액 = ${d.fromMonth}~${d.toMonth}월에 저장한 회차 중 가장 최근 회차(배당락일) · 누적 배당액·누적 과세표준액 = ${year}년 ${d.fromMonth}~${d.toMonth}월에 저장한 회차 합계(배당락일 기준) · 금액은 거래 통화(국내 원, 미국 달러) · 연필 아이콘(입력)에서 회차를 골라 저장하면 반영됩니다.</p>`;
      box.querySelectorAll('tr[data-idx]').forEach((tr) => {
        const it = d.items[Number(tr.dataset.idx)];
        tr.querySelector('[data-input]').addEventListener('click', () => openDivInput(it, year));
      });
    }

    // 월 배당금 입력 팝업: 종목 배당 내역을 불러와 회차를 고르고 보유수량(수정 가능)으로 총 배당금·과세표준 계산
    function openDivInput(it, initYear) {
      const body = openModal(`월 배당금 입력 · ${esc(it.name || it.code)} (${esc(it.code)}) · ${esc(it.group_name)} ${req('FR-DIV-07')}`, { wide: true, loadingText: '배당 내역을 불러오는 중…' });
      const c = it.currency;
      async function render(y) {
        let r;
        try {
          r = await api('GET', `/divmgmt/rounds?year=${y}&group=${it.group_id}&code=${encodeURIComponent(it.code)}`);
        } catch (err) {
          body.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
          return;
        }
        const years = [...new Set([y, ...r.years])].sort((a, b) => b - a);
        const rowsHtml = r.rounds.map((x, i) => {
          const q = x.saved ? x.saved.quantity : r.quantity;
          return `<tr data-ri="${i}">
            <td><input type="checkbox" data-pick ${x.saved ? 'checked' : ''} aria-label="${x.year}년 ${x.seq}회 선택" /></td>
            <td>${x.seq}회<br/><small class="muted">락 ${esc(x.ex_date.slice(5).replace('-', '.'))}</small></td>
            <td class="right">${x.pay_date ? esc(x.pay_date) : dash}</td>
            <td class="right">${money(x.per_share, c)}</td>
            <td class="right">${x.tax_per_share == null ? dash : money(x.tax_per_share, c)}</td>
            <td class="right">${x.ref_close == null ? dash : `${money(x.ref_close, c)}<br/><small class="muted">${esc(String(x.ref_date).slice(5).replace('-', '.'))}</small>`}</td>
            <td class="right">${x.yield_pct == null ? dash : pct(x.yield_pct).replace('+', '')}</td>
            <td class="right qty-col"><input name="qty" inputmode="decimal" value="${esc(String(q))}" class="qty-input" /></td>
            <td class="right" data-amt></td>
            <td class="right" data-tax></td>
          </tr>`;
        }).join('');
        body.innerHTML = `
          <div class="field-row div-top" style="justify-content:space-between;align-items:flex-end;margin-bottom:6px">
            <div class="field"><label>배당 연도</label><select data-pyear>${years.map((v) => `<option value="${v}" ${v === y ? 'selected' : ''}>${v}년</option>`).join('')}</select></div>
            <div class="field-row" style="align-items:center;gap:12px"><span class="small" data-sum></span><button type="button" class="secondary" data-close>취소</button><button type="button" data-save ${r.rounds.length ? '' : 'disabled'}>저장</button></div>
          </div>
          <p class="small muted" style="margin:0 0 8px">현재 보유수량 ${qty(r.quantity)}주 (회차별로 수정 가능) · 금액 단위 ${c === 'USD' ? '달러' : '원'}</p>
          ${r.rounds.length ? `<div class="table-wrap"><table class="div-input-table">
            <thead><tr><th><input type="checkbox" data-all aria-label="전체 선택" /></th><th>횟수</th><th>실지급일</th><th>주당 배당금</th><th>주당 과세표준</th><th>기준종가</th><th>배당수익률</th><th class="qty-col">보유수량</th><th>총 배당금</th><th>총 과세표준</th></tr></thead>
            <tbody>${rowsHtml}</tbody></table></div>` : `<div class="empty">${y}년 배당 내역이 없습니다.</div>`}
          <p class="small muted" style="margin:8px 0 0">횟수 아래 날짜 = 배당락일 · 총 배당금 = 보유수량 × 주당 배당금 · 총 과세표준 = 보유수량 × 주당 과세표준 · 기준종가 = 배당락 전일 종가, 배당수익률 = 주당 배당금 ÷ 기준종가 · 체크한 회차만 저장되며, 이 연도에 저장했던 회차 중 체크를 푼 회차는 지워집니다.${r.taxError ? ` · 과세표준 갱신 실패: ${esc(r.taxError)}` : ''}</p>
`;
        const trs = [...body.querySelectorAll('tr[data-ri]')];
        const all = body.querySelector('[data-all]');
        const num = (v) => Number(String(v || '').replace(/,/g, ''));
        const sync = () => {
          let n = 0; let amt = 0; let tax = 0; let taxMissing = false;
          trs.forEach((tr) => {
            const x = r.rounds[Number(tr.dataset.ri)];
            const q = num(tr.querySelector('[name=qty]').value);
            const a = q > 0 ? q * x.per_share : null;
            const t = q > 0 && x.tax_per_share != null ? q * x.tax_per_share : null;
            tr.querySelector('[data-amt]').innerHTML = a == null ? dash : `<b>${money(a, c)}</b>`;
            tr.querySelector('[data-tax]').innerHTML = t == null ? dash : money(t, c);
            tr.querySelector('[name=qty]').classList.toggle('invalid', !(q > 0));
            tr.classList.toggle('picked', tr.querySelector('[data-pick]').checked);
            if (tr.querySelector('[data-pick]').checked) {
              n++; amt += a || 0;
              if (t == null) taxMissing = true; else tax += t;
            }
          });
          body.querySelector('[data-sum]').innerHTML = `선택 <b>${n}회</b> · 총 배당금 <b>${money(amt, c)}</b> · 총 과세표준 <b>${taxMissing ? '-' : money(tax, c)}</b>`;
          if (all) { all.checked = n > 0 && n === trs.length; all.indeterminate = n > 0 && n < trs.length; }
        };
        trs.forEach((tr) => {
          tr.querySelector('[data-pick]').addEventListener('change', sync);
          tr.querySelector('[name=qty]').addEventListener('input', sync);
        });
        if (all) all.addEventListener('change', () => { trs.forEach((tr) => (tr.querySelector('[data-pick]').checked = all.checked)); sync(); });
        sync();
        body.querySelector('[data-pyear]').addEventListener('change', (e) => { body.innerHTML = '<div class="empty">배당 내역을 불러오는 중…</div>'; render(Number(e.target.value)); });
        body.querySelector('[data-close]').addEventListener('click', closeModal);
        body.querySelector('[data-save]').addEventListener('click', async (e) => {
          const picked = trs.filter((tr) => tr.querySelector('[data-pick]').checked)
            .map((tr) => ({ exDate: r.rounds[Number(tr.dataset.ri)].ex_date, quantity: tr.querySelector('[name=qty]').value }));
          e.target.disabled = true;
          try {
            const res = await api('POST', '/divmgmt/rounds', { year: y, groupId: it.group_id, code: it.code, rounds: picked });
            closeModal();
            toast(`${y}년 ${res.saved}개 회차를 저장했습니다. (총 배당금 ${money(res.amount, c)})`);
            load();
          } catch (err) {
            e.target.disabled = false;
            toast(err.message);
          }
        });
      }
      render(initYear);
    }

    load();
  }

  const PRIVATE = { '/assets': viewAssets, '/stock': viewStock, '/holdings': viewHoldings, '/yearly': viewYearly, '/dividends': viewDividends, '/divmgmt': viewDivMgmt, '/me': viewMe };

  async function render() {
    destroyCharts();
    closeAllModals();
    const { path, query } = parseHash();
    if (PUBLIC[path]) {
      if (state.user && path !== '/reset') return go('#/assets');
      return PUBLIC[path](query);
    }
    if (!state.user) return go('#/login');
    if (!state.settings) await loadSettings();
    (PRIVATE[path] || (() => go('#/assets')))(query);
    window.scrollTo(0, 0);
  }

  window.addEventListener('hashchange', render);
  api('GET', '/auth/me').then((r) => {
    state.user = r.user;
    render();
  }).catch(() => render());
})();
