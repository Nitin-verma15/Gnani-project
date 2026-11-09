// Everything that moves on the page apart from the 3D scene. None of it is needed for
// the assistant to work: if anything here fails, the page simply stays still.
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const finePointer = matchMedia("(hover: hover) and (pointer: fine)").matches;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

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
  }, { rootMargin: "0px 0px -8% 0px" });
  targets.forEach((el) => {
    const siblings = [...el.parentElement.children].filter((c) => c.hasAttribute("data-reveal"));
    el.style.setProperty("--delay", `${Math.min(siblings.indexOf(el), 6) * 70}ms`);
    observer.observe(el);
  });
}

/* ---------- Draggable, throwable, tilting cards ---------- */

const active = new Set();
let loopRunning = false;
let topLayer = 10;

function createCard(el, { draggable }) {
  const card = {
    el, draggable,
    x: 0, y: 0, vx: 0, vy: 0,
    base: Number(el.dataset.rot ?? 0),
    swing: 0, tiltX: 0, tiltY: 0, targetTiltX: 0, targetTiltY: 0,
    lift: 0, targetLift: 0,
    dragging: false, returning: false,
  };
  render(card);
  return card;
}

function render(card) {
  const { x, y, base, swing, tiltX, tiltY, lift } = card;
  card.el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) perspective(1000px) rotateX(${tiltX.toFixed(2)}deg) rotateY(${tiltY.toFixed(2)}deg) rotateZ(${(base + swing).toFixed(2)}deg) scale(${(1 + lift * 0.035).toFixed(3)})`;
}

function bounds(card) {
  const board = card.el.parentElement;
  const overhang = 18;
  return {
    minX: -card.el.offsetLeft - overhang,
    maxX: board.clientWidth - card.el.offsetLeft - card.el.offsetWidth + overhang,
    minY: -card.el.offsetTop - overhang,
    maxY: board.clientHeight - card.el.offsetTop - card.el.offsetHeight + overhang,
  };
}

function wake(card) {
  active.add(card);
  if (loopRunning) return;
  loopRunning = true;
  let last = performance.now();
  requestAnimationFrame(function loop(now) {
    const steps = Math.min(3, (now - last) / 16.67);
    last = now;
    for (const c of active) if (!step(c, steps)) active.delete(c);
    if (active.size) requestAnimationFrame(loop);
    else loopRunning = false;
  });
}

/** Advances one card and returns whether it's still moving. */
function step(card, steps) {
  const smooth = 1 - 0.82 ** steps;
  card.tiltX += (card.targetTiltX - card.tiltX) * smooth;
  card.tiltY += (card.targetTiltY - card.tiltY) * smooth;
  card.lift += (card.targetLift - card.lift) * smooth;

  if (card.returning) {
    card.x += -card.x * (1 - 0.86 ** steps);
    card.y += -card.y * (1 - 0.86 ** steps);
    if (Math.abs(card.x) + Math.abs(card.y) < 0.4) {
      card.x = 0;
      card.y = 0;
      card.returning = false;
    }
  } else if (!card.dragging && (card.vx || card.vy)) {
    card.x += card.vx * steps;
    card.y += card.vy * steps;
    const limit = bounds(card);
    if (card.x < limit.minX || card.x > limit.maxX) {
      card.x = clamp(card.x, limit.minX, limit.maxX);
      card.vx *= -0.55;
    }
    if (card.y < limit.minY || card.y > limit.maxY) {
      card.y = clamp(card.y, limit.minY, limit.maxY);
      card.vy *= -0.55;
    }
    const friction = 0.93 ** steps;
    card.vx *= friction;
    card.vy *= friction;
    if (Math.hypot(card.vx, card.vy) < 0.08) {
      card.vx = 0;
      card.vy = 0;
    }
  }

  const swingTarget = clamp(card.vx * 0.55, -11, 11);
  card.swing += (swingTarget - card.swing) * smooth;
  render(card);

  return card.dragging || card.returning || Boolean(card.vx || card.vy)
    || Math.abs(card.targetTiltX - card.tiltX) > 0.02 || Math.abs(card.targetTiltY - card.tiltY) > 0.02
    || Math.abs(card.targetLift - card.lift) > 0.005 || Math.abs(card.swing - swingTarget) > 0.02;
}

function attachTilt(card) {
  const { el } = card;
  el.addEventListener("pointermove", (event) => {
    if (event.pointerType !== "mouse") return;
    const rect = el.getBoundingClientRect();
    const px = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    const py = clamp((event.clientY - rect.top) / rect.height, 0, 1);
    el.style.setProperty("--mx", `${(px * 100).toFixed(1)}%`);
    el.style.setProperty("--my", `${(py * 100).toFixed(1)}%`);
    if (card.dragging) return;
    card.targetTiltY = (px - 0.5) * 13;
    card.targetTiltX = (0.5 - py) * 13;
    card.targetLift = Math.max(card.targetLift, 0.5);
    wake(card);
  });
  el.addEventListener("pointerleave", () => {
    if (card.dragging) return;
    card.targetTiltX = 0;
    card.targetTiltY = 0;
    card.targetLift = 0;
    wake(card);
  });
}

function attachDrag(card) {
  const { el } = card;
  let start = null;
  let lastMove = null;

  el.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target.closest("a, button")) return;
    start = { px: event.clientX, py: event.clientY, x: card.x, y: card.y };
    lastMove = { x: event.clientX, y: event.clientY, t: event.timeStamp };
    card.returning = false;
    card.vx = 0;
    card.vy = 0;
  });

  el.addEventListener("pointermove", (event) => {
    if (!start) return;
    const dx = event.clientX - start.px;
    const dy = event.clientY - start.py;
    if (!card.dragging) {
      if (Math.hypot(dx, dy) < 5) return;
      card.dragging = true;
      el.setPointerCapture(event.pointerId);
      el.classList.add("dragging");
      el.style.zIndex = String(++topLayer);
      card.targetTiltX = 0;
      card.targetTiltY = 0;
      card.targetLift = 1;
      document.documentElement.classList.add("has-moved-card");
      wake(card);
    }
    const limit = bounds(card);
    card.x = clamp(start.x + dx, limit.minX, limit.maxX);
    card.y = clamp(start.y + dy, limit.minY, limit.maxY);
    const dt = Math.max(1, event.timeStamp - lastMove.t);
    card.vx = ((event.clientX - lastMove.x) / dt) * 16.67;
    card.vy = ((event.clientY - lastMove.y) / dt) * 16.67;
    lastMove = { x: event.clientX, y: event.clientY, t: event.timeStamp };
    wake(card);
  });

  const release = (event) => {
    start = null;
    if (!card.dragging) return;
    card.dragging = false;
    el.classList.remove("dragging");
    card.targetLift = 0;
    // A pause before letting go means a drop, not a throw.
    if (event.type === "pointercancel" || reducedMotion || event.timeStamp - lastMove.t > 90) {
      card.vx = 0;
      card.vy = 0;
    } else {
      card.vx = clamp(card.vx, -42, 42);
      card.vy = clamp(card.vy, -42, 42);
    }
    wake(card);
  };
  el.addEventListener("pointerup", release);
  el.addEventListener("pointercancel", release);

  // Keyboard users can move cards too.
  el.addEventListener("keydown", (event) => {
    const move = { ArrowLeft: [-28, 0], ArrowRight: [28, 0], ArrowUp: [0, -28], ArrowDown: [0, 28] }[event.key];
    if (!move || event.target !== el) return;
    event.preventDefault();
    const limit = bounds(card);
    card.returning = false;
    card.x = clamp(card.x + move[0], limit.minX, limit.maxX);
    card.y = clamp(card.y + move[1], limit.minY, limit.maxY);
    el.style.zIndex = String(++topLayer);
    document.documentElement.classList.add("has-moved-card");
    wake(card);
  });
}

function setUpCards() {
  for (const board of document.querySelectorAll("[data-board]")) {
    const cards = [...board.querySelectorAll(":scope > .movable")].map((el) => {
      const card = createCard(el, { draggable: true });
      if (!reducedMotion && finePointer) attachTilt(card);
      attachDrag(card);
      return card;
    });
    board.closest("section")?.querySelector("[data-board-reset]")?.addEventListener("click", () => {
      for (const card of cards) {
        card.vx = 0;
        card.vy = 0;
        if (reducedMotion) {
          card.x = 0;
          card.y = 0;
          render(card);
        } else {
          card.returning = true;
          wake(card);
        }
      }
    });
    addEventListener("resize", () => {
      for (const card of cards) {
        const limit = bounds(card);
        card.x = clamp(card.x, limit.minX, limit.maxX);
        card.y = clamp(card.y, limit.minY, limit.maxY);
        render(card);
      }
    });
  }
  if (!reducedMotion && finePointer) {
    for (const el of document.querySelectorAll(".tilt")) attachTilt(createCard(el, { draggable: false }));
  }
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

setUpPhotos();
setUpReveals();
setUpCards();

/* ---------- The 3D scene ---------- */

const canvas = document.getElementById("scene");
if (canvas) {
  try {
    const { startScene } = await import("/scene.js");
    startScene(canvas);
    document.documentElement.classList.add("has-scene");
  } catch (err) {
    // No WebGL, or the file didn't load. The page's gradient background carries on alone.
    console.warn("3D scene unavailable:", err);
    canvas.remove();
  }
}
