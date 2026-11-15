// Website language: Hinglish (the default) or English.
// Text that changes carries its English version in a data-en attribute; the Hinglish
// version is whatever the page was written with. Scripts use pick() for their own text
// and onLang() to redraw when the visitor switches. The choice is remembered per browser.

const KEY = "counterbook-lang";
const LANGS = ["hinglish", "english"];
let current = "hinglish";
try {
  const saved = localStorage.getItem(KEY);
  if (LANGS.includes(saved)) current = saved;
} catch { /* storage blocked: stay on the default */ }

const listeners = new Set();

export const lang = () => current;
export const pick = (hinglish, english) => (current === "english" ? english : hinglish);
export function onLang(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function applyText() {
  for (const el of document.querySelectorAll("[data-en]")) {
    if (el.dataset.hi === undefined) el.dataset.hi = el.innerHTML;
    el.innerHTML = current === "english" ? el.dataset.en : el.dataset.hi;
  }
  for (const el of document.querySelectorAll("[data-en-label]")) {
    if (el.dataset.hiLabel === undefined) el.dataset.hiLabel = el.getAttribute("aria-label") ?? "";
    el.setAttribute("aria-label", current === "english" ? el.dataset.enLabel : el.dataset.hiLabel);
  }
  for (const button of document.querySelectorAll("[data-lang-choice]")) {
    button.setAttribute("aria-pressed", String(button.dataset.langChoice === current));
  }
}

export function setLang(next) {
  if (!LANGS.includes(next) || next === current) return;
  current = next;
  try { localStorage.setItem(KEY, next); } catch { /* fine */ }
  applyText();
  for (const fn of listeners) fn(current);
}

document.addEventListener("click", (event) => {
  const button = event.target.closest?.("[data-lang-choice]");
  if (button) setLang(button.dataset.langChoice);
});

applyText();
