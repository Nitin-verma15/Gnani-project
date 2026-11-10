// Everything that moves on the page apart from the 3D scene: the scroll story's chapters,
// the nav, and reveals. None of it is needed for the assistant to work.
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const smooth = (a, b, v) => {
  const t = clamp((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/* ---------- The story: scroll progress drives chapters ---------- */

// Where each chapter sits in the story's scroll, from 0 to 1. scene.js uses the same marks.
export const CHAPTERS = [0, 0.26, 0.5, 0.73, 0.95];

const story = document.getElementById("story");
const chapters = [...document.querySelectorAll(".chapter")];
const railItems = [...document.querySelectorAll(".story-rail li")];

export function storyProgress() {
  if (!story) return 0;
  const rect = story.getBoundingClientRect();
  const span = story.offsetHeight - innerHeight;
  return clamp(-rect.top / Math.max(1, span));
}

function updateStory() {
  const p = storyProgress();
  story.classList.toggle("is-moving", p > 0.015);
  let active = 0;
  chapters.forEach((el, i) => {
    const c = CHAPTERS[i];
    const fadeIn = i === 0 ? 1 : smooth(c - 0.13, c - 0.06, p);
    const fadeOut = i === chapters.length - 1 ? 1 : 1 - smooth(c + 0.06, c + 0.13, p);
    const o = fadeIn * fadeOut;
    if (o > 0.5) active = i;
    el.style.opacity = o.toFixed(3);
    el.classList.toggle("is-visible", o > 0.01);
    if (!reducedMotion) {
      const drift = (p - c) * -160;
      el.style.transform = `translate3d(0, ${drift.toFixed(1)}px, 0)`;
      el.style.filter = o < 0.98 ? `blur(${((1 - o) * 6).toFixed(1)}px)` : "";
    }
  });
  railItems.forEach((li, i) => li.classList.toggle("is-active", i === active));
}

/* ---------- Nav ---------- */

const nav = document.getElementById("nav");
function updateNav() {
  // Clear over the story's opening, solid once the page is underway.
  nav?.classList.toggle("is-solid", scrollY > innerHeight * 0.6);
}

let ticking = false;
function onScroll() {
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(() => {
    ticking = false;
    if (story) updateStory();
    updateNav();
  });
}
addEventListener("scroll", onScroll, { passive: true });
addEventListener("resize", onScroll);
onScroll();

/* ---------- Reveal on scroll ---------- */

function setUpReveals() {
  const targets = document.querySelectorAll("[data-reveal]");
  if (reducedMotion || !("IntersectionObserver" in window)) return;
  document.documentElement.classList.add("motion");
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add("in");
      observer.unobserve(entry.target);
    }
  }, { rootMargin: "0px 0px -10% 0px" });
  targets.forEach((el) => {
    const siblings = [...el.parentElement.children].filter((c) => c.hasAttribute("data-reveal"));
    el.style.setProperty("--delay", `${Math.min(siblings.indexOf(el), 6) * 90}ms`);
    observer.observe(el);
  });
}

/* ---------- Photos ---------- */

function setUpPhotos() {
  // Photos load from Pexels, so a card must still look right if one can't.
  for (const img of document.querySelectorAll(".photo img")) {
    const fail = () => img.closest(".photo").classList.add("photo-missing");
    img.addEventListener("error", fail);
    if (img.complete && !img.naturalWidth && img.src) fail();
  }
}

/* ---------- Account: demo shop, and "Open your shop" when signed in ---------- */

function setUpAccount() {
  const demo = document.getElementById("landing-demo");
  demo?.addEventListener("click", async () => {
    demo.disabled = true;
    try {
      const res = await fetch("/api/auth/demo", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      // A single-shop setup has no demo sign-in; its dashboard is open anyway.
      location.href = res.ok || res.status === 404 ? "/app" : "/login";
    } catch {
      location.href = "/login";
    }
  });
  fetch("/api/state").then((r) => r.json()).then((state) => {
    if (state.auth === "accounts" && !state.signedIn) return;
    const area = document.getElementById("nav-account");
    const open = Object.assign(document.createElement("a"), { className: "btn btn-gold btn-sm", href: "/app", textContent: "Open your shop" });
    if (state.account?.shop_name) {
      const name = Object.assign(document.createElement("span"), { className: "account-name", textContent: state.account.shop_name });
      area?.replaceChildren(name, open);
    } else {
      area?.replaceChildren(open);
    }
  }).catch(() => {});
}

setUpPhotos();
setUpReveals();
setUpAccount();

/* ---------- The 3D scene ---------- */

const canvas = document.getElementById("scene");
if (canvas) {
  try {
    const { startScene } = await import("/scene.js");
    startScene(canvas, { progress: storyProgress, chapters: CHAPTERS });
    document.documentElement.classList.add("has-scene");
  } catch (err) {
    // No WebGL, or the file didn't load. The chapters still read as a sequence.
    console.warn("3D scene unavailable:", err);
    canvas.remove();
  }
}
