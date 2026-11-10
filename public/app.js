import { romanize } from "/romanize.js";
import { downsample, encodeWav, mergeChunks, rms } from "/audio.js";
import { safeUrl } from "/book.js";

const COPY = {
  tapToSpeak: "Tap the mic and speak",
  listening: "Listening…",
  thinking: "Checking the books…",
  speaking: "Speaking. Tap to stop",
  micLabel: "Start speaking",
  micStop: "Stop",
  soundOn: "Spoken replies are on",
  soundOff: "Spoken replies are off",
  noSpeech: "Didn't catch that. Please try again.",
  micSilent: "Mic se koi awaaz nahi aayi. Check the right microphone is selected and not muted, or type below.",
  micBlocked: "Microphone is blocked. Allow it in browser settings, or type below.",
  noMic: "Voice needs Chrome or Edge. You can type below.",
  speechFailed: "Couldn't make that out. Please type it.",
  offline: "Couldn't reach the server. Please try again.",
  undone: "Removed",
  undoFailed: "That couldn't be undone.",
  appointments: "Appointments today",
  orders: "Open orders",
  lowStock: "Low stock",
  wrongPin: "That PIN didn't work.",
};
// Entry cards are coloured by what kind of entry they are; the words still say it.
const ENTRY_KINDS = [[/^Sale/, "sale"], [/^Expense/, "expense"], [/^Payment/, "payment"], [/^(Stock|Added stock|Updated stock)/, "stock"], [/^(Order|Appointment)/, "plan"]];
const entryKind = (summary) => ENTRY_KINDS.find(([re]) => re.test(summary))?.[1] ?? "other";
// Speech recognition language. The Hinglish setting listens in Hindi, which handles
// mixed speech best; what it hears is shown in Roman letters.
const SPEECH_LANG = { hinglish: "hi-IN", english: "en-IN" };
// These all work in demo mode as well as with the real assistant.
const CHIPS = ["Ramesh ko 500 udhaar diya", "300 ka kharcha", "Aaj ka hisaab", "Kitna udhaar baaki hai?"];

const $ = (id) => document.getElementById(id);
const els = {
  log: $("log"), welcome: $("welcome"), chips: $("chips"), status: $("status"), mic: $("mic"), wave: $("console-dock"),
  input: $("input"), send: $("send"), composer: $("composer"), sound: $("sound"), name: $("business-name"),
};
const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2, minimumFractionDigits: 0 });

const store = {
  get(key, fallback) { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* preference just won't persist */ } },
};

let speechMode = store.get("speech", "hinglish") === "english" ? "english" : "hinglish";
let soundOn = store.get("sound", "on") !== "off";
let busy = false;
let speaking = false;
let listening = false;
let voiceEngine = "browser";
const voiceAvailable = () => voiceEngine === "gnani" || Boolean(Recognition);

/* ---------- Rendering ---------- */

function renderChips() {
  els.chips.replaceChildren(...CHIPS.map((text) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.textContent = text;
    chip.disabled = busy;
    chip.addEventListener("click", () => send(text));
    return chip;
  }));
}

function renderSpeechMode() {
  for (const btn of document.querySelectorAll("[data-speech]")) {
    btn.setAttribute("aria-pressed", String(btn.dataset.speech === speechMode));
  }
}

function renderSound() {
  const label = soundOn ? COPY.soundOn : COPY.soundOff;
  els.sound.setAttribute("aria-pressed", String(soundOn));
  els.sound.setAttribute("aria-label", label);
  els.sound.title = label;
  $("sound-waves").toggleAttribute("hidden", !soundOn);
  $("sound-off").toggleAttribute("hidden", soundOn);
}

function renderGlance(g) {
  $("glance-sales").textContent = inr.format(g.sales_today);
  $("glance-expenses").textContent = inr.format(g.expenses_today);
  $("glance-outstanding").textContent = inr.format(g.outstanding);
  const extra = [];
  if (g.appointments_today) extra.push(`${COPY.appointments}: ${g.appointments_today}`);
  if (g.open_orders) extra.push(`${COPY.orders}: ${g.open_orders}`);
  if (g.low_stock) extra.push(`${COPY.lowStock}: ${g.low_stock}`);
  $("glance-extra").textContent = extra.join(" · ");
  $("glance-extra").hidden = !extra.length;
}

function renderBusiness(b) {
  if (b?.name) els.name.textContent = b.name;
}

function addMessage(role, text, className = "") {
  els.welcome.hidden = true;
  const el = document.createElement("div");
  el.className = `msg msg-${role} ${className}`.trim();
  el.textContent = romanize(text);
  els.log.append(el);
  scrollDown();
  return el;
}

function addLinks(links) {
  const safe = (links ?? []).map((l) => ({ ...l, url: safeUrl(l.url) })).filter((l) => l.url);
  if (!safe.length) return;
  els.welcome.hidden = true;
  const row = document.createElement("div");
  row.className = "entry-links";
  for (const link of safe) {
    const a = document.createElement("a");
    a.className = `link-chip link-${link.kind === "whatsapp" ? "wa" : "bill"}`;
    a.href = link.url;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = romanize(link.label);
    row.append(a);
  }
  els.log.append(row);
  scrollDown();
}

let toastTimer = 0;
function toast(message) {
  const t = $("toast");
  t.textContent = message;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

const refreshBook = () => dispatchEvent(new CustomEvent("munshi:refresh"));

function addAction({ id, summary, undone_at: undoneAt }) {
  els.welcome.hidden = true;
  const card = document.createElement("div");
  card.className = `entry entry-${entryKind(summary)}`;
  card.dataset.actionId = id;
  const label = document.createElement("span");
  label.className = "entry-summary";
  label.textContent = romanize(summary);
  card.append(label);
  if (undoneAt) {
    card.classList.add("undone");
  } else {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "entry-undo";
    btn.textContent = "Undo";
    btn.setAttribute("aria-label", `Undo: ${romanize(summary)}`);
    btn.addEventListener("click", () => undo(id, card, btn));
    card.append(btn);
  }
  els.log.append(card);
  scrollDown();
}

function markUndone(card) {
  card.classList.add("undone");
  card.querySelector(".entry-undo")?.remove();
}

// Only scrolls the conversation panel, never the page around it.
function scrollDown() {
  els.log.scrollTop = els.log.scrollHeight;
}

function setStatus(message) {
  if (message) els.status.textContent = message;
  else if (listening) els.status.textContent = COPY.listening;
  else if (busy) els.status.textContent = COPY.thinking;
  else if (speaking) els.status.textContent = COPY.speaking;
  else els.status.textContent = voiceAvailable() ? COPY.tapToSpeak : COPY.noMic;
  els.mic.setAttribute("aria-label", listening || speaking ? COPY.micStop : COPY.micLabel);
  els.wave.classList.toggle("is-live", listening || speaking);
  // The 3D ledger, if it's running, listens for these. The assistant doesn't depend on them.
  dispatchEvent(new CustomEvent("munshi:voice", { detail: { active: listening || speaking } }));
}

function setBusy(value) {
  busy = value;
  els.mic.disabled = value || !voiceAvailable();
  els.send.disabled = value;
  for (const chip of els.chips.children) chip.disabled = value;
  for (const btn of document.querySelectorAll("[data-try]")) btn.disabled = value;
  setStatus();
}

/* ---------- Talking to the server ---------- */

async function send(text, { spoken = false } = {}) {
  text = text.trim();
  if (!text || busy) return;
  stopSpeaking();
  addMessage("user", text);
  setBusy(true);

  let bubble = null;
  let streamed = "";
  const showText = (value) => {
    bubble ??= addMessage("assistant", "");
    bubble.textContent = romanize(value);
    scrollDown();
  };

  let finished = false;
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (res.status === 401) return showLock();
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    for await (const event of readEvents(res.body)) {
      if (event.type === "text") {
        streamed += event.delta;
        showText(streamed);
      } else if (event.type === "tool") {
        // Words written before a tool call were thinking aloud; the reply comes after.
        bubble?.remove();
        bubble = null;
        streamed = "";
      } else if (event.type === "links") {
        bubble = null;
        streamed = "";
        addLinks(event.links);
      } else if (event.type === "action") {
        bubble = null; // text after an entry belongs below its card
        streamed = "";
        addAction(event.action);
        dispatchEvent(new CustomEvent("munshi:entry", { detail: { summary: romanize(event.action.summary) } }));
      } else if (event.type === "undone") {
        const card = els.log.querySelector(`[data-action-id="${Number(event.id)}"]`);
        if (card) markUndone(card);
      } else if (event.type === "done") {
        finished = true;
        showText(event.reply);
        renderGlance(event.glance);
        renderBusiness(event.business);
        refreshBook();
        if (spoken && soundOn) speak(event.reply);
      } else if (event.type === "error") {
        finished = true;
        addMessage("assistant", event.message, "msg-error");
        renderGlance(event.glance);
        refreshBook();
        if (spoken && soundOn) speak(event.message);
      }
    }
    if (!finished) throw new Error("Stream ended early");
  } catch (err) {
    console.error(err);
    addMessage("assistant", COPY.offline, "msg-error");
  } finally {
    setBusy(false);
  }
}

async function* readEvents(body) {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += value;
    let end;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      if (line.startsWith("data: ")) yield JSON.parse(line.slice(6));
    }
  }
}

async function undo(id, card, btn) {
  btn.disabled = true;
  try {
    const res = await fetch(`/api/actions/${id}/undo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error);
    markUndone(card);
    renderGlance(body.glance);
    refreshBook();
    toast(`${COPY.undone}: ${romanize(body.undone)}`);
  } catch (err) {
    console.error(err);
    btn.disabled = false;
    toast(err.message || COPY.undoFailed);
  }
}

/* ---------- Voice ---------- */

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;

function startListening() {
  stopSpeaking();
  recognition = new Recognition();
  recognition.lang = SPEECH_LANG[speechMode];
  recognition.interimResults = true;
  recognition.continuous = false;

  let transcript = "";
  let interimBubble = null;
  let failure = null;

  recognition.onstart = () => {
    listening = true;
    els.mic.setAttribute("aria-pressed", "true");
    setStatus();
  };
  recognition.onresult = (event) => {
    transcript = Array.from(event.results, (r) => r[0].transcript).join(" ").trim();
    interimBubble ??= addMessage("user", "", "interim");
    interimBubble.textContent = romanize(transcript);
    scrollDown();
  };
  recognition.onerror = (event) => {
    failure = event.error;
  };
  recognition.onend = () => {
    listening = false;
    recognition = null;
    els.mic.setAttribute("aria-pressed", "false");
    interimBubble?.remove();
    if (transcript && (!failure || failure === "no-speech")) {
      send(transcript, { spoken: true });
    } else if (failure === "not-allowed" || failure === "service-not-allowed") {
      setStatus(COPY.micBlocked);
    } else if (failure === "aborted") {
      setStatus();
    } else if (failure && failure !== "no-speech") {
      setStatus(COPY.speechFailed);
    } else {
      setStatus(COPY.noSpeech);
    }
  };
  try {
    recognition.start();
  } catch (err) {
    console.error(err);
    recognition = null;
    setStatus(COPY.speechFailed);
  }
}

/* Gnani voice: records in the browser, sends WAV through our server, which holds the key. */

// Speech is anything clearly louder than the room. The bar is set from the first moments
// of each recording, so a quiet laptop mic and a noisy shop both work.
const CALIBRATE_MS = 400;
const SPEECH_OVER_NOISE = 2.6;
const MIN_SPEECH_LEVEL = 0.004;
const MAX_SPEECH_LEVEL = 0.009;
const SILENT_MIC_LEVEL = 0.0015; // below this the mic is muted or the wrong device
const STOP_AFTER_SILENCE_MS = 1400;
const GIVE_UP_WITHOUT_SPEECH_MS = 8000;
const MAX_RECORDING_MS = 28000; // Prisma's REST limit is 30 seconds
let recording = null;

async function startGnaniRecording() {
  stopSpeaking();
  const session = { chunks: [], heard: false, stopped: false };
  recording = session;
  listening = true;
  els.mic.setAttribute("aria-pressed", "true");
  setStatus();

  let stream, context;
  const cleanUp = () => {
    stream?.getTracks().forEach((track) => track.stop());
    context?.close().catch(() => {});
    listening = false;
    recording = null;
    els.mic.setAttribute("aria-pressed", "false");
  };

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    if (session.stopped) return cleanUp(); // tapped again while the permission prompt was up
    context = new AudioContext();
    await context.resume();
    await context.audioWorklet.addModule("/recorder-worklet.js");
    if (session.stopped) return cleanUp();
  } catch (err) {
    console.error(err);
    cleanUp();
    return setStatus(err.name === "NotAllowedError" ? COPY.micBlocked : COPY.speechFailed);
  }

  const rate = context.sampleRate;
  const startedAt = performance.now();
  let lastSoundAt = startedAt;
  const roomLevels = [];
  let speechLevel = MAX_SPEECH_LEVEL;
  let peak = 0;

  session.finish = () => {
    if (session.stopped) return;
    session.stopped = true;
    const { chunks, heard } = session;
    cleanUp();
    els.wave.style.removeProperty("--lvl");
    console.info(`Mic: loudest ${peak.toFixed(4)}, speech bar ${speechLevel.toFixed(4)}`);
    if (!heard && peak < SILENT_MIC_LEVEL) return setStatus(COPY.micSilent);
    // Even quiet sound goes to Gnani, which is better at telling speech from noise.
    if (!heard && peak < MIN_SPEECH_LEVEL / 2) return setStatus(COPY.noSpeech);
    upload(encodeWav(downsample(mergeChunks(chunks), rate)));
  };

  const source = context.createMediaStreamSource(stream);
  const recorder = new AudioWorkletNode(context, "recorder");
  recorder.port.onmessage = ({ data }) => {
    if (session.stopped) return;
    session.chunks.push(data);
    const now = performance.now();
    const level = rms(data);
    peak = Math.max(peak, level);
    if (now - startedAt < CALIBRATE_MS) {
      roomLevels.push(level);
    } else if (roomLevels.length) {
      // The quietest moments are the room; people often start talking straight away.
      const sorted = roomLevels.sort((a, b) => a - b);
      const room = sorted[Math.floor(sorted.length * 0.2)];
      speechLevel = Math.min(MAX_SPEECH_LEVEL, Math.max(MIN_SPEECH_LEVEL, room * SPEECH_OVER_NOISE));
      roomLevels.length = 0;
    }
    // The bars beside the mic follow your voice, so you can see it's listening.
    els.wave.style.setProperty("--lvl", Math.min(1, level / (speechLevel * 2)).toFixed(2));
    if (level > speechLevel && now - startedAt >= CALIBRATE_MS) {
      session.heard = true;
      lastSoundAt = now;
    }
    if ((session.heard && now - lastSoundAt > STOP_AFTER_SILENCE_MS)
      || (!session.heard && now - startedAt > GIVE_UP_WITHOUT_SPEECH_MS)
      || now - startedAt > MAX_RECORDING_MS) {
      session.finish();
    }
  };
  source.connect(recorder);
}

function stopGnaniRecording() {
  if (!recording) return;
  if (recording.finish) {
    recording.heard = true; // the owner chose to stop, so send what we have
    recording.finish();
  } else {
    recording.stopped = true; // still starting up
  }
}

async function upload(wav) {
  setBusy(true);
  let transcript = "";
  let problem = null;
  try {
    const res = await fetch(`/api/speech/transcribe?mode=${speechMode}`, {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: wav,
    });
    const body = await res.json();
    if (!res.ok) problem = body.error ?? COPY.speechFailed;
    else transcript = body.transcript;
  } catch (err) {
    console.error(err);
    problem = COPY.offline;
  }
  setBusy(false);
  if (problem) return setStatus(problem);
  if (!transcript) return setStatus(COPY.noSpeech);
  send(transcript, { spoken: true });
}

let speechRequest = 0; // lets a newer action cancel a reply that's still being fetched
let playing = null;

async function speak(text) {
  if (!text) return;
  if (voiceEngine !== "gnani") return speakWithBrowser(text);
  const thisRequest = ++speechRequest;
  speaking = true;
  setStatus();
  try {
    const res = await fetch("/api/speech/speak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: text.slice(0, 1500), mode: speechMode }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const url = URL.createObjectURL(await res.blob());
    if (thisRequest !== speechRequest) return URL.revokeObjectURL(url);
    const audio = new Audio(url);
    playing = audio;
    const finish = () => {
      URL.revokeObjectURL(url);
      if (playing !== audio) return;
      playing = null;
      speaking = false;
      setStatus();
    };
    audio.onended = finish;
    audio.onerror = () => {
      finish();
      speakWithBrowser(text);
    };
    await audio.play();
  } catch (err) {
    console.error(err);
    // A reply should still be heard if Gnani's voice is unavailable.
    if (thisRequest === speechRequest) speakWithBrowser(text);
  }
}

function speakWithBrowser(text) {
  if (!("speechSynthesis" in window) || !text) {
    speaking = false;
    return setStatus();
  }
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = SPEECH_LANG[speechMode];
  const voice = speechSynthesis.getVoices().find((v) => v.lang.replace("_", "-") === utterance.lang);
  if (voice) utterance.voice = voice;
  const finish = () => {
    speaking = false;
    setStatus();
  };
  utterance.onend = finish;
  utterance.onerror = finish;
  speaking = true;
  setStatus();
  speechSynthesis.speak(utterance);
}

function stopSpeaking() {
  speechRequest++;
  if (playing) {
    playing.pause();
    playing = null;
  }
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  speaking = false;
}

/* ---------- Wiring ---------- */

els.mic.addEventListener("click", () => {
  if (listening) {
    if (voiceEngine === "gnani") stopGnaniRecording();
    else recognition?.stop();
  } else if (speaking) {
    stopSpeaking();
    setStatus();
  } else if (voiceEngine === "gnani") {
    startGnaniRecording();
  } else {
    startListening();
  }
});

els.composer.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = els.input.value;
  if (!text.trim() || busy) return;
  els.input.value = "";
  send(text);
});

els.sound.addEventListener("click", () => {
  soundOn = !soundOn;
  store.set("sound", soundOn ? "on" : "off");
  if (!soundOn) { stopSpeaking(); setStatus(); }
  renderSound();
});

for (const btn of document.querySelectorAll("[data-speech]")) {
  btn.addEventListener("click", () => {
    speechMode = btn.dataset.speech;
    store.set("speech", speechMode);
    renderSpeechMode();
  });
}

// "Try this" buttons around the page send their phrase to the live assistant.
for (const btn of document.querySelectorAll("[data-try]")) {
  btn.addEventListener("click", () => {
    const smooth = !matchMedia("(prefers-reduced-motion: reduce)").matches;
    $("try").scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "center" });
    send(btn.dataset.try);
  });
}

// The shop book's "Try" buttons and anything else on the page can ask the assistant something.
addEventListener("munshi:say", (event) => {
  const smooth = !matchMedia("(prefers-reduced-motion: reduce)").matches;
  $("try").scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "center" });
  send(event.detail.text);
});
addEventListener("munshi:business", (event) => renderBusiness(event.detail));

// "/" jumps to the message box, like many chat apps.
addEventListener("keydown", (event) => {
  if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.target.closest?.("input, textarea, [contenteditable]")) return;
  event.preventDefault();
  els.input.focus();
});

/* ---------- PIN lock ---------- */

function showLock() {
  setBusy(false);
  $("lock-screen").hidden = false;
  document.body.classList.add("is-locked");
  $("lock-pin").focus();
}

$("lock-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const pin = $("lock-pin").value;
  $("lock-error").textContent = "";
  try {
    const res = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin }) });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || COPY.wrongPin);
    $("lock-screen").hidden = true;
    document.body.classList.remove("is-locked");
    $("lock-pin").value = "";
    init();
  } catch (err) {
    $("lock-error").textContent = err.message || COPY.wrongPin;
    $("lock-pin").select();
  }
});

async function init() {
  els.mic.disabled = !voiceAvailable();
  renderChips();
  renderSpeechMode();
  renderSound();
  setStatus();
  try {
    const res = await fetch("/api/state");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const state = await res.json();
    if (state.locked) return showLock();
    $("demo-note").hidden = !state.demo;
    // Gnani needs mic capture in the browser; without it, fall back to built-in speech.
    voiceEngine = state.voice === "gnani" && navigator.mediaDevices?.getUserMedia && window.AudioWorkletNode ? "gnani" : "browser";
    $("voice-engine").textContent = voiceEngine === "gnani" ? "Voice by Gnani Prisma and Timbre" : "Voice by your browser. Add a Gnani key for Prisma and Timbre.";
    setBusy(false);
    renderBusiness(state.business);
    renderGlance(state.glance);
    els.log.querySelectorAll(".msg, .entry, .entry-links").forEach((node) => node.remove());
    for (const m of state.messages) {
      // Same order as when it happened: entry cards, then the reply about them.
      for (const action of m.actions) addAction(action);
      addLinks(m.links);
      if (m.text) addMessage(m.role, m.text);
    }
    els.welcome.hidden = state.messages.length > 0;
    scrollDown();
    dispatchEvent(new CustomEvent("munshi:ready", { detail: { business: state.business, pin: state.pin } }));
  } catch (err) {
    console.error(err);
    setStatus(COPY.offline);
  }
}

init();
