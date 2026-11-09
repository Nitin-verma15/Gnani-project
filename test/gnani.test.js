import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { openDb } from "../src/db.js";
import { createApp } from "../src/server.js";
import { createDemoClient } from "../src/demo.js";
import { createGnani, GnaniError } from "../src/gnani.js";
import { downsample, encodeWav, mergeChunks, rms } from "../public/audio.js";

const listen = (handler) => new Promise((resolve) => {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
});

/** A stand-in for api.vachana.ai that records requests and replies as told. */
async function mockGnani(respond) {
  const seen = [];
  const { server, url } = await listen(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    const entry = { path: req.url, headers: req.headers };
    if ((req.headers["content-type"] ?? "").startsWith("multipart/")) {
      entry.form = await new Response(raw, { headers: { "Content-Type": req.headers["content-type"] } }).formData();
    } else {
      entry.json = JSON.parse(raw.toString());
    }
    seen.push(entry);
    respond(req, res);
  });
  return { seen, server, url };
}

const sendJson = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

test("transcribe sends what the Prisma docs specify", async () => {
  const api = await mockGnani((req, res) => sendJson(res, 200, { success: true, transcript: " to theek hai " }));
  try {
    const gnani = createGnani({ apiKey: "secret", baseUrl: api.url });
    const text = await gnani.transcribe({ audio: Buffer.from("RIFFfake"), mode: "hinglish", keyterms: ["Ramesh Gupta", "bad<|name", ""] });
    assert.equal(text, "to theek hai");

    const { path, headers, form } = api.seen[0];
    assert.equal(path, "/stt/v3");
    assert.equal(headers["x-api-key-id"], "secret");
    assert.equal(form.get("model"), "prisma-v3.0");
    assert.equal(form.get("format"), "transliterate");
    assert.equal(form.get("language_code"), "hi-IN,en-IN");
    assert.deepEqual(JSON.parse(form.get("keyterms")), ["Ramesh Gupta"]);
    assert.ok(form.get("topic").length <= 1600);
    assert.equal(await form.get("audio_file").text(), "RIFFfake");
    assert.equal(form.get("audio_file").name, "speech.wav");
  } finally {
    api.server.close();
  }
});

test("English mode and an empty customer list are sent correctly", async () => {
  const api = await mockGnani((req, res) => sendJson(res, 200, { transcript: "" }));
  try {
    const gnani = createGnani({ apiKey: "k", baseUrl: api.url });
    assert.equal(await gnani.transcribe({ audio: Buffer.from("x"), mode: "english" }), "");
    assert.equal(api.seen[0].form.get("language_code"), "en-IN");
    assert.equal(api.seen[0].form.get("keyterms"), null);
  } finally {
    api.server.close();
  }
});

test("synthesize requests MP3 from Timbre with the right voice", async () => {
  const api = await mockGnani((req, res) => {
    res.writeHead(200, { "Content-Type": "audio/mpeg" });
    res.end(Buffer.from([1, 2, 3]));
  });
  try {
    const gnani = createGnani({ apiKey: "k", baseUrl: api.url });
    assert.deepEqual([...await gnani.synthesize({ text: "₹500 likh diya", mode: "hinglish" })], [1, 2, 3]);
    await gnani.synthesize({ text: "Done", mode: "english" });

    const [hinglish, english] = api.seen;
    assert.equal(hinglish.path, "/api/v1/tts/inference");
    assert.equal(hinglish.headers["x-api-key-id"], "k");
    assert.equal(hinglish.json.model, "timbre-v2.5");
    assert.equal(hinglish.json.voice, "Poorvi");
    assert.equal(hinglish.json.language, "hi-en");
    assert.equal(hinglish.json.audio_config.container, "mp3");
    assert.equal(english.json.voice, "Kaveri");
    assert.equal(english.json.language, "en-IN");
  } finally {
    api.server.close();
  }
});

test("Gnani's failures become plain messages", async () => {
  const cases = [[401, /key/], [402, /credit/], [429, /busy/], [500, /try again/]];
  for (const [status, expected] of cases) {
    const api = await mockGnani((req, res) => sendJson(res, status, { detail: { error_code: "X" } }));
    try {
      const gnani = createGnani({ apiKey: "k", baseUrl: api.url });
      await assert.rejects(gnani.synthesize({ text: "x" }), (err) => {
        assert.ok(err instanceof GnaniError);
        assert.match(err.friendly, expected);
        return true;
      });
    } finally {
      api.server.close();
    }
  }
  const unreachable = createGnani({ apiKey: "k", baseUrl: "http://127.0.0.1:1" });
  await assert.rejects(unreachable.synthesize({ text: "x" }), GnaniError);
});

async function withApp(gnani, fn) {
  const db = openDb(":memory:");
  const { server, url } = await listen(createApp({ db, client: createDemoClient(), demo: true, gnani }));
  try {
    await fn(url, db);
  } finally {
    server.close();
  }
}

test("the site's speech routes use customers' names and never reveal the key", async () => {
  const seen = {};
  const fakeGnani = {
    async transcribe(args) { seen.stt = args; return "रमेश को 500 उधार दिया"; },
    async synthesize(args) { seen.tts = args; return Buffer.from([9, 9]); },
  };
  await withApp(fakeGnani, async (url, db) => {
    db.prepare("INSERT INTO customers (name, created_at) VALUES ('Sunita Devi', 'now')").run();
    const state = await (await fetch(`${url}/api/state`)).json();
    assert.equal(state.voice, "gnani");
    assert.doesNotMatch(JSON.stringify(state), /secret|api_key/i);

    const res = await fetch(`${url}/api/speech/transcribe?mode=hinglish`, { method: "POST", headers: { "Content-Type": "audio/wav" }, body: Buffer.from("wav") });
    assert.deepEqual(await res.json(), { transcript: "ramesh ko 500 udhaar diya" }, "stays in English letters whatever comes back");
    assert.deepEqual(seen.stt.keyterms, ["Sunita Devi"]);
    assert.equal(seen.stt.audio.toString(), "wav");

    const spoken = await fetch(`${url}/api/speech/speak`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "Ho gaya", mode: "english" }) });
    assert.equal(spoken.headers.get("content-type"), "audio/mpeg");
    assert.deepEqual([...new Uint8Array(await spoken.arrayBuffer())], [9, 9]);
    assert.equal(seen.tts.mode, "english");
  });
});

test("the speech routes reject bad input", async () => {
  const fakeGnani = { transcribe: async () => "", synthesize: async () => Buffer.alloc(0) };
  await withApp(fakeGnani, async (url) => {
    const wav = { method: "POST", headers: { "Content-Type": "audio/wav" } };
    assert.equal((await fetch(`${url}/api/speech/transcribe?mode=klingon`, { ...wav, body: "x" })).status, 400);
    assert.equal((await fetch(`${url}/api/speech/transcribe?mode=english`, { ...wav, body: Buffer.alloc(2 * 1024 * 1024 + 1) })).status, 413);
    assert.equal((await fetch(`${url}/api/speech/transcribe?mode=english`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "x" })).status, 415);
    const say = (body) => fetch(`${url}/api/speech/speak`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await say({ text: "  ", mode: "english" })).status, 400);
    assert.equal((await say({ text: "x".repeat(1501), mode: "english" })).status, 413);
    assert.equal((await say({ text: "x", mode: "klingon" })).status, 400);
  });
});

test("a Gnani failure reaches the site as a readable 502", async () => {
  const fakeGnani = { transcribe: async () => { throw new GnaniError(402, "no credit"); } };
  await withApp(fakeGnani, async (url) => {
    const res = await fetch(`${url}/api/speech/transcribe?mode=english`, { method: "POST", headers: { "Content-Type": "audio/wav" }, body: "x" });
    assert.equal(res.status, 502);
    assert.match((await res.json()).error, /credit/);
  });
});

test("without a key the site reports browser voice and the routes are off", async () => {
  await withApp(null, async (url) => {
    assert.equal((await (await fetch(`${url}/api/state`)).json()).voice, "browser");
    const res = await fetch(`${url}/api/speech/speak`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(res.status, 404);
  });
});

test("WAV encoding produces a valid 16-bit mono file", () => {
  const view = new DataView(encodeWav(new Float32Array([0, 1, -1, 2, -2]), 16000));
  const text = (start, length) => String.fromCharCode(...Array.from({ length }, (_, i) => view.getUint8(start + i)));
  assert.equal(text(0, 4), "RIFF");
  assert.equal(text(8, 4), "WAVE");
  assert.equal(text(36, 4), "data");
  assert.equal(view.getUint32(4, true), 36 + 10);
  assert.equal(view.getUint16(20, true), 1);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), 10);
  assert.deepEqual([0, 1, 2, 3, 4].map((i) => view.getInt16(44 + i * 2, true)), [0, 32767, -32768, 32767, -32768], "out-of-range samples are clipped");
});

test("downsampling keeps duration and averages samples", () => {
  const second = new Float32Array(48000).fill(0.5);
  const out = downsample(second, 48000);
  assert.equal(out.length, 16000);
  assert.ok(Math.abs(out[100] - 0.5) < 1e-6);
  assert.equal(downsample(new Float32Array(44100), 44100).length, 16000);
  const low = new Float32Array(10);
  assert.equal(downsample(low, 8000), low, "already low enough");
});

test("merging and level helpers", () => {
  assert.deepEqual([...mergeChunks([new Float32Array([1]), new Float32Array([2, 3])])], [1, 2, 3]);
  assert.equal(rms(new Float32Array(0)), 0);
  assert.ok(Math.abs(rms(new Float32Array([0.5, -0.5])) - 0.5) < 1e-6);
});
