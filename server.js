// 전화영어 학습 앱 - 웹 서버
import "dotenv/config";
import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import { askClaude, describeError, newSession, MODELS, DEFAULT_MODEL } from "./src/tutor.js";

const PORT = process.env.PORT || 3000;
// 화면에서 모델을 고르지 않았을 때 쓰는 기본 모델
const MODEL = process.env.CLAUDE_MODEL || DEFAULT_MODEL;

const client = new Anthropic(); // ANTHROPIC_API_KEY 환경변수 사용

const sessions = new Map();
const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2시간 지난 세션은 정리
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) if (now - s.createdAt > SESSION_TTL_MS) sessions.delete(id);
}, 10 * 60 * 1000).unref();

const app = express();
app.use(express.json());
app.use(express.static("public"));

app.get("/api/models", (req, res) => {
  res.json({ models: MODELS, default: MODELS[MODEL] ? MODEL : DEFAULT_MODEL });
});

function sendError(res, err) {
  if (!(err.status >= 400 && err.status < 500)) console.error(err);
  const { status, message } = describeError(err, { keyHint: ".env의 ANTHROPIC_API_KEY를 확인하세요." });
  res.status(status).json({ error: message });
}

// 통화 시작: 세션을 만들고 Claude의 첫 인사를 받아옵니다.
app.post("/api/session", async (req, res) => {
  const { level = "intermediate", topic = "", model = MODEL } = req.body || {};
  const id = randomUUID();
  const session = newSession(level, topic, model);
  sessions.set(id, session);
  try {
    const greeting = await askClaude(client, session, "[CALL_CONNECTED]");
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
    res.json(await askClaude(client, session, text.slice(0, 2000)));
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
