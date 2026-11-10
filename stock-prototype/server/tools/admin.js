// 서버 관리자 도구 (v0.25) — 공개 서버에서 비밀번호 재설정 등
// 서버가 DB를 메모리에 올려 두고 저장하므로, 반드시 서버를 멈춘 상태에서 실행한다.
// (deploy/oracle/kstock-admin.sh 가 서비스 중지 → 실행 → 재시작을 대신 해 준다)
//
//   node server/tools/admin.js list-users
//   node server/tools/admin.js reset-password <이메일>
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db');

function tempPassword() {
  // 영문+숫자 12자리 (비밀번호 규칙: 8자 이상, 영문·숫자 포함)
  const abc = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
  const num = '23456789';
  const all = abc + num;
  const pick = (set) => set[crypto.randomInt(set.length)];
  const chars = [pick(abc), pick(num), ...Array.from({ length: 10 }, () => pick(all))];
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  await db.init();
  if (cmd === 'list-users') {
    const rows = db.all(`SELECT u.id, u.email, u.created_at,
        (SELECT COUNT(*) FROM holding_items h WHERE h.user_id = u.id) AS items
      FROM users u ORDER BY u.id`);
    if (!rows.length) console.log('가입한 회원이 없습니다.');
    rows.forEach((r) => console.log(`${String(r.id).padStart(4)}  ${r.email.padEnd(32)}  가입 ${r.created_at.slice(0, 10)}  주식 항목 ${r.items}건`));
    return;
  }
  if (cmd === 'reset-password') {
    const email = String(arg || '').trim().toLowerCase();
    const user = email && db.get('SELECT id, email FROM users WHERE email = ?', [email]);
    if (!user) {
      console.error(`회원을 찾을 수 없습니다: ${arg || '(이메일 없음)'}`);
      process.exitCode = 1;
      return;
    }
    const pw = tempPassword();
    const hash = await bcrypt.hash(pw, 10);
    db.tx(() => {
      db.run('UPDATE users SET password_hash = ? WHERE id = ?', [hash, user.id]);
      db.run('DELETE FROM sessions WHERE user_id = ?', [user.id]); // 다른 기기 로그인 해제
    });
    db.saveNow();
    console.log(`${user.email} 의 임시 비밀번호: ${pw}`);
    console.log('본인에게 안전하게 전달하고, 로그인 후 환경설정 → 비밀번호 변경에서 바꾸도록 안내하세요.');
    return;
  }
  console.log('사용법:\n  list-users                 가입한 회원 목록\n  reset-password <이메일>    임시 비밀번호 발급(모든 기기 로그아웃)');
  process.exitCode = cmd ? 1 : 0;
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
