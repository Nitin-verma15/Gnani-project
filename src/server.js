import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, extname, join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { openDb } from "./db.js";
import { createTools, ToolError } from "./tools.js";
import { runTurn } from "./agent.js";
import { createDemoClient } from "./demo.js";
import { createGnani, GnaniError, SPEECH_MODES } from "./gnani.js";
import { romanize } from "../public/romanize.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_FILES = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/romanize.js": ["romanize.js", "text/javascript; charset=utf-8"],
  "/audio.js": ["audio.js", "text/javascript; charset=utf-8"],
  "/motion.js": ["motion.js", "text/javascript; charset=utf-8"],
  "/scene.js": ["scene.js", "text/javascript; charset=utf-8"],
  "/vendor/three.module.min.js": ["vendor/three.module.min.js", "text/javascript; charset=utf-8"],
  "/recorder-worklet.js": ["recorder-worklet.js", "text/javascript; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
};
const MAX_BODY_BYTES = 64 * 1024;
const MAX_TEXT_CHARS = 4000;
const MAX_AUDIO_BYTES = 2 * 1024 * 1024; // comfortably over 30 seconds of 16 kHz WAV, Prisma's limit
const MAX_SPOKEN_CHARS = 1500;
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/** Words the owner sees, in both languages, since an error may be read aloud. */
function friendlyError(err) {
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return "API key sahi nahi hai. The API key isn't working; check ANTHROPIC_API_KEY in .env.";
  }
  if (err instanceof Anthropic.RateLimitError) return "Abhi bahut requests hain, thodi der mein try kijiye. Too many requests, please try again shortly.";
  if (err instanceof Anthropic.APIConnectionError) return "Internet connection nahi mil raha. Can't reach the AI service, please check your connection.";
  return "Kuch gadbad ho gayi, please dobara try kijiye. Something went wrong, please try again.";
}

export function createApp({ db, client, demo, gnani = null }) {
  const tools = createTools(db);
  let queue = Promise.resolve(); // one turn at a time keeps the conversation history ordered

  const json = (res, status, body) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  };

  async function readBody(req, contentType, maxBytes) {
    // Requiring these types means another site's page can't post here without a CORS preflight.
    if (!(req.headers["content-type"] ?? "").startsWith(contentType)) throw new HttpError(415, `Expected ${contentType}`);
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxBytes) throw new HttpError(413, "Too large");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  async function readJson(req) {
    const body = await readBody(req, "application/json", MAX_BODY_BYTES);
    try {
      return JSON.parse(body.toString("utf8"));
    } catch {
      throw new HttpError(400, "Invalid JSON");
    }
  }

  function state() {
    const rows = db.prepare("SELECT role, text, action_ids FROM chat_log ORDER BY id DESC LIMIT 100").all().reverse();
    return {
      demo,
      voice: gnani ? "gnani" : "browser",
      business: tools.profile(),
      glance: tools.glance(),
      messages: rows.map((r) => ({ role: r.role, text: r.text, actions: tools.actionsById(JSON.parse(r.action_ids)) })),
    };
  }

  async function chat(req, res) {
    const body = await readJson(req);
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) throw new HttpError(400, "Message is empty");
    if (text.length > MAX_TEXT_CHARS) throw new HttpError(413, "Message is too long");

    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store" });
    const emit = (event) => { if (!res.destroyed) res.write(`data: ${JSON.stringify(event)}\n\n`); };

    const turn = queue.then(async () => {
      try {
        const { reply } = await runTurn({ db, client, tools, text, emit, now: new Date() });
        emit({ type: "done", reply, glance: tools.glance(), business: tools.profile() });
      } catch (err) {
        console.error("Turn failed:", err);
        // Entries saved before the failure stay, so refresh the numbers too.
        emit({ type: "error", message: friendlyError(err), glance: tools.glance() });
      }
      res.end();
    });
    queue = turn;
    await turn;
  }

  async function transcribe(req, res, mode) {
    if (!gnani) throw new HttpError(404, "Gnani voice isn't configured");
    if (!SPEECH_MODES.includes(mode)) throw new HttpError(400, "Unknown speech mode");
    const audio = await readBody(req, "audio/wav", MAX_AUDIO_BYTES);
    // Telling Prisma the customers' names helps it recognise them.
    const keyterms = db.prepare("SELECT name FROM customers WHERE voided_at IS NULL ORDER BY id DESC LIMIT 200").all().map((c) => c.name);
    const transcript = await gnani.transcribe({ audio, mode, keyterms });
    json(res, 200, { transcript: romanize(transcript) });
  }

  async function speak(req, res) {
    if (!gnani) throw new HttpError(404, "Gnani voice isn't configured");
    const { text, mode } = await readJson(req);
    if (typeof text !== "string" || !text.trim()) throw new HttpError(400, "Nothing to say");
    if (text.length > MAX_SPOKEN_CHARS) throw new HttpError(413, "Text is too long");
    if (!SPEECH_MODES.includes(mode)) throw new HttpError(400, "Unknown speech mode");
    const audio = await gnani.synthesize({ text, mode });
    res.writeHead(200, { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" });
    res.end(audio);
  }

  function undo(res, id) {
    try {
      const result = tools.undoAction(id, { seen: false });
      json(res, 200, { ...result, glance: tools.glance() });
    } catch (err) {
      if (err instanceof ToolError) return json(res, 409, { error: err.message });
      throw err;
    }
  }

  return async function handler(req, res) {
    const { pathname, searchParams } = new URL(req.url, "http://localhost");
    try {
      // Blocks DNS rebinding: this server has no login, so only local pages may reach it.
      if (!LOCAL_HOST.test(req.headers.host ?? "")) throw new HttpError(403, "Forbidden host");
      if (req.method === "GET" && pathname === "/api/state") return json(res, 200, state());
      if (req.method === "POST" && pathname === "/api/chat") return await chat(req, res);
      if (req.method === "POST" && pathname === "/api/speech/transcribe") return await transcribe(req, res, searchParams.get("mode"));
      if (req.method === "POST" && pathname === "/api/speech/speak") return await speak(req, res);
      const undoMatch = pathname.match(/^\/api\/actions\/(\d+)\/undo$/);
      if (req.method === "POST" && undoMatch) {
        await readJson(req);
        return undo(res, Number(undoMatch[1]));
      }
      const file = PUBLIC_FILES[pathname];
      if (req.method === "GET" && file) {
        // Read first, so a missing file is a clear 404 rather than an empty "200 OK".
        const body = await readFile(join(ROOT, "public", file[0])).catch((err) => {
          if (err.code === "ENOENT") throw new HttpError(404, "Not found");
          throw err;
        });
        res.writeHead(200, { "Content-Type": file[1], "Cache-Control": "no-cache" });
        return res.end(body);
      }
      json(res, 404, { error: "Not found" });
    } catch (err) {
      if (err instanceof HttpError) return json(res, err.status, { error: err.message });
      if (err instanceof GnaniError) {
        console.error(err.message);
        return json(res, 502, { error: err.friendly });
      }
      console.error(err);
      if (!res.headersSent) json(res, 500, { error: "Internal error" });
      else res.end();
    }
  };
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const hasCredentials = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  const db = openDb(process.env.MUNSHI_DB || join(ROOT, "data", "munshi.db"));
  const client = hasCredentials ? new Anthropic() : createDemoClient();
  const port = Number(process.env.PORT) || 3000;
  // Loopback only: there's no login yet, and this holds business data.
  const gnani = process.env.GNANI_API_KEY
    ? createGnani({ apiKey: process.env.GNANI_API_KEY, ...(process.env.GNANI_BASE_URL ? { baseUrl: process.env.GNANI_BASE_URL } : {}) })
    : null;
  createServer(createApp({ db, client, demo: !hasCredentials, gnani })).listen(port, "127.0.0.1", () => {
    console.log(`Munshi is running at http://localhost:${port}`);
    console.log(gnani ? "Voice: Gnani Prisma and Timbre." : "Voice: browser speech (no GNANI_API_KEY set).");
    if (!hasCredentials) console.log("Demo mode: no ANTHROPIC_API_KEY set, so only a few fixed phrases are understood.");
  });
}
