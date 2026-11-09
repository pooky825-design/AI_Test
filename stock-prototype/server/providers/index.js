// 데이터 출처 선택 지점 (FR-DATA-07)
// 출처를 바꾸려면 이 파일에서 primary/backup만 교체하면 되고, 다른 기능은 수정하지 않는다.
const yahoo = require('./yahoo');
const naver = require('./naver');
const sample = require('./sample');

const mode = (process.env.DATA_PROVIDER || 'live').toLowerCase();

module.exports =
  mode === 'sample'
    ? { mode, primary: sample, backup: null, fx: sample, koreanName: async () => null }
    : { mode, primary: yahoo, backup: naver, fx: yahoo, koreanName: naver.koreanName };
