// 실행 모드 설정 (v0.25)
//  - 기본(local): PC 프로토타입·안드로이드 앱 내장 서버. 데모 계정, 화면에 재설정 링크 표시
//  - cloud: 인터넷에 공개하는 서버(Oracle Cloud 등). KSTOCK_MODE=cloud 로 켠다
//    · 데모 계정 만들지 않음, 비밀번호 재설정 링크를 화면에 보여주지 않음(관리자 도구로 재설정)
//    · HTTPS 프록시(Caddy) 뒤에서 동작: Secure 쿠키, X-Forwarded-For 신뢰, 127.0.0.1 에서만 대기
//    · SIGNUP_CODE 를 정하면 가입할 때 그 코드를 알아야 함(가족·지인만 가입)
const env = typeof process !== 'undefined' && process.env ? process.env : {};

const CLOUD = String(env.KSTOCK_MODE || '').toLowerCase() === 'cloud';

module.exports = {
  CLOUD,
  SIGNUP_CODE: String(env.SIGNUP_CODE || '').trim(),
  SEED_DEMO: CLOUD ? env.SEED_DEMO === '1' : true,
  HOST: env.HOST || (CLOUD ? '127.0.0.1' : undefined),
  DATA_DIR: env.DATA_DIR || '',
};
