const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const express = require('express');
const db = require('./db');
const auth = require('./auth');
const market = require('./services/market');
const providers = require('./providers');
const { seedDemo } = require('./seed');

const PORT = Number(process.env.PORT) || 3000;

function openChrome(url) {
  if (process.platform !== 'win32') return;
  const candidates = [
    path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
  ];
  const chrome = candidates.find((p) => p && fs.existsSync(p));
  exec(chrome ? `"${chrome}" "${url}"` : `start "" "${url}"`, { shell: 'cmd.exe' });
}

async function main() {
  const { isNew } = await db.init();
  if (isNew) await seedDemo();

  const app = express();
  app.use(express.json({ limit: '100kb' }));
  app.use(auth.loadUser);
  app.get('/vendor/chart.umd.js', (_req, res) => res.sendFile(path.join(__dirname, '..', 'node_modules', 'chart.js', 'dist', 'chart.umd.min.js')));
  app.get('/api/health', (_req, res) => res.json({ ok: true, dataMode: providers.mode }));
  app.use('/api', require('./routes/api'));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // 오류 응답: 없는 코드(404)와 시세 수집 실패(502)를 구분 (FR-STK-05)
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = { VALIDATION: 400, NOT_FOUND: 404, SOURCE_ERROR: 502 }[err.code];
    if (!status) {
      console.error(err);
      return res.status(500).json({ error: '서버 오류가 발생했습니다.', code: 'SERVER_ERROR' });
    }
    res.status(status).json({ error: err.message, code: err.code, fields: err.fields });
  });

  const server = app.listen(PORT, () => {
    const url = `http://localhost:${PORT}`;
    console.log('==============================================');
    console.log(` 주식 관리시스템 프로토타입 실행 중: ${url}`);
    console.log(` 데이터 출처: ${providers.mode === 'sample' ? '샘플(가상) 데이터' : '야후 파이낸스(주) / 네이버 증권(예비)'}`);
    console.log(' 종료하려면 이 창에서 Ctrl+C 를 누르세요.');
    console.log('==============================================');
    if (process.env.OPEN_BROWSER === '1') openChrome(url);
  });
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`포트 ${PORT}가 이미 사용 중입니다. 이미 실행 중인 창이 있는지 확인하거나 PORT 환경변수로 다른 포트를 지정하세요.`);
      if (process.env.OPEN_BROWSER === '1') openChrome(`http://localhost:${PORT}`);
    } else console.error(e);
  });

  // FR-DATA-01: 장 마감 후 일별 종가 자동 수집 (1시간 주기 확인)
  setInterval(() => market.collectDaily().catch((e) => console.warn('[collect]', e.message)), 60 * 60 * 1000);

  const shutdown = () => {
    db.saveNow();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
