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

test("every element the scripts look up by id is on the page", () => {
  const html = read("index.html");
  const ids = new Set();
  for (const file of ["app.js", "book.js", "motion.js"]) {
    for (const m of read(file).matchAll(/(?:\$|getElementById)\("([\w-]+)"\)/g)) ids.add(m[1]);
  }
  assert.ok(ids.size > 20, "found the lookups");
  for (const id of ids) assert.match(html, new RegExp(`id="${id}"`), `#${id} is missing from index.html`);
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
