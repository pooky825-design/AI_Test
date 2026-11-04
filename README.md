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

## 구조

| 파일 | 역할 |
|---|---|
| `server.js` | Express 서버. 대화 기록을 세션별로 보관하고 Claude API를 호출 |
| `public/index.html` | 시작 화면 / 통화 화면 / 요약 화면 |
| `public/app.js` | 음성 인식(Web Speech API), 음성 출력(speechSynthesis), 화면 렌더링 |
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

## 설정

`.env`에서 바꿀 수 있습니다.

- `CLAUDE_MODEL` (기본값 `claude-opus-5-5`): 비용을 줄이려면 `claude-sonnet-5-5`나 `claude-haiku-5-5`를 사용할 수 있습니다. Haiku는 서버 측 fallback을 지원하지 않으므로 그때는 `server.js`에서 `betas`/`fallbacks` 두 줄을 지우세요.
- `PORT` (기본값 3000)

응답 속도를 위해 `effort: "low"`를 사용하며, Claude가 안전 정책으로 요청을 거절하면 서버 측에서 다른 모델로 자동 재시도하도록(`fallbacks: "default"`) 설정되어 있습니다.

## 참고

- 대화 기록은 서버 메모리에만 저장되며, 서버를 재시작하거나 2시간이 지나면 사라집니다.
