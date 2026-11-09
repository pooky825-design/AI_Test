// 앱(WebView) 안에서 server/routes/api.js 를 그대로 쓰기 위한 최소 Express 호환 라우터
function compile(pattern) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/\/:([A-Za-z0-9_]+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; }) + '/?$');
  return { re, keys };
}

function Router() {
  const stack = [];
  const add = (method) => (pattern, fn) => {
    stack.push({ method, ...compile(pattern), fn });
    return router;
  };
  const router = {
    get: add('GET'),
    post: add('POST'),
    put: add('PUT'),
    delete: add('DELETE'),
    use(fn) {
      stack.push({ method: null, re: null, keys: [], fn });
      return router;
    },
    // 요청 처리: 미들웨어는 next()를 불러야 다음으로 진행, 라우트 핸들러는 처리 후 종료
    async handle(req, res) {
      for (const layer of stack) {
        if (layer.method && layer.method !== req.method) continue;
        if (layer.re) {
          const m = layer.re.exec(req.path);
          if (!m) continue;
          req.params = {};
          layer.keys.forEach((k, i) => (req.params[k] = decodeURIComponent(m[i + 1])));
          await layer.fn(req, res, (err) => { if (err) throw err; });
          return true;
        }
        let proceed = false;
        await layer.fn(req, res, (err) => {
          if (err) throw err;
          proceed = true;
        });
        if (!proceed) return true;
      }
      return false;
    },
  };
  return router;
}

function createResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    json(o) { this.body = o; this.headers['content-type'] = 'application/json'; return this; },
    send(b) { this.body = b; return this; },
  };
}

module.exports = { Router, createResponse };
module.exports.default = module.exports;
