// 전화영어 학습 앱 - 서버
// Claude와 영어로 대화하면서, 매 턴마다 (1) 영어 답변 (2) 한국어 번역
// (3) 사용자 문장 교정 (4) 다음에 말해볼 추천 영어 표현을 JSON으로 받아옵니다.
import "dotenv/config";
import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";

const PORT = process.env.PORT || 3000;
const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";

const client = new Anthropic(); // ANTHROPIC_API_KEY 환경변수 사용

const LEVELS = {
  beginner: "a beginner (CEFR A1-A2). Use short, simple sentences and very common words.",
  intermediate: "an intermediate learner (CEFR B1-B2). Use natural everyday English.",
  advanced: "an advanced learner (CEFR C1). Use natural, idiomatic English at native speed.",
};

function systemPrompt(level, topic) {
  return `You are "Emma", a friendly English tutor on a phone call with a Korean learner who is ${LEVELS[level] || LEVELS.intermediate}
Conversation topic: ${topic || "free talk about the learner's day"}.

How to talk:
- This is a spoken phone call. Keep each reply to 1-3 short sentences and usually end with a question so the learner keeps talking.
- Do not use markdown, emoji, or lists in "reply" - it will be read aloud by text-to-speech.
- If the learner writes in Korean, gently answer in English and help them say it in English.

For every turn, fill in the JSON fields:
- reply: what you say out loud (English only).
- reply_ko: a natural Korean translation of reply.
- correction: feedback on the learner's LAST message. Set has_error=false if it was natural English. Otherwise give the corrected sentence and a short explanation in Korean. Ignore missing punctuation and capitalization, since the input comes from speech recognition.
- suggestions: exactly 3 English sentences the learner could say next in reply to you, at their level, each with a Korean meaning. Make them varied (e.g. a simple answer, a more detailed answer, a follow-up question).
- key_expression: one useful expression from your reply (or null), with its Korean meaning.

The first user message "[CALL_CONNECTED]" is not from the learner: greet them warmly, introduce yourself and start the topic. For that turn set has_error=false.`;
}

const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["reply", "reply_ko", "correction", "suggestions", "key_expression"],
  properties: {
    reply: { type: "string" },
    reply_ko: { type: "string" },
    correction: {
      type: "object",
      additionalProperties: false,
      required: ["has_error", "corrected", "explanation_ko"],
      properties: {
        has_error: { type: "boolean" },
        corrected: { type: "string" },
        explanation_ko: { type: "string" },
      },
    },
    suggestions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["en", "ko"],
        properties: { en: { type: "string" }, ko: { type: "string" } },
      },
    },
    key_expression: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["en", "ko"],
          properties: { en: { type: "string" }, ko: { type: "string" } },
        },
      ],
    },
  },
};

// 세션별 대화 기록 (메모리 저장). Claude의 응답 content를 그대로 이어붙여
// 대화 기록을 append-only로 유지합니다.
const sessions = new Map();
const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2시간 지난 세션은 정리
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) if (now - s.createdAt > SESSION_TTL_MS) sessions.delete(id);
}, 10 * 60 * 1000).unref();

async function askClaude(session, userText) {
  session.messages.push({ role: "user", content: userText });

  let response;
  try {
    response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default", // 안전 분류기가 거절하면 서버 측에서 다른 모델로 자동 재시도
    output_config: {
      effort: "low", // 전화 대화는 빠른 응답이 중요하므로 low
      format: { type: "json_schema", schema: RESPONSE_SCHEMA },
    },
    system: systemPrompt(session.level, session.topic),
    messages: session.messages,
    });
  } catch (err) {
    session.messages.pop(); // 실패한 턴은 기록에서 제외
    throw err;
  }

  if (response.stop_reason === "refusal") {
    session.messages.pop(); // 거절된 턴은 기록에서 제외
    throw Object.assign(new Error("Claude가 이 요청에 응답하지 않았습니다. 다른 문장으로 다시 말해 주세요."), { status: 422 });
  }
  if (response.stop_reason === "max_tokens") {
    session.messages.pop();
    throw Object.assign(new Error("응답이 너무 길어 잘렸습니다. 다시 시도해 주세요."), { status: 502 });
  }

  session.messages.push({ role: "assistant", content: response.content });

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  return JSON.parse(text);
}

const app = express();
app.use(express.json());
app.use(express.static("public"));

function sendError(res, err) {
    if (err instanceof Anthropic.AuthenticationError) {
      return res.status(500).json({ error: "API 키가 올바르지 않습니다. .env의 ANTHROPIC_API_KEY를 확인하세요." });
    }
    if (err instanceof Anthropic.RateLimitError) {
      return res.status(429).json({ error: "요청이 많습니다. 잠시 후 다시 시도해 주세요." });
    }
    if (err instanceof Anthropic.APIError) {
      console.error(err);
      return res.status(502).json({ error: `Claude API 오류: ${err.message}` });
    }
    console.error(err);
    res.status(err.status || 500).json({ error: err.message });
}

// 통화 시작: 세션을 만들고 Claude의 첫 인사를 받아옵니다.
app.post("/api/session", async (req, res) => {
  const { level = "intermediate", topic = "" } = req.body || {};
  const id = randomUUID();
  const session = { level, topic: String(topic).slice(0, 200), messages: [], createdAt: Date.now() };
  sessions.set(id, session);
  try {
    const greeting = await askClaude(session, "[CALL_CONNECTED]");
    res.json({ sessionId: id, ...greeting });
  } catch (err) {
    sessions.delete(id);
    sendError(res, err);
  }
});

app.post("/api/chat", async (req, res) => {
  const { sessionId, text } = req.body || {};
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: "세션이 없습니다. 통화를 다시 시작해 주세요." });
  if (!text || typeof text !== "string") return res.status(400).json({ error: "text가 필요합니다." });
  try {
    res.json(await askClaude(session, text.slice(0, 2000)));
  } catch (err) {
    sendError(res, err);
  }
});

app.delete("/api/session/:id", (req, res) => {
  sessions.delete(req.params.id);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`전화영어 앱 실행 중: http://localhost:${PORT}`);
});
