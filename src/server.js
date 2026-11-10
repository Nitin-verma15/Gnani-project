import { createServer } from "node:http";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { openDb, backupTo } from "./db.js";
import { createTools, ToolError } from "./tools.js";
import { runTurn } from "./agent.js";
import { createDemoClient } from "./demo.js";
import { createGnani, GnaniError, SPEECH_MODES } from "./gnani.js";
import { createGeminiClient, GeminiApiError, geminiFriendlyError, GEMINI_DEFAULT_MODEL } from "./gemini.js";
import { renderBill, toCsv } from "./documents.js";
import { dailyBackup } from "./backup.js";
import { romanize } from "../public/romanize.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_FILES = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/book.js": ["book.js", "text/javascript; charset=utf-8"],
  "/romanize.js": ["romanize.js", "text/javascript; charset=utf-8"],
  "/audio.js": ["audio.js", "text/javascript; charset=utf-8"],
  "/motion.js": ["motion.js", "text/javascript; charset=utf-8"],
  "/scene.js": ["scene.js", "text/javascript; charset=utf-8"],
  "/vendor/three.module.min.js": ["vendor/three.module.min.js", "text/javascript; charset=utf-8"],
  "/recorder-worklet.js": ["recorder-worklet.js", "text/javascript; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
  "/favicon.svg": ["favicon.svg", "image/svg+xml"],
};
const MAX_BODY_BYTES = 64 * 1024;
const MAX_TEXT_CHARS = 4000;
const MAX_AUDIO_BYTES = 2 * 1024 * 1024; // comfortably over 30 seconds of 16 kHz WAV, Prisma's limit
const MAX_SPOKEN_CHARS = 1500;
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const SESSION_COOKIE = "munshi_session";
const SESSION_DAYS = 30;
const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MS = 60_000;
const EXPORTS = ["transactions", "customers", "stock"];

/** Words the owner sees, in both languages, since an error may be read aloud. */
function friendlyError(err) {
  if (err instanceof GeminiApiError) return geminiFriendlyError(err);
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return "API key sahi nahi hai. The API key isn't working; check ANTHROPIC_API_KEY in .env.";
  }
  if (err instanceof Anthropic.BadRequestError || err instanceof Anthropic.NotFoundError) {
    return "AI settings mein gadbad hai. The AI request was rejected; check MUNSHI_MODEL in .env, or remove it to use the default.";
  }
  if (err instanceof Anthropic.RateLimitError) return "Abhi bahut requests hain, thodi der mein try kijiye. Too many requests, please try again shortly.";
  if (err instanceof Anthropic.APIConnectionError) return "Internet connection nahi mil raha. Can't reach the AI service, please check your connection.";
  return "Kuch gadbad ho gayi, please dobara try kijiye. Something went wrong, please try again.";
}

const hashPin = (pin) => createHash("sha256").update(`munshi:${pin}`).digest();

function readCookie(req, name) {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

export function createApp({ db, client, demo, gnani = null, pin = null }) {
  const tools = createTools(db);
  const pinHash = pin ? hashPin(pin) : null;
  const sessions = new Map(); // token -> expiry time
  const login = { failures: 0, lockedUntil: 0 };
  let queue = Promise.resolve(); // one turn at a time keeps the conversation history ordered

  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
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

  function signedIn(req) {
    if (!pinHash) return true;
    const token = readCookie(req, SESSION_COOKIE);
    const expires = token && sessions.get(token);
    if (!expires) return false;
    if (expires < Date.now()) {
      sessions.delete(token);
      return false;
    }
    return true;
  }

  async function signIn(req, res) {
    const { pin: attempt } = await readJson(req);
    if (!pinHash) return json(res, 200, { ok: true });
    if (Date.now() < login.lockedUntil) {
      throw new HttpError(429, "Bahut galat PIN. Too many wrong PINs, wait a minute and try again.");
    }
    const ok = typeof attempt === "string" && timingSafeEqual(hashPin(attempt), pinHash);
    if (!ok) {
      login.failures++;
      if (login.failures >= MAX_FAILED_LOGINS) {
        login.failures = 0;
        login.lockedUntil = Date.now() + LOCKOUT_MS;
      }
      throw new HttpError(401, "PIN galat hai. That PIN isn't right.");
    }
    login.failures = 0;
    const token = randomBytes(32).toString("base64url");
    sessions.set(token, Date.now() + SESSION_DAYS * 86_400_000);
    json(res, 200, { ok: true }, {
      "Set-Cookie": `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86_400}`,
    });
  }

  function signOut(req, res) {
    const token = readCookie(req, SESSION_COOKIE);
    if (token) sessions.delete(token);
    json(res, 200, { ok: true }, { "Set-Cookie": `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
  }

  function state() {
    const rows = db.prepare("SELECT role, text, action_ids, links FROM chat_log ORDER BY id DESC LIMIT 100").all().reverse();
    return {
      demo,
      locked: false,
      pin: Boolean(pinHash),
      voice: gnani ? "gnani" : "browser",
      business: tools.profile(),
      glance: tools.glance(),
      messages: rows.map((r) => ({
        role: r.role, text: r.text,
        actions: tools.actionsById(JSON.parse(r.action_ids)),
        links: JSON.parse(r.links || "[]"),
      })),
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
    // Telling Prisma the customers' and items' names helps it recognise them.
    const keyterms = db.prepare(
      `SELECT name FROM (SELECT name, id FROM customers WHERE voided_at IS NULL ORDER BY id DESC LIMIT 150)
       UNION ALL SELECT name FROM (SELECT name FROM items WHERE voided_at IS NULL ORDER BY id DESC LIMIT 50)`,
    ).all().map((c) => c.name);
    const transcript = await gnani.transcribe({ audio, mode, keyterms });
    // Enough to tell "no audio arrived" from "Gnani heard nothing", without logging what was said.
    const seconds = Math.max(0, (audio.length - 44) / 32000).toFixed(1);
    console.log(`Speech (${mode}): ${seconds}s of audio, ${transcript ? `${transcript.length} characters heard` : "no words heard"}`);
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

  async function saveProfile(req, res) {
    const body = await readJson(req);
    const fields = {};
    for (const key of ["name", "type", "owner_name", "phone", "address", "gstin", "upi_id"]) {
      if (typeof body[key] === "string") fields[key] = body[key].slice(0, 200);
    }
    const out = tools.updateProfile(fields);
    if (out.error) return json(res, 400, { error: out.error });
    // The assistant hears about it on the next message, like an Undo tap.
    json(res, 200, { business: tools.profile(), action: out.action ?? null });
  }

  function bill(res, id) {
    const data = tools.billData(id);
    if (!data) throw new HttpError(404, "No such bill");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(renderBill(data));
  }

  function exportCsv(res, kind) {
    const rows = tools.exportRows(kind);
    if (!rows) throw new HttpError(404, "Not found");
    res.writeHead(200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="munshi-${kind}-${tools.today()}.csv"`,
      "Cache-Control": "no-store",
    });
    res.end(toCsv(rows));
  }

  async function downloadBackup(res) {
    const file = join(tmpdir(), `munshi-download-${randomBytes(8).toString("hex")}.db`);
    try {
      backupTo(db, file);
      const data = await readFile(file);
      res.writeHead(200, {
        "Content-Type": "application/vnd.sqlite3",
        "Content-Disposition": `attachment; filename="munshi-backup-${tools.today()}.db"`,
        "Cache-Control": "no-store",
      });
      res.end(data);
    } finally {
      await unlink(file).catch(() => {});
    }
  }

  return async function handler(req, res) {
    const { pathname, searchParams } = new URL(req.url, "http://localhost");
    try {
      // Without a PIN there is no login, so only pages on this computer may reach the server
      // (this also blocks DNS rebinding). With a PIN, the session cookie does that job.
      if (!pinHash && !LOCAL_HOST.test(req.headers.host ?? "")) throw new HttpError(403, "Forbidden host");

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

      if (req.method === "POST" && pathname === "/api/login") return await signIn(req, res);
      if (!signedIn(req)) {
        if (req.method === "GET" && pathname === "/api/state") return json(res, 200, { locked: true, pin: true, demo });
        throw new HttpError(401, "Locked. Enter the PIN.");
      }

      if (req.method === "POST" && pathname === "/api/logout") return signOut(req, res);
      if (req.method === "GET" && pathname === "/api/state") return json(res, 200, state());
      if (req.method === "GET" && pathname === "/api/overview") return json(res, 200, tools.overview());
      if (req.method === "POST" && pathname === "/api/chat") return await chat(req, res);
      if (req.method === "POST" && pathname === "/api/profile") return await saveProfile(req, res);
      if (req.method === "POST" && pathname === "/api/speech/transcribe") return await transcribe(req, res, searchParams.get("mode"));
      if (req.method === "POST" && pathname === "/api/speech/speak") return await speak(req, res);
      if (req.method === "GET" && pathname === "/api/backup") return await downloadBackup(res);
      const exportMatch = pathname.match(/^\/api\/export\/(\w+)\.csv$/);
      if (req.method === "GET" && exportMatch && EXPORTS.includes(exportMatch[1])) return exportCsv(res, exportMatch[1]);
      const billMatch = pathname.match(/^\/bill\/(\d+)$/);
      if (req.method === "GET" && billMatch) return bill(res, Number(billMatch[1]));
      const undoMatch = pathname.match(/^\/api\/actions\/(\d+)\/undo$/);
      if (req.method === "POST" && undoMatch) {
        await readJson(req);
        return undo(res, Number(undoMatch[1]));
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
  // Which AI runs the assistant: MUNSHI_PROVIDER if set, otherwise whichever key is present.
  const hasClaude = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  const hasGemini = Boolean(process.env.GEMINI_API_KEY?.trim());
  const wanted = process.env.MUNSHI_PROVIDER?.trim().toLowerCase();
  const provider = wanted === "gemini" && hasGemini ? "gemini"
    : wanted === "claude" && hasClaude ? "claude"
      : hasClaude ? "claude" : hasGemini ? "gemini" : "demo";
  if (wanted && wanted !== provider) console.warn(`MUNSHI_PROVIDER=${wanted}, but its API key isn't set. Using ${provider}.`);
  const geminiModel = process.env.GEMINI_MODEL?.trim() || GEMINI_DEFAULT_MODEL;
  const hasCredentials = provider !== "demo";
  const dbPath = process.env.MUNSHI_DB || join(ROOT, "data", "munshi.db");
  const db = openDb(dbPath);
  const client = provider === "claude" ? new Anthropic()
    : provider === "gemini" ? createGeminiClient({ apiKey: process.env.GEMINI_API_KEY.trim(), model: geminiModel, thinking: process.env.GEMINI_THINKING?.trim() || null })
      : createDemoClient();
  const port = Number(process.env.PORT) || 3000;
  const pin = process.env.MUNSHI_PIN?.trim() || null;
  const host = process.env.MUNSHI_HOST?.trim() || "127.0.0.1";
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(host);
  if (pin && pin.length < 4) {
    console.error("MUNSHI_PIN must be at least 4 characters.");
    process.exit(1);
  }
  if (!loopback && !pin) {
    console.error(`Refusing to listen on ${host} without MUNSHI_PIN: anyone on the network could read and change the books. Set MUNSHI_PIN in .env.`);
    process.exit(1);
  }
  const gnani = process.env.GNANI_API_KEY
    ? createGnani({ apiKey: process.env.GNANI_API_KEY, ...(process.env.GNANI_BASE_URL ? { baseUrl: process.env.GNANI_BASE_URL } : {}) })
    : null;

  const backupDir = process.env.MUNSHI_BACKUP_DIR || join(dirname(dbPath), "backups");
  const backUp = () => {
    try {
      const made = dailyBackup(db, backupDir);
      if (made) console.log(`Daily backup saved: ${made}`);
    } catch (err) {
      console.error("Daily backup failed:", err.message);
    }
  };
  backUp();
  setInterval(backUp, 60 * 60 * 1000).unref();

  createServer(createApp({ db, client, demo: !hasCredentials, gnani, pin })).listen(port, host, () => {
    console.log(`Munshi is running at http://${loopback ? "localhost" : host}:${port}`);
    if (provider === "claude") console.log("AI: Claude.");
    if (provider === "gemini") console.log(`AI: Google Gemini (${geminiModel}).`);
    console.log(gnani ? "Voice: Gnani Prisma and Timbre." : "Voice: browser speech (no GNANI_API_KEY set).");
    if (pin) console.log("PIN lock is on.");
    if (!hasCredentials) console.log("Demo mode: no GEMINI_API_KEY or ANTHROPIC_API_KEY set, so only a few fixed phrases are understood.");
  });
}
