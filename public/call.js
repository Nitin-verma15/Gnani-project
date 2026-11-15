// The nightly hisaab call. At the owner's chosen time, Counterbook "rings" on screen (and as a
// notification if the tab is in the background); answering plays the day's summary aloud,
// in Gnani's voice when it's set up, with the words on screen. "Call me now" rings at once.
import { lang, pick } from "/lang.js";

const RING_FOR_MS = 40_000;      // then it counts as missed
const LATE_WINDOW_MIN = 180;     // opening the app up to 3 hours after call time still rings
const CHECK_EVERY_MS = 15_000;

const $ = (id) => document.getElementById(id);
const els = {
  screen: $("call-screen"), what: $("call-what"), timer: $("call-timer"), lines: $("call-lines"),
  answer: $("call-answer"), decline: $("call-decline"),
  enabled: $("call-enabled"), time: $("call-time"), now: $("call-now"), status: $("call-status"),
};

let settings = { enabled: true, time: "21:00" };
let voice = "browser";
let shopKey = "shop";
let call = null; // the call in progress: { phase: "ringing" | "talking" | "ended", ... }

const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* fine */ } },
};

const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const minutesOf = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const rangKey = () => `counterbook-call-${shopKey}-${localDay()}`;
const prettyTime = (hhmm) => new Date(2000, 0, 1, Number(hhmm.slice(0, 2)), Number(hhmm.slice(3, 5)))
  .toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });

function setStatus(text) {
  els.status.textContent = text;
}

function renderSettings() {
  els.enabled.checked = settings.enabled;
  els.time.value = settings.time;
  els.time.disabled = !settings.enabled;
  setStatus(settings.enabled
    ? pick(`Har raat ${prettyTime(settings.time)} baje call aayega.`, `Calls every night at ${prettyTime(settings.time)}.`)
    : pick("Raat ka call band hai.", "The nightly call is off."));
}

async function saveSettings() {
  const next = { enabled: els.enabled.checked, time: els.time.value || "21:00" };
  try {
    const res = await fetch("/api/briefing/settings", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error);
    settings = body.call;
    renderSettings();
  } catch (err) {
    console.error(err);
    setStatus(pick("Save nahi hua, dobara try kijiye.", "Couldn't save. Please try again."));
  }
  // A call in a background tab can only get attention through a notification.
  if (next.enabled && "Notification" in window && Notification.permission === "default") {
    Notification.requestPermission().catch(() => {});
  }
}

/* ---------- Ringtone: a classic two-tone ring made on the fly, no sound file ---------- */

let audioCtx = null;
let ringTimer = null;

function startRingtone() {
  try {
    audioCtx ??= new AudioContext();
    audioCtx.resume().catch(() => {}); // browsers allow sound only after the page has been tapped once
  } catch {
    return;
  }
  const burst = (at) => {
    for (const freq of [440, 480]) {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(0.08, at + 0.02);
      gain.gain.setValueAtTime(0.08, at + 0.38);
      gain.gain.linearRampToValueAtTime(0, at + 0.4);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(at);
      osc.stop(at + 0.42);
    }
  };
  const ring = () => {
    if (audioCtx.state !== "running") return;
    const t = audioCtx.currentTime + 0.05;
    burst(t);
    burst(t + 0.6);
  };
  ring();
  ringTimer = setInterval(ring, 3000);
  navigator.vibrate?.([400, 200, 400, 2000, 400, 200, 400]);
}

function stopRingtone() {
  clearInterval(ringTimer);
  ringTimer = null;
  navigator.vibrate?.(0);
}

/* ---------- The call ---------- */

function show(phase) {
  els.screen.hidden = false;
  els.screen.dataset.phase = phase;
  els.answer.hidden = phase !== "ringing";
  els.decline.setAttribute("aria-label", phase === "ringing" ? pick("Kaato", "Decline") : pick("Call khatam karo", "End call"));
}

function close() {
  els.screen.hidden = true;
  els.lines.replaceChildren();
  els.timer.textContent = "";
  call = null;
}

function ring({ automatic }) {
  if (call) return;
  if (automatic) store.set(rangKey(), "1");
  call = { phase: "ringing", automatic };
  els.what.textContent = pick("Aaj ka hisaab · call aa raha hai…", "Today's hisaab · calling…");
  els.lines.replaceChildren();
  els.timer.textContent = "";
  show("ringing");
  startRingtone();
  els.answer.focus();
  if (document.hidden && "Notification" in window && Notification.permission === "granted") {
    try {
      const note = new Notification("Counterbook", { body: pick("Aaj ka hisaab sun lijiye. Uthane ke liye tap kijiye.", "Your daily hisaab is ready. Tap to answer."), tag: "counterbook-call", requireInteraction: true });
      note.onclick = () => { window.focus(); note.close(); };
      call.note = note;
    } catch { /* some browsers only allow notifications from a service worker */ }
  }
  call.missTimer = setTimeout(() => {
    if (call?.phase !== "ringing") return;
    end();
    setStatus(pick("Missed call. Sunne ke liye \"Abhi call karo\" dabaiye.", "Missed call. Tap \"Call me now\" to hear it."));
  }, RING_FOR_MS);
}

function startTimer() {
  const started = Date.now();
  const tick = () => {
    const s = Math.floor((Date.now() - started) / 1000);
    els.timer.textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  };
  tick();
  call.clock = setInterval(tick, 1000);
}

function highlight(index) {
  [...els.lines.children].forEach((li, i) => {
    li.classList.toggle("said", i < index);
    li.classList.toggle("saying", i === index);
  });
  els.lines.children[index]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

async function answer() {
  if (call?.phase !== "ringing") return;
  stopRingtone();
  clearTimeout(call.missTimer);
  call.note?.close();
  call.phase = "talking";
  show("talking");
  els.what.textContent = pick("Connected", "Connected");
  startTimer();
  els.decline.focus();

  const language = lang() === "english" ? "english" : "hinglish";
  let script;
  try {
    const res = await fetch(`/api/briefing?lang=${language}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    script = await res.json();
  } catch (err) {
    console.error(err);
    script = { lines: [pick("Maaf kijiye, abhi hisaab nahi mil paya. Thodi der baad try kijiye.", "Sorry, couldn't fetch today's hisaab. Please try again shortly.")] };
  }
  if (call?.phase !== "talking") return; // ended while loading
  els.lines.replaceChildren(...script.lines.map((line) => Object.assign(document.createElement("li"), { textContent: line })));
  highlight(0);
  await speakLines(script.lines, language);
  if (call?.phase === "talking") end({ finished: true });
}

/** No voice at all: still step through the lines at reading pace. */
function readAlong(lines) {
  return lines.reduce((previous, line, i) => previous.then(() => new Promise((resolve) => {
    if (call?.phase !== "talking") return resolve();
    highlight(i);
    call.stopAudio = resolve;
    setTimeout(resolve, line.length * 45);
  })), Promise.resolve());
}

/** Reads the lines aloud, moving the highlight along. Resolves when done or stopped. */
async function speakLines(lines, language) {
  if (voice === "gnani") {
    try {
      return await speakWithGnani(lines, language);
    } catch (err) {
      console.error("Gnani voice failed, using the browser's:", err);
    }
  }
  return speakWithBrowser(lines, language);
}

async function speakWithGnani(lines, language) {
  const text = lines.join(" ");
  const res = await fetch("/api/speech/speak", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: text.slice(0, 1500), mode: language }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const url = URL.createObjectURL(await res.blob());
  if (call?.phase !== "talking") return URL.revokeObjectURL(url);
  const audio = new Audio(url);
  call.audio = audio;
  // One recording for the whole call, so the highlight follows how far through it we are.
  const ends = [];
  let total = 0;
  for (const line of lines) ends.push((total += line.length + 1));
  audio.ontimeupdate = () => {
    if (!audio.duration) return;
    const reached = (audio.currentTime / audio.duration) * total;
    highlight(Math.max(0, ends.findIndex((end) => end >= reached)));
  };
  await new Promise((resolve, reject) => {
    audio.onended = resolve;
    audio.onerror = () => reject(new Error("audio failed"));
    call.stopAudio = resolve;
    audio.play().catch(reject);
  });
  URL.revokeObjectURL(url);
}

function speakWithBrowser(lines, language) {
  if (!("speechSynthesis" in window)) return readAlong(lines);
  const langCode = language === "english" ? "en-IN" : "hi-IN";
  const voiceFor = speechSynthesis.getVoices().find((v) => v.lang.replace("_", "-") === langCode);
  return lines.reduce((previous, line, i) => previous.then(() => new Promise((resolve) => {
    if (call?.phase !== "talking") return resolve();
    highlight(i);
    const u = new SpeechSynthesisUtterance(line);
    u.lang = langCode;
    if (voiceFor) u.voice = voiceFor;
    // Give each line at least reading time, so the call still plays on a device whose
    // browser has no speech voices (there, speech "finishes" instantly).
    const spoken = new Promise((done) => { u.onend = done; u.onerror = done; });
    const read = new Promise((done) => setTimeout(done, line.length * 45));
    call.stopAudio = resolve;
    Promise.all([spoken, read]).then(resolve);
    speechSynthesis.speak(u);
  })), Promise.resolve());
}

function end({ finished = false } = {}) {
  if (!call) return;
  const wasTalking = call.phase === "talking";
  stopRingtone();
  clearTimeout(call.missTimer);
  clearInterval(call.clock);
  call.note?.close();
  call.audio?.pause();
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  call.stopAudio?.();
  call.phase = "ended";
  if (!wasTalking) return close();
  if (finished) highlight(els.lines.children.length);
  els.what.textContent = pick("Call khatam", "Call ended");
  show("ended");
  setTimeout(close, finished ? 2500 : 600);
}

/* ---------- When to ring ---------- */

function check() {
  if (!settings.enabled || call) return;
  if (store.get(rangKey())) return;
  const now = new Date();
  const late = now.getHours() * 60 + now.getMinutes() - minutesOf(settings.time);
  if (late >= 0 && late < LATE_WINDOW_MIN) ring({ automatic: true });
}

/* ---------- Wiring ---------- */

els.answer.addEventListener("click", answer);
els.decline.addEventListener("click", () => {
  const ringing = call?.phase === "ringing";
  end();
  if (ringing) setStatus(pick("Call kaat diya. Baad mein \"Abhi call karo\" se sun sakte hain.", "Call declined. Tap \"Call me now\" to hear it later."));
});
els.screen.addEventListener("keydown", (e) => { if (e.key === "Escape") els.decline.click(); });
els.now.addEventListener("click", () => ring({ automatic: false }));
els.enabled.addEventListener("change", saveSettings);
els.time.addEventListener("change", saveSettings);

addEventListener("counterbook:ready", (e) => {
  const { call: saved, voice: engine, account } = e.detail ?? {};
  if (saved) settings = saved;
  voice = engine === "gnani" ? "gnani" : "browser";
  shopKey = account?.id ?? "shop";
  renderSettings();
  check();
  setInterval(check, CHECK_EVERY_MS);
  addEventListener("focus", check);
  document.addEventListener("visibilitychange", check);
});

/** For trying it out from the browser console: counterbook.ringNow(). */
window.counterbook = Object.assign(window.counterbook ?? {}, { ringNow: () => ring({ automatic: false }) });
