// The scroll story. One pinned 3D scene: a black-leather ledger with gold foil and gilded
// edges. As the page scrolls, the camera travels a path that pauses at each chapter:
//   Start      the closed book turns under a slow-moving light
//   Bolo       a gold voice waveform rises, and the spoken sentence floats above it
//   Likh diya  the cover swings open and the pen writes the sentence into the ledger
//   Hisaab     the week's sales and spending rise out of the left page as bars
//   Yaad       udhaar balances float around the book beside stacks of gold coins
// Everything is built in code; no model files load.
import * as THREE from "/vendor/three.module.min.js";

const GOLD = 0xcfae72;
const INK = "#26201b";
const INK_RED = "#962a20";
const INK_JADE = "#1d7a5b";
const HAND = "'Caveat', 'Segoe Print', cursive";
const SERIF = "'Instrument Serif', Georgia, serif";
const SANS = "'Geist', system-ui, sans-serif";
const MONO = "'Geist Mono', ui-monospace, monospace";

const COVER_W = 2.25;
const COVER_D = 3.05;
const COVER_TOP = 0.05;
const PAGE_IN = 0.045;
const PAGE_OUT = COVER_W - 0.1;
const PAGE_HALF_D = COVER_D / 2 - 0.09;
const BLOCK = 0.21;
const HINGE = COVER_TOP + BLOCK + 0.01; // the front cover swings about this height at the spine
const OPEN_TILT = 0.04;
const PW = 1024;
const PH = 1400;
const RULE_TOP = 262;
const RULE_GAP = 112;
const AMOUNT_X = PW - 300;

const SPOKEN = "Ramesh ko 500 ka saaman udhaar diya";
const WRITTEN = "Sale ₹500 to Ramesh, ₹500 on udhaar";
const SAMPLE_ROWS = ["Payment ₹200 from Sunita", "Expense ₹350, transport", "Sale ₹2,600 to Lakshmi", "Sale ₹1,450", "Order: monthly ration"];
const WEEK = [[46, 20], [70, 34], [58, 12], [96, 70], [64, 18], [110, 26], [84, 22]];
const DUES = [["Ramesh Gupta", "₹1,800", "8 days"], ["Imran Khan", "₹1,250", "8 days"], ["Sunita Devi", "₹1,000", "5 days"]];

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const smooth = (a, b, v) => {
  const t = clamp((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
/** 1 around a chapter's mark, easing to 0 either side. */
const around = (p, mark, inner = 0.07, outer = 0.14) => smooth(mark - outer, mark - inner, p) * (1 - smooth(mark + inner, mark + outer, p));

function pageHeight(d) {
  const t = Math.max(0, d - PAGE_IN);
  const rise = 1 - Math.exp(-t / 0.17);
  const droop = 1 - 0.14 * (t / (PAGE_OUT - PAGE_IN)) ** 2;
  return COVER_TOP + BLOCK * rise * droop;
}

/* ---------- Canvas helpers ---------- */

function makeCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

function texture(canvas, { srgb = true, repeat = null } = {}) {
  const t = new THREE.CanvasTexture(canvas);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  if (repeat) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(...repeat);
  }
  return t;
}

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Clean ivory ledger paper with faint red bahi-khata rules and a shadow toward the spine. */
function drawPaper(gutter) {
  const canvas = makeCanvas(PW, PH);
  const ctx = canvas.getContext("2d");
  const rand = rng(gutter === "left" ? 7 : 11);
  const base = ctx.createLinearGradient(0, 0, PW, PH);
  base.addColorStop(0, "#fbf7ec");
  base.addColorStop(1, "#f1e9d6");
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, PW, PH);
  for (let i = 0; i < 9000; i++) {
    ctx.fillStyle = rand() < 0.5 ? "rgba(110, 85, 50, .035)" : "rgba(255, 255, 255, .07)";
    ctx.fillRect(rand() * PW, rand() * PH, 1 + rand() * 1.6, 1 + rand() * 1.6);
  }
  ctx.strokeStyle = "rgba(150, 42, 32, .13)";
  ctx.lineWidth = 2;
  for (let y = RULE_TOP; y < PH - 60; y += RULE_GAP) {
    ctx.beginPath();
    ctx.moveTo(60, y);
    ctx.lineTo(PW - 60, y);
    ctx.stroke();
  }
  const vRule = (x, width) => {
    ctx.strokeStyle = "rgba(150, 42, 32, .42)";
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(x, 70);
    ctx.lineTo(x, PH - 70);
    ctx.stroke();
  };
  vRule(96, 2.5);
  vRule(104, 1.2);
  vRule(AMOUNT_X - 18, 2.5);
  vRule(AMOUNT_X - 10, 1.2);
  ctx.strokeStyle = "rgba(150, 42, 32, .4)";
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(60, 206);
  ctx.lineTo(PW - 60, 206);
  ctx.stroke();
  const vignette = ctx.createRadialGradient(PW / 2, PH / 2, PH * 0.3, PW / 2, PH / 2, PH * 0.8);
  vignette.addColorStop(0, "rgba(90, 60, 25, 0)");
  vignette.addColorStop(1, "rgba(90, 60, 25, .12)");
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, PW, PH);
  const gx = gutter === "left" ? 0 : PW;
  const shade = ctx.createLinearGradient(gx, 0, gutter === "left" ? 200 : PW - 200, 0);
  shade.addColorStop(0, "rgba(50, 35, 20, .45)");
  shade.addColorStop(0.35, "rgba(50, 35, 20, .12)");
  shade.addColorStop(1, "rgba(50, 35, 20, 0)");
  ctx.fillStyle = shade;
  ctx.fillRect(0, 0, PW, PH);
  return canvas;
}

function drawLeftPage(ctx, paper) {
  ctx.drawImage(paper, 0, 0);
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "center";
  ctx.fillStyle = INK_RED;
  ctx.font = `700 88px ${HAND}`;
  ctx.fillText("Shubh  Labh", PW / 2, 160);
  ctx.textAlign = "left";
  ctx.fillStyle = INK;
  ctx.font = `400 170px ${SERIF}`;
  ctx.fillText("Munshi", 128, 410);
  ctx.fillStyle = INK_RED;
  ctx.font = `italic 400 60px ${SERIF}`;
  ctx.fillText("the ledger that listens", 134, 488);
  ctx.font = `500 58px ${HAND}`;
  [["Kal ki bikri", "₹2,600"], ["Agarwal Traders, maal", "−₹6,500"], ["Bijli bill", "−₹1,200"]].forEach(([label, amount], i) => {
    const y = RULE_TOP + RULE_GAP * (4 + i) - 24;
    ctx.fillStyle = "rgba(60, 50, 42, .5)";
    ctx.fillText(label, 130, y);
    ctx.textAlign = "right";
    ctx.fillStyle = amount.startsWith("−") ? "rgba(150, 42, 32, .55)" : "rgba(29, 122, 91, .6)";
    ctx.fillText(amount, PW - 90, y);
    ctx.textAlign = "left";
  });
  // Where the week's bars stand when they rise
  ctx.fillStyle = "rgba(60, 50, 42, .45)";
  ctx.font = `600 34px ${MONO}`;
  ctx.fillText("THIS WEEK", 130, RULE_TOP + RULE_GAP * 7 + 40);
  ctx.strokeStyle = "rgba(38, 32, 27, .5)";
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(130, 1238);
  ctx.lineTo(PW - 120, 1238);
  ctx.stroke();
  ["M", "T", "W", "T", "F", "S", "S"].forEach((d, i) => {
    ctx.fillStyle = "rgba(60, 50, 42, .5)";
    ctx.font = `500 30px ${MONO}`;
    ctx.fillText(d, 168 + i * 104, 1288);
  });
}

function splitEntry(text) {
  const match = text.match(/₹[\d,]+(?:\.\d+)?/);
  if (!match) return { label: text, amount: "" };
  const label = (text.slice(0, match.index) + text.slice(match.index + match[0].length))
    .replace(/\s+,/g, ",").replace(/\s{2,}/g, " ").replace(/^[\s,]+|[\s,]+$/g, "");
  const out = /^(Expense|Stock)/.test(text);
  return { label, amount: `${out ? "−" : ""}${match[0]}`, out };
}

/** Right page. The first row is written up to `progress`; returns where the nib is. */
function drawRightPage(ctx, paper, rows, progress, dateText) {
  ctx.drawImage(paper, 0, 0);
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.fillStyle = INK_RED;
  ctx.font = `700 92px ${HAND}`;
  ctx.fillText("Aaj ka hisaab", 128, 168);
  ctx.textAlign = "right";
  ctx.fillStyle = "rgba(38, 32, 27, .65)";
  ctx.font = `500 50px ${HAND}`;
  ctx.fillText(dateText, PW - 90, 166);
  ctx.textAlign = "left";

  let nib = null;
  rows.slice(0, 9).forEach((text, i) => {
    const y = RULE_TOP + RULE_GAP * (i + 1) - 26;
    const { label, amount, out } = splitEntry(text);
    ctx.font = `600 62px ${HAND}`;
    let shown = label;
    while (ctx.measureText(shown).width > AMOUNT_X - 170 && shown.length > 4) shown = `${shown.slice(0, -2).trimEnd()}…`;
    const labelW = ctx.measureText(shown).width;
    ctx.font = `700 64px ${HAND}`;
    const amountW = ctx.measureText(amount).width;
    const amountX = PW - 90 - amountW;
    const p = i === 0 ? progress : 1;
    if (p <= 0) return;
    const labelPart = Math.min(1, p / 0.78);
    const amountPart = Math.max(0, (p - 0.78) / 0.22);
    if (i === 0 && p >= 1) {
      ctx.fillStyle = "rgba(207, 174, 114, .32)";
      ctx.beginPath();
      ctx.moveTo(118, y - 50);
      ctx.lineTo(PW - 76, y - 56);
      ctx.lineTo(PW - 72, y + 14);
      ctx.lineTo(112, y + 18);
      ctx.closePath();
      ctx.fill();
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, y - 90, 130 + labelW * labelPart + 4, 130);
    ctx.clip();
    ctx.fillStyle = INK;
    ctx.font = `600 62px ${HAND}`;
    ctx.fillText(shown, 130, y);
    ctx.restore();
    if (amount && amountPart > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(amountX - 4, y - 90, amountW * amountPart + 8, 130);
      ctx.clip();
      ctx.fillStyle = out ? INK_RED : INK_JADE;
      ctx.font = `700 64px ${HAND}`;
      ctx.fillText(amount, amountX, y);
      ctx.restore();
    }
    if (i === 0 && p < 1) nib = labelPart < 1 ? { x: 130 + labelW * labelPart, y: y - 14 } : { x: amountX + amountW * amountPart, y: y - 14 };
  });
  return nib;
}

/** Black leather with a gold-foil border and title. Also returns a map telling the renderer which parts are metal. */
function drawCover() {
  const W = 1024;
  const H = 1400;
  const color = makeCanvas(W, H);
  const surface = makeCanvas(W, H); // green = roughness, blue = metalness
  const c = color.getContext("2d");
  const s = surface.getContext("2d");
  const rand = rng(17);
  c.fillStyle = "#141210";
  c.fillRect(0, 0, W, H);
  for (let i = 0; i < 26000; i++) {
    const v = rand();
    c.fillStyle = v < 0.5 ? "rgba(0,0,0,.25)" : "rgba(255,240,220,.025)";
    c.fillRect(rand() * W, rand() * H, 2, 2);
  }
  s.fillStyle = "rgb(0, 200, 0)"; // leather: rough, not metal
  s.fillRect(0, 0, W, H);
  const foil = (draw) => {
    const g = c.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, "#f1d9a0");
    g.addColorStop(0.45, "#c9a463");
    g.addColorStop(1, "#e8cc8e");
    c.fillStyle = g;
    c.strokeStyle = g;
    draw(c);
    s.fillStyle = "rgb(0, 55, 255)";
    s.strokeStyle = "rgb(0, 55, 255)";
    draw(s);
  };
  foil((ctx) => {
    ctx.lineWidth = 5;
    ctx.strokeRect(70, 70, W - 140, H - 140);
    ctx.lineWidth = 2;
    ctx.strokeRect(92, 92, W - 184, H - 184);
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.font = `400 190px ${SERIF}`;
    ctx.fillText("Munshi", W / 2, 760);
    ctx.font = `500 34px ${MONO}`;
    ctx.fillText("H I S A A B   ·   K I T A A B", W / 2, 850);
    [[-36, 30], [-12, 70], [12, 46], [36, 22]].forEach(([dx, h]) => ctx.fillRect(W / 2 + dx - 6, 540 - h, 12, h * 2));
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(W / 2 - 120, 930);
    ctx.lineTo(W / 2 + 120, 930);
    ctx.stroke();
  });
  return { color, surface };
}

function drawLeatherBump(ctx) {
  const rand = rng(23);
  ctx.fillStyle = "#808080";
  ctx.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 2200; i++) {
    const x = rand() * 512;
    const y = rand() * 512;
    const r = 2 + rand() * 7;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const v = rand() < 0.5 ? 60 : 200;
    g.addColorStop(0, `rgba(${v},${v},${v},.5)`);
    g.addColorStop(1, `rgba(${v},${v},${v},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
}

function drawGildedEdge(ctx) {
  const rand = rng(5);
  for (let y = 0; y < 512; y += 3) {
    const v = 190 + Math.floor(rand() * 60);
    ctx.fillStyle = `rgb(${v}, ${v}, ${v})`;
    ctx.fillRect(0, y, 64, 3);
  }
}

function drawCoinFace(ctx) {
  const s = 512;
  const c = s / 2;
  ctx.fillStyle = "#7a7a7a";
  ctx.fillRect(0, 0, s, s);
  ctx.filter = "blur(1.5px)";
  ctx.strokeStyle = "#f2f2f2";
  ctx.lineWidth = 30;
  ctx.beginPath();
  ctx.arc(c, c, s * 0.465, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = "#e0e0e0";
  for (let i = 0; i < 56; i++) {
    const a = (i / 56) * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(c + Math.cos(a) * s * 0.405, c + Math.sin(a) * s * 0.405, 5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.font = "800 230px 'Geist', 'Segoe UI', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#ffffff";
  ctx.fillText("₹", c, c + 10);
  ctx.filter = "none";
}

function softDot(size, inner, outer) {
  const canvas = makeCanvas(size, size);
  const ctx = canvas.getContext("2d");
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, inner);
  g.addColorStop(1, outer);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return canvas;
}

/** A floating glass card with text. repaint() draws it again, e.g. once web fonts arrive. */
function makeCard(w, h, draw) {
  const canvas = makeCanvas(w, h);
  const tex = texture(canvas);
  const repaint = () => {
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, w, h);
    roundRect(ctx, 3, 3, w - 6, h - 6, Math.min(48, h / 2.4));
    ctx.fillStyle = "rgba(19, 19, 21, .84)";
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(207, 174, 114, .55)";
    ctx.stroke();
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    draw(ctx, w, h);
    tex.needsUpdate = true;
  };
  repaint();
  return { tex, repaint };
}

/* ---------- Geometry ---------- */

function pageBlockGeometry(side) {
  const N = 48;
  const pos = [];
  const uv = [];
  const idx = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const n = new THREE.Vector3();
  const quad = (verts, uvs, outward) => {
    const base = pos.length / 3;
    for (const v of verts) pos.push(v.x, v.y, v.z);
    for (const u of uvs) uv.push(u[0], u[1]);
    a.subVectors(verts[1], verts[0]);
    b.subVectors(verts[2], verts[0]);
    n.crossVectors(a, b);
    if (n.dot(outward) >= 0) idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    else idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
  };
  const xs = Array.from({ length: N + 1 }, (_, i) => {
    const t = i / N;
    return side > 0 ? PAGE_IN + t * (PAGE_OUT - PAGE_IN) : -PAGE_OUT + t * (PAGE_OUT - PAGE_IN);
  });
  const ys = xs.map((x) => pageHeight(Math.abs(x)));
  const z0 = -PAGE_HALF_D;
  const z1 = PAGE_HALF_D;
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  for (let i = 0; i < N; i++) {
    const u0 = i / N;
    const u1 = (i + 1) / N;
    quad([V(xs[i], ys[i], z0), V(xs[i + 1], ys[i + 1], z0), V(xs[i + 1], ys[i + 1], z1), V(xs[i], ys[i], z1)],
      [[u0, 1], [u1, 1], [u1, 0], [u0, 0]], V(0, 1, 0));
  }
  const topCount = idx.length;
  const bottom = COVER_TOP - 0.004;
  for (let i = 0; i < N; i++) {
    const u0 = i / N;
    const u1 = (i + 1) / N;
    quad([V(xs[i], bottom, z1), V(xs[i + 1], bottom, z1), V(xs[i + 1], ys[i + 1], z1), V(xs[i], ys[i], z1)], [[u0, 0], [u1, 0], [u1, 1], [u0, 1]], V(0, 0, 1));
    quad([V(xs[i], bottom, z0), V(xs[i + 1], bottom, z0), V(xs[i + 1], ys[i + 1], z0), V(xs[i], ys[i], z0)], [[u0, 0], [u1, 0], [u1, 1], [u0, 1]], V(0, 0, -1));
  }
  const oi = side > 0 ? N : 0;
  quad([V(xs[oi], bottom, z0), V(xs[oi], bottom, z1), V(xs[oi], ys[oi], z1), V(xs[oi], ys[oi], z0)], [[0, 0], [1, 0], [1, 1], [0, 1]], V(side, 0, 0));
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.addGroup(0, topCount, 0);
  g.addGroup(topCount, idx.length - topCount, 1);
  return g;
}

/** A cover board with softly rounded corners and edges, UVs spanning the whole board. */
function coverGeometry(side) {
  const r = 0.08;
  const x0 = side > 0 ? 0 : -COVER_W;
  const x1 = side > 0 ? COVER_W : 0;
  const y0 = -COVER_D / 2;
  const y1 = COVER_D / 2;
  const shape = new THREE.Shape();
  shape.moveTo(x0 + r, y0);
  shape.lineTo(x1 - r, y0);
  shape.quadraticCurveTo(x1, y0, x1, y0 + r);
  shape.lineTo(x1, y1 - r);
  shape.quadraticCurveTo(x1, y1, x1 - r, y1);
  shape.lineTo(x0 + r, y1);
  shape.quadraticCurveTo(x0, y1, x0, y1 - r);
  shape.lineTo(x0, y0 + r);
  shape.quadraticCurveTo(x0, y0, x0 + r, y0);
  const g = new THREE.ExtrudeGeometry(shape, { depth: 0.03, bevelEnabled: true, bevelThickness: 0.012, bevelSize: 0.014, bevelSegments: 3, curveSegments: 6 });
  g.rotateX(-Math.PI / 2);
  g.translate(0, COVER_TOP - 0.042, 0);
  const p = g.attributes.position;
  const uv = g.attributes.uv;
  for (let i = 0; i < p.count; i++) uv.setXY(i, (p.getX(i) - x0) / COVER_W, (p.getZ(i) + COVER_D / 2) / COVER_D);
  return g;
}

function ribbonGeometry(points, width) {
  const curve = new THREE.CatmullRomCurve3(points);
  const steps = 80;
  const pos = [];
  const idx = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const p = curve.getPoint(t);
    const tan = curve.getTangent(t);
    const across = new THREE.Vector3(1, 0, 0).addScaledVector(tan, -tan.x).normalize();
    pos.push(p.x - across.x * width / 2, p.y - across.y * width / 2, p.z - across.z * width / 2);
    pos.push(p.x + across.x * width / 2, p.y + across.y * width / 2, p.z + across.z * width / 2);
    if (i < steps) idx.push(i * 2, i * 2 + 2, i * 2 + 1, i * 2 + 1, i * 2 + 2, i * 2 + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function buildPen(lacquer, gold) {
  const pen = new THREE.Group();
  const barrel = new THREE.Mesh(new THREE.LatheGeometry([
    new THREE.Vector2(0, 0), new THREE.Vector2(0.034, 0.02), new THREE.Vector2(0.046, 0.12),
    new THREE.Vector2(0.05, 0.5), new THREE.Vector2(0.05, 0.92), new THREE.Vector2(0.045, 1.02),
    new THREE.Vector2(0.03, 1.08), new THREE.Vector2(0, 1.1),
  ], 32), lacquer);
  barrel.position.y = 0.3;
  const grip = new THREE.Mesh(new THREE.LatheGeometry([new THREE.Vector2(0.018, 0), new THREE.Vector2(0.03, 0.12), new THREE.Vector2(0.036, 0.3)], 24), lacquer);
  grip.position.y = 0.02;
  const nib = new THREE.Mesh(new THREE.ConeGeometry(0.026, 0.16, 3, 1, true), gold);
  nib.scale.set(1, 1, 0.35);
  nib.rotation.x = Math.PI;
  nib.position.y = 0.08;
  const ring1 = new THREE.Mesh(new THREE.TorusGeometry(0.048, 0.008, 10, 36), gold);
  ring1.rotation.x = Math.PI / 2;
  ring1.position.y = 0.42;
  const ring2 = ring1.clone();
  ring2.position.y = 1.18;
  const clip = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.42, 0.02), gold);
  clip.position.set(0, 1.08, 0.058);
  pen.add(barrel, grip, nib, ring1, ring2, clip);
  pen.traverse((o) => { o.castShadow = true; });
  return pen;
}

/* ---------- The scene ---------- */

export function startScene(canvas, { progress: readProgress, chapters = [0, 0.26, 0.5, 0.73, 0.95] }) {
  const [, BOLO, LIKH, HISAAB, YAAD] = chapters;
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const small = matchMedia("(max-width: 700px)").matches;
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);

  /* A dark studio with warm softboxes, for the gold and the leather to reflect */
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new THREE.Scene();
  room.add(new THREE.Mesh(new THREE.BoxGeometry(30, 30, 30), new THREE.MeshBasicMaterial({ color: 0x0c0b0a, side: THREE.BackSide })));
  const panel = (color, w, h, x, y, z) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }));
    m.position.set(x, y, z);
    m.lookAt(0, 0, 0);
    room.add(m);
  };
  panel(new THREE.Color(5.5, 5, 4.4), 12, 5, 0, 12, 4);
  panel(new THREE.Color(4.5, 3.4, 1.8), 2.5, 12, -12, 3, 3);
  panel(new THREE.Color(1.6, 1.5, 1.4), 2, 10, 12, 2, -3);
  panel(new THREE.Color(0.8, 0.75, 0.7), 16, 2, 0, -1, 12);
  scene.environment = pmrem.fromScene(room, 0.03).texture;

  scene.add(new THREE.HemisphereLight(0xfff1dc, 0x0a0806, 0.35));
  const key = new THREE.DirectionalLight(0xfff0dc, 2.2);
  key.position.set(4, 9, 6);
  key.castShadow = true;
  key.shadow.mapSize.set(small ? 1024 : 2048, small ? 1024 : 2048);
  Object.assign(key.shadow.camera, { left: -6, right: 6, top: 6, bottom: -6, near: 1, far: 30 });
  key.shadow.camera.updateProjectionMatrix();
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.02;
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xffd59a, 1.6);
  rim.position.set(-5, 3, -7);
  scene.add(rim);

  const world = new THREE.Group();
  scene.add(world);

  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: texture(softDot(256, "rgba(207,174,114,1)", "rgba(207,174,114,0)")), transparent: true, opacity: 0.16, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  halo.scale.set(10, 10, 1);
  halo.position.set(0, -0.6, -2.5);
  world.add(halo);

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(24, 24), new THREE.ShadowMaterial({ opacity: 0.4 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.03;
  ground.receiveShadow = true;
  world.add(ground);
  const contact = new THREE.Mesh(new THREE.PlaneGeometry(6.2, 4.4), new THREE.MeshBasicMaterial({
    map: texture(softDot(256, "rgba(0,0,0,.7)", "rgba(0,0,0,0)")), transparent: true, depthWrite: false,
  }));
  contact.rotation.x = -Math.PI / 2;
  contact.position.y = -0.025;
  world.add(contact);

  /* Materials */
  const gold = new THREE.MeshStandardMaterial({ color: GOLD, metalness: 1, roughness: 0.26, envMapIntensity: 1.4 });
  const leatherBump = texture(makeCanvas(512, 512), { srgb: false, repeat: [3, 4] });
  drawLeatherBump(leatherBump.image.getContext("2d"));
  const cover = drawCover();
  const coverMap = texture(cover.color);
  coverMap.center.set(0.5, 0.5);
  coverMap.rotation = Math.PI;
  const coverSurface = texture(cover.surface, { srgb: false });
  coverSurface.center.set(0.5, 0.5);
  coverSurface.rotation = Math.PI;
  const frontCover = new THREE.MeshPhysicalMaterial({
    map: coverMap, metalnessMap: coverSurface, roughnessMap: coverSurface, metalness: 1, roughness: 1,
    bumpMap: leatherBump, bumpScale: 0.8, clearcoat: 0.12, clearcoatRoughness: 0.75, envMapIntensity: 0.55,
  });
  const backCover = new THREE.MeshPhysicalMaterial({ color: 0x141210, roughness: 0.78, bumpMap: leatherBump, bumpScale: 0.8, clearcoat: 0.12, clearcoatRoughness: 0.75, envMapIntensity: 0.55 });
  const edgeTex = texture(makeCanvas(64, 512), { srgb: false });
  drawGildedEdge(edgeTex.image.getContext("2d"));
  const gilded = new THREE.MeshStandardMaterial({ color: 0xd8b878, metalness: 0.95, roughness: 0.32, bumpMap: edgeTex, bumpScale: 1.5, envMapIntensity: 1.3 });

  const paperLeft = drawPaper("right");
  const paperRight = drawPaper("left");
  const leftTex = texture(makeCanvas(PW, PH));
  const rightTex = texture(makeCanvas(PW, PH));
  const pageMat = (map) => new THREE.MeshStandardMaterial({ map, roughness: 0.86, envMapIntensity: 0.5 });

  /* The book: the back half stays put; the front half swings on a hinge at the spine */
  const book = new THREE.Group();
  world.add(book);
  function makeHalf(side, coverMat, map) {
    const half = new THREE.Group();
    const board = new THREE.Mesh(coverGeometry(side), coverMat);
    board.castShadow = board.receiveShadow = true;
    const pages = new THREE.Mesh(pageBlockGeometry(side), [pageMat(map), gilded]);
    pages.castShadow = pages.receiveShadow = true;
    half.add(board, pages);
    for (const zs of [-1, 1]) {
      const cx = side * (COVER_W - 0.004);
      const cz = zs * (COVER_D / 2 - 0.004);
      const along = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.07, 0.045), gold);
      along.position.set(cx - side * 0.15, COVER_TOP - 0.02, cz - zs * 0.018);
      const down = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.07, 0.3), gold);
      down.position.set(cx - side * 0.018, COVER_TOP - 0.02, cz - zs * 0.15);
      along.castShadow = down.castShadow = true;
      half.add(along, down);
    }
    return half;
  }
  const back = makeHalf(1, backCover, rightTex);
  back.rotation.z = OPEN_TILT;
  book.add(back);
  const hinge = new THREE.Group();
  hinge.position.y = HINGE;
  const front = makeHalf(-1, frontCover, leftTex);
  front.position.y = -HINGE;
  hinge.add(front);
  book.add(hinge);
  const spine = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, COVER_D - 0.02, 24, 1, false, Math.PI, Math.PI), backCover);
  spine.rotation.x = Math.PI / 2;
  spine.castShadow = true;
  book.add(spine);

  const rx = 0.18;
  const ribbon = new THREE.Mesh(ribbonGeometry([
    new THREE.Vector3(0.08, pageHeight(0.08) + 0.004, -PAGE_HALF_D - 0.02),
    new THREE.Vector3(rx - 0.04, pageHeight(rx - 0.04) + 0.004, -0.6),
    new THREE.Vector3(rx, pageHeight(rx) + 0.004, 0.6),
    new THREE.Vector3(rx + 0.02, pageHeight(rx + 0.02) + 0.003, PAGE_HALF_D - 0.02),
    new THREE.Vector3(rx + 0.03, COVER_TOP + 0.03, PAGE_HALF_D + 0.12),
    new THREE.Vector3(rx + 0.06, -0.3, PAGE_HALF_D + 0.18),
    new THREE.Vector3(rx + 0.1, -0.7, PAGE_HALF_D + 0.14),
  ], 0.08), new THREE.MeshPhysicalMaterial({ color: 0x5c1612, roughness: 0.45, sheen: 1, sheenRoughness: 0.3, sheenColor: new THREE.Color(0xffb08a), side: THREE.DoubleSide }));
  ribbon.castShadow = true;
  back.add(ribbon);

  /* The pen */
  const lacquer = new THREE.MeshPhysicalMaterial({ color: 0x0d0b0a, roughness: 0.16, clearcoat: 1, clearcoatRoughness: 0.06, envMapIntensity: 1.3 });
  const pen = buildPen(lacquer, gold);
  const penHolder = new THREE.Group();
  penHolder.add(pen);
  pen.rotation.set(-0.5, 0, -0.55);
  back.add(penHolder);
  const penRest = new THREE.Vector3(1.6, 0.9, 1.0);
  const penPos = penRest.clone();
  const pagePoint = (cx, cy, lift = 0) => {
    const x = PAGE_IN + (cx / PW) * (PAGE_OUT - PAGE_IN);
    const z = -PAGE_HALF_D + (cy / PH) * 2 * PAGE_HALF_D;
    return new THREE.Vector3(x, pageHeight(x) + lift, z);
  };

  /* Pages */
  let liveRows = SAMPLE_ROWS.slice();
  let lastWrite = -1;
  let nib = null;
  const today = () => new Date().toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });
  const drawLeft = () => {
    drawLeftPage(leftTex.image.getContext("2d"), paperLeft);
    leftTex.needsUpdate = true;
  };
  const drawRight = (progress) => {
    nib = drawRightPage(rightTex.image.getContext("2d"), paperRight, [WRITTEN, ...liveRows], progress, today());
    rightTex.needsUpdate = true;
  };
  drawLeft();
  drawRight(0);

  /* Chapter 1: the voice. A gold waveform and the sentence it carries. */
  const WAVE = small ? 44 : 64;
  const wave = new THREE.InstancedMesh(new THREE.CapsuleGeometry(0.028, 1, 4, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(GOLD).multiplyScalar(1.25), toneMapped: false, transparent: true }), WAVE);
  world.add(wave);
  const waveDummy = new THREE.Object3D();
  const cards = [];
  const spokenCard = makeCard(1400, 220, (ctx, w, h) => {
    ctx.fillStyle = "#e2c88f";
    ctx.font = `italic 400 92px ${SERIF}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(`“${SPOKEN}”`, w / 2, h / 2 + 4);
  });
  cards.push(spokenCard);
  const spoken = new THREE.Mesh(new THREE.PlaneGeometry(3.3, 0.52), new THREE.MeshBasicMaterial({ map: spokenCard.tex, transparent: true, depthWrite: false, toneMapped: false }));
  world.add(spoken);

  /* Chapter 3: the week, as bars rising from the left page */
  const barsGroup = new THREE.Group();
  front.add(barsGroup);
  const jade = new THREE.MeshStandardMaterial({ color: 0x2fa77f, roughness: 0.35, metalness: 0.1, emissive: 0x0d3a2a, emissiveIntensity: 0.6 });
  const coral = new THREE.MeshStandardMaterial({ color: 0xd9644a, roughness: 0.35, metalness: 0.1, emissive: 0x3a120a, emissiveIntensity: 0.6 });
  const barGeo = new THREE.BoxGeometry(0.075, 1, 0.075);
  barGeo.translate(0, 0.5, 0);
  const leftPoint = (cx, cy) => {
    const x = -PAGE_OUT + (cx / PW) * (PAGE_OUT - PAGE_IN);
    const z = -PAGE_HALF_D + (cy / PH) * 2 * PAGE_HALF_D;
    return new THREE.Vector3(x, pageHeight(-x), z);
  };
  const weekBars = WEEK.flatMap(([inH, outH], i) => {
    const make = (h, mat, dx) => {
      const m = new THREE.Mesh(barGeo, mat);
      m.position.copy(leftPoint(180 + i * 104 + dx, 1232));
      m.castShadow = true;
      m.userData.height = h / 110 * 0.9;
      m.scale.set(1, 0.001, 1);
      barsGroup.add(m);
      return m;
    };
    return [make(inH, jade, -4), make(outH, coral, 26)];
  });
  const weekPaint = makeCard(860, 284, (ctx) => {
    ctx.fillStyle = "#9b978e";
    ctx.font = `500 34px ${MONO}`;
    ctx.fillText("SALES THIS WEEK", 56, 92);
    ctx.fillStyle = "#f4f1ea";
    ctx.font = `400 112px ${SERIF}`;
    ctx.fillText("₹17,980", 52, 210);
    ctx.fillStyle = "#6fd0ad";
    ctx.font = `500 36px ${MONO}`;
    ctx.fillText("+12% vs last week", 440, 200);
  });
  cards.push(weekPaint);
  const weekCard = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 0.56), new THREE.MeshBasicMaterial({ map: weekPaint.tex, transparent: true, depthWrite: false, toneMapped: false }));
  world.add(weekCard);

  /* Chapter 4: who owes what, and the coins */
  const dueCards = DUES.map(([name, amount, since], i) => {
    const paint = makeCard(950, 250, (ctx) => {
        ctx.fillStyle = "#cfae72";
        ctx.beginPath();
        ctx.arc(110, 125, 52, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#17130a";
        ctx.font = `italic 400 64px ${SERIF}`;
        ctx.textAlign = "center";
        ctx.fillText(name[0], 110, 146);
        ctx.textAlign = "left";
        ctx.fillStyle = "#f4f1ea";
        ctx.font = `500 46px ${SANS}`;
        ctx.fillText(name, 196, 112);
        ctx.fillStyle = "#9b978e";
        ctx.font = `400 32px ${SANS}`;
        ctx.fillText(`Last seen ${since} ago`, 196, 168);
        ctx.textAlign = "right";
        ctx.fillStyle = "#e2c88f";
        ctx.font = `500 52px ${MONO}`;
        ctx.fillText(amount, 900, 142);
    });
    cards.push(paint);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.9, 0.5), new THREE.MeshBasicMaterial({ map: paint.tex, transparent: true, depthWrite: false, toneMapped: false }));
    world.add(mesh);
    return { mesh, i };
  });

  const faceBump = texture(makeCanvas(512, 512), { srgb: false });
  drawCoinFace(faceBump.image.getContext("2d"));
  faceBump.center.set(0.5, 0.5);
  faceBump.rotation = Math.PI / 2;
  const goldFace = new THREE.MeshStandardMaterial({ color: 0xe9c472, metalness: 1, roughness: 0.22, bumpMap: faceBump, bumpScale: 3, envMapIntensity: 1.5 });
  const goldEdge = new THREE.MeshStandardMaterial({ color: 0xc9a463, metalness: 1, roughness: 0.3, envMapIntensity: 1.4 });
  const coinGeo = new THREE.CylinderGeometry(0.2, 0.2, 0.045, 48);
  const coinMats = [goldEdge, goldFace, goldFace];
  const stacks = [[2.75, 0.4, 9], [3.2, -0.45, 6], [2.55, -1.15, 12]].map(([x, z, count]) => {
    const coins = Array.from({ length: count }, (_, k) => {
      const c = new THREE.Mesh(coinGeo, coinMats);
      c.position.set(x + Math.sin(k * 2.3) * 0.015, -0.005 + k * 0.047, z + Math.cos(k * 1.7) * 0.015);
      c.rotation.y = k * 0.7;
      c.castShadow = true;
      c.visible = false;
      world.add(c);
      return c;
    });
    return coins;
  });
  const orbitCoins = Array.from({ length: small ? 3 : 5 }, (_, i) => {
    const c = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.05, 64), coinMats);
    c.rotation.order = "YXZ";
    world.add(c);
    return { c, a: (i / 5) * Math.PI * 2, r: 3.3 + (i % 2) * 0.5, h: 0.9 + (i % 3) * 0.45, s: 0.12 + i * 0.015 };
  });

  /* Gold dust in the light */
  const DUST = small ? 70 : 150;
  const dustPos = new Float32Array(DUST * 3);
  const dr = rng(9);
  for (let i = 0; i < DUST; i++) dustPos.set([(dr() - 0.5) * 16, dr() * 6 - 1, (dr() - 0.5) * 12], i * 3);
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute("position", new THREE.BufferAttribute(dustPos, 3));
  const dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({
    size: 0.07, map: texture(softDot(64, "rgba(255,230,180,1)", "rgba(255,230,180,0)")), color: 0xe9cf98,
    transparent: true, opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
  }));
  world.add(dust);

  /* Camera path: a key per chapter, with holds in between so each chapter can be read */
  const KEYS = [
    { p: 0, pos: [5.2, 3.4, 8.2], look: [0.1, 0.25, 0] },
    { p: BOLO, pos: [0.4, 1.9, 9.2], look: [0, 0.75, 0.6] },
    { p: LIKH, pos: [0.5, 7.9, 4.2], look: [0.1, 0, 0.15] },
    { p: HISAAB, pos: [-4.6, 3.0, 5.6], look: [-0.9, 0.5, 0.2] },
    { p: YAAD, pos: [4.6, 5.0, 8.0], look: [0.8, 0.6, 0] },
  ].map((k) => ({ p: k.p, pos: new THREE.Vector3(...k.pos), look: new THREE.Vector3(...k.look) }));
  const camPos = new THREE.Vector3();
  const camLook = new THREE.Vector3();
  function cameraAt(p) {
    let i = 0;
    while (i < KEYS.length - 2 && p > KEYS[i + 1].p) i++;
    const a = KEYS[i];
    const b = KEYS[i + 1];
    const t = smooth(0.12, 0.88, clamp((p - a.p) / (b.p - a.p)));
    camPos.lerpVectors(a.pos, b.pos, t);
    camLook.lerpVectors(a.look, b.look, t);
    // Swing wide between keys instead of cutting straight through the book
    const arc = Math.sin(t * Math.PI) * 0.9;
    camPos.y += arc * 0.6;
    camPos.multiplyScalar(1 + arc * 0.06);
  }

  /* Framing: the book sits right of the text on wide screens, above it on phones */
  let fit = 1;
  function resize() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    const wide = w >= 900;
    fit = wide ? (camera.aspect < 1.5 ? 1.25 : 1.12) : 1.95;
    camera.setViewOffset(w, h, wide ? -w * 0.15 : 0, wide ? 0 : h * 0.25, w, h);
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(canvas);
  resize();

  const pointer = { x: 0, y: 0, sx: 0, sy: 0 };
  addEventListener("pointermove", (e) => {
    pointer.x = (e.clientX / innerWidth) * 2 - 1;
    pointer.y = (e.clientY / innerHeight) * 2 - 1;
  }, { passive: true });

  let time = 0;
  let eased = readProgress();
  let visible = true;
  let last = performance.now();

  function pose(dt) {
    const target = readProgress();
    eased += (target - eased) * (reducedMotion ? 1 : 1 - Math.exp(-dt * 6));
    const p = eased;
    pointer.sx += (pointer.x - pointer.sx) * (1 - Math.exp(-dt * 3));
    pointer.sy += (pointer.y - pointer.sy) * (1 - Math.exp(-dt * 3));

    cameraAt(p);
    camera.position.copy(camPos).sub(camLook).multiplyScalar(fit).add(camLook);
    camera.position.x += pointer.sx * 0.35;
    camera.position.y -= pointer.sy * 0.2;
    camera.lookAt(camLook);

    // The closed book idles and turns before the story starts, then settles.
    const settle = smooth(0.04, 0.2, p);
    const idle = reducedMotion ? 0 : 1 - settle;
    book.rotation.y = idle * (Math.sin(time * 0.35) * 0.22 - 0.35) + settle * 0;
    book.position.y = idle * (0.25 + Math.sin(time * 0.9) * 0.06);
    key.position.x = 4 + Math.sin(time * 0.25) * 3 * idle; // light sweeps across the foil

    // Chapter 2: the cover opens, then the pen writes as you scroll
    const open = smooth(LIKH - 0.16, LIKH - 0.05, p);
    hinge.rotation.z = -Math.PI * (1 - open);
    const write = smooth(LIKH - 0.04, LIKH + 0.07, p);
    const q = Math.round(write * 240) / 240;
    if (q !== lastWrite) {
      lastWrite = q;
      drawRight(q);
    }
    let penTarget;
    if (write > 0 && write < 1 && nib) {
      penTarget = pagePoint(nib.x, nib.y, 0.004 + (reducedMotion ? 0 : Math.abs(Math.sin(time * 30)) * 0.022));
    } else {
      penTarget = penRest.clone();
      penTarget.y += reducedMotion ? 0 : Math.sin(time * 1.2) * 0.04;
    }
    penPos.lerp(penTarget, write > 0 && write < 1 ? 1 - Math.exp(-dt * 24) : 1 - Math.exp(-dt * 4));
    penHolder.position.copy(penPos);
    penHolder.visible = open > 0.6;
    penHolder.scale.setScalar(smooth(0.6, 0.9, open));

    // Chapter 1: waveform and the spoken words, which then drop onto the page
    const voiceOn = around(p, BOLO, 0.06, 0.13) + smooth(BOLO, LIKH - 0.08, p) * (1 - smooth(LIKH - 0.12, LIKH - 0.04, p)) * 0.6;
    for (let i = 0; i < WAVE; i++) {
      const t = i / (WAVE - 1);
      const env = Math.sin(t * Math.PI) ** 1.4;
      const h = 0.03 + env * (0.12 + 0.42 * Math.abs(Math.sin(time * 3.1 + i * 0.47) * Math.cos(time * 1.7 + i * 0.21))) * voiceOn;
      waveDummy.position.set(-1.7 + t * 3.4, 0.05, 2.0);
      waveDummy.scale.set(1, Math.max(0.001, h), 1);
      waveDummy.updateMatrix();
      wave.setMatrixAt(i, waveDummy.matrix);
    }
    wave.instanceMatrix.needsUpdate = true;
    wave.material.opacity = clamp(voiceOn * 1.2);
    wave.visible = voiceOn > 0.01;
    const drop = smooth(BOLO + 0.06, LIKH - 0.03, p);
    const from = new THREE.Vector3(0.1, 1.25, 1.9);
    const to = back.localToWorld(pagePoint(PW * 0.45, RULE_TOP + RULE_GAP - 30, 0.02));
    spoken.position.lerpVectors(from, to, drop);
    spoken.position.y += Math.sin(drop * Math.PI) * 0.9;
    spoken.quaternion.copy(camera.quaternion);
    spoken.scale.setScalar(1 - drop * 0.6);
    spoken.material.opacity = smooth(BOLO - 0.12, BOLO - 0.05, p) * (1 - smooth(LIKH - 0.08, LIKH - 0.03, p));
    spoken.visible = spoken.material.opacity > 0.01;

    // Chapter 3: bars rise from the left page
    const rise = smooth(HISAAB - 0.1, HISAAB - 0.02, p) * (1 - smooth(HISAAB + 0.07, YAAD - 0.08, p));
    weekBars.forEach((bar, i) => {
      const stagger = smooth(i / weekBars.length * 0.5, i / weekBars.length * 0.5 + 0.5, rise);
      bar.scale.y = Math.max(0.001, bar.userData.height * stagger);
      bar.visible = stagger > 0.005;
    });
    const wc = around(p, HISAAB, 0.06, 0.12);
    weekCard.position.copy(front.localToWorld(leftPoint(PW * 0.5, 820))).add(new THREE.Vector3(0, 1.25 + (1 - wc) * 0.3, 0));
    weekCard.quaternion.copy(camera.quaternion);
    weekCard.material.opacity = wc;
    weekCard.visible = wc > 0.01;

    // Chapter 4: udhaar cards rise around the book, and coin stacks grow
    const yaad = smooth(YAAD - 0.12, YAAD - 0.03, p);
    dueCards.forEach(({ mesh, i }) => {
      const s = smooth(i * 0.18, i * 0.18 + 0.6, yaad);
      const a = -0.9 + i * 0.85;
      mesh.position.set(Math.cos(a) * 1.0 - 0.6, 1.4 + (DUES.length - 1 - i) * 0.62 + (1 - s) * -0.5 + (reducedMotion ? 0 : Math.sin(time + i) * 0.04), Math.sin(a) * 0.4 + 1.2);
      mesh.quaternion.copy(camera.quaternion);
      mesh.material.opacity = s;
      mesh.visible = s > 0.01;
    });
    stacks.forEach((coins, si) => {
      const grow = smooth(si * 0.15, si * 0.15 + 0.7, yaad);
      const shown = Math.round(grow * coins.length);
      coins.forEach((c, k) => { c.visible = k < shown; });
    });
    orbitCoins.forEach((o) => {
      const vis = 1 - smooth(BOLO - 0.1, BOLO, p) + smooth(YAAD - 0.1, YAAD, p);
      const a = o.a + time * o.s;
      o.c.position.set(Math.cos(a) * o.r, o.h + Math.sin(time + o.a) * 0.12, Math.sin(a) * o.r);
      o.c.rotation.x = Math.PI / 2 - 0.7;
      o.c.rotation.y = time * 0.6 + o.a;
      o.c.scale.setScalar(clamp(vis) * 0.9 + 0.001);
      o.c.visible = vis > 0.02;
    });

    halo.material.opacity = 0.12 + voiceOn * 0.12;
    dust.rotation.y = time * 0.015;
  }

  addEventListener("munshi:entry", (event) => {
    // Real entries from the assistant appear on the page under the story's example.
    liveRows = [event.detail.summary, ...liveRows].slice(0, 8);
    drawRight(lastWrite < 0 ? 0 : lastWrite);
  });

  function render(dt) {
    time += dt;
    pose(dt);
    renderer.render(scene, camera);
  }

  // Slow machines get a softer picture, then no shadows, rather than a stuttering story.
  let pixelRatio = renderer.getPixelRatio();
  let slow = 0;
  let frames = 0;
  function adapt(elapsed) {
    if (elapsed > 1000 || !document.hasFocus()) { slow = 0; frames = 0; return; }
    slow += elapsed;
    frames++;
    if (slow < 1500) return;
    const avg = slow / frames;
    slow = 0;
    frames = 0;
    if (avg <= 28) return;
    if (pixelRatio > 0.75) {
      pixelRatio = Math.max(0.75, pixelRatio - 0.25);
      renderer.setPixelRatio(pixelRatio);
      resize();
    } else if (renderer.shadowMap.enabled) {
      renderer.shadowMap.enabled = false;
      scene.traverse((o) => { if (o.material) [].concat(o.material).forEach((m) => { m.needsUpdate = true; }); });
    }
  }

  function frame(now) {
    requestAnimationFrame(frame);
    if (!visible || document.hidden) { last = now; return; }
    const elapsed = now - last;
    last = now;
    adapt(elapsed);
    render(Math.min(0.05, elapsed / 1000));
  }

  Promise.all([
    document.fonts?.load(`700 80px ${HAND}`),
    document.fonts?.load(`400 120px ${SERIF}`),
    document.fonts?.load(`italic 400 120px ${SERIF}`),
    document.fonts?.load(`500 40px ${MONO}`),
    document.fonts?.load(`500 40px ${SANS}`),
  ]).catch(() => {}).then(() => {
    // Everything drawn with the site's fonts is redrawn once they've arrived.
    drawLeft();
    drawRight(Math.max(0, lastWrite));
    const fresh = drawCover();
    cover.color.getContext("2d").drawImage(fresh.color, 0, 0);
    cover.surface.getContext("2d").drawImage(fresh.surface, 0, 0);
    coverMap.needsUpdate = true;
    coverSurface.needsUpdate = true;
    for (const card of cards) card.repaint();
    if (reducedMotion) render(1 / 60);
  });

  if (reducedMotion) {
    addEventListener("scroll", () => render(1 / 60), { passive: true });
    addEventListener("resize", () => render(1 / 60));
    render(1 / 60);
  } else {
    new IntersectionObserver(([e]) => { visible = e.isIntersecting; }).observe(canvas);
    requestAnimationFrame(frame);
  }
  canvas.dataset.ready = "true";
}
