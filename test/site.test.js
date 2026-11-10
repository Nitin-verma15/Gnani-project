import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { openDb } from "../src/db.js";
import { createApp } from "../src/server.js";
import { createDemoClient } from "../src/demo.js";

const read = (file) => readFileSync(new URL(`../public/${file}`, import.meta.url), "utf8");

// Each page, and the scripts that run on it.
const PAGES = {
  "index.html": ["motion.js"],
  "login.html": ["login.js"],
  "app.html": ["app.js", "book.js"],
};

test("every page, and every local file the pages need, is actually served", async () => {
  const server = createServer(createApp({ db: openDb(":memory:"), client: createDemoClient(), demo: true }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const paths = ["/", "/login", "/signup", "/app", "/healthz", "/recorder-worklet.js"];
    for (const page of Object.keys(PAGES)) {
      paths.push(...[...read(page).matchAll(/(?:src|href)="(\/[^"#]*)"/g)].map((m) => m[1]));
    }
    // Modules import more files, which the HTML doesn't mention.
    for (const file of ["app.js", "motion.js", "scene.js", "login.js"]) {
      paths.push(...[...read(file).matchAll(/["'](\/[\w./-]+\.js)["']/g)].map((m) => m[1]));
    }
    assert.ok(paths.includes("/vendor/three.module.min.js"));
    for (const path of new Set(paths)) {
      const res = await fetch(base + path);
      assert.equal(res.status, 200, path);
      assert.ok((await res.arrayBuffer()).byteLength > 0, `${path} is empty`);
      if (path.endsWith(".js")) assert.match(res.headers.get("content-type"), /javascript/, path);
    }
  } finally {
    server.close();
  }
});

test("every element a script looks up by id is on that script's page", () => {
  let total = 0;
  for (const [page, scripts] of Object.entries(PAGES)) {
    const html = read(page);
    for (const file of scripts) {
      for (const m of read(file).matchAll(/(?:\$|getElementById)\("([\w-]+)"\)/g)) {
        total++;
        assert.match(html, new RegExp(`id="${m[1]}"`), `#${m[1]} (used by ${file}) is missing from ${page}`);
      }
    }
  }
  assert.ok(total > 30, "found the lookups");
});

test("each page links to the others the way a visitor expects", () => {
  const landing = read("index.html");
  assert.match(landing, /href="\/signup"/);
  assert.match(landing, /href="\/login"/);
  assert.match(landing, /id="landing-demo"/);
  assert.doesNotMatch(landing, /id="try"/, "the assistant lives on /app, not the landing page");
  assert.match(read("login.js"), /location\.href = "\/app"/);
  assert.match(read("app.js"), /location\.replace\("\/login"\)/);
});

test("the scroll story has one chapter per progress label, in order", () => {
  const html = read("index.html");
  const chapters = [...html.matchAll(/data-chapter="(\d)"/g)].map((m) => Number(m[1]));
  assert.deepEqual(chapters, [0, 1, 2, 3, 4]);
  const rail = html.match(/<ol class="story-rail"[^>]*>([\s\S]*?)<\/ol>/)[1].match(/<li>/g);
  assert.equal(rail.length, chapters.length);
  assert.match(read("motion.js"), /CHAPTERS = \[0, [\d., ]+\]/);
});

test("every photo has alt text and credits its photographer", () => {
  const cards = read("index.html").split('class="photo photo-').slice(1);
  assert.equal(cards.length, 6);
  for (const card of cards) {
    assert.match(card, /<img src="https:\/\/images\.pexels\.com\/photos\/(\d+)\/pexels-photo-\1\.jpeg[^"]+" srcset="[^"]+" sizes="[^"]+" alt="[^"]{10,}"/);
    assert.match(card, /class="credit" href="https:\/\/www\.pexels\.com\/photo\/[\w-]+-\d+\/"[^>]*>Photo: [^<]+ \/ Pexels</);
  }
});
