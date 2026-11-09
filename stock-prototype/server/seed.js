// 데모 계정과 예시 데이터 (DB를 처음 만들 때 한 번 실행)
const bcrypt = require('bcryptjs');
const db = require('./db');

async function seedDemo() {
  const now = new Date().toISOString();
  const hash = await bcrypt.hash('demo1234', 10);
  const { lastId: uid } = db.run('INSERT INTO users (email, password_hash, email_verified, created_at) VALUES (?, ?, 1, ?)', [
    'demo@example.com', hash, now,
  ]);
  // 데모 그룹과 매수·매도 기록 (그룹별·연도별 관리 예시, 수량·단가는 가상의 값)
  const gid = {};
  ['일반', 'ISA', '연금'].forEach((name, i) => {
    gid[name] = db.run('INSERT INTO holding_groups (user_id, name, sort_order, created_at) VALUES (?, ?, ?, ?)', [uid, name, i, now]).lastId;
  });
  const ty = new Date().getFullYear();
  const trades = [
    ['일반', '005930', ty - 4, 'BUY', 50, 60000, '첫 매수'],
    ['일반', '005930', ty - 2, 'BUY', 50, 55000, '추가 매수'],
    ['일반', 'AAPL', ty - 5, 'BUY', 10, 150, null],
    ['일반', 'AAPL', ty - 2, 'SELL', 3, null, '일부 매도'],
    ['일반', 'AAPL', ty - 1, 'BUY', 3, 220, '다시 매수'],
    ['ISA', '069500', ty - 3, 'BUY', 50, 35000, null],
    ['ISA', '0080G0', ty - 1, 'BUY', 200, 5000, null],
    ['연금', 'SPY', ty - 3, 'BUY', 5, 450, null],
    ['연금', '069500', ty - 2, 'BUY', 20, 33000, '연금 계좌에서도 보유'],
  ];
  for (const [g, code, year, side, q, p, memo] of trades) {
    db.run(
      'INSERT INTO holding_trades (user_id, group_id, code, year, side, quantity, price, memo, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [uid, gid[g], code, year, side, q, p, memo, now, now]
    );
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
