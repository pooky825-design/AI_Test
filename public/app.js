// 전화영어 with Claude - 프론트엔드
// 음성 인식: Web Speech API (SpeechRecognition), 음성 출력: speechSynthesis
const $ = (id) => document.getElementById(id);

const state = {
  sessionId: null,
  busy: false,
  listening: false,
  lastReply: "",
  turns: 0,
  costUsd: 0,
  corrections: [],
  expressions: [],
  startedAt: 0,
  timerId: null,
};

// ---------- 실행 환경 ----------
// 안드로이드 앱(WebView)에서는 window.AndroidBridge 로 기기의 음성 인식/음성 출력을,
// window.LocalTutor 로 앱 안에서 직접 Claude를 호출합니다.
// 웹 브라우저에서는 Web Speech API와 서버(/api/*)를 사용합니다.
const Native = window.AndroidBridge || null;
const backend = window.LocalTutor || {
  getModels: () => fetch("/api/models").then((r) => r.json()),
  startSession: (opts) => api("/api/session", opts),
  chat: (sessionId, text) => api("/api/chat", { sessionId, text }),
  endSession: (id) => fetch(`/api/session/${id}`, { method: "DELETE" }),
};

// ---------- 음성 출력 (TTS) ----------
let englishVoice = null;
function pickVoice() {
  const voices = speechSynthesis.getVoices();
  englishVoice =
    voices.find((v) => /en-US/i.test(v.lang) && /female|samantha|jenny|aria|google us/i.test(v.name)) ||
    voices.find((v) => /en-US/i.test(v.lang)) ||
    voices.find((v) => /^en/i.test(v.lang)) ||
    null;
}
if (!Native && "speechSynthesis" in window) {
  pickVoice();
  speechSynthesis.onvoiceschanged = pickVoice;
}

const ttsCallbacks = {};
let ttsSeq = 0;
window.__nativeTtsDone = (id) => {
  const cb = ttsCallbacks[id];
  delete ttsCallbacks[id];
  if (cb) cb();
};

function stopSpeaking() {
  if (Native) {
    // 중간에 끊은 발화는 "말하기 끝" 콜백(자동 듣기 등)을 실행하지 않습니다.
    for (const id in ttsCallbacks) delete ttsCallbacks[id];
    $("call").classList.remove("speaking");
    Native.stopSpeaking();
  }
  else if ("speechSynthesis" in window) speechSynthesis.cancel();
}

function speak(text, { onEnd } = {}) {
  const done = () => {
    $("call").classList.remove("speaking");
    if (state.sessionId) setStatus("통화 중");
    onEnd && onEnd();
  };
  stopSpeaking();
  if (!Native && !("speechSynthesis" in window)) return onEnd && onEnd();
  $("call").classList.add("speaking");
  setStatus("Emma가 말하는 중...");
  const rate = parseFloat($("rate").value) || 0.9;
  if (Native) {
    const id = "u" + ++ttsSeq;
    ttsCallbacks[id] = done;
    Native.speak(text, rate, id);
    return;
  }
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "en-US";
  if (englishVoice) u.voice = englishVoice;
  u.rate = rate;
  u.onend = u.onerror = done;
  speechSynthesis.speak(u);
}

// ---------- 음성 인식 (STT) ----------
let finalText = "";
const rec = {
  start() {
    finalText = "";
    state.listening = true;
    $("micBtn").classList.add("listening");
    setStatus("듣는 중... 영어로 말해보세요");
  },
  interim(text) {
    $("interim").textContent = (finalText + " " + text).trim();
  },
  final(text) {
    finalText = (finalText + " " + text).trim();
    $("interim").textContent = finalText;
  },
  error(code) {
    if (code === "not-allowed") alert("마이크 권한을 허용해 주세요.");
    else if (code === "unavailable") alert("이 기기에서 음성 인식을 사용할 수 없어요. Google 앱을 설치하거나 업데이트해 주세요. 텍스트 입력은 사용할 수 있어요.");
  },
  end() {
    if (!state.listening) return;
    state.listening = false;
    $("micBtn").classList.remove("listening");
    $("interim").textContent = "";
    if (state.sessionId) setStatus("통화 중");
    const text = finalText.trim();
    finalText = "";
    if (text) sendMessage(text);
  },
};

let recognizer = null; // { start(), stop() }
if (Native) {
  // AndroidBridge가 window.__nativeSpeech(type, text) 로 결과를 알려줍니다.
  window.__nativeSpeech = (type, text) => rec[type] && rec[type](text || "");
  recognizer = { start: () => Native.startListening(), stop: () => Native.stopListening() };
} else {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SR) {
    const r = new SR();
    r.lang = "en-US";
    r.interimResults = true;
    r.continuous = false;
    r.onstart = () => rec.start();
    r.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) rec.final(t);
        else interim += t;
      }
      rec.interim(interim);
    };
    r.onerror = (e) => rec.error(e.error);
    r.onend = () => rec.end();
    recognizer = { start: () => r.start(), stop: () => r.stop() };
  }
}

function startListening() {
  if (!recognizer || state.busy || state.listening || !state.sessionId) return;
  stopSpeaking();
  try { recognizer.start(); } catch { /* 이미 시작됨 */ }
}
function stopListening() {
  if (recognizer && state.listening) recognizer.stop();
}

// ---------- 화면 렌더링 ----------
function setStatus(t) { $("status").textContent = t; }
function scrollDown() { const el = $("transcript"); el.scrollTop = el.scrollHeight; }
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function addMyMessage(text) {
  const wrap = el("div", "msg me");
  const bubble = el("div", "bubble");
  bubble.append(el("div", "en", text));
  wrap.append(bubble);
  $("transcript").append(wrap);
  scrollDown();
  return wrap;
}

function addCorrection(myMsgEl, original, correction) {
  if (!correction) return;
  if (!correction.has_error) {
    myMsgEl.append(el("div", "good", "✓ 자연스러운 문장이에요"));
    return;
  }
  const box = el("div", "correction");
  box.append(el("b", null, "✏️ 이렇게 말하면 더 자연스러워요"));
  const fixed = el("div", "fixed", correction.corrected);
  box.append(fixed);
  if (correction.explanation_ko) box.append(el("div", null, correction.explanation_ko));
  const listen = el("button", null, "🔊 듣기");
  listen.style.cssText = "background:none;color:var(--accent);padding:0;margin-top:4px;font-size:.8rem";
  listen.onclick = () => speak(correction.corrected);
  box.append(listen);
  myMsgEl.append(box);
  state.corrections.push({ original, corrected: correction.corrected, explanation: correction.explanation_ko });
  scrollDown();
}

function addTutorMessage(data) {
  const wrap = el("div", "msg tutor");
  const bubble = el("div", "bubble");
  bubble.append(el("div", "en", data.reply));
  const ko = el("div", "ko blur", data.reply_ko);
  ko.title = "눌러서 번역 보기";
  ko.onclick = () => ko.classList.toggle("blur");
  bubble.append(ko);
  const tools = el("div", "tools");
  const replay = el("button", null, "🔊 다시 듣기");
  replay.onclick = () => speak(data.reply);
  tools.append(replay);
  bubble.append(tools);
  wrap.append(bubble);
  if (data.key_expression && data.key_expression.en) {
    wrap.append(el("div", "keyexp", `⭐ ${data.key_expression.en} — ${data.key_expression.ko}`));
    state.expressions.push(data.key_expression);
  }
  $("transcript").append(wrap);
  scrollDown();
}

function renderSuggestions(list) {
  const box = $("suggestions");
  box.innerHTML = "";
  (list || []).forEach((s) => {
    const chip = el("div", "chip");
    const left = el("div");
    left.append(el("span", "en", s.en));
    left.append(el("span", "ko", s.ko));
    left.style.cursor = "pointer";
    left.title = "눌러서 발음 듣기";
    left.onclick = () => speak(s.en);
    const send = el("button", "send", "보내기 ➤");
    send.style.background = "none";
    send.onclick = () => sendMessage(s.en);
    chip.append(left, send);
    box.append(chip);
  });
}

function showTyping() {
  const t = el("div", "msg tutor");
  const b = el("div", "bubble typing", "Emma is thinking...");
  t.append(b);
  t.id = "typing";
  $("transcript").append(t);
  scrollDown();
}
function hideTyping() { const t = $("typing"); if (t) t.remove(); }

function handleTutorTurn(data) {
  state.lastReply = data.reply;
  addTutorMessage(data);
  renderSuggestions(data.suggestions);
  speak(data.reply, {
    onEnd: () => { if ($("autoListen").checked && state.sessionId) startListening(); },
  });
}

// ---------- 서버 통신 ----------
async function api(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `서버 오류 (${res.status})`);
  return data;
}

async function sendMessage(text) {
  if (state.busy || !state.sessionId) return;
  state.busy = true;
  stopListening();
  stopSpeaking();
  const myMsg = addMyMessage(text);
  showTyping();
  setStatus("Emma가 생각 중...");
  try {
    const data = await backend.chat(state.sessionId, text);
    state.costUsd += data.cost_usd || 0;
    hideTyping();
    state.turns++;
    addCorrection(myMsg, text, data.correction);
    handleTutorTurn(data);
  } catch (err) {
    hideTyping();
    myMsg.append(el("div", "error", `⚠️ ${err.message}`));
    setStatus("통화 중");
  } finally {
    state.busy = false;
  }
}

async function startCall() {
  $("setupError").textContent = "";
  $("callBtn").disabled = true;
  $("callBtn").textContent = "연결 중...";
  const preset = $("topicPreset").value;
  const topic = preset === "custom" ? $("topicCustom").value.trim() : preset;
  try {
    // iOS/Safari는 사용자 동작 안에서 음성 출력을 한 번 해줘야 이후 자동 재생이 됩니다.
    if (!Native && "speechSynthesis" in window) speechSynthesis.speak(new SpeechSynthesisUtterance(""));
    if (window.LocalTutor) window.LocalTutor.setApiKey($("apiKey").value);
    const data = await backend.startSession({ level: $("level").value, topic, model: $("model").value });
    state.sessionId = data.sessionId;
    Object.assign(state, { turns: 0, costUsd: data.cost_usd || 0, corrections: [], expressions: [] });
    $("transcript").innerHTML = "";
    $("setup").classList.add("hidden");
    $("call").classList.remove("hidden");
    if (!recognizer) {
      $("micBtn").disabled = true;
      $("micBtn").title = "이 브라우저는 음성 인식을 지원하지 않아요 (Chrome 권장)";
      setStatus("음성 인식 미지원 브라우저 - 텍스트로 입력해 주세요");
    }
    startTimer();
    handleTutorTurn(data);
  } catch (err) {
    $("setupError").textContent = err.message;
  } finally {
    $("callBtn").disabled = false;
    $("callBtn").textContent = "📞 통화 시작";
  }
}

function hangUp() {
  stopListening();
  stopSpeaking();
  if (state.sessionId) backend.endSession(state.sessionId);
  state.sessionId = null;
  clearInterval(state.timerId);
  $("call").classList.add("hidden");
  showSummary();
}

function showSummary() {
  const secs = Math.floor((Date.now() - state.startedAt) / 1000);
  $("summaryStats").textContent =
    `통화 시간 ${fmt(secs)} · 내가 말한 문장 ${state.turns}개 · 교정 ${state.corrections.length}개`;
  // 1달러 = 약 1,400원으로 계산한 대략적인 금액입니다.
  const won = state.costUsd * 1400;
  const wonText = won < 1 ? "1원 미만" : `${Math.round(won).toLocaleString("ko-KR")}원`;
  const usd = state.costUsd.toFixed(state.costUsd < 0.01 ? 4 : 3);
  $("summaryCost").textContent = `이번 통화 예상 비용: 약 ${wonText} ($${usd})`;
  const cl = $("summaryCorrections");
  cl.innerHTML = "";
  if (!state.corrections.length) cl.append(el("li", "muted", "교정 받은 문장이 없어요. 훌륭해요!"));
  state.corrections.forEach((c) => {
    const li = el("li");
    li.append(el("div", "muted", `❌ ${c.original}`));
    li.append(el("div", null, `✅ ${c.corrected}`));
    if (c.explanation) li.append(el("div", "muted", c.explanation));
    cl.append(li);
  });
  const ex = $("summaryExpressions");
  ex.innerHTML = "";
  if (!state.expressions.length) ex.append(el("li", "muted", "-"));
  state.expressions.forEach((e) => ex.append(el("li", null, `${e.en} — ${e.ko}`)));
  $("summary").classList.remove("hidden");
}

// ---------- 타이머 ----------
function fmt(s) { return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; }
function startTimer() {
  state.startedAt = Date.now();
  clearInterval(state.timerId);
  state.timerId = setInterval(() => {
    $("timer").textContent = fmt(Math.floor((Date.now() - state.startedAt) / 1000));
  }, 1000);
}

// ---------- 이벤트 ----------
$("topicPreset").onchange = (e) => $("topicCustom").classList.toggle("hidden", e.target.value !== "custom");
$("callBtn").onclick = startCall;

// 모델 선택: 고른 모델은 이 기기에 기억해 둡니다.
const MODEL_STORAGE = "tutor_model";
let modelInfo = {};
function showModelCost() {
  const m = modelInfo[$("model").value];
  $("modelCost").textContent = m ? `예상 비용: ${m.cost} · ` : "";
}
async function loadModels() {
  const sel = $("model");
  try {
    const info = window.LocalTutor ? window.LocalTutor.models : await backend.getModels();
    let saved = "";
    try { saved = localStorage.getItem(MODEL_STORAGE) || ""; } catch { /* 저장소 사용 불가 */ }
    sel.innerHTML = "";
    for (const [id, m] of Object.entries(info.models)) {
      const opt = el("option", null, m.label);
      opt.value = id;
      sel.append(opt);
    }
    sel.value = info.models[saved] ? saved : info.default;
    modelInfo = info.models;
    showModelCost();
  } catch {
    $("modelBox").classList.add("hidden"); // 모델 목록을 못 받으면 서버 기본 모델 사용
  }
}
$("model").onchange = (e) => {
  showModelCost();
  try { localStorage.setItem(MODEL_STORAGE, e.target.value); } catch { /* 저장소 사용 불가 */ }
};
loadModels();
if (window.LocalTutor) {
  // 앱에서는 Claude API 키를 이 기기에 저장해 두고 사용합니다.
  $("apiKeyBox").classList.remove("hidden");
  $("apiKey").value = window.LocalTutor.getApiKey();
}
$("hangupBtn").onclick = hangUp;
$("againBtn").onclick = () => { $("summary").classList.add("hidden"); $("setup").classList.remove("hidden"); };
$("micBtn").onclick = () => (state.listening ? stopListening() : startListening());
$("repeatBtn").onclick = () => state.lastReply && speak(state.lastReply);
$("textForm").onsubmit = (e) => {
  e.preventDefault();
  const v = $("textInput").value.trim();
  if (!v) return;
  $("textInput").value = "";
  sendMessage(v);
};
