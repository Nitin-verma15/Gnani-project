import { createServer } from "node:http";
import { readFile, unlink, writeFile } from "node:fs/promises";
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
import { openAccounts, AccountError, DEMO_SHOP_ID, normalizePhone } from "./accounts.js";
import { seedSample } from "./seed.js";
import { wavLevels, normalizeWav } from "./wav.js";
import { romanize } from "../public/romanize.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_FILES = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/login": ["login.html", "text/html; charset=utf-8"],
  "/signup": ["login.html", "text/html; charset=utf-8"],
  "/app": ["app.html", "text/html; charset=utf-8"],
  "/login.js": ["login.js", "text/javascript; charset=utf-8"],
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

// Behind HTTPS (a hosting provider's proxy), the cookie is also marked Secure.
const isHttps = (req) => req.socket?.encrypted || req.headers["x-forwarded-proto"] === "https";
const sessionCookie = (token, maxAge, req) => `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${req && isHttps(req) ? "; Secure" : ""}`;

/** One shop's books: its database, its tools, and a queue so its turns run one at a time. */
function shopContext(db) {
  return { db, tools: createTools(db), queue: Promise.resolve() };
}

/**
 * Two ways to run:
 *  - accounts: each shop registers and signs in; every shop has its own database.
 *  - db (single shop): one set of books, optionally behind a PIN.
 */
export function createApp({ db = null, accounts = null, client, demo, gnani = null, pin = null, lastSpeechPath = null }) {
  if (!db && !accounts) throw new Error("createApp needs either db or accounts");
  const single = db ? shopContext(db) : null;
  const shops = new Map(); // shop id -> context, opened on first use
  const pinHash = !accounts && pin ? hashPin(pin) : null;
  const pinSessions = new Map(); // token -> expiry time (PIN mode only)
  const pinLogin = { failures: 0, lockedUntil: 0 };
  const failedLogins = new Map(); // mobile -> { failures, lockedUntil } (accounts mode)

  function contextFor(shopId) {
    if (!shops.has(shopId)) {
      const shopDb = openDb(accounts.shopDbPath(shopId));
      if (shopId === DEMO_SHOP_ID) seedSample(shopDb);
      shops.set(shopId, shopContext(shopDb));
    }
    return shops.get(shopId);
  }

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

  /* ---------- Who is asking ---------- */

  /** The signed-in shop and its books, or null. */
  function current(req) {
    const token = readCookie(req, SESSION_COOKIE);
    if (accounts) {
      const shop = accounts.shopForToken(token);
      return shop ? { shop, ...contextFor(shop.id), ctxKey: shop.id } : null;
    }
    if (pinHash) {
      const expires = token && pinSessions.get(token);
      if (!expires || expires < Date.now()) {
        if (token) pinSessions.delete(token);
        return null;
      }
    }
    return { shop: null, ...single, ctxKey: "single" };
  }

  // Turns queue per shop, so two shops never wait on each other.
  const ctxRef = (who) => (accounts ? shops.get(who.ctxKey) : single);

  /* ---------- Accounts ---------- */

  function startSession(req, res, shop, status = 200) {
    const { token, maxAge } = accounts.createSession(shop.id);
    json(res, status, { ok: true, account: shop }, { "Set-Cookie": sessionCookie(token, maxAge, req) });
  }

  async function register(req, res) {
    const body = await readJson(req);
    const shop = accounts.register(body);
    // The new shop's books start with its name, owner and number, as if the owner had said them.
    const { tools } = contextFor(shop.id);
    const profile = { name: shop.shop_name, owner_name: shop.owner_name, phone: shop.phone };
    if (typeof body.type === "string" && body.type.trim()) profile.type = body.type.trim().slice(0, 80);
    tools.updateProfile(profile);
    startSession(req, res, shop, 201);
  }

  async function login(req, res) {
    const { phone, password } = await readJson(req);
    const key = normalizePhone(phone) ?? "invalid";
    const record = failedLogins.get(key) ?? { failures: 0, lockedUntil: 0 };
    if (Date.now() < record.lockedUntil) {
      throw new HttpError(429, "Bahut baar galat password. Too many wrong tries, wait a minute and try again.");
    }
    const shop = accounts.verify(phone, password);
    if (!shop) {
      record.failures++;
      if (record.failures >= MAX_FAILED_LOGINS) {
        record.failures = 0;
        record.lockedUntil = Date.now() + LOCKOUT_MS;
      }
      failedLogins.set(key, record);
      throw new HttpError(401, "Mobile number ya password galat hai. That number and password don't match.");
    }
    failedLogins.delete(key);
    startSession(req, res, shop);
  }

  async function demoLogin(req, res) {
    await readJson(req);
    startSession(req, res, accounts.ensureDemoShop());
  }

  async function pinSignIn(req, res) {
    const { pin: attempt } = await readJson(req);
    if (!pinHash) return json(res, 200, { ok: true });
    if (Date.now() < pinLogin.lockedUntil) {
      throw new HttpError(429, "Bahut galat PIN. Too many wrong PINs, wait a minute and try again.");
    }
    const ok = typeof attempt === "string" && timingSafeEqual(hashPin(attempt), pinHash);
    if (!ok) {
      pinLogin.failures++;
      if (pinLogin.failures >= MAX_FAILED_LOGINS) {
        pinLogin.failures = 0;
        pinLogin.lockedUntil = Date.now() + LOCKOUT_MS;
      }
      throw new HttpError(401, "PIN galat hai. That PIN isn't right.");
    }
    pinLogin.failures = 0;
    const token = randomBytes(32).toString("base64url");
    pinSessions.set(token, Date.now() + SESSION_DAYS * 86_400_000);
    json(res, 200, { ok: true }, { "Set-Cookie": sessionCookie(token, SESSION_DAYS * 86_400, req) });
  }

  function signOut(req, res) {
    const token = readCookie(req, SESSION_COOKIE);
    if (accounts) accounts.endSession(token);
    else if (token) pinSessions.delete(token);
    json(res, 200, { ok: true }, { "Set-Cookie": sessionCookie("", 0, req) });
  }

  /* ---------- The shop's books ---------- */

  function state(who) {
    const rows = who.db.prepare("SELECT role, text, action_ids, links FROM chat_log ORDER BY id DESC LIMIT 100").all().reverse();
    return {
      demo,
      auth: accounts ? "accounts" : pinHash ? "pin" : "none",
      signedIn: true,
      locked: false,
      pin: Boolean(pinHash),
      account: who.shop,
      voice: gnani ? "gnani" : "browser",
      business: who.tools.profile(),
      glance: who.tools.glance(),
      messages: rows.map((r) => ({
        role: r.role, text: r.text,
        actions: who.tools.actionsById(JSON.parse(r.action_ids)),
        links: JSON.parse(r.links || "[]"),
      })),
    };
  }

  async function chat(req, res, who) {
    const body = await readJson(req);
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) throw new HttpError(400, "Message is empty");
    if (text.length > MAX_TEXT_CHARS) throw new HttpError(413, "Message is too long");

    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store" });
    const emit = (event) => { if (!res.destroyed) res.write(`data: ${JSON.stringify(event)}\n\n`); };
    const { db: shopDb, tools } = who;
    const ctx = ctxRef(who);

    const turn = ctx.queue.then(async () => {
      try {
        const { reply } = await runTurn({ db: shopDb, client, tools, text, emit, now: new Date() });
        emit({ type: "done", reply, glance: tools.glance(), business: tools.profile() });
      } catch (err) {
        console.error("Turn failed:", err);
        // Entries saved before the failure stay, so refresh the numbers too.
        emit({ type: "error", message: friendlyError(err), glance: tools.glance() });
      }
      res.end();
    });
    ctx.queue = turn;
    await turn;
  }

  async function transcribe(req, res, mode, who) {
    if (!gnani) throw new HttpError(404, "Gnani voice isn't configured");
    if (!SPEECH_MODES.includes(mode)) throw new HttpError(400, "Unknown speech mode");
    const audio = await readBody(req, "audio/wav", MAX_AUDIO_BYTES);
    // Telling Prisma the customers' and items' names helps it recognise them.
    const keyterms = who.db.prepare(
      `SELECT name FROM (SELECT name, id FROM customers WHERE voided_at IS NULL ORDER BY id DESC LIMIT 150)
       UNION ALL SELECT name FROM (SELECT name FROM items WHERE voided_at IS NULL ORDER BY id DESC LIMIT 50)`,
    ).all().map((c) => c.name);
    // Quiet microphones record speech too softly to be heard, so bring it up to a normal level.
    const before = wavLevels(audio);
    const { buffer: louder, gain } = normalizeWav(audio);
    // On a local run, keep the latest recording (overwritten each time) so a mic problem can be checked.
    if (lastSpeechPath) writeFile(lastSpeechPath, audio).catch(() => {});
    const transcript = await gnani.transcribe({ audio: louder, mode, keyterms });
    // Enough to tell a silent mic from "Gnani heard nothing", without logging what was said.
    const seconds = Math.max(0, (audio.length - 44) / 32000).toFixed(1);
    const level = before ? `, level ${before.peak.toFixed(3)}${gain > 1 ? ` boosted ${gain.toFixed(1)}x` : ""}` : "";
    console.log(`Speech (${mode}): ${seconds}s of audio${level}, ${transcript ? `${transcript.length} characters heard` : "no words heard"}`);
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

  function undo(res, id, who) {
    try {
      const result = who.tools.undoAction(id, { seen: false });
      json(res, 200, { ...result, glance: who.tools.glance() });
    } catch (err) {
      if (err instanceof ToolError) return json(res, 409, { error: err.message });
      throw err;
    }
  }

  async function saveProfile(req, res, who) {
    const body = await readJson(req);
    const fields = {};
    for (const key of ["name", "type", "owner_name", "phone", "address", "gstin", "upi_id"]) {
      if (typeof body[key] === "string") fields[key] = body[key].slice(0, 200);
    }
    const out = who.tools.updateProfile(fields);
    if (out.error) return json(res, 400, { error: out.error });
    json(res, 200, { business: who.tools.profile(), action: out.action ?? null });
  }

  function bill(res, id, who) {
    const data = who.tools.billData(id);
    if (!data) throw new HttpError(404, "No such bill");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(renderBill(data));
  }

  function exportCsv(res, kind, who) {
    const rows = who.tools.exportRows(kind);
    if (!rows) throw new HttpError(404, "Not found");
    res.writeHead(200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="munshi-${kind}-${who.tools.today()}.csv"`,
      "Cache-Control": "no-store",
    });
    res.end(toCsv(rows));
  }

  async function downloadBackup(res, who) {
    const file = join(tmpdir(), `munshi-download-${randomBytes(8).toString("hex")}.db`);
    try {
      backupTo(who.db, file);
      const data = await readFile(file);
      res.writeHead(200, {
        "Content-Type": "application/vnd.sqlite3",
        "Content-Disposition": `attachment; filename="munshi-backup-${who.tools.today()}.db"`,
        "Cache-Control": "no-store",
      });
      res.end(data);
    } finally {
      await unlink(file).catch(() => {});
    }
  }

  const handler = async function handler(req, res) {
    const { pathname, searchParams } = new URL(req.url, "http://localhost");
    try {
      // With no sign-in at all, only pages on this computer may reach the server (this also
      // blocks DNS rebinding). With accounts or a PIN, the session cookie does that job.
      if (!accounts && !pinHash && !LOCAL_HOST.test(req.headers.host ?? "")) throw new HttpError(403, "Forbidden host");

      // For a hosting provider's health check.
      if (req.method === "GET" && pathname === "/healthz") {
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
        return res.end("ok");
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

      if (accounts) {
        if (req.method === "POST" && pathname === "/api/auth/register") return await register(req, res);
        if (req.method === "POST" && pathname === "/api/auth/login") return await login(req, res);
        if (req.method === "POST" && pathname === "/api/auth/demo") return await demoLogin(req, res);
      } else if (req.method === "POST" && pathname === "/api/login") {
        return await pinSignIn(req, res);
      }
      if (req.method === "POST" && pathname === "/api/logout") return signOut(req, res);

      const who = current(req);
      if (!who) {
        if (req.method === "GET" && pathname === "/api/state") {
          return json(res, 200, accounts
            ? { auth: "accounts", signedIn: false, demo }
            : { auth: "pin", signedIn: false, locked: true, pin: true, demo });
        }
        throw new HttpError(401, accounts ? "Please sign in to your shop." : "Locked. Enter the PIN.");
      }

      if (req.method === "GET" && pathname === "/api/state") return json(res, 200, state(who));
      if (req.method === "GET" && pathname === "/api/overview") return json(res, 200, who.tools.overview());
      if (req.method === "POST" && pathname === "/api/chat") return await chat(req, res, who);
      if (req.method === "POST" && pathname === "/api/profile") return await saveProfile(req, res, who);
      if (req.method === "POST" && pathname === "/api/speech/transcribe") return await transcribe(req, res, searchParams.get("mode"), who);
      if (req.method === "POST" && pathname === "/api/speech/speak") return await speak(req, res);
      if (req.method === "GET" && pathname === "/api/backup") return await downloadBackup(res, who);
      const exportMatch = pathname.match(/^\/api\/export\/(\w+)\.csv$/);
      if (req.method === "GET" && exportMatch && EXPORTS.includes(exportMatch[1])) return exportCsv(res, exportMatch[1], who);
      const billMatch = pathname.match(/^\/bill\/(\d+)$/);
      if (req.method === "GET" && billMatch) return bill(res, Number(billMatch[1]), who);
      const undoMatch = pathname.match(/^\/api\/actions\/(\d+)\/undo$/);
      if (req.method === "POST" && undoMatch) {
        await readJson(req);
        return undo(res, Number(undoMatch[1]), who);
      }
      json(res, 404, { error: "Not found" });
    } catch (err) {
      if (err instanceof HttpError || err instanceof AccountError) return json(res, err.status, { error: err.message });
      if (err instanceof GnaniError) {
        console.error(err.message);
        return json(res, 502, { error: err.friendly });
      }
      console.error(err);
      if (!res.headersSent) json(res, 500, { error: "Internal error" });
      else res.end();
    }
  };
  /** Every shop's database that is open or registered, for the daily backups. */
  handler.shopDatabases = () => (accounts
    ? accounts.allShopIds().map((id) => [id, contextFor(id).db])
    : [["munshi", single.db]]);
  /** Closes every shop database this app opened. */
  handler.close = () => {
    for (const ctx of shops.values()) ctx.db.close();
    shops.clear();
  };
  return handler;
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
  const client = provider === "claude" ? new Anthropic()
    : provider === "gemini" ? createGeminiClient({ apiKey: process.env.GEMINI_API_KEY.trim(), model: geminiModel, thinking: process.env.GEMINI_THINKING?.trim() || null })
      : createDemoClient();

  // Shop accounts are the default. MUNSHI_SINGLE_SHOP=1 keeps the older one-shop setup (data/munshi.db).
  const singleShop = process.env.MUNSHI_SINGLE_SHOP === "1";
  const dataDir = process.env.MUNSHI_DATA_DIR || join(ROOT, "data");
  const dbPath = process.env.MUNSHI_DB || join(dataDir, "munshi.db");
  const accounts = singleShop ? null : openAccounts(dataDir);
  const db = singleShop ? openDb(dbPath) : null;

  const port = Number(process.env.PORT) || 3000;
  const pin = singleShop ? process.env.MUNSHI_PIN?.trim() || null : null;
  const host = process.env.MUNSHI_HOST?.trim() || "127.0.0.1";
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(host);
  if (pin && pin.length < 4) {
    console.error("MUNSHI_PIN must be at least 4 characters.");
    process.exit(1);
  }
  if (singleShop && !loopback && !pin) {
    console.error(`Refusing to listen on ${host} without MUNSHI_PIN: anyone on the network could read and change the books. Set MUNSHI_PIN in .env.`);
    process.exit(1);
  }
  const gnani = process.env.GNANI_API_KEY
    ? createGnani({ apiKey: process.env.GNANI_API_KEY, ...(process.env.GNANI_BASE_URL ? { baseUrl: process.env.GNANI_BASE_URL } : {}) })
    : null;

  const lastSpeechPath = loopback ? join(dataDir, "last-speech.wav") : null;
  const app = createApp({ db, accounts, client, demo: !hasCredentials, gnani, pin, lastSpeechPath });

  // A copy of every shop's books each day, in its own folder.
  const backupDir = process.env.MUNSHI_BACKUP_DIR || join(dataDir, "backups");
  const backUp = () => {
    for (const [id, shopDb] of app.shopDatabases()) {
      try {
        const made = dailyBackup(shopDb, singleShop ? backupDir : join(backupDir, id));
        if (made) console.log(`Daily backup saved: ${made}`);
      } catch (err) {
        console.error(`Daily backup failed for ${id}:`, err.message);
      }
    }
  };
  backUp();
  setInterval(backUp, 60 * 60 * 1000).unref();

  createServer(app).listen(port, host, () => {
    console.log(`Munshi is running at http://${loopback ? "localhost" : host}:${port}`);
    console.log(singleShop ? "Single shop mode." : "Shop accounts: each shop registers and signs in with its own books.");
    if (provider === "claude") console.log("AI: Claude.");
    if (provider === "gemini") console.log(`AI: Google Gemini (${geminiModel}).`);
    console.log(gnani ? "Voice: Gnani Prisma and Timbre." : "Voice: browser speech (no GNANI_API_KEY set).");
    if (pin) console.log("PIN lock is on.");
    if (!hasCredentials) console.log("Demo mode: no GEMINI_API_KEY or ANTHROPIC_API_KEY set, so only a few fixed phrases are understood.");
  });
}
