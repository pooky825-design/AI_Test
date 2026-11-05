# 전화영어 with Claude 📞

Claude와 영어로 "통화"하며 연습하는 웹 앱입니다. 휴대폰 브라우저에서도 동작합니다.

## 주요 기능

- 🎤 **음성 대화**: 마이크로 영어를 말하면 인식해서 Claude(튜터 Emma)에게 보내고, Emma의 답변을 영어 음성으로 읽어줍니다.
- 📝 **영어 자막**: 나와 Emma의 대화가 모두 화면에 영어로 표시됩니다. 한국어 번역은 흐리게 가려져 있다가 누르면 보입니다.
- 💡 **추천 영어**: 매 턴마다 다음에 말해볼 만한 영어 문장 3개를 한국어 뜻과 함께 보여줍니다. 누르면 발음을 들을 수 있고, "보내기"로 바로 말할 수도 있습니다.
- ✏️ **문장 교정**: 내가 말한 문장이 어색하면 자연스러운 표현과 한국어 설명을 알려줍니다.
- ⭐ **오늘의 표현**과 **통화 요약**: 통화를 끝내면 교정받은 문장과 배운 표현을 정리해 줍니다.
- 레벨(초급/중급/고급), 대화 주제, 말하기 속도, 자동 듣기 설정.

## 실행 방법

필요한 것: Node.js 18 이상, [Anthropic API 키](https://console.anthropic.com)

```bash
npm install
cp .env.example .env      # .env 파일에 ANTHROPIC_API_KEY 입력
npm start
```

브라우저에서 http://localhost:3000 을 엽니다.

- 음성 인식은 **Chrome**(PC/안드로이드)과 **Safari**(iOS)에서 잘 동작합니다. 지원하지 않는 브라우저에서는 텍스트 입력으로 대화할 수 있습니다.
- 휴대폰에서 쓰려면 마이크 권한 때문에 **HTTPS**가 필요합니다 (localhost는 예외). 배포하거나 `ngrok http 3000` 같은 터널을 사용하세요.

## 안드로이드 앱 (APK)

서버 없이 휴대폰에서 바로 동작하는 안드로이드 앱으로도 빌드할 수 있습니다.

- 앱 첫 화면에서 **Anthropic API 키**를 입력하면 기기에 저장되고, 앱이 Claude API를 직접 호출합니다.
- 음성 인식/음성 출력은 안드로이드 기기의 기능(Google 음성 인식, TTS)을 사용합니다.
- Android 6.0 이상에서 설치할 수 있습니다. 설치 시 "출처를 알 수 없는 앱" 설치를 허용해야 합니다.

### 빌드 방법 (Ubuntu/Debian)

```bash
sudo apt-get install android-sdk-platform-23 aapt apksigner zipalign dalvik-exchange openjdk-17-jdk
npm install
./android/build.sh        # 결과물: dist/english-phone-tutor.apk
```

Gradle/Android Studio 없이 빌드합니다. 처음 빌드할 때 `~/.android/english-phone-tutor.keystore` 서명 키가 만들어집니다. 같은 키로 서명해야 기존 앱 위에 업데이트 설치가 되므로 이 파일을 보관하세요.

> ⚠️ API 키가 앱(기기)에 저장되므로 **본인 전용**으로 쓰세요. 여러 사람에게 배포하려면 웹 서버 방식(`server.js`)을 쓰고 키는 서버에만 두는 것이 안전합니다.

## 구조

| 파일 | 역할 |
|---|---|
| `src/tutor.js` | Claude 호출 핵심 로직 (프롬프트, 응답 JSON 형식, 오류 메시지). 서버와 앱이 함께 사용 |
| `server.js` | Express 서버. 대화 기록을 세션별로 보관하고 `src/tutor.js`로 Claude 호출 |
| `mobile/entry.js` | 안드로이드 앱용: 서버 대신 앱 안에서 Claude를 직접 호출 |
| `android/` | 안드로이드 앱 (`MainActivity.java`: WebView + 음성 인식/TTS 브리지), 빌드 스크립트 |
| `public/index.html` | 시작 화면 / 통화 화면 / 요약 화면 |
| `public/app.js` | 음성 인식/출력(브라우저: Web Speech API, 앱: AndroidBridge), 화면 렌더링 |
| `public/style.css` | 스타일 (다크 모드 지원) |

Claude는 매 턴마다 아래 형식의 JSON(structured outputs)으로 응답합니다.

```json
{
  "reply": "Oh, that sounds tiring! What did you eat for lunch?",
  "reply_ko": "아, 피곤했겠네요! 점심은 뭐 먹었어요?",
  "correction": { "has_error": true, "corrected": "I went to the office yesterday.", "explanation_ko": "과거의 일은 went를 써요." },
  "suggestions": [{ "en": "I had kimchi stew.", "ko": "김치찌개 먹었어요." }],
  "key_expression": { "en": "That sounds tiring", "ko": "피곤했겠네요" }
}
```

## AI 모델과 비용

시작 화면에서 모델을 고를 수 있고, 고른 모델은 기억됩니다. 통화가 끝나면 요약 화면에 **이번 통화의 예상 비용**이 표시됩니다 (Claude가 알려주는 실제 토큰 사용량 × 공시 가격, 1달러 ≈ 1,400원으로 계산한 대략치).

| 모델 | 특징 | 10분 통화 예상 비용 |
|---|---|---|
| Opus 5.5 (기본값) | 가장 꼼꼼한 교정 | 약 350원 |
| Sonnet 5.5 | 균형 | 약 150원 |
| Haiku 5.5 | 가장 저렴 | 약 10~20원 |

- **프롬프트 캐싱**이 켜져 있어, 매 턴 다시 보내는 대화 기록은 할인된 가격(캐시 읽기)으로 계산됩니다.
- 응답 속도를 위해 `effort: "low"`를 사용합니다.
- Opus/Sonnet은 Claude가 안전 정책으로 요청을 거절하면 서버 측에서 다른 모델로 자동 재시도합니다(`fallbacks: "default"`). Haiku에는 이 기능이 없어 보내지 않습니다.
- 모델 목록과 가격은 `src/tutor.js`의 `MODELS`에 있습니다.

웹 서버 설정(`.env`):

- `CLAUDE_MODEL`: 화면에서 모델을 고르지 않았을 때 쓰는 기본 모델 (기본값 `claude-opus-5-5`)
- `PORT` (기본값 3000)

## 참고

- 대화 기록은 서버 메모리에만 저장되며, 서버를 재시작하거나 2시간이 지나면 사라집니다.
