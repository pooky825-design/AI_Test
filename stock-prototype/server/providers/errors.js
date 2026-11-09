// 출처 연동부 공통 오류
class NotFoundError extends Error {
  constructor(message) {
    super(message || '존재하지 않는 종목코드입니다.');
    this.code = 'NOT_FOUND';
  }
}
class SourceError extends Error {
  constructor(message) {
    super(message || '외부 출처에서 시세를 가져오지 못했습니다.');
    this.code = 'SOURCE_ERROR';
  }
}
module.exports = { NotFoundError, SourceError };
