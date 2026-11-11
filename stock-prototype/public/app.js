/* K-Stock (주식 관리시스템) 프로토타입 — 화면 SC-01 ~ SC-07 */
(() => {
  'use strict';

  const $app = document.getElementById('app');
  const state = { user: null, charts: [], settings: null, received: undefined, actAs: null, actSettings: {}, server: { cloud: false, signupCode: false, demo: true } };
  // 실행 환경 (v0.25): 안드로이드 앱 안(휴대폰 모드: 앱 내장 서버 / 클라우드 모드: 연결한 서버 화면) 또는 PC 브라우저
  const IN_APP = !!window.AndroidBridge;
  const LOCAL_APP = IN_APP && !!window.MobileApp;
  const REMOTE_APP = IN_APP && !window.MobileApp;
  const appServerUrl = () => { try { return (window.AndroidBridge.getServerUrl && window.AndroidBridge.getServerUrl()) || ''; } catch (_) { return ''; } };
  const hostOf = (u) => { try { return new URL(u).host; } catch (_) { return u; } };

  // 회원별 화면 설정: 마지막 조회 기간·선택 연도 (서버에 저장 → PC·앱 어디서나 이어짐)
  const settings = {
    // 공유받은 화면을 보는 동안에는 내 설정을 건드리지 않고 메모리에만 둔다 (v0.16)
    get(key) { return state.actAs ? state.actSettings[key] : (state.settings || {})[key]; },
    set(key, value) {
      if (state.actAs) { state.actSettings[key] = value; return; }
      state.settings = { ...(state.settings || {}), [key]: value };
      api('PUT', `/settings/${encodeURIComponent(key)}`, { value }).catch(() => {});
    },
  };
  async function loadSettings() {
    try { state.settings = (await api('GET', '/settings')).settings || {}; } catch (_) { state.settings = {}; }
    applyTheme(state.settings['ui.theme'] || null);
    // 계정에 저장한 언어가 있으면 그 언어로 (v0.26)
    // 로그인 화면에서 언어를 골랐으면 그 선택을 계정에 저장하고, 아니면 계정에 저장한 언어를 쓴다
    const savedLang = state.settings['ui.lang'];
    if (window.I18N && state.pendingLang) {
      if (savedLang !== state.pendingLang) {
        state.settings['ui.lang'] = state.pendingLang;
        api('PUT', '/settings/ui.lang', { value: state.pendingLang }).catch(() => {});
      }
      state.pendingLang = null;
    } else if (window.I18N && (savedLang === 'ko' || savedLang === 'en') && savedLang !== window.I18N.lang) window.I18N.set(savedLang);
  }

  // ---------------------------------------------------------------------------
  // 화면 테마 (v0.17): 기준 색 하나로 메뉴·버튼·탭·강조 행·배경 색을 모두 계산한다
  // ---------------------------------------------------------------------------
  const THEME_DEFAULT = '#eb6c07'; // 앱 아이콘 바탕색 (v0.19)
  const THEME_PRESETS = [
    ['#eb6c07', '주황(기본)'], ['#e11d48', '빨강'], ['#db2777', '핑크'], ['#7c3aed', '보라'],
    ['#1f4e79', '남색'], ['#2563eb', '파랑'], ['#0f766e', '청록'], ['#2f855a', '초록'],
    ['#a16207', '황토'], ['#475569', '회색'],
  ];
  const isHex = (v) => /^#[0-9a-f]{6}$/i.test(String(v || ''));
  function hexToHsl(hex) {
    const n = parseInt(hex.slice(1), 16);
    const r = ((n >> 16) & 255) / 255; const g = ((n >> 8) & 255) / 255; const b = (n & 255) / 255;
    const max = Math.max(r, g, b); const min = Math.min(r, g, b); const l = (max + min) / 2;
    let h = 0; let sat = 0;
    if (max !== min) {
      const d = max - min;
      sat = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h *= 60;
    }
    return [h, sat * 100, l * 100];
  }
  const hsl = (h, sat, l) => `hsl(${Math.round(h)}, ${Math.round(Math.max(0, Math.min(100, sat)))}%, ${Math.round(Math.max(0, Math.min(100, l)))}%)`;
  function themeVars(hex) {
    const [h, s0, l0] = hexToHsl(hex);
    const sat = Math.min(s0, 90);
    const l = Math.max(28, Math.min(l0, 50)); // 흰 글자가 읽히도록 밝기를 제한
    const ts = sat < 8 ? sat : Math.max(sat, 35); // 옅은 색 단계의 채도
    return {
      '--primary': hsl(h, sat, l), '--primary-2': hsl(h, sat, Math.min(l, 38)), '--primary-soft': hsl(h, ts, 95),
      '--bg': hsl(h, Math.min(ts, 45), 97), '--border': hsl(h, Math.min(ts, 35), 89), '--surface-2': hsl(h, Math.min(ts, 40), 98.5),
      '--t-50': hsl(h, ts, 96), '--t-100': hsl(h, ts, 91), '--t-200': hsl(h, ts, 83), '--t-300': hsl(h, ts * 0.9, 68),
      '--t-700': hsl(h, sat, Math.min(l, 36)), '--t-900': hsl(h, Math.min(sat, 60), 20),
      '--side-a': hsl(h, sat, l + 9), '--side-b': hsl(h, sat, l + 2), '--side-c': hsl(h, sat, l - 6),
    };
  }
  function applyTheme(hex) {
    const root = document.documentElement;
    const custom = isHex(hex) && hex.toLowerCase() !== THEME_DEFAULT;
    Object.entries(themeVars(custom ? hex : THEME_DEFAULT)).forEach(([k, v]) => root.style.setProperty(k, v));
    const meta = document.querySelector('meta[name=theme-color]');
    if (meta) meta.setAttribute('content', getComputedStyle(root).getPropertyValue('--side-b').trim());
    try { if (custom) localStorage.setItem('ui.theme', hex); else localStorage.removeItem('ui.theme'); } catch (_) { /* 무시 */ }
  }
  // 그래프 색 (v0.19): 테마 기준 색 한 가지 계열에서 진하게·기본·연하게 3단계를 만들고,
  // 환율 선은 같은 계열의 아주 진한 색으로 그려 색 컨셉이 흐트러지지 않게 한다
  function chartPalette() {
    const cur = (state.settings || {})['ui.theme'];
    const [h, s0, l0] = hexToHsl(isHex(cur) ? cur : THEME_DEFAULT);
    const sat = Math.min(s0, 90);
    const l = Math.max(36, Math.min(l0, 52));
    return {
      c1: hsl(h, sat, l - 13), // 조금 진하게
      c2: hsl(h, sat, l + 5), // 기본에 가깝게
      c3: hsl(h, sat * 0.85, l + 25), // 조금 연하게
      line: hsl(h, Math.min(sat, 70), 22), // 환율 선: 아주 진하게
    };
  }
  function saveTheme(hex) {
    const v = isHex(hex) && hex.toLowerCase() !== THEME_DEFAULT ? hex.toLowerCase() : null;
    applyTheme(v);
    state.settings = { ...(state.settings || {}), 'ui.theme': v };
    return api('PUT', '/settings/ui.theme', { value: v });
  }
  // 로그인 전 화면도 마지막으로 쓴 테마로 (이 기기에 기억한 값)
  try { applyTheme(localStorage.getItem('ui.theme')); } catch (_) { /* 무시 */ }
  const THIS_YEAR = new Date().getFullYear();
  const yearOptions = (sel, min = THIS_YEAR - 15, max = THIS_YEAR) =>
    Array.from({ length: max - min + 1 }, (_, k) => max - k).map((y) => `<option value="${y}" ${y === sel ? 'selected' : ''}>${y}년</option>`).join('');

  // ---------------------------------------------------------------------------
  // 공통 도우미
  // ---------------------------------------------------------------------------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // 사용자가 입력한 값(그룹명·메모 등)과 종목명은 언어를 바꿔도 번역하지 않는다 (v0.26.1)
  const ud = (v) => `<span data-noi18n>${esc(v)}</span>`;

  // ---------------------------------------------------------------------------
  // 화면 공유 (v0.16): 공유받은 화면을 열면 요청마다 ?as=<공유한 사용자 id> 를 붙인다
  // ---------------------------------------------------------------------------
  const SHARE_PATH = { '#/assets': 'assets', '#/yearly': 'yearly', '#/stock': 'stock', '#/holdings': 'holdings', '#/divmgmt': 'divmgmt' };
  const NO_AS = /^\/(auth|shares|settings|backup|restore)(\/|\?|$)/;
  const PERM_LABEL = { view: '조회', edit: '편집' };
  function withAs(path) {
    if (!state.actAs || NO_AS.test(path)) return path;
    return `${path}${path.includes('?') ? '&' : '?'}as=${state.actAs.user_id}`;
  }
  function setActAs(share) {
    state.actAs = share || null;
    state.actSettings = {};
    try {
      if (share) sessionStorage.setItem('actAs', String(share.user_id));
      else sessionStorage.removeItem('actAs');
    } catch (_) { /* 저장소를 못 쓰면 이번 화면에서만 유지 */ }
  }
  async function loadReceived() {
    try {
      const r = await api('GET', '/shares');
      state.received = r.received || [];
      return r;
    } catch (_) {
      state.received = [];
      return null;
    }
  }
  function resetShareState() {
    state.received = undefined;
    setActAs(null);
  }

  async function api(method, path, body) {
    const res = await fetch(`/api${withAs(path)}`, {
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
      if (res.status === 401 && state.user) { state.user = null; resetShareState(); go('#/login'); }
      throw err;
    }
    return data;
  }

  // 표시 형식 (4.3): 원 정수 / 달러 소수 2자리 / 비율 소수 1자리. 표시할 때만 반올림
  const nf0 = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 0 });
  const nf2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const nfq = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 6 });
  // 언어 (v0.26): 영어면 원화를 ₩1,234 형태로. 캔버스(그래프) 글자는 화면 번역이 닿지 않으므로 tt()로 직접 바꾼다
  const isEn = () => !!(window.I18N && window.I18N.lang === 'en');
  const tt = (str) => (window.I18N ? window.I18N.t(str) : str);
  const krw = (n) => (n == null ? '-' : isEn() ? `${Math.round(n) < 0 ? '-' : ''}₩${nf0.format(Math.abs(Math.round(n)))}` : `${nf0.format(Math.round(n))}원`);
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
  const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString(isEn() ? 'en-US' : 'ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '-');
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
    ['#/assets', '나의 자산', 'SC-02'],
    ['#/yearly', '연도별 자산 (요약)', 'SC-05'],
    ['#/stock', '종목 정보 조회', 'SC-03'],
    ['#/holdings', '보유 종목 관리', 'SC-04'],
    ['#/divmgmt', '배당 내역 관리', 'SC-08'],
    ['#/me', '환경설정', 'SC-07'],
  ];
  // 메뉴 아이콘 (v0.22): 글자색(currentColor)을 따르는 선 아이콘
  const NAV_ICON_PATHS = {
    '#/yearly': '<path d="M4 20h16"/><rect x="5" y="12" width="3" height="6" rx="1"/><rect x="10.5" y="8" width="3" height="10" rx="1"/><rect x="16" y="4" width="3" height="14" rx="1"/>',
    '#/assets': '<path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H18v3"/><rect x="4" y="8" width="16" height="11" rx="2.5"/><path d="M16 13.5h2"/>',
    '#/stock': '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/><path d="M7.5 12l2-2 1.5 1.5L13.5 9"/>',
    '#/holdings': '<rect x="4" y="4" width="16" height="16" rx="2.5"/><path d="M8 9h8M8 12.5h8M8 16h5"/>',
    '#/divmgmt': '<ellipse cx="10" cy="7" rx="6" ry="2.6"/><path d="M4 7v4c0 1.4 2.7 2.6 6 2.6s6-1.2 6-2.6V7"/><path d="M8 16.3c.6.2 1.3.3 2 .3"/><path d="M4 11v4c0 1.4 2.7 2.6 6 2.6"/><circle cx="17" cy="16.5" r="3.5"/>',
    '#/me': '<path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h11M19 17h1"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="17" r="2"/>',
  };
  const navIcon = (h) => `<svg class="nav-ico" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${NAV_ICON_PATHS[h] || ''}</svg>`;

  function shareSwitch() {
    if (!state.received || !state.received.length) return '';
    const cur = state.actAs ? state.actAs.user_id : '';
    return `<label class="act-switch"><span>보는 자산</span><select data-actas>
      <option value="">내 자산</option>
      ${state.received.map((r) => `<option value="${r.user_id}" ${r.user_id === cur ? 'selected' : ''}>${esc(r.email)} (공유)</option>`).join('')}
    </select></label>`;
  }
  function shareBanner(active) {
    if (!state.actAs) return '';
    const sc = SHARE_PATH[active];
    const perm = sc ? state.actAs.perms[sc] : null;
    const mode = perm === 'edit' ? '<span class="perm edit">편집 가능</span>' : perm ? '<span class="perm view">조회 전용</span>' : '';
    return `<div class="share-banner"><span>👥 <b>${esc(state.actAs.email)}</b>님이 공유한 화면을 보고 있습니다 ${mode}</span><button class="sm secondary" data-actexit>내 자산으로 돌아가기</button></div>`;
  }

  function shell(active, inner) {
    const nav = state.actAs ? NAV.filter(([h]) => h === '#/me' || (SHARE_PATH[h] && state.actAs.perms[SHARE_PATH[h]])) : NAV;
    const links = nav.map(([h, label, sc]) => `<a href="${h}" class="${active === h ? 'active' : ''}">${navIcon(h)}<span class="nav-label">${label}</span><span class="sc">${sc}</span></a>`).join('');
    const mlinks = nav.map(([h, label]) => `<a href="${h}" class="${active === h ? 'active' : ''}">${navIcon(h)}<span class="nav-label">${label}</span></a>`).join('');
    $app.innerHTML = `
      <div class="shell">
        <aside class="side">
          <div class="brand"><img src="icon-192.png" alt="" class="brand-ico" /><div><span class="brand-name">K-Stock</span><small>주식 자산 관리</small></div></div>
          ${shareSwitch()}
          ${links}
          <div class="spacer"></div>
          <div class="who">${esc(state.user.email)}</div>
          <button class="linkish" data-logout>로그아웃</button>
        </aside>
        <div>
          <div class="mobile-top">
            <div class="bar"><span class="mbrand"><img src="icon-192.png" alt="" class="brand-ico" /><span class="brand-name">K-Stock</span></span><button class="linkish" data-logout>로그아웃</button></div>
            ${shareSwitch()}
            <nav>${mlinks}</nav>
          </div>
          <main class="main"><div class="content">${shareBanner(active)}${inner}</div><div class="footer-note">${DISCLAIMER}</div></main>
        </div>
      </div>`;
    $app.querySelectorAll('[data-logout]').forEach((b) => b.addEventListener('click', async () => {
      await api('POST', '/auth/logout');
      state.user = null;
      resetShareState();
      go('#/login');
    }));
    $app.querySelectorAll('[data-actas]').forEach((sel) => sel.addEventListener('change', () => {
      const id = Number(sel.value);
      setActAs(id ? state.received.find((r) => r.user_id === id) : null);
      render();
    }));
    $app.querySelectorAll('[data-actexit]').forEach((b) => b.addEventListener('click', () => { setActAs(null); render(); }));
    return $app.querySelector('main .content');
  }

  function loading(main, text = '불러오는 중…') {
    main.insertAdjacentHTML('beforeend', `<div class="card empty" data-loading>${esc(text)}</div>`);
  }

  // ---------------------------------------------------------------------------
  // SC-01 로그인·사용자 추가·비밀번호 재설정
  // ---------------------------------------------------------------------------
  // 언어 선택 (v0.26): 로그인 화면과 환경설정에서 한국어 / English 중 선택. 이 기기에 기억하고, 로그인 중이면 계정에도 저장
  function langSelectHtml() {
    const cur = isEn() ? 'en' : 'ko';
    return `<label class="lang-switch" data-noi18n><span>언어 (Language)</span><select data-lang aria-label="언어 (Language)">
      <option value="ko" ${cur === 'ko' ? 'selected' : ''}>한국어</option><option value="en" ${cur === 'en' ? 'selected' : ''}>English</option></select></label>`;
  }
  function setLang(v) {
    if (!window.I18N) return;
    window.I18N.set(v);
    if (!state.user) state.pendingLang = v;
    if (state.user && state.settings) {
      state.settings = { ...state.settings, 'ui.lang': v };
      api('PUT', '/settings/ui.lang', { value: v }).catch(() => {});
    }
    render();
  }
  function bindLang(root) {
    root.querySelectorAll('[data-lang]').forEach((sel) => sel.addEventListener('change', () => setLang(sel.value)));
  }

  function authPage(title, sub, body) {
    $app.innerHTML = `
      <div class="auth-wrap"><div class="auth-card">
        <div class="lang-row">${langSelectHtml()}</div>
        <div class="card">
          <h1>${title}</h1>
          <p class="muted" style="margin:4px 0 0">${sub}</p>
          ${body}
        </div>
        <p class="footer-note" style="text-align:center;border:none">${DISCLAIMER}</p>
      </div></div>`;
    bindLang($app);
    return $app.querySelector('form');
  }

  // ---------------------------------------------------------------------------
  // 클라우드 서버 연결 (v0.25, 안드로이드 앱): 서버 주소를 정하면 앱이 그 서버 화면을 연다
  // ---------------------------------------------------------------------------
  function cloudConnectModal() {
    const body = openModal('클라우드 서버에 연결');
    const cur = appServerUrl();
    body.innerHTML = `<p style="margin:0 0 10px">다른 기기와 화면을 공유하려면, 직접 만든 K-Stock 클라우드 서버(예: Oracle Cloud)에 연결하세요. 연결하면 이 앱은 그 서버의 화면과 데이터를 사용합니다.</p>
      <form class="stack" data-cform novalidate>
        <div class="field"><label>서버 주소</label><input name="url" placeholder="https://kstock.duckdns.org" value="${esc(cur)}" autocomplete="off" inputmode="url" /><span class="err" data-err="url"></span></div>
        <div class="notice info small"><div><b>휴대폰에 있던 데이터를 옮기려면</b><br/>① 연결 전에 환경설정 → <b>백업 파일 저장</b> ② 연결 후 서버에서 사용자 추가·로그인 ③ 환경설정 → <b>백업 파일로 복원</b><br/>휴대폰 안의 데이터는 지워지지 않으며, 언제든 ‘이 휴대폰 모드’로 돌아올 수 있습니다.</div></div>
        <div class="field-row" style="justify-content:flex-end"><button type="button" class="secondary" data-close>취소</button><button type="submit">연결</button></div>
      </form>`;
    const f = body.querySelector('[data-cform]');
    body.querySelector('[data-close]').addEventListener('click', closeAllModals);
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      const msg = window.AndroidBridge.setServerUrl(f.url.value.trim());
      showFieldErrors(f, msg ? { url: msg } : {});
      if (!msg) toast('서버에 연결하는 중…');
    });
    f.url.focus();
  }
  function switchToLocal() {
    if (!confirm('이 휴대폰 모드로 전환할까요? 휴대폰 안에 저장된 데이터로 돌아갑니다(서버의 데이터는 그대로 남습니다).')) return;
    window.AndroidBridge.setServerUrl('');
  }
  function cloudLoginBox(query) {
    if (LOCAL_APP) {
      const saved = appServerUrl();
      const err = query && query.cloudError && saved
        ? `<div class="notice error small"><div class="grow"><b>클라우드 서버(${esc(hostOf(saved))})에 연결하지 못했습니다.</b><br/>인터넷 연결이나 서버 상태를 확인하세요. 지금 화면은 휴대폰 안의 데이터입니다.</div></div>
           <div class="field-row" style="margin-bottom:10px"><button type="button" class="sm" data-cretry>다시 연결</button><button type="button" class="sm secondary" data-clocal>이 휴대폰 모드로 사용</button></div>`
        : '';
      return `${err}<div class="cloud-box">☁️ 다른 기기와 공유하려면 <button type="button" class="linkish" data-cloud>클라우드 서버에 연결</button></div>`;
    }
    if (REMOTE_APP) return `<div class="cloud-box">☁️ 연결된 서버: <b>${esc(hostOf(appServerUrl() || location.origin))}</b> · <button type="button" class="linkish" data-clocal>이 휴대폰 모드로 전환</button></div>`;
    return '';
  }
  function bindCloudBox(root) {
    root.querySelectorAll('[data-cloud]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); cloudConnectModal(); }));
    root.querySelectorAll('[data-cretry]').forEach((a) => a.addEventListener('click', () => window.AndroidBridge.setServerUrl(appServerUrl())));
    root.querySelectorAll('[data-clocal]').forEach((a) => a.addEventListener('click', (e) => {
      e.preventDefault();
      if (LOCAL_APP) { window.AndroidBridge.setServerUrl(''); toast('이 휴대폰 모드로 사용합니다.'); render(); } else switchToLocal();
    }));
  }

  // 로그인 아이디 기억 (v0.18): 이 기기(브라우저·앱)에만 저장, 비밀번호는 저장하지 않음
  const LOGIN_IDS_MAX = 5;
  const loginStore = {
    ids() { try { const v = JSON.parse(localStorage.getItem('login.ids') || '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; } catch (_) { return []; } },
    setIds(list) { try { localStorage.setItem('login.ids', JSON.stringify(list.slice(0, LOGIN_IDS_MAX))); } catch (_) { /* 무시 */ } },
    remember() { try { return localStorage.getItem('login.remember') === '1'; } catch (_) { return false; } },
    setRemember(on) { try { localStorage.setItem('login.remember', on ? '1' : '0'); } catch (_) { /* 무시 */ } },
  };

  function viewLogin(query = {}) {
    const form = authPage('<img src="icon-192.png" alt="" class="auth-ico" />K-Stock', '로그인 <span class="req">SC-01 · FR-AUTH-02</span>', `
      <form class="stack" novalidate>
        <div class="field id-field"><label>이메일(아이디)</label><input name="email" type="email" autocomplete="off" required /><div class="id-menu" data-idmenu hidden></div><span class="err" data-err="email"></span></div>
        <div class="field"><label>비밀번호</label><input name="password" type="password" autocomplete="current-password" required /><span class="err" data-err="password"></span></div>
        <div class="remember-row"><label><input type="checkbox" name="rememberId" /> 아이디 저장</label><span class="small muted" data-idcount></span></div>
        <div class="notice error" data-msg hidden></div>
        <button type="submit">로그인</button>
      </form>
      <div class="links"><a href="#/signup">사용자 추가</a><a href="#/forgot">비밀번호를 잊으셨나요?</a></div>
      ${state.server.demo ? '<div class="demo-box">데모 계정: <b>demo@example.com</b> / <b>demo1234</b><br/>보유 종목 5개와 배당 내역이 미리 들어 있습니다.</div>' : ''}
      ${cloudLoginBox(query)}`);
    bindCloudBox($app);
    // 저장한 아이디: 체크되어 있으면 마지막 아이디를 채우고, 입력칸을 누르면 예전 아이디 목록을 보여준다
    const menu = form.querySelector('[data-idmenu]');
    const remember = form.rememberId;
    remember.checked = loginStore.remember();
    const countEl = form.querySelector('[data-idcount]');
    const showCount = () => { const n = loginStore.ids().length; countEl.textContent = n ? `저장된 아이디 ${n}개 · 입력칸을 눌러 선택` : ''; };
    function openMenu() {
      const q = form.email.value.trim().toLowerCase();
      const list = loginStore.ids().filter((id) => !q || id.toLowerCase().includes(q) && id.toLowerCase() !== q);
      if (!list.length) { menu.hidden = true; return; }
      menu.innerHTML = list.map((id) => `<div class="id-opt" data-id="${esc(id)}"><span>${esc(id)}</span><button type="button" class="linkish" data-rm title="목록에서 지우기" aria-label="${esc(id)} 지우기">✕</button></div>`).join('');
      menu.hidden = false;
    }
    menu.addEventListener('mousedown', (e) => e.preventDefault()); // 고르는 동안 입력칸 포커스 유지
    menu.addEventListener('click', (e) => {
      const opt = e.target.closest('[data-id]');
      if (!opt) return;
      if (e.target.closest('[data-rm]')) {
        loginStore.setIds(loginStore.ids().filter((id) => id !== opt.dataset.id));
        showCount();
        openMenu();
        return;
      }
      form.email.value = opt.dataset.id;
      menu.hidden = true;
      form.password.focus();
    });
    form.email.addEventListener('focus', openMenu);
    form.email.addEventListener('click', openMenu);
    form.email.addEventListener('input', openMenu);
    form.email.addEventListener('blur', () => setTimeout(() => { menu.hidden = true; }, 120));
    form.email.addEventListener('keydown', (e) => { if (e.key === 'Escape') menu.hidden = true; });
    showCount();
    const saved = loginStore.ids();
    if (remember.checked && saved.length) {
      form.email.value = saved[0];
      form.password.focus();
    } else form.email.focus();
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      menu.hidden = true;
      const msg = form.querySelector('[data-msg]');
      try {
        const { email, password } = formData(form);
        const r = await api('POST', '/auth/login', { email, password });
        // 아이디 저장: 체크하면 목록 맨 앞에 두고 다음에 자동으로 채움, 해제하면 이 아이디를 목록에서 지움
        const id = String(email || '').trim();
        const rest = loginStore.ids().filter((x) => x.toLowerCase() !== id.toLowerCase());
        loginStore.setIds(remember.checked ? [id, ...rest] : rest);
        loginStore.setRemember(remember.checked);
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
    const form = authPage('사용자 추가', '이메일과 비밀번호로 새 사용자를 추가합니다. <span class="req">FR-AUTH-01</span>', `
      <div class="notice info small" style="margin-top:14px">${state.server.cloud ? '이 서버는 가입 즉시 계정이 활성화됩니다. 비밀번호를 잊으면 서버 관리자에게 재설정을 요청해야 하니 잘 기억해 두세요.' : '프로토타입에서는 이메일 인증 절차를 생략하고 가입 즉시 계정이 활성화됩니다.'}</div>
      <form class="stack" novalidate style="margin-top:4px">
        <div class="field"><label>이메일</label><input name="email" type="email" autocomplete="username" /><span class="err" data-err="email"></span></div>
        <div class="field"><label>비밀번호</label><input name="password" type="password" autocomplete="new-password" /><span class="hint">8자 이상, 영문과 숫자 포함</span><span class="err" data-err="password"></span></div>
        <div class="field"><label>비밀번호 확인</label><input name="password2" type="password" autocomplete="new-password" /><span class="err" data-err="password2"></span></div>
        ${state.server.signupCode ? '<div class="field"><label>가입 코드</label><input name="signupCode" autocomplete="off" /><span class="hint">서버 관리자에게 받은 코드</span><span class="err" data-err="signupCode"></span></div>' : ''}
        <button type="submit">사용자 추가</button>
      </form>
      <div class="links"><a href="#/login">← 로그인으로</a></div>`);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const d = formData(form);
      if (d.password !== d.password2) return showFieldErrors(form, { password2: '비밀번호가 일치하지 않습니다.' });
      try {
        const r = await api('POST', '/auth/signup', { email: d.email, password: d.password, signupCode: d.signupCode });
        state.user = r.user;
        toast('사용자를 추가했습니다.');
        go('#/assets');
      } catch (err) {
        showFieldErrors(form, err.fields || {});
        if (!err.fields || !Object.keys(err.fields).length) toast(err.message);
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
  // SC-02 나의 자산 (로그인 후 첫 화면)
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
        <div><h1>나의 자산 ${req('SC-02 · FR-AST · FR-XLS-01')}</h1><p>${ongoing ? '선택한 연도 말 보유 종목의 현재 평가금액과 손익을 원화 기준으로 보여줍니다.' : `${year}년 말 보유 종목을 그해 연말 종가·연말 환율로 평가합니다.`}</p></div>
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
      .concat(d.groups.map((g) => `<button class="${d.groupId === g.id ? 'on' : ''}" data-g="${g.id}">${ud(g.name)}</button>`)).join('');
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
      html.push(`<div class="notice warn"><div class="grow"><b>${ud(r.instrument.name)}</b>에 액면분할·병합(${esc(r.splitNotice.ratio)}, ${esc(r.splitNotice.date)})이 발생했습니다. 과거 종가는 다시 수집했으며, 보유 수량은 자동으로 바꾸지 않으니 확인 후 보유 수량을 고쳐 주세요. ${req('FR-DATA-03')}</div><a href="#/holdings?year=${THIS_YEAR}"><button class="sm secondary">종목 수정</button></a></div>`);
    });
    d.rows.filter((r) => r.error).forEach((r) => {
      html.push(`<div class="notice error"><div class="grow"><b>${ud(r.instrument ? r.instrument.name : r.code)}</b> 합계에서 제외했습니다: ${esc(r.error)}</div>${d.ongoing ? '<button class="sm" data-refresh2>재시도</button>' : ''}</div>`);
    });

    if (!d.rows.length) {
      html.push(`<div class="card empty">${d.year}년 말 ${d.groupId ? `‘${ud((d.groups.find((g) => g.id === d.groupId) || {}).name)}’ 그룹의 ` : ''}보유 종목이 없습니다.<br/><br/><a href="#/stock"><button>종목 정보 조회하러 가기</button></a> <a href="#/holdings?year=${d.year}"><button class="secondary">${d.year}년 종목 등록</button></a></div>`);
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
              <td><a href="#/assets?year=${d.year}&group=${g.groupId}">${ud(g.name)}</a></td><td class="num">${g.count}${g.soldCount ? `<br/><small class="muted">매도 ${g.soldCount}</small>` : ''}</td>
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
          <h2>분류별 합계${d.groupId ? ` · ${ud((d.groups.find((g) => g.id === d.groupId) || {}).name)}` : ''}</h2>
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
          <h2>${d.year}년${d.ongoing ? '' : ' 말'} 종목별 평가금액${d.groupId ? ` · ${ud((d.groups.find((g) => g.id === d.groupId) || {}).name)}` : d.merged ? ' · 전체 통합' : ''} ${req('FR-AST-01 · FR-STK-06')}</h2>
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
                <td class="left"><div class="name-cell"><a href="#/stock?code=${encodeURIComponent(r.code)}" data-stock-popup="${esc(r.code)}" title="종목 정보 조회 팝업 열기">${ud(r.instrument.name)}</a><small>${esc(r.code)} · <span class="cat cat-${esc(r.category)}">${esc(r.categoryLabel)}</span> ${badge(r.instrument.type)} · <span class="badge sold">${d.year}년 전량 매도${r.soldQty > 1e-9 ? ` ${qty(r.soldQty)}주` : ''}</span>${r.mergedGroups && r.mergedGroups.length ? ` · ${r.mergedGroups.map(esc).join('·')}` : ''}</small></div></td>
                <td class="num">0</td><td class="num muted">-</td><td class="num muted">-</td><td class="num muted">-</td><td class="num muted">-</td>${d.ongoing ? '<td class="num muted">-</td>' : ''}
                ${yearCell(r)}${totalCell(r)}
              </tr>`;
              const rowHtml = (r) => {
                const c = r.instrument.currency;
                return `<tr>
                <td class="left"><div class="name-cell"><a href="#/stock?code=${encodeURIComponent(r.code)}" data-stock-popup="${esc(r.code)}" title="종목 정보 조회 팝업 열기">${ud(r.instrument.name)}</a><small>${esc(r.code)} · ${esc(r.instrument.market)} · <span class="cat cat-${esc(r.category)}">${esc(r.categoryLabel)}</span> ${badge(r.instrument.type)}${r.stale ? ' · <span class="up">지연</span>' : ''}${r.mergedGroups && r.mergedGroups.length > 1 ? ` · <span class="badge grp">${r.mergedGroups.map(esc).join('·')} 합산</span>` : ''}</small></div></td>
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
                return `<tr class="group-row"><td colspan="${cols}"><a href="#/assets?year=${d.year}&group=${g.id}">${ud(g.name)}</a> <span class="muted" style="font-weight:400">${gt.count || 0}종목${gt.soldCount ? ` · 전량 매도 ${gt.soldCount}` : ''}</span></td></tr>
                  ${ok.filter((r) => r.groupId === g.id).map(rowHtml).join('')}${sold.filter((r) => r.groupId === g.id).map(soldHtml).join('')}
                  <tr class="group-sub"><td colspan="3">${ud(g.name)} 소계</td><td class="num">${krw(gt.origCostKrw)}</td>${gapCells(gt)}${sumCells(gt)}</tr>`;
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
  // v0.23: 나의 자산(data-ckey) 외 화면은 data-fold 로 지정. 버튼은 상자 오른쪽 위에 두어 제목이 다시 그려져도 유지
  function makeFoldable(root, settingKey) {
    const folded = new Set(settings.get(settingKey) || []);
    root.querySelectorAll('.card[data-ckey], .card[data-fold]').forEach((card) => {
      const h2 = card.querySelector(':scope > h2');
      if (!h2 || card.querySelector(':scope > .fold-btn')) return;
      const key = card.dataset.ckey || card.dataset.fold;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'fold-btn';
      card.classList.add('foldable');
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
      card._unfold = () => { if (folded.has(key)) btn.click(); }; // 수정 버튼 등으로 상자를 써야 할 때 자동으로 펴기
      card.appendChild(btn);
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

  // 내가 조회한 종목 (v0.20): 보유 종목이 아닌 종목을 조회하면 최근 순으로 계정 설정(stock.recent)에 저장
  const RECENT_MAX = 12;
  const recentStocks = () => (Array.isArray(settings.get('stock.recent')) ? settings.get('stock.recent') : []).filter((r) => r && r.c);
  function rememberStock(inst) {
    const item = { c: inst.code, n: String(inst.name || '').slice(0, 40), t: inst.type || '' };
    settings.set('stock.recent', [item, ...recentStocks().filter((r) => r.c !== item.c)].slice(0, RECENT_MAX));
  }

  // 종목명·종목코드 검색 팝업 (v0.21)
  function mountStockSearch(input, menu, onPick) {
    let items = [];
    let active = -1;
    let seq = 0;
    let timer = null;
    let offline = false;
    const hl = (text, q) => {
      const t = String(text || '');
      const i = q ? t.toLowerCase().indexOf(q.toLowerCase()) : -1;
      return i < 0 ? esc(t) : `${esc(t.slice(0, i))}<mark>${esc(t.slice(i, i + q.length))}</mark>${esc(t.slice(i + q.length))}`;
    };
    function close() { menu.hidden = true; active = -1; input.setAttribute('aria-expanded', 'false'); }
    function paint(q) {
      if (!items.length) {
        menu.innerHTML = offline
          ? '<div class="ac-empty">종목명 검색 서버(네이버·야후)에 연결하지 못했습니다. 인터넷 연결을 확인하거나 종목코드로 조회하세요.</div>'
          : `<div class="ac-empty">‘${esc(q)}’와 비슷한 종목이 없습니다.</div>`;
      } else {
        menu.innerHTML = `<div class="ac-head">종목명 · 종목코드 · 시장 <span>↑↓ 이동 · Enter 선택</span></div>`
          + items.map((it, i) => `<div class="ac-opt ${i === active ? 'on' : ''}" data-i="${i}" role="option">
            <span class="ac-name">${hl(it.name, q)}</span>
            <span class="ac-code">${hl(it.code, q)}</span>
            <span class="ac-mk ${it.nation === 'US' ? 'us' : 'kr'}">${it.nation === 'US' ? '미국' : '국내'} · ${esc(it.market || '')}</span>
          </div>`).join('');
      }
      menu.hidden = false;
      input.setAttribute('aria-expanded', 'true');
    }
    async function search(q) {
      const my = ++seq;
      try {
        const r = await api('GET', `/search/stocks?q=${encodeURIComponent(q)}`);
        if (my !== seq) return items;
        items = r.items || [];
        offline = !!r.offline;
      } catch (_) { if (my === seq) { items = []; offline = true; } }
      return items;
    }
    async function run() {
      const q = input.value.trim();
      if (!q || (/^[A-Za-z]$/.test(q))) { items = []; close(); return; }
      menu.hidden = false;
      menu.innerHTML = '<div class="ac-empty">검색 중…</div>';
      const my = seq + 1;
      await search(q);
      if (my !== seq || input.value.trim() !== q || document.activeElement !== input) return;
      active = -1;
      paint(q);
    }
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 250); });
    input.addEventListener('focus', () => { if (items.length && input.value.trim()) paint(input.value.trim()); });
    input.addEventListener('blur', () => setTimeout(close, 150));
    input.addEventListener('keydown', (e) => {
      if (menu.hidden || !items.length) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = items.length;
        active = e.key === 'ArrowDown' ? (active + 1) % n : (active - 1 + n) % n;
        paint(input.value.trim());
        const on = menu.querySelector('.ac-opt.on');
        if (on) on.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Escape') close();
    });
    menu.addEventListener('mousedown', (e) => e.preventDefault());
    menu.addEventListener('click', (e) => {
      const opt = e.target.closest('[data-i]');
      if (!opt) { close(); return; } // 안내 문구를 누르면 팝업을 닫아 아래 버튼을 쓸 수 있게
      const it = items[Number(opt.dataset.i)];
      input.value = it.code;
      close();
      onPick(it.code);
    });
    return { current: () => (!menu.hidden && active >= 0 ? items[active] : null), search, isOffline: () => offline };
  }

  async function viewStock(query) {
    const main = shell('#/stock', `
      <div class="page-head"><div><h1>종목 정보 조회 ${req('SC-03 · FR-STK · FR-CHT-01')}</h1><p>국내(KOSPI·KOSDAQ) 주식·ETF·ETN, 미국 주식·ETF의 종목명 또는 종목코드를 입력하세요.</p></div></div>
      <div class="card">
        <form class="inline" data-search novalidate>
          <div class="field ac-field" style="flex:1;min-width:220px">
            <input name="code" placeholder="종목명 또는 종목코드 (예: 삼성전자, 애플, KODEX, 005930, AAPL)" value="${esc(query.code || '')}" autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false" />
            <div class="ac-menu" data-ac hidden role="listbox"></div>
            <span class="err" data-err="code"></span>
          </div>
          <button type="submit">조회</button>
        </form>
        <div class="small muted" style="margin-top:8px">종목명 일부를 입력하면 비슷한 종목명·종목코드 목록이 뜨고, 골라서 조회할 수 있습니다(↑↓ 이동, Enter 선택). 코드를 직접 넣으면 형식으로 시장을 자동 판별합니다: 숫자로 시작하는 6자리 → 국내, 영문 티커 → 미국 ${req('FR-STK-02')}</div>
      </div>
      <div data-boxes></div>
      <div data-result></div>`);
    const form = main.querySelector('[data-search]');
    const ac = mountStockSearch(form.code, form.querySelector('[data-ac]'), (code) => go(`#/stock?code=${encodeURIComponent(code)}`));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const raw = form.code.value.trim();
      if (!raw) return;
      // 목록에서 고른 종목이 있으면 그 코드로, 종목명(한글·띄어쓰기 포함)을 넣었으면 첫 번째 검색 결과로 조회
      const picked = ac.current();
      if (picked) return go(`#/stock?code=${encodeURIComponent(picked.code)}`);
      if (/[가-힣\s&]/.test(raw) || raw.length > 10) {
        const items = await ac.search(raw);
        if (items.length) return go(`#/stock?code=${encodeURIComponent(items[0].code)}`);
        showFieldErrors(form, { code: ac.isOffline()
          ? '종목명 검색 서버에 연결하지 못했습니다. 인터넷 연결을 확인하거나 종목코드로 조회하세요.'
          : '일치하는 종목을 찾지 못했습니다. 종목명을 다시 확인하거나 종목코드를 입력하세요.' });
        return;
      }
      go(`#/stock?code=${encodeURIComponent(raw.toUpperCase())}`);
    });
    // 내 보유 종목·내가 조회한 종목 상자 (v0.26): 종목을 조회할 때도 그대로 두고, 각 상자를 접고 펼 수 있다
    const boxes = main.querySelector('[data-boxes]');
    const cur = String(query.code || '').trim().toUpperCase();
    let held = null;
    const samples = '<a href="#/stock?code=005930">005930</a> · <a href="#/stock?code=0080G0">0080G0</a> · <a href="#/stock?code=530036">530036</a> · <a href="#/stock?code=AAPL">AAPL</a> · <a href="#/stock?code=SPY">SPY</a>';
    async function paintBoxes() {
      if (held === null) {
        try { held = (await api('GET', `/holdings?year=${THIS_YEAR}`)).holdings || []; } catch (_) { held = []; }
        held.sort((a, b) => String(a.name || a.code).localeCompare(String(b.name || b.code), 'ko'));
      }
      const heldCodes = new Set(held.map((h) => h.code));
      const recent = recentStocks().filter((r) => !heldCodes.has(r.c));
      const heldCard = held.length
        ? `<div class="card" data-fold="held">
            <h2>내 보유 종목 <span class="small muted" style="font-weight:400">${held.length}개 · 눌러서 조회</span></h2>
            <div class="stock-chips">${held.map((h) => `<a class="stock-chip ${h.code === cur ? 'on' : ''}" href="#/stock?code=${encodeURIComponent(h.code)}">${badge(h.type)} <span class="nm">${ud(h.name || h.code)}</span><span class="muted">(${esc(h.code)})</span></a>`).join('')}</div>
            <p class="small muted" style="margin:10px 0 0">보유 종목은 <a href="#/holdings">보유 종목 관리</a>에 입력한 올해 보유 수량 기준이며, 모든 그룹을 합쳐 보여줍니다. 다른 종목은 위에 종목코드를 입력하세요.</p>
          </div>`
        : (cur ? '' : `<div class="card empty">종목코드를 입력해 조회하세요.<br/><span class="small">보유 종목이 없어 예시를 보여줍니다: ${samples}</span></div>`);
      const recentCard = recent.length ? `<div class="card" data-fold="recent" data-recent>
            <h2>내가 조회한 종목 <span class="small muted" style="font-weight:400">${recent.length}개 · 최근 조회 순 · 눌러서 조회</span></h2>
            <div class="stock-chips">${recent.map((r) => `<span class="stock-chip recent ${r.c === cur ? 'on' : ''}"><a href="#/stock?code=${encodeURIComponent(r.c)}">${r.t ? badge(r.t) : ''} <span class="nm">${ud(r.n || r.c)}</span><span class="muted">(${esc(r.c)})</span></a><button type="button" class="chip-x" data-rm="${esc(r.c)}" title="목록에서 지우기" aria-label="${esc(r.n || r.c)} 지우기">✕</button></span>`).join('')}</div>
            <div class="recent-foot"><p class="small muted" style="margin:0">보유 종목이 아닌 종목을 조회하면 여기에 최근 ${RECENT_MAX}개까지 저장됩니다(계정에 저장되어 PC·앱 어디서나 보임).</p><button type="button" class="sm secondary" data-rclear>전체 지우기</button></div>
          </div>` : '';
      boxes.innerHTML = heldCard + recentCard;
      makeFoldable(boxes, 'stock.collapsed');
      const rc = boxes.querySelector('[data-recent]');
      if (rc) {
        rc.addEventListener('click', (e) => {
          const x = e.target.closest('[data-rm]');
          if (x) {
            settings.set('stock.recent', recentStocks().filter((r) => r.c !== x.dataset.rm));
            paintBoxes();
          } else if (e.target.closest('[data-rclear]') && confirm('조회한 종목 목록을 모두 지울까요?')) {
            settings.set('stock.recent', []);
            paintBoxes();
          }
        });
      }
    }
    const boxesReady = paintBoxes();
    if (!cur) {
      form.code.focus();
      return;
    }
    const resBox = main.querySelector('[data-result]');
    await loadStock(resBox, query.code, query.refresh === '1', main.querySelector('[data-search]'));
    // 조회에 성공했고 내 보유 종목이 아니면 ‘내가 조회한 종목’에 저장하고 상자를 다시 그린다
    if (resBox._q && resBox._q.instrument) {
      const inst = resBox._q.instrument;
      await boxesReady;
      if (!held.some((h) => h.code === inst.code)) {
        rememberStock(inst);
        if (location.hash.startsWith('#/stock')) paintBoxes();
      }
    }
  }

  // 종목 정보·날짜별 종가를 box 안에 그린다. 종목 조회 화면과 나의 자산의 종목 팝업에서 함께 사용
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
    box._q = q;
    const i = q.instrument;
    const c = i.currency;
    box.innerHTML = `
      ${q.stale ? `<div class="notice warn"><div><b>최신 시세가 아닙니다.</b> 외부 출처 오류로 마지막 저장값(${fmtTime(q.priceTime)} 기준)을 표시합니다. ${req('FR-DATA-06')}<br/><span class="small">${esc(q.staleReason)}</span></div></div>` : ''}
      <div class="card">
        <div class="quote">
          <div>
            <div class="title"><h2>${ud(i.name)}</h2>${badge(i.type)}<span class="badge mk">${esc(i.market)}</span></div>
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
          ${state.actAs && state.actAs.perms.holdings !== 'edit' ? '' : `<a href="#/holdings?code=${encodeURIComponent(i.code)}"><button>보유 종목으로 등록</button></a>`}
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
      <div class="card ro-hide" data-fold="form">
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
      <div class="card" data-fold="list"><h2 data-list-title></h2><div data-trades><div class="empty">불러오는 중…</div></div></div>`);
    makeFoldable(main, 'holdings.collapsed');

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
        hint.innerHTML = `${ud(q.instrument.name)} ${badge(q.instrument.type)}`;
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
      main.querySelector('[data-list-title]').innerHTML = `${year}년 주식 항목 · ${ud(groupName())} ${req('FR-HLD-02')}`;
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
        .concat(groups.map((g) => `<button class="${groupId === g.id ? 'on' : ''}" data-g="${g.id}">${ud(g.name)}</button>`)).join('');
      tabs.querySelectorAll('[data-g]').forEach((b) => b.addEventListener('click', () => {
        settings.set('holdings.group', b.dataset.g);
        go(`#/holdings?year=${year}&group=${b.dataset.g}`);
      }));
      form.groupId.innerHTML = groups.map((g) => `<option value="${g.id}" data-noi18n>${esc(g.name)}</option>`).join('');
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
        tbox.innerHTML = `<div class="empty">${year}년 ${ud(groupName())}에 보유한 종목이 없습니다.<br/><span class="small">위에서 종목을 등록하세요.</span></div>`;
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
          head = `<tr class="group-row"><td colspan="${cols}">${ud(it.group_name)}</td></tr>`;
        }
        return `${head}<tr data-idx="${idx}">
          <td class="left"><div class="name-cell"><span>${ud(it.name || it.code)}</span><small>${esc(it.code)} · <span class="cat cat-${esc(it.category)}">${esc(it.category_label)}</span> ${badge(it.type)}</small></div></td>
          <td class="right">${hasCarry(it) ? qty(it.basis_carried_qty) : dash}</td>
          <td class="right">${hasCarry(it) ? basisCell(it) : dash}</td>
          <td class="right">${qty(it.quantity)}</td>
          <td class="right">${money(it.purchase_amount, it.currency)}</td>
          <td class="right">${it.quantity > 0 ? money(it.purchase_amount / it.quantity, it.currency) : dash}</td>
          <td class="right"><b>${baseCell(it)}</b></td>
          <td class="small" data-noi18n>${esc(it.memo || '')}</td>
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
          body.innerHTML = `<p style="margin:0 0 10px">[${ud(it.group_name)}] <b>${ud(it.name || it.code)}</b> 종목을 ${year}년 보유 목록에서 삭제합니다. ${year}년부터 보유하지 않은 것으로 처리되며, 배당 내역은 유지됩니다.</p>
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
          main.querySelector('[data-form-title]').innerHTML = `${year}년 종목 수정 · ${ud(it.group_name)} ${req('FR-HLD-02')}`;
          const formCard = main.querySelector('[data-fold="form"]');
          if (formCard && formCard._unfold) formCard._unfold();
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
      const scope = groupId ? `‘${ud(groupName())}’ 그룹` : '전체 그룹';
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
          head = `<tr class="group-row"><td colspan="7">${ud(it.group_name)}</td></tr>`;
        }
        const dis = it.status === 'REGISTERED';
        return `${head}<tr data-ci="${idx}" class="${dis ? 'muted' : ''}">
          <td><input type="checkbox" data-pick ${dis ? 'disabled' : 'checked'} aria-label="${esc(it.name || it.code)} 선택" /></td>
          <td class="left"><div class="name-cell"><span>${ud(it.name || it.code)}</span><small>${esc(it.code)} · <span class="cat cat-${esc(it.category)}">${esc(it.category_label)}</span> ${badge(it.type)}</small></div></td>
          <td class="right">${qty(it.quantity)}</td>
          <td class="right">${money(it.avg_price, it.currency)}</td>
          <td class="right">${money(it.purchase_amount, it.currency)}</td>
          <td class="small" data-noi18n>${esc(it.memo || '')}</td>
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
        <div><h1>연도별 자산 (요약) ${req('SC-05 · FR-YR · FR-DIV-04 · FR-XLS-02')}</h1><p>보유 종목 관리에 연도별로 입력한 연말 보유 수량으로 연도별 자산금액을 비교합니다.</p></div>
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
    // 분류별 자산금액 칸 (v0.13.11): 금액 + 비중
    const catCell = (y, id) => {
      const v = y.byCategory ? y.byCategory[id] || 0 : 0;
      if (!v) return '<span class="muted">-</span>';
      return `${krw(v)}<br/><small class="muted">${y.valueKrw ? pct(v / y.valueKrw).replace('+', '') : ''}</small>`;
    };
    main.querySelector('[data-loading]').outerHTML = !hasHoldings
      ? '<div class="card empty">보유 종목이 없습니다. 보유 종목을 먼저 등록하세요.</div>'
      : `
      <div class="card" data-fold="assets">
        <h2>연도별 자산 증감 ${req('FR-YR-01 · 02 · 03 · 05 · 06 · FR-CHT-02')}</h2>
        <div class="grid c2 yr-grid">
          <div class="chart-box" style="height:300px"><canvas data-c1></canvas></div>
          <div class="table-wrap"><table class="yr-table">
            <thead><tr><th>연도</th><th class="num">총자산</th><th class="num">국내</th><th class="num">해외</th><th class="num">해외추종</th><th class="num">전년 대비</th></tr></thead>
            <tbody>${years.slice().reverse().map((y) => `
              <tr class="clickable" data-y="${y.year}">
                <td><b>${y.year}</b> <span class="small muted">▾</span>${y.ongoing ? '<br/><span class="badge ongoing">진행 중</span>' : ''}${y.excludedCount ? `<br/><small class="up">제외 ${y.excludedCount}개</small>` : ''}</td>
                <td class="num"><span class="tip" data-tip="연말 환율 ${esc(rate(y.fxRate))}" tabindex="0"><b>${krw(y.valueKrw)}</b></span></td>
                <td class="num">${catCell(y, 'DOMESTIC')}</td>
                <td class="num">${catCell(y, 'OVERSEAS')}</td>
                <td class="num">${catCell(y, 'OVERSEAS_TRACK')}</td>
                <td class="num ${cls(y.diffKrw)}">${y.diffKrw == null ? '-' : `${sKrw(y.diffKrw)}<br/><small>${pct(y.diffPct)}</small>`}</td>
              </tr>`).join('')}</tbody>
          </table></div>
        </div>
        <div data-ydetail></div>
        <p class="small muted" style="margin:10px 0 0">연도별 자산금액 = Σ (연말 수정 종가 × 그 해 말 보유 수량 × 해당 연도 말 환율) · 그래프의 꺾은선 = 환율(USD/KRW, 지난 연도는 연말 환율, 올해는 현재 환율) · 국내·해외·해외추종 = 보유 종목 관리의 종목 분류별 합계(아래 작은 글씨는 비중) · 총자산을 누르면 연말 환율 · 진행 중인 연도는 최신 시세·현재 환율로 계산 · 연도를 누르면 아래에 종목별 내역이 펼쳐집니다 · 상장 전 연도의 종목은 ‘-’로 표시하고 합계에서 제외</p>
      </div>
      <div class="card" data-divyearly data-fold="dividends">${divYearlyShell()}</div>
      <div class="card" data-divlist data-fold="divlist">${divListShell()}</div>`;
    // 종목별 내역 (연도 행을 누르면 표 아래에 전체 폭으로 표시)
    const detailHtml = (y) => `<div class="inner" style="margin-top:12px">
      <h3 style="margin:0 0 8px">${y.year}년 종목별 내역${y.ongoing ? ' <span class="badge ongoing">진행 중</span>' : ''}</h3>
      <div class="table-wrap"><table><thead><tr><th>종목</th><th>구분</th><th class="num">연말 보유 수량</th><th class="num">${y.ongoing ? '현재가' : '연말 종가'}</th><th>종가 기준일</th><th class="num">적용 환율</th><th class="num">원화 금액</th></tr></thead>
      <tbody>${y.items.map((i) => `<tr>
        <td class="left"><div class="name-cell">${ud(i.name)}<small>${esc(i.code)}${i.tradedThisYear ? ' · 이 해 매매 있음' : ' · 이전 연도 수량 이어 씀'}</small></div></td><td>${badge(i.type)}</td>
        <td class="num">${qty(i.quantity)}</td>
        <td class="num">${i.close == null ? '-' : money(i.close, i.currency)}</td>
        <td class="small muted">${i.closeDate ? (y.ongoing ? fmtTime(i.closeDate) : esc(i.closeDate)) : '-'}</td>
        <td class="num">${i.excluded ? '-' : i.currency === 'USD' ? rate(i.fxRate) : '1'}</td>
        <td class="num">${i.excluded ? `- <span class="small up">(${esc(i.reason)} · 합계 제외)</span>` : krw(i.valueKrw)}</td>
      </tr>`).join('')}</tbody></table></div></div>`;
    if (!hasHoldings) return;
    makeFoldable(main, 'yearly.collapsed');
    main.classList.add('yr-page'); // 표 데이터 정렬: 종목·메모 왼쪽, 지급일 가운데, 나머지 오른쪽
    main.querySelectorAll('tr[data-y]').forEach((tr) => tr.addEventListener('click', () => {
      const box = main.querySelector('[data-ydetail]');
      const open = box.dataset.year === tr.dataset.y;
      main.querySelectorAll('tr[data-y]').forEach((r) => r.classList.remove('on'));
      if (open) { box.innerHTML = ''; box.dataset.year = ''; return; }
      box.innerHTML = detailHtml(years.find((y) => String(y.year) === tr.dataset.y));
      box.dataset.year = tr.dataset.y;
      tr.classList.add('on');
    }));
    destroyCharts();
    const labels = years.map((y) => (y.ongoing ? `${y.year} (${tt('진행 중')})` : String(y.year)));
    const baseOpts = {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => krw(ctx.parsed.y) } } },
      scales: { y: { beginAtZero: true, suggestedMax: 1, ticks: { precision: 0, callback: (v) => (isEn() ? new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(v) : v >= 1e8 ? `${(v / 1e8).toFixed(1)}억` : v >= 1e4 ? `${nf0.format(v / 1e4)}만` : nf0.format(v)) } }, x: { grid: { display: false } } },
    };
    // 연도별 자산금액: 한 막대에 국내·해외·해외추종을 층으로 쌓는다 (v0.13.11)
    // 색감은 아래 연도별 배당 증감 그래프(남색·호박색·주황갈색)와 맞춘다 (v0.15.1)
    const pal = chartPalette(); // 테마 색에 맞춘 그래프 색 (v0.18)
    const CAT_COLORS = { DOMESTIC: pal.c1, OVERSEAS: pal.c2, OVERSEAS_TRACK: pal.c3 };
    const CAT_LABELS = { DOMESTIC: tt('국내'), OVERSEAS: tt('해외'), OVERSEAS_TRACK: tt('해외추종') };
    state.charts.push(new Chart(main.querySelector('[data-c1]'), {
      type: 'bar',
      data: {
        labels,
        datasets: [
          // 환율 꺾은선 (v0.14.1): 지난 연도는 연말 환율, 올해는 현재 환율. 막대 위쪽에 그린다
          {
            type: 'line', label: tt('환율(USD/KRW)'), data: years.map((y) => y.fxRate), yAxisID: 'yFx', order: 0,
            borderColor: pal.line, backgroundColor: pal.line, borderWidth: 2, pointRadius: 4, tension: 0.25,
          },
          ...Object.keys(CAT_LABELS).map((id) => ({
            label: CAT_LABELS[id], data: years.map((y) => (y.byCategory ? y.byCategory[id] || 0 : 0)), backgroundColor: CAT_COLORS[id], borderRadius: 4, stack: 'asset', order: 1,
          })),
        ],
      },
      options: {
        ...baseOpts,
        layout: { padding: { top: 18 } },
        plugins: {
          legend: { display: true, position: 'bottom', labels: { boxWidth: 12 } },
          tooltip: { callbacks: {
            label: (ctx) => (ctx.dataset.yAxisID === 'yFx' ? `${tt('환율')} ${rate(ctx.parsed.y)}${years[ctx.dataIndex].ongoing ? ` (${tt('현재')})` : ` (${tt('연말')})`}` : `${ctx.dataset.label} ${krw(ctx.parsed.y)}`),
            footer: (items) => `${tt('총자산')} ${krw(years[items[0].dataIndex].valueKrw)}`,
          } },
        },
        scales: {
          ...baseOpts.scales,
          x: { ...baseOpts.scales.x, stacked: true },
          // 막대 위에 환율 선이 놓이도록 막대 축에 여유를 두고, 환율 축은 위쪽 25% 구간만 쓰게 범위를 잡는다
          y: { ...baseOpts.scales.y, stacked: true, suggestedMax: Math.max(...years.map((y) => y.valueKrw || 0)) * 1.35 },
          yFx: (() => {
            const fx = years.map((y) => y.fxRate).filter((v) => v != null);
            const lo = fx.length ? Math.min(...fx) : 0;
            const hi = fx.length ? Math.max(...fx) : 1;
            const span = Math.max(hi - lo, 20);
            return { display: false, min: lo - span * 3.2, max: hi + span * 0.25 };
          })(),
        },
      },
      plugins: [{
        id: 'fxLabels',
        afterDatasetsDraw(chart) {
          const meta = chart.getDatasetMeta(0);
          if (!meta || meta.hidden) return;
          const { ctx } = chart;
          ctx.save();
          ctx.font = '600 11px sans-serif';
          ctx.fillStyle = pal.line;
          ctx.textAlign = 'center';
          meta.data.forEach((pt, i) => {
            const v = years[i].fxRate;
            if (v != null) ctx.fillText(nf0.format(Math.round(v)), pt.x, pt.y - 8);
          });
          ctx.restore();
        },
      }],
    }));
    // 연도별 배당 합계 (v0.13.8): 조회 기간의 모든 연도
    const loadDivYearly = () => api('GET', `/dividends/yearly?from=${from}&to=${to}`).then(({ years: dy }) => {
      const card = main.querySelector('[data-divyearly]');
      if (card) renderDivYearly(card, dy, { all: true });
    }).catch((err) => {
      const card = main.querySelector('[data-divyearly] [data-yearly]');
      if (card) card.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    });
    loadDivYearly();
    // 배당 내역 조회 (v0.14): 배당 내역 관리에서 저장한 회차
    mountDivList(main.querySelector('[data-divlist]'));
  }

  // ---------------------------------------------------------------------------
  // SC-06 배당금 관리
  // ---------------------------------------------------------------------------
  // 연도별 배당 합계 카드 (연도별 자산 (요약) 화면)
  //  배당·과세표준액 = 배당금 관리에 저장한 회차, 수령액 = 실제 수령 기록
  function divYearlyShell() {
    return `<h2>연도별 배당 증감 ${req('FR-DIV-03 · FR-CHT-03')}</h2>
        <div class="grid c2"><div class="chart-box" style="height:260px"><canvas></canvas></div><div data-yearly class="table-wrap"></div></div>`;
  }
  // 세금(배당소득세 추정) = 과세표준액 × 16.5% (소득세 15.4% 아님: 요청 기준 16.5%)
  const DIV_TAX_RATE = 0.165;
  function renderDivYearly(card, years, { all = false } = {}) {
    const shown = all ? years : years.filter((y, i) => y.count || y.divCount || i >= years.length - 5);
    const dash = '<span class="muted">-</span>';
    card.querySelector('[data-yearly]').innerHTML = `<table><thead><tr><th>연도</th><th class="num">배당</th><th class="num">수령회차</th><th class="num">과세표준액</th><th class="num">세금</th></tr></thead><tbody>${shown.slice().reverse().map((y) => {
      const taxCell = y.taxMissing ? `<span class="tip" data-tip="과세표준이 없는 회차 ${y.taxMissing}개 제외" tabindex="0">${krw(y.taxKrw)}*</span>` : krw(y.taxKrw);
      return `<tr><td><b>${y.year}</b>${y.year === THIS_YEAR ? '<br/><span class="badge ongoing">진행 중</span>' : ''}</td>
        <td class="num">${y.divCount ? `<b>${krw(y.divKrw)}</b>` : dash}</td>
        <td class="num">${y.divCount ? `${y.divCount}회` : dash}</td>
        <td class="num">${y.divCount ? taxCell : dash}</td>
        <td class="num">${y.divCount ? krw(y.taxKrw * DIV_TAX_RATE) : dash}</td></tr>`;
    }).join('')}</tbody></table>
        <p class="small muted" style="margin:6px 0 0">배당·수령회차·과세표준액 = 배당 내역 관리에 저장한 회차 합계(배당락일 연도, 미국 종목은 지급일 환율로 원화 환산) · 세금 = 과세표준액 × 16.5%(배당소득세 추정, 계좌 유형에 따라 다를 수 있음)</p>`;
    if (card._chart) { card._chart.destroy(); state.charts = state.charts.filter((c) => c !== card._chart); }
    const pal = chartPalette();
    card._chart = new Chart(card.querySelector('canvas'), {
      type: 'bar',
      data: {
        labels: shown.map((y) => (y.year === THIS_YEAR ? `${y.year} (${tt('진행 중')})` : String(y.year))),
        datasets: [
          { label: tt('배당'), data: shown.map((y) => y.divKrw), backgroundColor: pal.c1, borderRadius: 4 },
          { label: tt('과세표준액'), data: shown.map((y) => y.taxKrw), backgroundColor: pal.c2, borderRadius: 4 },
          { label: tt('세금'), data: shown.map((y) => y.taxKrw * DIV_TAX_RATE), backgroundColor: pal.c3, borderRadius: 4 },
        ],
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: true, position: 'bottom', labels: { boxWidth: 12 } }, tooltip: { callbacks: { label: (c) => `${c.dataset.label} ${krw(c.parsed.y)}` } } }, scales: { y: { beginAtZero: true, ticks: { callback: (v) => nf0.format(v) } }, x: { grid: { display: false } } } },
    });
    state.charts.push(card._chart);
  }

  // 배당 내역 조회 카드 (v0.14): 배당 내역 관리에서 저장한 회차를 지급일 기간으로 조회. 기본 올해 1월 1일 ~ 오늘
  const DIV_WITHHOLD_RATE = 0.154; // 과세 = 과세표준 × 15.4%
  function divListShell() {
    return `<h2>배당 내역 조회 ${req('FR-DIV-02')}</h2>
      <form class="field-row" data-filter style="margin-bottom:12px">
        <div class="field"><label>시작일</label><input type="date" name="from" value="${THIS_YEAR}-01-01" /></div>
        <div class="field"><label>종료일</label><input type="date" name="to" value="${today()}" /></div>
        <div class="field" style="width:110px"><label>종목코드</label><input name="code" list="hcodes" /></div>
        <button type="submit" class="secondary">조회</button>
        <div class="divhist-sum" data-sum></div>
      </form>
      <datalist id="hcodes"></datalist>
      <div data-list></div>`;
  }
  function mountDivList(card) {
    api('GET', '/holdings').then(({ holdings }) => {
      const dl = card.querySelector('#hcodes');
      if (dl) dl.innerHTML = holdings.map((h) => `<option value="${esc(h.code)}">${esc(h.name || '')}</option>`).join('');
    }).catch(() => {});
    const filter = card.querySelector('[data-filter]');
    const dash = '<span class="muted">-</span>';
    async function load() {
      const f = formData(filter);
      if (f.from && f.to && f.from > f.to) return toast('시작일이 종료일보다 늦습니다.');
      const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
      const { rows } = await api('GET', `/divmgmt/history?${qs}`);
      const list = card.querySelector('[data-list]');
      const sumBox = card.querySelector('[data-sum]');
      const tot = (f2) => rows.reduce((a, r) => a + (r[f2] || 0), 0);
      const miss = rows.some((r) => r.tax_krw == null) ? '*' : '';
      // 조회 버튼 옆 소계 요약 (v0.15.1): 표의 합계(원화)와 같은 값
      if (sumBox) sumBox.innerHTML = `<span class="muted">(합계)</span> <span>월배당 <b>${krw(tot('amount_krw'))}</b></span> · <span>과세표준 <b>${krw(tot('tax_krw'))}${miss}</b></span> · <span>과세 <b>${krw(tot('tax_krw') * DIV_WITHHOLD_RATE)}${miss}</b></span>`;
      if (!rows.length) {
        list.innerHTML = '<div class="empty">조건에 맞는 배당 내역이 없습니다. 배당 내역 관리에서 회차를 저장하면 여기에 나옵니다.</div>';
        return;
      }
      const krwTip = (r, v) => (r.currency === 'USD' && v != null ? `<br/><small class="muted">${krw(v * r.fx_rate)}</small>` : '');
      const sum = (f2) => rows.reduce((a, r) => a + (r[f2] || 0), 0);
      const taxMissing = rows.some((r) => r.tax_krw == null);
      list.innerHTML = `<div class="table-wrap scroll-y"><table class="divhist-table"><thead><tr><th>지급일</th><th>종목</th><th>수량</th><th>주당배당</th><th>월 배당</th><th>과세표준</th><th>과세</th></tr></thead><tbody>
        ${rows.map((r) => `<tr>
          <td class="center">${esc(r.paid)}${r.pay_date ? '' : '<br/><small class="muted">배당락일</small>'}</td>
          <td class="left"><div class="name-cell"><span>${ud(r.name)} ${badge(r.type)}</span><small>${esc(r.code)} · ${ud(r.group_name)}</small></div></td>
          <td>${qty(r.quantity)}</td>
          <td>${money(r.per_share, r.currency)}</td>
          <td><b>${money(r.amount, r.currency)}</b>${krwTip(r, r.amount)}</td>
          <td>${r.tax_amount == null ? dash : money(r.tax_amount, r.currency) + krwTip(r, r.tax_amount)}</td>
          <td>${r.tax_amount == null ? dash : money(r.tax_amount * DIV_WITHHOLD_RATE, r.currency) + krwTip(r, r.tax_amount * DIV_WITHHOLD_RATE)}</td>
        </tr>`).join('')}</tbody>
        <tfoot><tr><td colspan="4">합계 (원화)</td><td>${krw(sum('amount_krw'))}</td><td>${krw(sum('tax_krw'))}${taxMissing ? '*' : ''}</td><td>${krw(sum('tax_krw') * DIV_WITHHOLD_RATE)}${taxMissing ? '*' : ''}</td></tr></tfoot></table></div>
        <div class="small muted" style="margin-top:6px">${rows.length}건 · 배당 내역 관리에서 저장한 회차 기준 · 월 배당 = 수량 × 주당배당 · 과세 = 과세표준 × 15.4% · 미국 종목은 지급일 환율로 원화 환산(작은 글씨)${taxMissing ? ' · * 과세표준이 없는 회차 제외' : ''} · 지급일이 없는 회차는 배당락일 기준</div>`;
    }
    filter.addEventListener('submit', (e) => { e.preventDefault(); load(); });
    return load();
  }

  // ---------------------------------------------------------------------------
  // SC-07 내 정보
  // ---------------------------------------------------------------------------
  // ---------------------------------------------------------------------------
  // 데이터 백업·복원 (v0.15)
  //  - 웹: 파일 내려받기 / 파일 선택
  //  - 앱: 안드로이드 파일 선택 창(저장 위치 선택·파일 열기). 앱 삭제 후에도 남는 위치에 저장된다
  // ---------------------------------------------------------------------------
  const docWaiters = {};
  window.__docDone = (id, ok, payload) => { const w = docWaiters[id]; if (w) { delete docWaiters[id]; w(ok, payload); } };
  const nativeDoc = (fn, ...args) => new Promise((resolve, reject) => {
    const id = `d${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    docWaiters[id] = (ok, payload) => (ok ? resolve(payload) : reject(new Error(payload || '취소했습니다.')));
    window.AndroidBridge[fn](...args, id);
  });
  const utf8ToB64 = (text) => {
    const bytes = new TextEncoder().encode(text);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  };
  const b64ToUtf8 = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));

  async function backupData() {
    try {
      const data = await api('GET', '/backup');
      const text = JSON.stringify(data, null, 2);
      const name = `stock-manager-backup-${today()}.json`; // 영문 파일 이름(일부 브라우저는 한글 이름을 무시)
      const c = data.counts || {};
      const summary = `주식 항목 ${c.items || 0}건 · 그룹 ${c.groups || 0}개 · 배당 회차 ${c.holdingDividends || 0}건`;
      if (window.AndroidBridge && window.AndroidBridge.createDocument) {
        const msg = await nativeDoc('createDocument', name, 'application/json', utf8ToB64(text));
        toast(`${msg} (${summary})`);
      } else {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
        a.download = name;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { a.remove(); URL.revokeObjectURL(a.href); }, 3000);
        toast(`${name} 파일을 내려받았습니다. (${summary})`);
      }
    } catch (err) {
      toast(err.message);
    }
  }

  async function readBackupFile() {
    if (window.AndroidBridge && window.AndroidBridge.openDocument) return b64ToUtf8(await nativeDoc('openDocument'));
    return new Promise((resolve, reject) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,application/json';
      input.addEventListener('change', () => {
        const f = input.files && input.files[0];
        if (!f) return reject(new Error('취소했습니다.'));
        f.text().then(resolve, reject);
      });
      input.click();
    });
  }

  async function restoreData() {
    let backup;
    try {
      backup = JSON.parse(await readBackupFile());
    } catch (err) {
      toast(err instanceof SyntaxError ? '백업 파일을 읽을 수 없습니다(JSON 형식 아님).' : err.message);
      return;
    }
    if (!backup || backup.format !== 'stock-manager-backup') { toast('K-Stock 백업 파일이 아닙니다.'); return; }
    const c = backup.counts || {};
    const body = openModal('백업 파일로 복원');
    body.innerHTML = `<p style="margin:0 0 10px">아래 백업 파일로 복원합니다. 지금 계정(<b>${esc(state.user.email)}</b>)의 데이터는 <b>모두 지워지고</b> 백업 내용으로 바뀝니다.</p>
      <table><tbody>
        <tr><td class="left">백업 계정</td><td class="right">${esc(backup.account || '-')}</td></tr>
        <tr><td class="left">백업 일시</td><td class="right">${esc(fmtTime(backup.exportedAt))}</td></tr>
        <tr><td class="left">그룹</td><td class="right">${c.groups || 0}개</td></tr>
        <tr><td class="left">주식 항목(연도별)</td><td class="right">${c.items || 0}건</td></tr>
        <tr><td class="left">배당 내역 관리 회차</td><td class="right">${c.holdingDividends || 0}건</td></tr>
        <tr><td class="left">종목 분류 · 화면 설정</td><td class="right">${c.categories || 0}건 · ${c.settings || 0}건</td></tr>
      </tbody></table>
      ${backup.account && backup.account !== state.user.email ? '<div class="notice warn" style="margin-top:10px"><div>다른 계정에서 만든 백업입니다. 복원하면 지금 계정에 그 데이터가 들어갑니다.</div></div>' : ''}
      <div class="field-row" style="justify-content:flex-end;margin-top:14px"><button class="secondary" data-close>취소</button><button class="danger" data-go>복원</button></div>`;
    body.querySelector('[data-close]').addEventListener('click', closeModal);
    body.querySelector('[data-go]').addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        const r = await api('POST', '/restore', { backup });
        closeModal();
        await loadSettings();
        toast(`복원했습니다. 주식 항목 ${r.counts.items}건 · 배당 회차 ${r.counts.holdingDividends}건`);
        go('#/assets');
      } catch (err) {
        e.target.disabled = false;
        toast(err.message);
      }
    });
  }

  // 화면 테마 카드 (v0.17)
  function mountThemeCard(card) {
    const sw = card.querySelector('[data-swatches]');
    const color = card.querySelector('[data-color]');
    const hexIn = card.querySelector('[data-hex]');
    const current = () => ((state.settings || {})['ui.theme'] || THEME_DEFAULT).toLowerCase();
    function paint() {
      const cur = current();
      sw.innerHTML = THEME_PRESETS.map(([hex, name]) => `<button type="button" class="theme-sw ${hex === cur ? 'on' : ''}" data-hexv="${hex}"><i style="background:${hex}"></i>${esc(name)}</button>`).join('')
        + (THEME_PRESETS.some(([hex]) => hex === cur) ? '' : `<button type="button" class="theme-sw on" data-hexv="${cur}"><i style="background:${cur}"></i>직접 지정</button>`);
      color.value = cur;
      hexIn.value = cur;
      const pal = chartPalette();
      card.querySelector('[data-pv-chart]').innerHTML = [[14, 8, 3], [20, 10, 5], [26, 14, 6]].map((hs) => `<span class="pv-stack">${hs.map((hgt, i) => `<i style="height:${hgt}px;background:${[pal.c3, pal.c2, pal.c1][i]}"></i>`).join('')}</span>`).join('')
        + `<span class="small muted">그래프 색</span><i class="pv-line" style="background:${pal.line}"></i><span class="small muted">환율 선</span>`;
    }
    async function pick(hex) {
      if (!isHex(hex)) { toast('색상은 #RRGGBB 형식으로 입력하세요.'); return; }
      try {
        await saveTheme(hex);
        paint();
        toast('테마를 적용했습니다.');
      } catch (err) { toast(err.message); }
    }
    sw.addEventListener('click', (e) => { const b = e.target.closest('[data-hexv]'); if (b) pick(b.dataset.hexv); });
    color.addEventListener('input', () => { hexIn.value = color.value; applyTheme(color.value); }); // 고르는 동안 미리 적용
    color.addEventListener('change', () => pick(color.value));
    card.querySelector('[data-apply]').addEventListener('click', () => pick(hexIn.value.trim().startsWith('#') ? hexIn.value.trim() : `#${hexIn.value.trim()}`));
    card.querySelector('[data-reset]').addEventListener('click', () => pick(THEME_DEFAULT));
    paint();
  }

  // 화면 공유·권한 관리 카드 (v0.16)
  function permSelect(sc, val, attrs = '') {
    return `<select class="perm-sel ${val || 'none'}" data-sc="${sc.id}" ${attrs}>
      <option value="" ${!val ? 'selected' : ''}>없음</option>
      <option value="view" ${val === 'view' ? 'selected' : ''}>조회</option>
      ${sc.edit ? `<option value="edit" ${val === 'edit' ? 'selected' : ''}>편집</option>` : ''}
    </select>`;
  }
  function mountShareCard(card) {
    const body = card.querySelector('[data-share-body]');
    const permsOf = (scope) => Object.fromEntries([...scope.querySelectorAll('[data-sc]')].map((x) => [x.dataset.sc, x.value]).filter(([, v]) => v));
    async function load() {
      const r = await loadReceived();
      if (!r) { body.innerHTML = '<div class="notice error">공유 정보를 불러오지 못했습니다.</div>'; return; }
      const { screens, given, received } = r;
      const head = screens.map((sc) => `<th class="center">${esc(sc.label)}</th>`).join('');
      body.innerHTML = `
        <form class="field-row share-add" data-add novalidate>
          <div class="field" style="min-width:220px;flex:1"><label>공유할 회원 이메일</label><input name="email" type="email" placeholder="friend@example.com" autocomplete="off" /><span class="err" data-err="email"></span></div>
          ${screens.map((sc) => `<div class="field"><label>${esc(sc.label)}</label>${permSelect(sc, sc.id === 'assets' || sc.id === 'yearly' ? 'view' : '')}</div>`).join('')}
          <button type="submit">공유 추가</button>
        </form>
        <h3 style="margin:16px 0 8px">내가 공유한 회원 <span class="muted small">${given.length}명</span></h3>
        ${given.length ? `<div class="table-wrap"><table class="share-table"><thead><tr><th>회원</th>${head}<th class="center">해제</th></tr></thead><tbody>
          ${given.map((g) => `<tr data-id="${g.id}">
            <td class="left"><b>${esc(g.email)}</b><br/><small class="muted">변경 ${fmtTime(g.updated_at)}</small></td>
            ${screens.map((sc) => `<td class="center">${permSelect(sc, g.perms[sc.id])}</td>`).join('')}
            <td class="center"><button class="icon-btn danger" data-unshare title="공유 해제" aria-label="공유 해제">${ICON_DEL}</button></td>
          </tr>`).join('')}</tbody></table></div>` : '<div class="empty">아직 공유한 회원이 없습니다.</div>'}
        <h3 style="margin:16px 0 8px">나에게 공유된 화면 <span class="muted small">${received.length}명</span></h3>
        ${received.length ? `<div class="table-wrap"><table class="share-table"><thead><tr><th>공유한 회원</th><th>화면 · 권한</th><th class="center">작업</th></tr></thead><tbody>
          ${received.map((g) => `<tr data-id="${g.id}" data-uid="${g.user_id}">
            <td class="left"><b>${esc(g.email)}</b></td>
            <td class="left">${screens.filter((sc) => g.perms[sc.id]).map((sc) => `<span class="perm-chip ${g.perms[sc.id]}">${esc(sc.label)} · ${PERM_LABEL[g.perms[sc.id]]}</span>`).join(' ')}</td>
            <td class="center"><div class="field-row" style="justify-content:center;flex-wrap:nowrap"><button class="sm" data-open>열기</button><button class="sm secondary" data-leave>받지 않기</button></div></td>
          </tr>`).join('')}</tbody></table></div>` : '<div class="empty">공유받은 화면이 없습니다.</div>'}
        <p class="small muted" style="margin:10px 0 0">조회: 화면을 보기만 하고 엑셀 내보내기는 할 수 있음 · 편집: 보유 종목 관리(항목 등록·수정·삭제, 일괄이월, 그룹 관리)·배당 내역 관리(회차 저장)까지 가능 · 연도별 자산 (요약)·나의 자산·종목 정보 조회는 조회만 공유됩니다(종목 정보 조회의 ‘내 보유 종목’ 목록은 공유한 회원 기준) · 환경설정(백업·비밀번호·테마)은 공유되지 않습니다 · 권한을 모두 ‘없음’으로 바꾸면 공유가 해제됩니다${window.AndroidBridge ? ' · 안드로이드 앱은 데이터가 휴대폰 안에 있으므로 같은 휴대폰의 다른 계정끼리만 공유됩니다(여러 사람이 함께 쓰려면 PC 웹 버전 서버를 사용하세요)' : ''}</p>`;
      const add = body.querySelector('[data-add]');
      add.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          await api('POST', '/shares', { email: add.email.value, perms: permsOf(add) });
          toast('공유했습니다.');
          load();
        } catch (err) {
          showFieldErrors(add, err.fields || {});
          if (!err.fields || !err.fields.email) toast(err.message);
        }
      });
      body.querySelectorAll('.share-table tr[data-id] select[data-sc]').forEach((sel) => sel.addEventListener('change', async () => {
        const tr = sel.closest('tr');
        sel.className = `perm-sel ${sel.value || 'none'}`;
        try {
          const res = await api('PUT', `/shares/${tr.dataset.id}`, { perms: permsOf(tr) });
          toast(res.removed ? '모든 권한을 없애 공유를 해제했습니다.' : '권한을 바꿨습니다.');
          if (res.removed) load();
        } catch (err) { toast(err.message); load(); }
      }));
      body.querySelectorAll('[data-unshare], [data-leave]').forEach((b) => b.addEventListener('click', async () => {
        const tr = b.closest('tr');
        const who = tr.querySelector('b').textContent;
        if (!confirm(b.dataset.leave !== undefined ? `${who}님이 공유한 화면을 더 이상 받지 않을까요?` : `${who}님에게 준 공유를 해제할까요?`)) return;
        try {
          await api('DELETE', `/shares/${tr.dataset.id}`);
          toast('공유를 해제했습니다.');
          if (b.dataset.leave !== undefined) {
            if (state.actAs && state.actAs.id === Number(tr.dataset.id)) setActAs(null);
            await loadReceived();
            render(); // 메뉴 위 ‘보는 자산’ 목록도 다시 그린다
          } else load();
        } catch (err) { toast(err.message); }
      }));
      body.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => {
        const uid = Number(b.closest('tr').dataset.uid);
        setActAs(state.received.find((r) => r.user_id === uid));
        go(Object.keys(SHARE_PATH).find((h) => state.actAs.perms[SHARE_PATH[h]]));
      }));
    }
    load();
  }

  function viewMe() {
    const main = shell('#/me', `
      <div class="page-head"><div><h1>환경설정 ${req('SC-07 · FR-AUTH-03 · FR-AUTH-04 · FR-SHR')}</h1><p>${esc(state.user.email)} · 가입일 ${fmtTime(state.user.created_at)}</p></div></div>
      <div class="card" data-fold="lang">
        <h2><span data-noi18n>언어 (Language)</span> ${req('FR-COM-07')}</h2>
        <div class="field-row" style="align-items:center;gap:12px">${langSelectHtml()}<span class="small muted">화면에 보이는 글자를 고른 언어로 표시합니다. 엑셀 파일과 종목명은 원래 언어 그대로입니다.</span></div>
      </div>
      ${IN_APP ? `<div class="card" data-fold="cloud">
        <h2>클라우드 서버 연결 ${req('FR-CLD-01')}</h2>
        ${REMOTE_APP ? `<p style="margin:0 0 10px">지금 <b>클라우드 서버(${esc(hostOf(appServerUrl() || location.origin))})</b>에 연결되어 있습니다. 다른 기기(PC 브라우저·다른 휴대폰)에서도 같은 주소로 접속하면 같은 데이터를 보고, 화면 공유도 기기에 상관없이 됩니다.</p>
          <div class="field-row"><button class="secondary" data-clocal>이 휴대폰 모드로 전환</button></div>
          <p class="small muted" style="margin:10px 0 0">이 휴대폰 모드로 바꾸면 휴대폰 안에 저장된 데이터를 씁니다. 서버의 데이터는 그대로 남습니다.</p>`
        : `<p style="margin:0 0 10px">지금은 <b>이 휴대폰 모드</b>입니다(데이터가 휴대폰 안에만 있어 같은 휴대폰의 계정끼리만 공유 가능). 다른 기기와 공유하려면 직접 만든 K-Stock 클라우드 서버(Oracle Cloud 등)에 연결하세요.</p>
          <div class="field-row"><button data-cloud>클라우드 서버에 연결</button></div>
          <p class="small muted" style="margin:10px 0 0">데이터 옮기기: 연결 전에 아래 <b>백업 파일 저장</b> → 연결 후 서버에서 사용자 추가·로그인 → <b>백업 파일로 복원</b>. 서버 만드는 방법은 README의 ‘클라우드 서버(Oracle Cloud)’ 안내를 보세요.</p>`}
      </div>` : ''}
      <div class="card" data-fold="backup">
        <h2>데이터 백업 · 복원 ${req('FR-BAK-01 · 02')}</h2>
        <p style="margin:0 0 10px">보유 종목(그룹·연도별 항목·이월 금액), 종목 분류, 배당 내역 관리 회차, 화면 설정 등 <b>내 데이터 전부</b>를 파일 하나로 저장합니다. 앱을 지웠다가 다시 설치해도 이 파일로 복원하면 그대로 이어서 쓸 수 있습니다.</p>
        <div class="field-row" style="gap:10px;flex-wrap:wrap">
          <button data-backup>백업 파일 저장</button>
          <button class="secondary" data-restore>백업 파일로 복원</button>
        </div>
        <p class="small muted" style="margin:10px 0 0">${window.AndroidBridge ? '저장 위치를 고르는 창이 열립니다. 앱을 지워도 남도록 <b>다운로드</b> 폴더나 구글 드라이브 등에 저장하세요.' : '백업 파일(.json)이 내려받기 폴더에 저장됩니다.'} 복원하면 지금 계정의 데이터가 백업 파일 내용으로 <b>모두 바뀝니다</b>. 시세·환율은 복원 후 다시 받아옵니다.</p>
      </div>
      <div class="card" data-theme-card data-fold="theme">
        <h2>화면 테마 ${req('FR-UI-01')}</h2>
        <p style="margin:0 0 6px">기준 색을 고르면 왼쪽 메뉴·버튼·탭·합계 행·배경 등 <b>전체 화면 색</b>이 그 색에 맞춰 바뀝니다. 계정에 저장되어 PC·앱 어디서나 같은 테마로 보입니다.</p>
        <div class="theme-swatches" data-swatches></div>
        <div class="theme-custom">
          <label class="small muted" for="themeColor">직접 지정</label>
          <input type="color" id="themeColor" data-color />
          <input data-hex maxlength="7" style="width:100px" placeholder="#eb6c07" />
          <button class="sm" data-apply>적용</button>
          <button class="sm secondary" data-reset>기본값(주황)으로</button>
        </div>
        <div class="theme-preview" aria-hidden="true">
          <div class="pv-side"><b>미리보기</b><span class="on">나의 자산</span><span>보유 종목 관리</span></div>
          <div class="pv-main">
            <div class="pv-row"><button class="sm" tabindex="-1">기본 버튼</button><button class="sm secondary" tabindex="-1">보조 버튼</button><a href="#/me" tabindex="-1">링크</a></div>
            <div class="pv-row"><span class="pv-tot">소계 31,427,427원</span><span class="up">+5.2%</span><span class="down">-1.8%</span></div>
            <div class="pv-row pv-chart" data-pv-chart></div>
          </div>
        </div>
        <p class="small muted" style="margin:10px 0 0">연도별 자산·배당 그래프도 테마 색 한 계열로 바뀝니다(조금 진하게·기본·조금 연하게, 환율 선은 아주 진하게). 상승 빨강·하락 파랑(종목 시세 그래프 포함)과 분류 배지 색은 의미가 있는 색이라 그대로 둡니다. 밝은 색을 고르면 흰 글자가 읽히도록 자동으로 조금 진하게 맞춥니다.</p>
      </div>
      <div class="card" data-share-card data-fold="share">
        <h2>화면 공유 · 권한 관리 ${req('FR-SHR-01 · 02 · 03')}</h2>
        <p style="margin:0 0 10px">다른 회원에게 내 화면 중 <b>일부만</b> 골라 보여줄 수 있습니다. 화면마다 <b>조회</b>(보기만) 또는 <b>편집</b>(보유 종목·배당 회차 수정까지) 권한을 줍니다. 공유받은 사람은 메뉴 위의 <b>보는 자산</b>에서 내 이름을 골라 허용된 화면만 열 수 있습니다.</p>
        <div data-share-body><div class="empty">불러오는 중…</div></div>
      </div>
      <div class="grid c2">
        <div class="card" data-fold="password">
          <h2>비밀번호 변경</h2>
          <form data-pw novalidate style="display:flex;flex-direction:column;gap:12px;max-width:360px">
            <div class="field"><label>현재 비밀번호</label><input type="password" name="current" autocomplete="current-password" /><span class="err" data-err="current"></span></div>
            <div class="field"><label>새 비밀번호</label><input type="password" name="next" autocomplete="new-password" /><span class="hint">8자 이상, 영문과 숫자 포함</span><span class="err" data-err="next"></span></div>
            <div><button type="submit">변경</button></div>
          </form>
        </div>
        <div class="card" data-fold="withdraw">
          <h2>사용자 삭제</h2>
          <div class="notice warn"><div>사용자를 삭제하면 계정, 보유 종목, 배당 내역이 모두 삭제되며 복구할 수 없습니다. ${req('NFR-PRI-01')}</div></div>
          <form data-del novalidate style="display:flex;flex-direction:column;gap:12px;max-width:360px">
            <div class="field"><label>비밀번호 확인</label><input type="password" name="password" autocomplete="current-password" /><span class="err" data-err="password"></span></div>
            <div><button type="submit" class="danger">사용자 삭제</button></div>
          </form>
        </div>
      </div>`);
    makeFoldable(main, 'me.collapsed');
    bindCloudBox(main);
    bindLang(main);
    mountThemeCard(main.querySelector('[data-theme-card]'));
    mountShareCard(main.querySelector('[data-share-card]'));
    main.querySelector('[data-backup]').addEventListener('click', backupData);
    main.querySelector('[data-restore]').addEventListener('click', restoreData);
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
      if (!confirm('정말 이 사용자를 삭제하시겠습니까? 모든 데이터가 삭제됩니다.')) return;
      try {
        await api('DELETE', '/auth/account', formData(del));
        state.user = null;
        resetShareState();
        toast('사용자를 삭제했습니다.');
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
    if (REMOTE_APP && window.AndroidBridge.saveFile) {
      // 클라우드 서버 화면(앱): 파일을 받아 휴대폰 다운로드 폴더에 저장
      try {
        toast('엑셀 파일을 만드는 중…');
        const res = await fetch(`/api${withAs(path)}`, { credentials: 'same-origin' });
        if (!res.ok) throw new Error(((await res.json().catch(() => ({}))).error) || '내보내기에 실패했습니다.');
        const cd = res.headers.get('content-disposition') || '';
        const m = /filename\*=UTF-8''([^;]+)/.exec(cd) || /filename="?([^";]+)"?/.exec(cd);
        const name = m ? decodeURIComponent(m[1]) : 'k-stock.xlsx';
        const bytes = new Uint8Array(await res.arrayBuffer());
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        toast(window.AndroidBridge.saveFile(name, btoa(bin), res.headers.get('content-type') || 'application/octet-stream'));
      } catch (e) {
        toast(e.message);
      }
      return;
    }
    if (!window.MobileApp) {
      location.href = `/api${withAs(path)}`;
      return;
    }
    try {
      toast('엑셀 파일을 만드는 중…');
      const r = await window.MobileApp.request('GET', withAs(path));
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

  // 종목 조회 팝업 (나의 자산에서 종목을 누를 때)
  function openStockModal(code) {
    const body = openModal(`종목 정보 조회 ${req('SC-03')}`, { wide: true, loadingText: `${code} 조회 중…` });
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
    parts.push(`<div class="modal-title"><b>${ud(i.name)}</b> ${badge(i.type)} <span class="muted small">${esc(i.code)}</span></div>`);
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
    parts.push(`<p class="small muted" style="margin:12px 0 0">출처 ${esc(d.source || '-')} · 저장 ${fmtTime(d.loadedAt)} (1일 동안 재사용) · 실지급일은 운용사·FunETF가 제공하는 국내 ETF 회차만 표시합니다. 실제 배당은 배당 내역 관리 화면에서 회차를 선택해 저장하세요.</p>`);
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
        <div><h1>배당 내역 관리 ${req('SC-08')}</h1><p>그룹별 보유 종목의 배당 회차를 골라 저장하면 그 해 누적 배당액과 누적 과세표준액에 반영됩니다. 오른쪽 <b>연필 아이콘(입력)</b>을 누르면 종목의 배당 내역을 자동으로 불러옵니다.</p></div>
        <div class="field-row" style="align-items:flex-end">
          <div class="field"><label>연도</label><select data-year>${yearOptions(year, THIS_YEAR - 9)}</select></div>
          <div class="field"><label>기간</label><div class="field-row" style="align-items:center;gap:6px"><select data-from>${monthOpts(fromM)}</select><span>~</span><select data-to>${monthOpts(toM)}</select></div></div>
        </div>
      </div>
      <div class="card"><div class="group-bar"><div class="group-tabs" data-tabs><span class="small muted">그룹 불러오는 중…</span></div><a href="#/holdings" class="small">그룹 관리 →</a></div></div>
      <div class="card"><div class="divm-head"><h2 data-title>${year}년 ${fromM}~${toM}월 배당금</h2><div class="divhist-sum" data-dsum hidden></div></div><div data-list><div class="empty">불러오는 중…</div></div></div>`);
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
        .concat(d.groups.map((g) => `<button class="${d.groupId === g.id ? 'on' : ''}" data-g="${g.id}">${ud(g.name)}</button>`)).join('');
      tabs.querySelectorAll('[data-g]').forEach((b) => b.addEventListener('click', () => {
        settings.set('divmgmt.group', b.dataset.g);
        go(`#/divmgmt?${qsOf({ group: b.dataset.g })}`);
      }));
      const gname = d.groupId ? (d.groups.find((g) => g.id === d.groupId) || {}).name : '전체 그룹';
      main.querySelector('[data-title]').innerHTML = `${year}년 ${d.fromMonth}월~${d.toMonth}월 <span>배당금</span> · ${ud(gname)} ${req('FR-DIV-06')}`;
      const box = main.querySelector('[data-list]');
      const sumBox = main.querySelector('[data-dsum]');
      sumBox.hidden = true;
      if (!d.items.length) {
        box.innerHTML = `<div class="empty">${year}년 ${ud(gname)}에 보유한 종목이 없습니다.<br/><a href="#/holdings?year=${year}">보유 종목 관리</a>에서 종목을 등록하세요.</div>`;
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
            head += sumRow(`${ud(prev[0].group_name)} 소계`, sumOf(prev));
          }
          lastGroup = it.group_id;
          head += `<tr class="group-row"><td colspan="${cols}">${ud(it.group_name)}</td></tr>`;
        }
        const c = it.currency;
        return `${head}<tr data-idx="${idx}">
          <td class="left"><div class="name-cell"><span>${ud(it.name || it.code)}</span><small>${esc(it.code)} ${badge(it.type)}</small></div></td>
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
      const lastSub = !d.groupId && lastGroup != null ? sumRow(`${ud(d.items.filter((x) => x.group_id === lastGroup)[0].group_name)} 소계`, sumOf(d.items.filter((x) => x.group_id === lastGroup))) : '';
      const hasUsd = d.items.some((x) => x.currency === 'USD');
      // 제목 옆 합계 요약 (v0.26.3): 표 아래 합계(원화)와 같은 값
      const tot = sumOf(d.items);
      sumBox.innerHTML = `<span class="muted">(합계)</span> <span>월 배당 <b>${sumCell(tot.last)}</b></span> · <span>월 과세표준 <b>${sumCell(tot.last_tax)}</b></span> · <span>누적 배당 <b>${sumCell(tot.ytd)}</b></span> · <span>누적 과세표준 <b>${sumCell(tot.ytd_tax)}</b></span>`;
      sumBox.hidden = false;
      box.innerHTML = `<div class="table-wrap"><table class="divm-table">
        <thead><tr><th>종목</th><th>보유수량</th><th>${d.ongoing ? '현재 단가' : '연말 종가'}</th><th>평가금액</th><th>월 배당액(최근)</th><th>월 과세표준액</th><th>누적 배당액<br/><small class="th-period">(${d.fromMonth}월~${d.toMonth}월)</small></th><th>누적 과세표준액<br/><small class="th-period">(${d.fromMonth}월~${d.toMonth}월)</small></th><th></th></tr></thead>
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
      const body = openModal(`월 배당금 입력 · ${ud(it.name || it.code)} (${esc(it.code)}) · ${ud(it.group_name)} ${req('FR-DIV-07')}`, { wide: true, loadingText: '배당 내역을 불러오는 중…' });
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

  const PRIVATE = { '/assets': viewAssets, '/stock': viewStock, '/holdings': viewHoldings, '/yearly': viewYearly, '/dividends': viewYearly, '/divmgmt': viewDivMgmt, '/me': viewMe };

  async function render() {
    destroyCharts();
    closeAllModals();
    const { path, query } = parseHash();
    if (PUBLIC[path]) {
      if (state.user && path !== '/reset') {
        if (query.cloudError) toast('클라우드 서버에 연결하지 못해 휴대폰 안의 데이터로 열었습니다. 환경설정에서 다시 연결할 수 있습니다.');
        return go('#/assets');
      }
      return PUBLIC[path](query);
    }
    if (!state.user) return go('#/login');
    if (!state.settings) await loadSettings();
    if (state.received === undefined) {
      await loadReceived();
      let saved = null;
      try { saved = Number(sessionStorage.getItem('actAs')) || null; } catch (_) { /* 무시 */ }
      setActAs(saved ? state.received.find((r) => r.user_id === saved) : null);
    }
    // 공유받은 화면을 보는 중이면 권한 있는 화면만 열고, 조회 권한이면 수정 버튼을 숨긴다
    const sc = path === '/dividends' ? 'yearly' : SHARE_PATH[`#${path}`];
    if (state.actAs && path !== '/me' && !(sc && state.actAs.perms[sc])) {
      const first = Object.keys(SHARE_PATH).find((h) => state.actAs.perms[SHARE_PATH[h]]);
      if (first) return go(first);
      setActAs(null);
    }
    document.body.classList.toggle('ro', !!(state.actAs && sc && state.actAs.perms[sc] !== 'edit'));
    (PRIVATE[path] || (() => go('#/assets')))(query);
    window.scrollTo(0, 0);
  }

  window.addEventListener('hashchange', render);
  api('GET', '/health').then((h) => { state.server = { ...state.server, ...h }; }).catch(() => {}).finally(() => {
    api('GET', '/auth/me').then((r) => {
      state.user = r.user;
      render();
    }).catch(() => render());
  });
})();
