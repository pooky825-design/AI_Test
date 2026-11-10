// 공개 서버용 보안 도우미 (v0.25)
//  - 보안 헤더
//  - 로그인·가입·재설정 요청 횟수 제한 (메모리 기반, 서버 재시작 시 초기화)

function securityHeaders(cloud) {
  return (req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    // 화면은 같은 서버의 파일만 쓴다(인라인 스타일 속성은 허용)
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    if (cloud) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    next();
  };
}

// 실패 횟수 제한: key 별로 windowMs 안에 max 번까지. 넘으면 잠금 시간 동안 거부
function limiter({ windowMs, max }) {
  const hits = new Map();
  const sweep = () => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  };
  return {
    blocked(key) {
      const v = hits.get(key);
      if (!v || v.reset < Date.now()) return 0;
      return v.count >= max ? Math.ceil((v.reset - Date.now()) / 1000) : 0;
    },
    hit(key) {
      if (hits.size > 5000) sweep();
      const now = Date.now();
      const v = hits.get(key);
      if (!v || v.reset < now) hits.set(key, { count: 1, reset: now + windowMs });
      else v.count += 1;
    },
    clear(key) { hits.delete(key); },
  };
}

const clientIp = (req) => req.ip || (req.socket && req.socket.remoteAddress) || 'local';

module.exports = { securityHeaders, limiter, clientIp };
