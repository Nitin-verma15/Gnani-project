import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openAccounts, normalizePhone, AccountError } from "../src/accounts.js";
import { createApp } from "../src/server.js";
import { createDemoClient } from "../src/demo.js";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "munshi-accounts-"));
}

/** A running app in accounts mode. Each `as()` is a separate browser with its own cookie. */
async function withAccountsApp(dir, fn) {
  const accounts = openAccounts(dir);
  const app = createApp({ accounts, client: createDemoClient(), demo: true });
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const as = () => {
    let cookie = "";
    const call = async (path, { method = "GET", body } = {}) => {
      const res = await fetch(base + path, {
        method,
        headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const set = res.headers.get("set-cookie");
      if (set) cookie = set.split(";")[0].endsWith("=") ? "" : set.split(";")[0];
      return res;
    };
    return {
      call,
      get cookie() { return cookie; },
      set cookie(v) { cookie = v; },
      post: (path, body = {}) => call(path, { method: "POST", body }),
      json: async (path) => (await call(path)).json(),
      chat: async (text) => {
        const raw = await (await call("/api/chat", { method: "POST", body: { text } })).text();
        return raw.split("\n\n").filter(Boolean).map((l) => JSON.parse(l.replace(/^data: /, ""))).at(-1);
      },
    };
  };
  try {
    await fn({ as, base });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    app.close();
    accounts.close();
  }
}

const shopA = { shop_name: "Gupta General Store", owner_name: "Rakesh Gupta", phone: "98765 43210", password: "chai-2026", type: "kirana" };
const shopB = { shop_name: "Priya Beauty Parlour", owner_name: "Priya", phone: "+91 91234 56789", password: "salon-pass" };

test("Indian mobile numbers are accepted in the usual ways and nothing else", () => {
  assert.equal(normalizePhone("98765 43210"), "9876543210");
  assert.equal(normalizePhone("+91-98765-43210"), "9876543210");
  assert.equal(normalizePhone("098765 43210"), "9876543210");
  assert.equal(normalizePhone("12345 67890"), null, "Indian mobiles start with 6 to 9");
  assert.equal(normalizePhone("98765"), null);
  assert.equal(normalizePhone(undefined), null);
});

test("registration checks its fields, refuses a taken number, and never stores the password", () => {
  const dir = tempDir();
  try {
    const accounts = openAccounts(dir);
    assert.throws(() => accounts.register({ ...shopA, shop_name: " " }), AccountError);
    assert.throws(() => accounts.register({ ...shopA, phone: "123" }), /Mobile number/);
    assert.throws(() => accounts.register({ ...shopA, password: "123" }), /6/);
    const shop = accounts.register(shopA);
    assert.equal(shop.phone, "9876543210");
    assert.throws(() => accounts.register({ ...shopB, phone: "9876543210" }), (err) => err.status === 409);
    assert.equal(accounts.verify("98765 43210", "chai-2026").id, shop.id);
    assert.equal(accounts.verify("98765 43210", "wrong"), null);
    assert.equal(accounts.verify("90000 00000", "chai-2026"), null);
    accounts.close();

    const raw = new DatabaseSync(join(dir, "accounts.db"));
    const row = raw.prepare("SELECT password_hash FROM shops").get();
    raw.close();
    assert.doesNotMatch(row.password_hash, /chai-2026/);
    assert.match(row.password_hash, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a new shop registers, signs in, and gets its own empty books named after it", async () => {
  const dir = tempDir();
  try {
    await withAccountsApp(dir, async ({ as }) => {
      const owner = as();
      const before = await owner.json("/api/state");
      assert.deepEqual([before.auth, before.signedIn], ["accounts", false]);
      assert.equal(before.messages, undefined);
      assert.equal((await owner.call("/api/overview")).status, 401);

      const res = await owner.post("/api/auth/register", shopA);
      assert.equal(res.status, 201);
      assert.match(res.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
      const state = await owner.json("/api/state");
      assert.equal(state.signedIn, true);
      assert.equal(state.account.shop_name, "Gupta General Store");
      assert.equal(state.business.name, "Gupta General Store");
      assert.equal(state.business.owner_name, "Rakesh Gupta");
      assert.equal(state.business.type, "kirana");
      assert.equal(state.glance.outstanding, 0);
      assert.ok(existsSync(join(dir, "shops", `${state.account.id}.db`)), "the shop has its own database file");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("one shop can never see another shop's books, bills or exports", async () => {
  const dir = tempDir();
  try {
    await withAccountsApp(dir, async ({ as }) => {
      const a = as();
      const b = as();
      await a.post("/api/auth/register", shopA);
      await b.post("/api/auth/register", shopB);

      const done = await a.chat("Ramesh ko 500 udhaar diya");
      assert.equal(done.glance.outstanding, 500);
      const billUrl = (await a.json("/api/overview")).recent[0].bill_url;
      assert.equal((await a.call(billUrl)).status, 200);

      assert.equal((await b.json("/api/state")).glance.outstanding, 0);
      assert.deepEqual((await b.json("/api/overview")).pending, []);
      assert.equal((await b.call(billUrl)).status, 404, "the same bill number doesn't exist in another shop");
      assert.doesNotMatch(await (await b.call("/api/export/transactions.csv")).text(), /Ramesh/);
      assert.equal((await b.json("/api/state")).messages.length, 0, "conversations are separate too");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sign in, wrong passwords, lockout and sign out", async () => {
  const dir = tempDir();
  try {
    await withAccountsApp(dir, async ({ as }) => {
      await as().post("/api/auth/register", shopA);
      const owner = as();
      assert.equal((await owner.post("/api/auth/login", { phone: "9876543210", password: "nope" })).status, 401);
      const ok = await owner.post("/api/auth/login", { phone: "+91 98765 43210", password: "chai-2026" });
      assert.equal(ok.status, 200);
      assert.equal((await owner.json("/api/state")).account.owner_name, "Rakesh Gupta");
      await owner.post("/api/logout");
      assert.equal((await owner.json("/api/state")).signedIn, false);

      const guesser = as();
      for (let i = 0; i < 5; i++) await guesser.post("/api/auth/login", { phone: "9876543210", password: `guess${i}` });
      assert.equal((await guesser.post("/api/auth/login", { phone: "9876543210", password: "chai-2026" })).status, 429);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a signed-in owner stays signed in after the server restarts", async () => {
  const dir = tempDir();
  try {
    let cookie;
    await withAccountsApp(dir, async ({ as }) => {
      const owner = as();
      await owner.post("/api/auth/register", shopA);
      await owner.chat("300 ka kharcha");
      cookie = owner.cookie;
    });
    await withAccountsApp(dir, async ({ as }) => {
      const owner = as();
      owner.cookie = cookie;
      const state = await owner.json("/api/state");
      assert.equal(state.signedIn, true);
      assert.equal(state.glance.expenses_today, 300, "the books are still there");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the demo shop needs no account and comes with sample data", async () => {
  const dir = tempDir();
  try {
    await withAccountsApp(dir, async ({ as }) => {
      const visitor = as();
      assert.equal((await visitor.post("/api/auth/demo")).status, 200);
      const state = await visitor.json("/api/state");
      assert.equal(state.account.demo, true);
      assert.equal(state.business.name, "Sharma Kirana Store");
      assert.ok((await visitor.json("/api/overview")).pending.length > 0);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
