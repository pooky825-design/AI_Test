// 전화영어 with Claude - 프론트엔드
// 음성 인식: Web Speech API (SpeechRecognition), 음성 출력: speechSynthesis
const $ = (id) => document.getElementById(id);

const state = {
  sessionId: null,
  busy: false,
  listening: false,
  lastReply: "",
  turns: 0,
  corrections: [],
  expressions: [],
  startedAt: 0,
  timerId: null,
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
if ("speechSynthesis" in window) {
  pickVoice();
  speechSynthesis.onvoiceschanged = pickVoice;
}

function speak(text, { onEnd } = {}) {
  if (!("speechSynthesis" in window)) return onEnd && onEnd();
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "en-US";
  if (englishVoice) u.voice = englishVoice;
  u.rate = parseFloat($("rate").value) || 0.9;
  $("call").classList.add("speaking");
  setStatus("Emma가 말하는 중...");
  u.onend = u.onerror = () => {
    $("call").classList.remove("speaking");
    setStatus("통화 중");
    onEnd && onEnd();
  };
  speechSynthesis.speak(u);
}

// ---------- 음성 인식 (STT) ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
if (SR) {
  recognition = new SR();
  recognition.lang = "en-US";
  recognition.interimResults = true;
  recognition.continuous = false;

  let finalText = "";
  recognition.onstart = () => {
    finalText = "";
    state.listening = true;
    $("micBtn").classList.add("listening");
    setStatus("듣는 중... 영어로 말해보세요");
  };
  recognition.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) finalText += t;
      else interim += t;
    }
    $("interim").textContent = (finalText + " " + interim).trim();
  };
  recognition.onerror = (e) => {
    if (e.error === "not-allowed") alert("마이크 권한을 허용해 주세요.");
  };
  recognition.onend = () => {
    state.listening = false;
    $("micBtn").classList.remove("listening");
    $("interim").textContent = "";
    if (state.sessionId) setStatus("통화 중");
    const text = finalText.trim();
    if (text) sendMessage(text);
  };
}

function startListening() {
  if (!recognition || state.busy || state.listening || !state.sessionId) return;
  speechSynthesis.cancel();
  try { recognition.start(); } catch { /* 이미 시작됨 */ }
}
function stopListening() {
  if (recognition && state.listening) recognition.stop();
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
  speechSynthesis.cancel();
  const myMsg = addMyMessage(text);
  showTyping();
  setStatus("Emma가 생각 중...");
  try {
    const data = await api("/api/chat", { sessionId: state.sessionId, text });
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
    if ("speechSynthesis" in window) speechSynthesis.speak(new SpeechSynthesisUtterance(""));
    const data = await api("/api/session", { level: $("level").value, topic });
    state.sessionId = data.sessionId;
    Object.assign(state, { turns: 0, corrections: [], expressions: [] });
    $("transcript").innerHTML = "";
    $("setup").classList.add("hidden");
    $("call").classList.remove("hidden");
    if (!recognition) {
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
  speechSynthesis.cancel();
  if (state.sessionId) fetch(`/api/session/${state.sessionId}`, { method: "DELETE" });
  state.sessionId = null;
  clearInterval(state.timerId);
  $("call").classList.add("hidden");
  showSummary();
}

function showSummary() {
  const secs = Math.floor((Date.now() - state.startedAt) / 1000);
  $("summaryStats").textContent =
    `통화 시간 ${fmt(secs)} · 내가 말한 문장 ${state.turns}개 · 교정 ${state.corrections.length}개`;
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
