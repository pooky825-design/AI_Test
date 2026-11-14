# 배당 일정 조회 (SEIBro) 📅

한국예탁결제원 **SEIBro**의 주식 배당정보로 종목별 **배당기준일 · 현금배당 지급일 · 주당배당금**을 조회하는 웹 앱입니다.

## 데이터 출처

SEIBro의 배당 데이터는 공공데이터포털의 **「금융위원회_주식배당정보」 Open API**로 제공됩니다 (데이터 제공: 한국예탁결제원, 하루 1회 갱신).

- 엔드포인트: `https://apis.data.go.kr/1160100/GetStocDiviInfoService_V2/getDiviInfo_V2`
- 활용신청: https://www.data.go.kr/data/15043284/openapi.do (무료, 개발계정은 자동 승인)
- 이용조건: 출처표시, **상업적 이용 시 한국예탁결제원과 별도 계약 필요**

## 주요 기능

- 🔎 **종목으로 찾기**: 회사명(부분일치), 종목코드 6자리(`005930`), ISIN(`KR7005930003`) 중 아무거나 입력
  - 종목코드는 ISIN으로 자동 변환해 조회합니다 (ISO 6166 검사숫자 계산).
  - 보통주/우선주는 따로 묶어서 보여줍니다.
- 📆 **다가오는 일정**: 앞으로 올 배당기준일·지급일을 D-day와 함께 표시
- 📊 **요약**: 최근 주당배당금, 최근 1년 배당 합계·횟수, 다음 배당기준일, 다음 지급일
- 🗓 **공시일로 찾기**: 특정 날짜에 등록된 배당 공시 전체 조회
- 💾 **CSV 저장** (엑셀에서 한글이 깨지지 않도록 BOM 포함)
- 최근 검색어 기억, 다크 모드, 모바일 화면 지원

## 실행 방법

필요한 것: Node.js 20.12 이상. 웹 서버는 외부 패키지가 없어 `npm install` 없이 실행됩니다.

```bash
cd dividend-app
cp .env.example .env      # SEIBRO_SERVICE_KEY 에 공공데이터포털 일반 인증키(Decoding) 입력
npm start                 # http://localhost:3100
```

- 서비스키를 넣지 않으면 **데모 모드**로 실행됩니다. 가상의 회사(예시전자, 샘플금융지주, 테스트화학)로 만든 예시 데이터라 실제 종목 정보가 아닙니다.
- 인코딩된 키(`%2B` 등 포함)를 넣어도 자동으로 처리합니다.
- 테스트: `npm test`

## 안드로이드 앱 (APK)

서버 없이 휴대폰에서 바로 동작하는 앱입니다 (Android 6.0 이상, 약 50KB).

1. `dividend-schedule.apk`를 휴대폰에 옮겨 설치합니다 ("출처를 알 수 없는 앱" 설치 허용 필요).
2. 처음에는 **데모 모드**(가상의 예시 데이터)로 열립니다.
3. 오른쪽 위 **⚙︎ 설정**에 공공데이터포털 **일반 인증키**를 붙여넣고 저장하면 실제 배당정보를 조회합니다. 키는 기기에만 저장됩니다.
4. CSV 저장을 누르면 저장 위치를 고르는 화면이 열립니다.

앱은 공공데이터포털(`apis.data.go.kr`)에만 직접 접속합니다. WebView의 CORS 제한을 피하려고 API 요청은 안드로이드 쪽(`HttpURLConnection`)에서 보냅니다.

### 빌드 방법 (Ubuntu/Debian)

```bash
sudo apt-get install android-sdk-platform-23 aapt apksigner zipalign dalvik-exchange openjdk-17-jdk
cd dividend-app
npm install               # esbuild (앱용 번들에만 필요)
npm run build:apk         # 결과물: dist/dividend-schedule.apk
```

Gradle/Android Studio 없이 빌드합니다. 처음 빌드할 때 `~/.android/dividend-schedule.keystore` 서명 키가 만들어집니다. 같은 키로 서명해야 기존 앱 위에 업데이트 설치가 되므로 이 파일을 보관하세요.

## API

| 경로 | 설명 |
|---|---|
| `GET /api/dividends?q=삼성전자` | 회사명/종목코드/ISIN으로 배당 내역 조회. 종목별로 묶고 같은 기준일 중복은 최신 등록분만 남김 |
| `GET /api/dividends/by-date?date=20260305` | 해당 날짜에 등록된 배당 공시 전체 |
| `GET /api/config` | 데모 모드 여부, 오늘 날짜(KST) |

응답 예 (`stocks[].dividends[]`):

```json
{
  "recordDate": "20251231",   // 배당기준일 (dvdnBasDt)
  "payDate": "20260417",      // 현금배당 지급일 (cashDvdnPayDt)
  "stockDeliveryDate": "",    // 주식배당 교부일 (stckHndvDt)
  "dividendKind": "현금배당",  // stckDvdnRcdNm
  "dps": 566,                 // 주당 일반배당금 (stckGenrDvdnAmt)
  "dpsDiff": 0,               // 주당 차등배당금 (stckGrdnDvdnAmt)
  "cashRate": 11.32,          // 액면가 대비 현금배당률 % (stckGenrCashDvdnRt)
  "parValue": 100,            // 액면가 (stckParPrc)
  "basDt": "20260305"         // 데이터 등록일
}
```

## 구조

| 파일 | 역할 |
|---|---|
| `src/seibro.js` | API 호출(페이지 자동 순회, 오류 해석), 종목코드→ISIN 변환, 응답 정리 |
| `src/service.js` | 검색 로직 + 6시간 메모리 캐시 (서버와 앱이 함께 사용) |
| `src/demo.js` | 데모 모드용 가상 응답 |
| `server.js` | Node 내장 `http` 서버 |
| `mobile/entry.js` | 앱용: 서버 대신 앱 안에서 API 호출 (`window.LocalDividend`) |
| `android/` | 안드로이드 앱 (`MainActivity.java`: WebView + HTTP/서비스키 저장/파일 저장 브리지), 빌드 스크립트 |
| `public/` | 화면 (`index.html`, `app.js`, `style.css`) |
| `test/` | `node:test` 단위 테스트 |

## 참고 / 한계

- 배당금은 공시 당시 기준이며 **액면분할 이전 배당금은 보정되지 않습니다.**
- 회사명 검색은 공시상 정식 명칭 기준입니다 (예: NAVER → `네이버`). 정확히 찾으려면 종목코드를 쓰세요.
- 배당을 받으려면 배당기준일 **2영업일 전까지** 매수해야 합니다 (T+2 결제).
- 투자 판단 전 반드시 DART 공시 원문을 확인하세요.
