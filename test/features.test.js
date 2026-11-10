import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.js";
import { createTools, gstBreakup, whatsappLink, upiLink } from "../src/tools.js";
import { renderBill, toCsv } from "../src/documents.js";
import { createApp } from "../src/server.js";
import { createDemoClient } from "../src/demo.js";
import { runTurn } from "../src/agent.js";
import { dailyBackup } from "../src/backup.js";

const TODAY = "2026-11-10";
const fixedNow = () => new Date("2026-11-10T06:00:00Z");

function setup(now = fixedNow) {
  const db = openDb(":memory:");
  const tools = createTools(db, { now });
  const ok = (name, input) => {
    const out = tools.run(name, input);
    assert.equal(out.error, undefined, `unexpected error from ${name}: ${out.error}`);
    return out;
  };
  return { db, tools, ok };
}

/* ---------- Fixes ---------- */

test("inactive customers are found even past the 200 biggest spenders", () => {
  const { db, tools, ok } = setup();
  for (let i = 0; i < 210; i++) ok("record_sale", { amount: 1000 + i, paid_in_full: true, customer_name: `Big ${i}` });
  ok("record_sale", { amount: 10, paid_in_full: true, customer_name: "Quiet Asha", date: "2026-09-01" });
  db.prepare("UPDATE transactions SET occurred_on = ? WHERE customer_id != (SELECT id FROM customers WHERE name = 'Quiet Asha')").run(TODAY);
  const found = tools.run("find_customers", { inactive_for_days: 30 }).result.customers;
  assert.deepEqual(found.map((c) => c.name), ["Quiet Asha"]);
});

test("a bare undo won't reverse an entry from an earlier day without confirming it", () => {
  let clock = new Date("2026-11-09T06:00:00Z");
  const { tools, ok } = setup(() => clock);
  const { action } = ok("record_expense", { amount: 100, category: "rent" });
  clock = new Date("2026-11-10T06:00:00Z");
  const refused = tools.run("undo_last_action", {});
  assert.match(refused.error, /2026-11-09/);
  assert.match(refused.error, new RegExp(`action_id ${action.id}`));
  assert.match(ok("undo_last_action", { action_id: action.id }).result.undone, /Expense ₹100/);
});

test("re-saving a customer with nothing new doesn't create an entry", () => {
  const { tools, ok } = setup();
  ok("add_customer", { name: "Ramesh", phone: "9000000001" });
  const again = ok("add_customer", { name: "ramesh", phone: "9000000001" });
  assert.equal(again.action, undefined);
  assert.equal(tools.recentActions().length, 1);
});

test("paid_in_full and a missing payment answer are handled", () => {
  const { tools, ok } = setup();
  assert.equal(ok("record_sale", { amount: 250, paid_in_full: true }).result.customer_balance, undefined);
  assert.match(tools.run("record_sale", { amount: 250 }).error, /paid_in_full/);
  assert.equal(tools.glance().sales_today, 250);
});

/* ---------- Stock ---------- */

test("selling items takes them off the shelf, prices the sale and undo puts them back", () => {
  const { tools, ok } = setup();
  ok("set_item", { name: "Toor dal 1kg", unit: "packet", price: 160, low_stock_at: 5, quantity_on_hand: 7 });
  const sale = ok("record_sale", { paid_amount: 0, customer_name: "Ramesh", items: [{ item_name: "toor dal", quantity: 3 }] });
  assert.equal(sale.result.amount, 480, "amount comes from saved prices, not the model");
  assert.match(sale.result.warning, /low: 4 packet/);
  assert.equal(tools.run("list_stock", {}).result.items[0].on_hand, 4);
  assert.equal(tools.glance().low_stock, 1);
  ok("undo_last_action", {});
  assert.equal(tools.run("list_stock", {}).result.items[0].on_hand, 7);
  assert.equal(tools.glance().outstanding, 0);
});

test("unknown or ambiguous items are refused", () => {
  const { tools, ok } = setup();
  ok("set_item", { name: "Rice 1kg" });
  ok("set_item", { name: "Rice 5kg" });
  assert.match(tools.run("record_sale", { amount: 10, paid_in_full: true, items: [{ item_name: "rice", quantity: 1 }] }).error, /more than one/);
  assert.match(tools.run("record_sale", { amount: 10, paid_in_full: true, items: [{ item_name: "ghee", quantity: 1 }] }).error, /No stock item/);
  assert.match(tools.run("record_sale", { paid_in_full: true, items: [{ item_name: "Rice 1kg", quantity: 1 }] }).error, /No saved price/);
  assert.equal(tools.glance().sales_today, 0);
});

test("a delivery with a cost adds stock and an expense, and undo removes both", () => {
  const { tools, ok } = setup();
  ok("set_item", { name: "Sugar", unit: "kg" });
  const out = ok("adjust_stock", { item_name: "sugar", quantity: 50, reason: "purchase", cost: 2000 });
  assert.equal(out.result.on_hand, 50);
  assert.equal(tools.glance().expenses_today, 2000);
  assert.match(tools.run("adjust_stock", { item_name: "sugar", quantity: 5, reason: "damaged" }).error, /negative/);
  tools.undoAction(out.action.id, { seen: true });
  assert.equal(tools.glance().expenses_today, 0);
  assert.equal(tools.run("list_stock", {}).result.items[0].on_hand, 0);
});

test("a counted quantity sets stock to the count, and undoing a new item keeps it if used", () => {
  const { tools, ok } = setup();
  const created = ok("set_item", { name: "Oil", price: 150, quantity_on_hand: 10 });
  ok("set_item", { name: "Oil", quantity_on_hand: 8 });
  assert.equal(tools.run("list_stock", {}).result.items[0].on_hand, 8);
  ok("record_sale", { paid_in_full: true, items: [{ item_name: "Oil", quantity: 1 }] });
  const undone = tools.undoAction(created.action.id, { seen: true });
  assert.match(undone.note, /kept/);
  assert.equal(tools.run("list_stock", {}).result.items.length, 1);
});

/* ---------- Bills, GST, reminders, UPI ---------- */

test("GST is split out of an inclusive amount exactly", () => {
  assert.deepEqual(gstBreakup(59000, 18), { rate: 18, taxable: 50000, cgst: 4500, sgst: 4500, tax: 9000 });
  const odd = gstBreakup(10001, 5);
  assert.equal(odd.taxable + odd.cgst + odd.sgst, 10001, "no paisa lost to rounding");
  assert.equal(gstBreakup(1000, 0), null);
});

test("a sale's bill has the shop, GST, balance and a UPI link, and escapes what it prints", () => {
  const { tools, ok } = setup();
  ok("update_business_profile", { name: "Sharma <b>Store</b>", gstin: "07abcde1234f1z5", upi_id: "Sharma@OKAXIS" });
  const sale = ok("record_sale", { amount: 1180, paid_amount: 180, gst_rate: 18, customer_name: '<script>alert("x")</script>' });
  assert.deepEqual(sale.links, [{ kind: "bill", label: "Bill", url: `/bill/${sale.result.sale_id}` }]);
  const bill = tools.billData(sale.result.sale_id);
  assert.equal(bill.business.gstin, "07ABCDE1234F1Z5");
  assert.equal(bill.due, 100000);
  assert.match(bill.upi_url, /^upi:\/\/pay\?pa=sharma%40okaxis&.*am=1000\.00/);
  const html = renderBill(bill);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /Sharma &lt;b&gt;Store/);
  assert.match(html, /CGST @ 9%/);
  assert.match(html, /Tax invoice/);
  assert.match(tools.run("update_business_profile", { gstin: "12345" }).error, /GSTIN/);
  assert.match(tools.run("update_business_profile", { upi_id: "not a upi" }).error, /UPI ID/);
});

test("reminders become WhatsApp links the owner sends, with an Indian number", () => {
  const { tools, ok } = setup();
  ok("update_business_profile", { name: "Sharma Store", upi_id: "sharma@upi" });
  ok("add_customer", { name: "Ramesh", phone: "090000 00001" });
  assert.match(tools.run("draft_reminder", { customer_name: "Ramesh" }).error, /doesn't owe/);
  ok("record_sale", { amount: 500, paid_amount: 0, customer_name: "Ramesh" });
  const out = ok("draft_reminder", { customer_name: "Ramesh" });
  assert.match(out.links[0].url, /^https:\/\/wa\.me\/919000000001\?text=/);
  assert.match(decodeURIComponent(out.links[0].url), /₹500 baaki.*sharma@upi/s);
  assert.equal(whatsappLink("12", "hi"), "https://wa.me/?text=hi", "a bad number lets the owner pick the contact");
  assert.equal(upiLink({}, 100), null);
});

test("share_bill only works for live sales", () => {
  const { tools, ok } = setup();
  const sale = ok("record_sale", { amount: 100, paid_in_full: true });
  ok("record_expense", { amount: 50, category: "rent" });
  assert.equal(ok("share_bill", { sale_id: sale.result.sale_id }).links[0].url, `/bill/${sale.result.sale_id}`);
  assert.match(tools.run("share_bill", { sale_id: 2 }).error, /No sale/);
  tools.undoAction(sale.action.id, { seen: true });
  assert.match(tools.run("share_bill", { sale_id: sale.result.sale_id }).error, /undone/);
});

/* ---------- Exports and backups ---------- */

test("CSV export protects spreadsheets from formulas and keeps undone rows marked", () => {
  const csv = toCsv([{ name: "=HYPERLINK(\"x\")", amount: -50, note: 'say "hi", ok' }]);
  assert.ok(csv.startsWith("﻿name,amount,note\r\n"));
  assert.match(csv, /"'=HYPERLINK\(""x""\)",-50,"say ""hi"", ok"/);
  const { tools, ok } = setup();
  const sale = ok("record_sale", { amount: 100, paid_in_full: true });
  tools.undoAction(sale.action.id, { seen: true });
  assert.equal(tools.exportRows("transactions")[0].status, "undone");
});

test("daily backups are made once a day and only the newest are kept", () => {
  const dir = mkdtempSync(join(tmpdir(), "munshi-test-"));
  try {
    const db = openDb(":memory:");
    for (let d = 1; d <= 16; d++) writeFileSync(join(dir, `munshi-2026-10-${String(d).padStart(2, "0")}.db`), "");
    assert.ok(dailyBackup(db, dir, { keep: 14, now: fixedNow() }));
    assert.equal(dailyBackup(db, dir, { keep: 14, now: fixedNow() }), null, "not twice in a day");
    const files = readdirSync(dir).sort();
    assert.equal(files.length, 14);
    assert.equal(files.at(-1), "munshi-2026-11-10.db");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------- Server ---------- */

async function withServer(options, fn) {
  const db = openDb(":memory:");
  const server = createServer(createApp({ db, client: createDemoClient(), demo: true, ...options }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base, db);
  } finally {
    server.close();
  }
}
const post = (url, body, headers = {}) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

test("the shop book, bills, exports, backup and profile are served", async () => {
  await withServer({}, async (base) => {
    await (await post(`${base}/api/chat`, { text: "Ramesh ko 500 udhaar diya" })).text();
    const overview = await (await fetch(`${base}/api/overview`)).json();
    assert.equal(overview.pending[0].owes, 500);
    assert.equal(overview.days.length, 7);
    const billUrl = overview.recent[0].bill_url;
    const bill = await fetch(base + billUrl);
    assert.equal(bill.status, 200);
    assert.match(await bill.text(), /INV-0000/);
    assert.equal((await fetch(`${base}/bill/999`)).status, 404);

    const state = await (await fetch(`${base}/api/state`)).json();
    assert.equal(state.messages.at(-1).links[0].kind, "bill", "links survive a reload");

    const csv = await fetch(`${base}/api/export/transactions.csv`);
    assert.match(csv.headers.get("content-disposition"), /attachment; filename="munshi-transactions-/);
    assert.match(await csv.text(), /Ramesh/);
    assert.equal((await fetch(`${base}/api/export/secrets.csv`)).status, 404);

    const backup = Buffer.from(await (await fetch(`${base}/api/backup`)).arrayBuffer());
    assert.equal(backup.subarray(0, 15).toString(), "SQLite format 3");

    const saved = await post(`${base}/api/profile`, { name: "Gupta General Store", upi_id: "gupta@upi" });
    assert.equal((await saved.json()).business.name, "Gupta General Store");
    assert.equal((await post(`${base}/api/profile`, { gstin: "nope" })).status, 400);
  });
});

test("with a PIN, everything but the page itself needs signing in", async () => {
  await withServer({ pin: "4321" }, async (base) => {
    assert.equal((await fetch(`${base}/`)).status, 200);
    const lockedState = await (await fetch(`${base}/api/state`)).json();
    assert.equal(lockedState.locked, true);
    assert.equal(lockedState.signedIn, false);
    assert.equal(lockedState.messages, undefined, "nothing from the books before signing in");
    assert.equal((await fetch(`${base}/api/overview`)).status, 401);
    assert.equal((await fetch(`${base}/api/backup`)).status, 401);
    assert.equal((await post(`${base}/api/chat`, { text: "hi" })).status, 401);
    assert.equal((await post(`${base}/api/login`, { pin: "0000" })).status, 401);

    const login = await post(`${base}/api/login`, { pin: "4321" });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie");
    assert.match(cookie, /HttpOnly; SameSite=Strict/);
    const session = { Cookie: cookie.split(";")[0] };
    const state = await (await fetch(`${base}/api/state`, { headers: session })).json();
    assert.equal(state.locked, false);
    assert.equal(state.pin, true);

    await post(`${base}/api/logout`, {}, session);
    assert.equal((await fetch(`${base}/api/overview`, { headers: session })).status, 401);
  });
});

test("too many wrong PINs lock sign-in for a while", async () => {
  await withServer({ pin: "4321" }, async (base) => {
    for (let i = 0; i < 5; i++) await post(`${base}/api/login`, { pin: "1111" });
    assert.equal((await post(`${base}/api/login`, { pin: "4321" })).status, 429);
  });
});

test("with a PIN, other host names are allowed because the cookie guards access", async () => {
  const handler = createApp({ db: openDb(":memory:"), client: createDemoClient(), demo: true, pin: "4321" });
  let status;
  let body = "";
  const res = { writeHead: (s) => { status = s; }, end(b) { body = b; }, headersSent: false };
  await handler({ method: "GET", url: "/api/state", headers: { host: "192.168.1.20:3000" } }, res);
  assert.equal(status, 200);
  assert.equal(JSON.parse(body).locked, true);
});

/* ---------- Agent ---------- */

test("links from tools reach the page and are saved with the reply", async () => {
  const db = openDb(":memory:");
  const tools = createTools(db);
  const responses = [
    { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t0", name: "record_sale", input: { amount: 100, paid_in_full: true } }] },
    { stop_reason: "end_turn", content: [{ type: "text", text: "Done." }] },
  ];
  const client = { beta: { messages: { stream: () => { const next = responses.shift(); return { on() { return this; }, finalMessage: async () => next }; } } } };
  const events = [];
  const { links } = await runTurn({ db, client, tools, text: "100 sale", emit: (e) => events.push(e) });
  assert.equal(links[0].kind, "bill");
  assert.ok(events.some((e) => e.type === "links"));
  const row = db.prepare("SELECT links FROM chat_log WHERE role = 'assistant'").get();
  assert.equal(JSON.parse(row.links)[0].kind, "bill");
});

test("an existing database from the first version gains the new columns", () => {
  const dir = mkdtempSync(join(tmpdir(), "munshi-migrate-"));
  try {
    const path = join(dir, "old.db");
    const old = openDb(path);
    old.exec("ALTER TABLE chat_log DROP COLUMN links");
    old.close();
    const db = openDb(path);
    assert.ok(db.prepare("PRAGMA table_info(chat_log)").all().some((c) => c.name === "links"));
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
