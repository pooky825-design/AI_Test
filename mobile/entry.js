// 안드로이드 앱용 진입점: 서버 없이 앱 안에서 바로 Claude API를 호출합니다.
// esbuild로 번들되어 android/assets/www/tutor-bundle.js 가 됩니다.
// window.LocalTutor 가 있으면 public/app.js 는 서버 대신 이것을 사용합니다.
import Anthropic from "@anthropic-ai/sdk";
import { askClaude, describeError, newSession, MODELS, DEFAULT_MODEL } from "../src/tutor.js";

const KEY_STORAGE = "anthropic_api_key";
const Native = window.AndroidBridge || null; // 앱에서는 키를 기기 설정(SharedPreferences)에 저장
const sessions = new Map();
let client = null;
let clientKey = null;

function getKey() {
  if (Native) return Native.getApiKey() || "";
  try { return localStorage.getItem(KEY_STORAGE) || ""; } catch { return ""; }
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function getClient() {
  const key = getKey();
  if (!key) throw new Error("설정에서 Anthropic API 키를 먼저 입력해 주세요.");
  if (!client || clientKey !== key) {
    // API 키는 이 기기에만 저장되며, 앱이 Anthropic API와 직접 통신합니다.
    client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true });
    clientKey = key;
  }
  return client;
}

async function run(fn) {
  try {
    return await fn();
  } catch (err) {
    throw new Error(describeError(err, { keyHint: "설정에서 API 키를 확인하세요." }).message);
  }
}

window.LocalTutor = {
  models: { models: MODELS, default: DEFAULT_MODEL },
  getApiKey: getKey,
  setApiKey(key) {
    if (Native) return Native.setApiKey(key.trim());
    try { localStorage.setItem(KEY_STORAGE, key.trim()); } catch { /* 저장 불가 */ }
  },
  async startSession({ level, topic, model }) {
    const id = newId();
    const session = newSession(level, topic, model);
    const greeting = await run(() => askClaude(getClient(), session, "[CALL_CONNECTED]"));
    sessions.set(id, session);
    return { sessionId: id, ...greeting };
  },
  async chat(sessionId, text) {
    const session = sessions.get(sessionId);
    if (!session) throw new Error("세션이 없습니다. 통화를 다시 시작해 주세요.");
    return run(() => askClaude(getClient(), session, text.slice(0, 2000)));
  },
  endSession(sessionId) {
    sessions.delete(sessionId);
  },
};
