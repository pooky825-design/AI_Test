// K-Stock 언어 선택 (v0.26)
// 화면 코드는 한국어로 그대로 두고, 영어를 고르면 화면에 그려지는 글자(텍스트·placeholder·title 등)를
// 사전(public/i18n/en.js)과 숫자 단위 규칙으로 바꿔 보여 준다. 새로 그려지는 부분은 MutationObserver 로 따라간다.
(function () {
  const DICT = window.I18N_EN || {};
  const KEY = 'ui.lang';
  let lang = 'ko';
  try { lang = localStorage.getItem(KEY) === 'en' ? 'en' : 'ko'; } catch (_) { /* 저장소를 못 쓰면 한국어 */ }

  const HANGUL = /[가-힣]/;
  const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 긴 문구부터 바꾸도록 길이 순 정렬. 한 글자 키는 오히려 다른 단어를 망가뜨리므로 정확히 같을 때만 사용
  const keys = Object.keys(DICT).filter((k) => k.length >= 2).sort((a, b) => b.length - a.length);
  const BIG = keys.length ? new RegExp(keys.map(reEsc).join('|'), 'g') : null;
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const mon = (m) => MON[Number(m) - 1] || m;
  const RULES = [
    [/([+\-−]?)(\d[\d,]*(?:\.\d+)?)\s?원/g, '$1₩$2'],
    [/(\d+)\s?개월/g, '$1 mo'],
    [/(\d{1,2})월\s?~\s?(\d{1,2})월/g, (_, a, b) => `${mon(a)}–${mon(b)}`],
    [/(\d{4})년\s?(\d{1,2})월/g, (_, y, m) => `${mon(m)} ${y}`],
    [/(\d{4})년/g, '$1'],
    [/(\d{1,2})년/g, '$1Y'],
    [/락\s(\d)/g, 'Ex $1'],
    [/(^|[\s(,])원(?=[)\s,·]|$)/g, '$1KRW'],
    [/(\d{1,2})월/g, (_, m) => mon(m)],
    [/(\d[\d,]*)\s?(개|건|명|회)/g, '$1'],
    [/(\d[\d,]*(?:\.\d+)?)\s?주(?![가-힣])/g, '$1 sh'],
    [/(\d+)\s?분/g, '$1 min'],
    [/(\d(?:[\d,.]*\d)?)\s?배(?![가-힣])/g, '$1x'],
  ];

  function t(str) {
    if (lang !== 'en' || !str || !HANGUL.test(str)) return str;
    const core = str.trim();
    if (Object.prototype.hasOwnProperty.call(DICT, core)) {
      const lead = str.slice(0, str.indexOf(core));
      return lead + DICT[core] + str.slice(lead.length + core.length);
    }
    // 숫자 뒤에 붙는 단어 중 사전보다 먼저 바꿔야 하는 것
    let out = str.replace(/(\d[\d,]*)\s?종목/g, '$1 stocks');
    out = BIG ? out.replace(BIG, (m) => DICT[m]) : out;
    for (const [re, to] of RULES) out = out.replace(re, to);
    return out;
  }

  // 사용자가 입력한 값이나 종목명은 바꾸지 않는다
  const SKIP_PARENT = 'script, style, textarea, datalist, datalist option, [data-noi18n], .nm, .ac-name, .name-cell > span, .name-cell > a, .quote .title h2, .who';
  const ATTRS = ['placeholder', 'title', 'aria-label', 'data-tip'];
  function fixText(node) {
    const p = node.parentElement;
    if (!p || p.closest('[data-noi18n]') || p.matches(SKIP_PARENT)) return;
    const v = node.nodeValue;
    if (!HANGUL.test(v)) return;
    const n = t(v);
    if (n !== v) node.nodeValue = n;
  }
  function fixAttrs(el) {
    if (el.closest && el.closest('[data-noi18n]')) return;
    for (const a of ATTRS) {
      const v = el.getAttribute && el.getAttribute(a);
      if (v && HANGUL.test(v)) {
        const n = t(v);
        if (n !== v) el.setAttribute(a, n);
      }
    }
  }
  function walk(root) {
    if (lang !== 'en' || !root) return;
    if (root.nodeType === 3) { fixText(root); return; }
    if (root.nodeType !== 1 && root.nodeType !== 9) return;
    if (root.nodeType === 1) fixAttrs(root);
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    let n = tw.nextNode();
    while (n) {
      if (n.nodeType === 3) fixText(n); else fixAttrs(n);
      n = tw.nextNode();
    }
  }

  const obs = new MutationObserver((muts) => {
    if (lang !== 'en') return;
    for (const m of muts) {
      if (m.type === 'characterData') fixText(m.target);
      else if (m.type === 'attributes') fixAttrs(m.target);
      else m.addedNodes.forEach(walk);
    }
  });
  obs.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });

  const nativeConfirm = window.confirm.bind(window);
  const nativeAlert = window.alert.bind(window);
  window.confirm = (msg) => nativeConfirm(t(String(msg)));
  window.alert = (msg) => nativeAlert(t(String(msg)));

  function set(next) {
    lang = next === 'en' ? 'en' : 'ko';
    try { localStorage.setItem(KEY, lang); } catch (_) { /* 무시 */ }
    document.documentElement.lang = lang;
    walk(document.documentElement);
  }
  document.documentElement.lang = lang;
  if (document.readyState !== 'loading') walk(document.documentElement);
  else document.addEventListener('DOMContentLoaded', () => walk(document.documentElement));

  window.I18N = { get lang() { return lang; }, set, t };
})();
