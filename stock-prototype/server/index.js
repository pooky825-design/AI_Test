const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const express = require('express');
const db = require('./db');
const auth = require('./auth');
const market = require('./services/market');
const providers = require('./providers');
const { seedDemo, seedSampleDividends } = require('./seed');
const config = require('./config');
const { securityHeaders } = require('./security');

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
  if (isNew && config.SEED_DEMO) await seedDemo();

  const app = express();
  app.disable('x-powered-by');
  // 공개 서버는 Caddy(HTTPS) 뒤에서 동작: 실제 접속 IP는 X-Forwarded-For 첫 번째 프록시 값으로 판단
  if (config.CLOUD) app.set('trust proxy', 'loopback');
  app.use(securityHeaders(config.CLOUD));
  app.use(express.json({ limit: '5mb' })); // 백업 복원 파일(v0.15)도 받을 수 있게
  app.use(auth.loadUser);
  app.get('/vendor/chart.umd.js', (_req, res) => res.sendFile(path.join(__dirname, '..', 'node_modules', 'chart.js', 'dist', 'chart.umd.min.js')));
  // 화면이 서버 성격을 알 수 있게: 공개 서버 여부, 가입 코드 필요 여부, 데모 계정 유무 (v0.25)
  app.get('/api/health', (_req, res) => res.json({ ok: true, dataMode: providers.mode, cloud: config.CLOUD, signupCode: !!config.SIGNUP_CODE, demo: config.SEED_DEMO }));
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

  const server = app.listen(PORT, config.HOST, () => {
    const url = `http://${config.HOST || 'localhost'}:${PORT}`;
    console.log('==============================================');
    console.log(` K-Stock 실행 중: ${url}`);
    if (config.CLOUD) console.log(` 공개 서버 모드 (가입 코드 ${config.SIGNUP_CODE ? '필요' : '없음 — 누구나 가입 가능'})`);
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
  // 처음 설치 때 샘플 계정의 배당 입력 회차를 시세 출처에서 받아 채움 (v0.30.47). 실패하면 1시간 뒤 다시
  seedSampleDividends();
  setInterval(seedSampleDividends, 60 * 60 * 1000);

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
