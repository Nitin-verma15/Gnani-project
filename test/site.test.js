import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { openDb } from "../src/db.js";
import { createApp } from "../src/server.js";
import { createDemoClient } from "../src/demo.js";

const read = (file) => readFileSync(new URL(`../public/${file}`, import.meta.url), "utf8");

test("every local file the site needs is actually served", async () => {
  const server = createServer(createApp({ db: openDb(":memory:"), client: createDemoClient(), demo: true }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const html = read("index.html");
    const paths = [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((m) => m[1]);
    // Modules import more files, which the HTML doesn't mention.
    for (const file of ["app.js", "motion.js", "scene.js"]) {
      paths.push(...[...read(file).matchAll(/["'](\/[\w./-]+\.js)["']/g)].map((m) => m[1]));
    }
    paths.push("/recorder-worklet.js");
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

test("card boards are positioned, or thrown cards would fly off the page", () => {
  assert.match(read("style.css"), /\[data-board\]\s*\{\s*position:\s*relative;/);
  assert.ok(read("index.html").match(/data-board>/g).length >= 2);
});

test("every photo has alt text and credits its photographer", () => {
  const cards = read("index.html").split('class="photo photo-').slice(1);
  assert.equal(cards.length, 6);
  for (const card of cards) {
    assert.match(card, /<img src="https:\/\/images\.pexels\.com\/photos\/(\d+)\/pexels-photo-\1\.jpeg[^"]+" srcset="[^"]+" sizes="[^"]+" alt="[^"]{10,}"/);
    assert.match(card, /class="credit" href="https:\/\/www\.pexels\.com\/photo\/[\w-]+-\d+\/"[^>]*>Photo: [^<]+ \/ Pexels</);
  }
});
