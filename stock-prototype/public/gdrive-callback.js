  // 구글 로그인 결과(?code=…&state=…)를 K-Stock 화면(같은 주소)에 넘긴다 (v0.27.0)
  (function () {
    var q = location.search.slice(1);
    var ok = /(^|&)code=/.test(q);
    try { if (window.opener) window.opener.postMessage({ type: 'kstock-gdrive', query: q }, location.origin); } catch (e) {}
    try { localStorage.setItem('gdrive.cb', JSON.stringify({ q: q, t: Date.now() })); } catch (e) {}
    document.getElementById('msg').textContent = ok ? '구글 드라이브 연결을 마쳤습니다.' : '구글 로그인이 완료되지 않았습니다.';
    history.replaceState(null, '', location.pathname); // 주소창에서 code 지우기
    setTimeout(function () { try { localStorage.removeItem('gdrive.cb'); } catch (e) {} window.close(); }, 1200);
  })();
