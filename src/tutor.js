// 전화영어 튜터 핵심 로직 - 서버(server.js)와 안드로이드 앱(mobile/entry.js)이 함께 사용합니다.
// Claude와 영어로 대화하면서, 매 턴마다 (1) 영어 답변 (2) 한국어 번역
// (3) 사용자 문장 교정 (4) 다음에 말해볼 추천 영어 표현을 JSON으로 받아옵니다.
import Anthropic from "@anthropic-ai/sdk";

// 선택할 수 있는 모델. cost는 10분(약 20턴) 통화 기준, 프롬프트 캐싱을 켠 대략적인 추정치입니다.
// fallbacks: 안전 분류기가 거절했을 때 서버 측에서 다른 모델로 자동 재시도하는지 여부
//            (Claude Haiku 5.5는 서버 측 fallback이 없어서 보내지 않습니다).
// price: 100만 토큰당 달러 (입력, 출력, 캐시 쓰기(5분), 캐시 읽기)
export const MODELS = {
  "claude-opus-5-5": {
    label: "Opus 5.5 · 꼼꼼한 교정", cost: "10분 약 350원", fallbacks: true,
    price: { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  },
  "claude-sonnet-5-5": {
    label: "Sonnet 5.5 · 균형", cost: "10분 약 150원", fallbacks: true,
    price: { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  },
  "claude-haiku-5-5": {
    label: "Haiku 5.5 · 가장 저렴", cost: "10분 약 10~20원", fallbacks: false,
    price: { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
  },
};

// 응답의 토큰 사용량으로 이번 턴의 비용(달러)을 추정합니다.
// fallback으로 다른 모델이 답한 경우에도 요청한 모델 가격으로 계산하므로 대략치입니다.
export function estimateCostUsd(model, usage) {
  const p = (MODELS[model] || MODELS[DEFAULT_MODEL]).price;
  if (!usage) return 0;
  return (
    ((usage.input_tokens || 0) * p.input +
      (usage.output_tokens || 0) * p.output +
      (usage.cache_creation_input_tokens || 0) * p.cacheWrite +
      (usage.cache_read_input_tokens || 0) * p.cacheRead) /
    1e6
  );
}
export const DEFAULT_MODEL = "claude-opus-5-5";

export function resolveModel(model) {
  return Object.hasOwn(MODELS, model) ? model : DEFAULT_MODEL;
}

const LEVELS = {
  beginner: "a beginner (CEFR A1-A2). Use short, simple sentences and very common words.",
  intermediate: "an intermediate learner (CEFR B1-B2). Use natural everyday English.",
  advanced: "an advanced learner (CEFR C1). Use natural, idiomatic English at native speed.",
};

export function systemPrompt(level, topic) {
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

export const RESPONSE_SCHEMA = {
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

export function newSession(level, topic, model) {
  return {
    level,
    topic: String(topic || "").slice(0, 200),
    model: resolveModel(model),
    messages: [],
    createdAt: Date.now(),
  };
}

// 세션의 대화 기록(session.messages)은 Claude의 응답 content를 그대로 이어붙여
// append-only로 유지합니다.
export async function askClaude(client, session, userText) {
  session.messages.push({ role: "user", content: userText });

  let response;
  try {
    const fallback = MODELS[session.model].fallbacks
      ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" }
      : {};
    response = await client.beta.messages.create({
      model: session.model,
      max_tokens: 16000,
      ...fallback,
      // 프롬프트 캐싱: 시스템 프롬프트와 지금까지의 대화를 캐시해서, 다음 턴에는
      // 새로 추가된 부분만 정가로 계산됩니다. 대화 기록을 고치지 않고 이어붙이기만
      // 하므로 매 턴 캐시가 그대로 재사용됩니다.
      cache_control: { type: "ephemeral" },
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
  return { ...JSON.parse(text), cost_usd: estimateCostUsd(session.model, response.usage) };
}

// 오류를 사용자에게 보여줄 한국어 메시지와 HTTP 상태 코드로 바꿉니다.
export function describeError(err, { keyHint = "API 키를 확인하세요." } = {}) {
  if (err instanceof Anthropic.AuthenticationError) {
    return { status: 401, message: `API 키가 올바르지 않습니다. ${keyHint}` };
  }
  if (err instanceof Anthropic.RateLimitError) {
    return { status: 429, message: "요청이 많습니다. 잠시 후 다시 시도해 주세요." };
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return { status: 502, message: "Claude에 연결할 수 없습니다. 인터넷 연결을 확인해 주세요." };
  }
  if (err instanceof Anthropic.APIError) {
    return { status: 502, message: `Claude API 오류: ${err.message}` };
  }
  return { status: err.status || 500, message: err.message };
}
