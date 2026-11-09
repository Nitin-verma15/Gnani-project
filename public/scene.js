// The living ledger: an open 3D bahi-khata with orbiting rupee coins and a ring of
// sound bars. It glides across the page on scroll, pulses with the voice, and writes
// each real entry onto its page. Everything is built in code, so no model files load.
import * as THREE from "/vendor/three.module.min.js";

const BLUE = 0x1f5cff;
const SAND = 0xf4eddd;
const INK = "#232120";
const COVER_W = 2.25;
const COVER_D = 3.05;
const COIN_COUNT = 11;
const BURST_SIZE = 16;
const BAR_COUNT = 64;
const SAMPLE_ROWS = [
  "Sale ₹1,450",
  "Payment ₹500 from Ramesh",
  "Expense ₹350, transport",
  "Sale ₹2,600",
  "Order: monthly ration",
];

function canvasTexture(width, height, draw) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  draw(canvas.getContext("2d"));
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

function coinFace(ctx) {
  const s = 256;
  const gold = ctx.createRadialGradient(s * 0.38, s * 0.32, 10, s / 2, s / 2, s * 0.56);
  gold.addColorStop(0, "#fff0bf");
  gold.addColorStop(0.55, "#e2bd6a");
  gold.addColorStop(1, "#a97f33");
  ctx.fillStyle = gold;
  ctx.fillRect(0, 0, s, s);
  ctx.strokeStyle = "rgba(92, 62, 14, .55)";
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.arc(s / 2, s / 2, s * 0.41, 0, Math.PI * 2);
  ctx.stroke();
  ctx.font = "800 150px 'Instrument Sans', 'Noto Sans', 'DejaVu Sans', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#5e4210";
  ctx.fillText("₹", s / 2, s / 2 + 6);
}

function drawRules(ctx, w, h, top, gap) {
  ctx.fillStyle = "#f7f1e3";
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = "rgba(31, 92, 255, .24)";
  ctx.lineWidth = 2;
  for (let y = top; y < h - 30; y += gap) {
    ctx.beginPath();
    ctx.moveTo(40, y);
    ctx.lineTo(w - 40, y);
    ctx.stroke();
  }
  ctx.strokeStyle = "rgba(31, 92, 255, .55)";
  ctx.beginPath();
  ctx.moveTo(92, 40);
  ctx.lineTo(92, h - 40);
  ctx.stroke();
}

function drawLeftPage(ctx, w, h) {
  drawRules(ctx, w, h, 240, 96);
  ctx.fillStyle = INK;
  ctx.font = "800 136px 'Bricolage Grotesque', system-ui, sans-serif";
  ctx.fillText("Munshi", 120, 160);
  ctx.fillStyle = "#1f5cff";
  ctx.font = "600 52px 'Instrument Sans', system-ui, sans-serif";
  ctx.fillText("The ledger that listens", 122, 228);
  const bars = [46, 90, 62, 124, 78, 150, 96, 58, 112, 70, 40, 84];
  bars.forEach((height, i) => {
    ctx.fillStyle = "#1f5cff";
    ctx.fillRect(130 + i * 44, h * 0.56 - height / 2, 22, height);
  });
}

function drawRightPage(ctx, w, h, rows) {
  drawRules(ctx, w, h, 196, 132);
  ctx.fillStyle = INK;
  ctx.font = "800 84px 'Bricolage Grotesque', system-ui, sans-serif";
  ctx.fillText("Today", 120, 142);
  rows.slice(0, 8).forEach((row, i) => {
    const y = 302 + i * 132;
    const fresh = i === 0 && row.fresh;
    ctx.fillStyle = fresh ? "#1f5cff" : INK;
    ctx.font = `${fresh ? 800 : 600} 60px 'Instrument Sans', system-ui, sans-serif`;
    let text = row.text;
    while (ctx.measureText(text).width > w - 170 && text.length > 4) text = `${text.slice(0, -2).trimEnd()}…`;
    ctx.fillText(text, 120, y);
  });
}

export function startScene(canvas) {
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
  camera.position.z = 12;

  scene.add(new THREE.HemisphereLight(0xfff1d6, 0x1c2a66, 1.5));
  const sun = new THREE.DirectionalLight(0xfff0d0, 2.6);
  sun.position.set(4, 7, 8);
  scene.add(sun);
  const glow = new THREE.PointLight(BLUE, 16, 16);
  glow.position.set(-3, -2.5, 3);
  scene.add(glow);

  const rig = new THREE.Group();
  scene.add(rig);

  /* The book */
  const book = new THREE.Group();
  rig.add(book);
  const coverMaterial = new THREE.MeshStandardMaterial({ color: BLUE, roughness: 0.42, metalness: 0.1 });
  const edgeMaterial = new THREE.MeshStandardMaterial({ color: 0xe5d9bf, roughness: 0.95 });
  const pageW = 1024;
  const pageH = 1400;
  let rows = SAMPLE_ROWS.map((text) => ({ text }));
  const leftTexture = canvasTexture(pageW, pageH, (ctx) => drawLeftPage(ctx, pageW, pageH));
  const rightTexture = canvasTexture(pageW, pageH, (ctx) => drawRightPage(ctx, pageW, pageH, rows));
  const redrawRight = () => {
    drawRightPage(rightTexture.image.getContext("2d"), pageW, pageH, rows);
    rightTexture.needsUpdate = true;
  };

  function makeHalf(side, texture) {
    const half = new THREE.Group();
    const cover = new THREE.Mesh(new THREE.BoxGeometry(COVER_W, 0.07, COVER_D), coverMaterial);
    cover.position.x = side * (COVER_W / 2);
    const pageMaterial = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.9, color: 0xffffff });
    const pages = new THREE.Mesh(
      new THREE.BoxGeometry(COVER_W - 0.12, 0.24, COVER_D - 0.14),
      [edgeMaterial, edgeMaterial, pageMaterial, edgeMaterial, edgeMaterial, edgeMaterial],
    );
    pages.position.set(side * (COVER_W / 2 - 0.02), 0.155, 0);
    half.add(cover, pages);
    half.rotation.z = side * 0.055;
    book.add(half);
  }
  makeHalf(-1, leftTexture);
  makeHalf(1, rightTexture);
  const spine = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, COVER_D, 16), coverMaterial);
  spine.rotation.x = Math.PI / 2;
  spine.position.y = 0.02;
  book.add(spine);

  /* A page that turns whenever an entry is written */
  const flipPivot = new THREE.Group();
  flipPivot.position.y = 0.31;
  const flipGeometry = new THREE.PlaneGeometry(COVER_W - 0.14, COVER_D - 0.16);
  flipGeometry.rotateX(-Math.PI / 2);
  flipGeometry.translate((COVER_W - 0.14) / 2, 0, 0);
  flipPivot.add(new THREE.Mesh(flipGeometry, new THREE.MeshStandardMaterial({ color: SAND, roughness: 0.85, side: THREE.DoubleSide })));
  flipPivot.visible = false;
  book.add(flipPivot);
  let flip = -1;

  /* Sound bars ringed around the book */
  const barMaterial = new THREE.MeshStandardMaterial({ color: BLUE, emissive: BLUE, emissiveIntensity: 0.9, roughness: 0.3 });
  const bars = new THREE.InstancedMesh(new THREE.BoxGeometry(0.075, 1, 0.075), barMaterial, BAR_COUNT);
  rig.add(bars);
  const barMatrix = new THREE.Object3D();

  /* Coins */
  const coinGeometry = new THREE.CylinderGeometry(0.36, 0.36, 0.075, 48);
  const faceTexture = canvasTexture(256, 256, coinFace);
  // A cylinder's cap maps textures a quarter-turn off, which would lay the ₹ on its side.
  faceTexture.center.set(0.5, 0.5);
  faceTexture.rotation = Math.PI / 2;
  // There's no environment map to reflect, so real metalness would render nearly black.
  // A low metalness plus a little self-glow reads as bright gold.
  const faceMaterial = new THREE.MeshStandardMaterial({
    map: faceTexture, emissive: 0xffffff, emissiveMap: faceTexture, emissiveIntensity: 0.34, metalness: 0.12, roughness: 0.42,
  });
  const coinMaterials = [
    new THREE.MeshStandardMaterial({ color: 0xd9ad57, emissive: 0x6b4c14, emissiveIntensity: 0.6, metalness: 0.2, roughness: 0.36 }),
    faceMaterial,
    faceMaterial,
  ];
  const orbiters = Array.from({ length: COIN_COUNT }, (_, i) => {
    const mesh = new THREE.Mesh(coinGeometry, coinMaterials);
    const scale = 0.7 + ((i * 37) % 10) / 22;
    mesh.scale.setScalar(scale);
    mesh.rotation.order = "YXZ";
    rig.add(mesh);
    return {
      mesh,
      angle: (i / COIN_COUNT) * Math.PI * 2,
      radius: 2.75 + ((i * 53) % 10) / 13,
      height: 0.55 + ((i * 29) % 10) / 9,
      speed: 0.14 + ((i * 17) % 10) / 90,
      spin: 0.6 + ((i * 41) % 10) / 8,
      phase: i * 1.7,
    };
  });

  /* Coins thrown up when an entry lands */
  const burstPool = Array.from({ length: BURST_SIZE }, () => {
    const mesh = new THREE.Mesh(coinGeometry, coinMaterials);
    mesh.visible = false;
    scene.add(mesh);
    return { mesh, life: 0, velocity: new THREE.Vector3(), spin: new THREE.Vector3() };
  });

  /* Dust in the light */
  const dustCount = 170;
  const dustPositions = new Float32Array(dustCount * 3);
  for (let i = 0; i < dustCount * 3; i += 3) {
    dustPositions[i] = (Math.random() - 0.5) * 18;
    dustPositions[i + 1] = (Math.random() - 0.5) * 10;
    dustPositions[i + 2] = (Math.random() - 0.5) * 6;
  }
  const dustGeometry = new THREE.BufferGeometry();
  dustGeometry.setAttribute("position", new THREE.BufferAttribute(dustPositions, 3));
  const dust = new THREE.Points(dustGeometry, new THREE.PointsMaterial({ color: 0xe9dfca, size: 0.035, transparent: true, opacity: 0.55, depthWrite: false }));
  scene.add(dust);

  /* Layout: where the book sits at each end of the scroll */
  const layout = { heroX: 0, heroY: 0, tryX: 0, tryY: 0, scale: 1, tryScale: 1 };
  const stage = canvas.parentElement;
  const trySection = document.getElementById("try-section");
  let scrollSpan = 1;

  function resize() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    const visibleH = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.position.z;
    const visibleW = visibleH * camera.aspect;
    if (w >= 1000) {
      layout.scale = Math.min(0.92, (visibleW * 0.46) / 7.2, (visibleH * 0.82) / 6.4);
      layout.heroX = visibleW * 0.255;
      layout.heroY = -0.05;
      // Beside the assistant it shrinks and drops, leaving the heading above it clear.
      layout.tryScale = layout.scale * 0.68;
      layout.tryX = -visibleW * 0.255;
      layout.tryY = -visibleH * 0.235;
    } else {
      layout.scale = Math.min(0.56, (visibleW * 0.9) / 7.2);
      layout.tryScale = layout.scale;
      layout.heroX = 0;
      layout.heroY = -visibleH * 0.335;
      layout.tryX = 0;
      layout.tryY = -visibleH * 0.335;
    }
    const navHeight = 84;
    scrollSpan = Math.max(1, trySection.offsetTop - stage.offsetTop - navHeight);
  }
  new ResizeObserver(resize).observe(canvas);
  resize();

  const pointer = { x: 0, y: 0, sx: 0, sy: 0 };
  addEventListener("pointermove", (event) => {
    pointer.x = (event.clientX / innerWidth) * 2 - 1;
    pointer.y = (event.clientY / innerHeight) * 2 - 1;
  }, { passive: true });

  let voiceTarget = 0;
  let voice = 0;
  let scrollEased = Math.min(1, scrollY / scrollSpan);
  let visible = true;
  let time = 0;
  let last = performance.now();

  function pose(dt) {
    const scroll = Math.min(1, Math.max(0, scrollY / scrollSpan));
    const ease = reducedMotion ? 1 : 1 - Math.exp(-dt * 5);
    scrollEased += (scroll - scrollEased) * ease;
    const p = scrollEased * scrollEased * (3 - 2 * scrollEased);
    pointer.sx += (pointer.x - pointer.sx) * ease;
    pointer.sy += (pointer.y - pointer.sy) * ease;
    voice += (voiceTarget - voice) * (reducedMotion ? 1 : 1 - Math.exp(-dt * 6));

    const float = reducedMotion ? 0 : Math.sin(time * 0.8) * 0.09;
    rig.position.x = THREE.MathUtils.lerp(layout.heroX, layout.tryX, p);
    rig.position.y = THREE.MathUtils.lerp(layout.heroY, layout.tryY, p) + float;
    rig.scale.setScalar(THREE.MathUtils.lerp(layout.scale, layout.tryScale, p) * (1 + voice * 0.035));
    rig.rotation.x = 0.92 + pointer.sy * 0.14 + (reducedMotion ? 0 : Math.sin(time * 0.55) * 0.025);
    rig.rotation.y = THREE.MathUtils.lerp(-0.34, 0.36, p) + pointer.sx * 0.24;
    rig.rotation.z = THREE.MathUtils.lerp(0.05, -0.05, p) + (reducedMotion ? 0 : Math.sin(time * 0.4) * 0.02);

    for (let i = 0; i < BAR_COUNT; i++) {
      const angle = (i / BAR_COUNT) * Math.PI * 2;
      const wave = Math.abs(Math.sin(time * 2.1 + i * 0.52)) * 0.55 + Math.abs(Math.sin(time * 3.4 + i * 1.31)) * 0.45;
      const height = 0.1 + wave * (0.34 + voice * 1.55);
      barMatrix.position.set(Math.cos(angle) * 2.95, -0.1 + height / 2, Math.sin(angle) * 2.95);
      barMatrix.scale.set(1, height, 1);
      barMatrix.rotation.y = -angle;
      barMatrix.updateMatrix();
      bars.setMatrixAt(i, barMatrix.matrix);
    }
    bars.instanceMatrix.needsUpdate = true;
    barMaterial.emissiveIntensity = 0.75 + voice * 1.3;

    for (const coin of orbiters) {
      const angle = coin.angle + time * coin.speed * (1 + voice);
      coin.mesh.position.set(
        Math.cos(angle) * coin.radius,
        coin.height + Math.sin(time * 1.1 + coin.phase) * 0.22,
        Math.sin(angle) * coin.radius,
      );
      // Turn like a coin on a string, with the face tipped back toward the camera.
      coin.mesh.rotation.x = Math.PI / 2 - 0.62 + Math.sin(time * 0.7 + coin.phase) * 0.12;
      coin.mesh.rotation.y = Math.sin(time * coin.spin * 0.55 + coin.phase) * 0.95;
    }

    dust.rotation.y = time * 0.012;
    dust.position.y = Math.sin(time * 0.2) * 0.15;
    glow.intensity = 16 + voice * 60;
  }

  function stepEffects(dt) {
    if (flip >= 0) {
      flip += dt / 0.8;
      flipPivot.visible = flip < 1;
      flipPivot.rotation.z = Math.PI * (flip * flip * (3 - 2 * flip));
      if (flip >= 1) flip = -1;
    }
    for (const coin of burstPool) {
      if (coin.life <= 0) continue;
      coin.life -= dt;
      coin.velocity.y -= dt * 7.5;
      coin.mesh.position.addScaledVector(coin.velocity, dt);
      coin.mesh.rotation.x += coin.spin.x * dt;
      coin.mesh.rotation.z += coin.spin.z * dt;
      coin.mesh.scale.setScalar(Math.min(1, coin.life * 2) * 0.85 * layout.scale);
      coin.mesh.visible = coin.life > 0;
    }
  }

  function throwCoins() {
    const origin = new THREE.Vector3();
    rig.getWorldPosition(origin);
    burstPool.forEach((coin, i) => {
      coin.life = 1.5 + Math.random() * 0.7;
      coin.mesh.visible = true;
      coin.mesh.position.copy(origin);
      coin.mesh.position.z += 0.8;
      const angle = (i / BURST_SIZE) * Math.PI * 2 + Math.random() * 0.4;
      coin.velocity.set(Math.cos(angle) * (1.6 + Math.random() * 2.2), 4.4 + Math.random() * 2.6, 0.4 + Math.random() * 1.2);
      coin.spin.set((Math.random() - 0.5) * 16, 0, (Math.random() - 0.5) * 16);
    });
  }

  addEventListener("munshi:entry", (event) => {
    rows = [{ text: event.detail.summary, fresh: true }, ...rows.map(({ text }) => ({ text }))];
    redrawRight();
    if (reducedMotion) return renderOnce();
    flip = 0;
    throwCoins();
  });
  addEventListener("munshi:voice", (event) => {
    voiceTarget = event.detail.active ? 1 : 0;
    if (reducedMotion) renderOnce();
  });

  function renderOnce() {
    pose(1 / 60);
    renderer.render(scene, camera);
  }

  // A slow laptop gets a slightly softer picture rather than a stuttering demo.
  let pixelRatio = renderer.getPixelRatio();
  let slowWindow = 0;
  let framesInWindow = 0;
  function adaptQuality(elapsed) {
    // Browsers throttle unfocused windows, which says nothing about this machine's speed.
    if (elapsed > 1000 || !document.hasFocus()) {
      slowWindow = 0;
      framesInWindow = 0;
      return;
    }
    slowWindow += elapsed;
    framesInWindow++;
    if (slowWindow < 1500) return;
    const average = slowWindow / framesInWindow;
    slowWindow = 0;
    framesInWindow = 0;
    if (average > 28 && pixelRatio > 0.75) {
      pixelRatio = Math.max(0.75, pixelRatio - 0.25);
      renderer.setPixelRatio(pixelRatio);
      resize();
      canvas.dataset.quality = String(pixelRatio);
    }
  }

  function frame(now) {
    requestAnimationFrame(frame);
    if (!visible || document.hidden) {
      last = now;
      return;
    }
    const elapsed = now - last;
    const dt = Math.min(0.05, elapsed / 1000);
    last = now;
    time += dt;
    adaptQuality(elapsed);
    pose(dt);
    stepEffects(dt);
    renderer.render(scene, camera);
  }

  // Pages use the site's fonts, which may arrive after the first draw.
  document.fonts?.ready.then(() => {
    drawLeftPage(leftTexture.image.getContext("2d"), pageW, pageH);
    leftTexture.needsUpdate = true;
    coinFace(faceTexture.image.getContext("2d"));
    faceTexture.needsUpdate = true;
    redrawRight();
    if (reducedMotion) renderOnce();
  });

  if (reducedMotion) {
    addEventListener("scroll", renderOnce, { passive: true });
    addEventListener("resize", renderOnce);
    renderOnce();
  } else {
    // Stop drawing once the stage has scrolled away, to save the battery.
    new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; }).observe(stage);
    requestAnimationFrame(frame);
  }
  canvas.dataset.ready = "true";
}
