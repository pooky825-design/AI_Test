// 데모 계정과 예시 데이터 (DB를 처음 만들 때 한 번 실행)
const bcrypt = require('bcryptjs');
const db = require('./db');

async function seedDemo() {
  const now = new Date().toISOString();
  const hash = await bcrypt.hash('demo1234', 10);
  const { lastId: uid } = db.run('INSERT INTO users (email, password_hash, email_verified, created_at) VALUES (?, ?, 1, ?)', [
    'demo@example.com', hash, now,
  ]);
  // 2.3 예시와 비슷한 구성의 데모 보유 종목 (수량·매입단가는 가상의 값)
  const holdings = [
    ['005930', 100, 60000],
    ['069500', 50, 35000],
    ['0080G0', 200, 5000],
    ['AAPL', 10, 150],
    ['SPY', 5, 450],
  ];
  for (const [code, q, p] of holdings) {
    db.run('INSERT INTO holdings (user_id, code, quantity, avg_price, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [uid, code, q, p, now, now]);
  }
  const y = new Date().getFullYear();
  const dividends = [
    ['005930', `${y - 2}-04-19`, 30500, 'KRW', '결산 배당 (데모)'],
    ['005930', `${y - 1}-04-18`, 30500, 'KRW', '결산 배당 (데모)'],
    ['069500', `${y - 1}-04-30`, 10600, 'KRW', 'ETF 분배금 (데모)'],
    ['AAPL', `${y - 1}-05-15`, 2.13, 'USD', '세후 수령액 (데모)'],
    ['SPY', `${y - 1}-10-31`, 7.8, 'USD', 'ETF 분배금 (데모)'],
    ['005930', `${y}-04-17`, 36100, 'KRW', '결산 배당 (데모)'],
  ];
  for (const [code, d, a, c, m] of dividends) {
    db.run('INSERT INTO dividends (user_id, code, pay_date, amount, currency, memo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [uid, code, d, a, c, m, now]);
  }
  console.log('데모 계정 생성: demo@example.com / demo1234');
}

module.exports = { seedDemo };
