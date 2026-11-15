import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { openDb } from "../src/db.js";
import { createTools } from "../src/tools.js";
import { createApp } from "../src/server.js";
import { createDemoClient } from "../src/demo.js";
import { briefingFacts, briefingScript, isCallTime, DEFAULT_CALL_TIME } from "../src/briefing.js";

// 10 Nov 2026, 9 PM in India.
const now = () => new Date("2026-11-10T15:30:00Z");

function shop() {
  const db = openDb(":memory:");
  const tools = createTools(db, { now });
  const ok = (name, input) => {
    const out = tools.run(name, input);
    assert.equal(out.error, undefined, `${name}: ${out.error}`);
    return out;
  };
  return { db, tools, ok };
}

function busyDay() {
  const s = shop();
  const { ok } = s;
  ok("update_business_profile", { name: "Sharma Kirana Store", owner_name: "Rakesh" });
  ok("record_sale", { amount: 1200, paid_in_full: true });
  ok("record_sale", { amount: 800, paid_amount: 0, customer_name: "Ramesh" });
  ok("record_sale", { amount: 500, paid_amount: 0, customer_name: "Sita", date: "2026-11-01" });
  ok("record_sale", { amount: 350, paid_amount: 0, customer_name: "Imran", date: "2026-11-02" });
  ok("record_sale", { amount: 100, paid_amount: 0, customer_name: "Asha", date: "2026-11-03" });
  ok("record_payment", { amount: 200, customer_name: "Sita" });
  ok("record_expense", { amount: 350, category: "transport" });
  ok("create_order", { description: "monthly ration", customer_name: "Lakshmi", due_on: "2026-11-11" });
  ok("create_order", { description: "oil tin", customer_name: "Gurpreet", due_on: "2026-11-08" });
  ok("create_order", { description: "sweets box", due_on: "2026-11-20" });
  ok("create_appointment", { service: "Home delivery", customer_name: "Neha", starts_at: "2026-11-11T18:00" });
  ok("create_appointment", { service: "Home delivery", customer_name: "Vikram", starts_at: "2026-11-12T10:00" });
  ok("set_item", { name: "Toor dal 1kg", low_stock_at: 8, quantity_on_hand: 5 });
  ok("set_item", { name: "Sugar", low_stock_at: 10, quantity_on_hand: 40 });
  return s;
}

test("the facts cover today, who to collect from, what's due and low stock", () => {
  const { tools } = busyDay();
  const f = briefingFacts(tools);
  assert.equal(f.today, "2026-11-10");
  assert.equal(f.tomorrow, "2026-11-11");
  assert.equal(f.number_of_sales, 2);
  assert.equal(f.sales, 2000);
  assert.equal(f.expenses, 350);
  assert.equal(f.udhaar_given, 800);
  assert.equal(f.udhaar_collected, 200);
  // Largest balance first, capped at three, with the rest counted.
  assert.deepEqual(f.collect, [{ name: "Ramesh", owes: 800 }, { name: "Imran", owes: 350 }, { name: "Sita", owes: 300 }]);
  assert.equal(f.more_to_collect, 1);
  assert.equal(f.total_outstanding, 1550);
  // Tomorrow's order, an overdue one, and tomorrow's booking; not next week's order or the day after's booking.
  assert.deepEqual(f.due.map((d) => [d.what, d.who, d.late]).sort(), [
    ["Home delivery", "Neha", false], ["monthly ration", "Lakshmi", false], ["oil tin", "Gurpreet", true],
  ]);
  assert.deepEqual(f.low_stock, ["Toor dal 1kg"]);
});

test("the Hinglish script reads naturally and includes every fact", () => {
  const { tools } = busyDay();
  const { lines, text } = briefingScript(briefingFacts(tools), { owner: "Rakesh", lang: "hinglish" });
  assert.equal(lines[0], "Namaste Rakesh ji, Counterbook se aaj ka hisaab.");
  assert.equal(lines[1], "Aaj 2 sales hui, kul ₹2,000.");
  assert.match(text, /Kharcha ₹350 hua\. Udhaar mein ₹200 wapas aaye\. ₹800 naya udhaar diya\./);
  assert.match(text, /Kal inse paise lene hain: Ramesh ₹800, Imran ₹350 aur Sita ₹300\./);
  assert.match(text, /Aur 1 log bhi, kul baaki ₹1,550\./);
  assert.match(text, /Lakshmi ka monthly ration/);
  assert.match(text, /Gurpreet ka oil tin \(pehle se late\)/);
  assert.match(text, /Neha ka Home delivery 18:00 baje/);
  assert.match(text, /Stock kam hai: Toor dal 1kg\./);
  assert.equal(lines.at(-1), "Shubh ratri!");
  assert.doesNotMatch(text, /sweets box|Vikram|Sugar/);
  assert.ok(text.length < 1500, "fits one text-to-speech request");
});

test("the English script, and a quiet day with nothing to report", () => {
  const { tools } = busyDay();
  const english = briefingScript(briefingFacts(tools), { owner: "Rakesh", lang: "english" }).text;
  assert.match(english, /^Hello Rakesh, this is Counterbook with today's accounts\. Today you made 2 sales, worth ₹2,000 in total\./);
  assert.match(english, /Tomorrow, collect from Ramesh \(₹800\), Imran \(₹350\) and Sita \(₹300\)\./);
  assert.match(english, /Running low: Toor dal 1kg\. Good night!$/);

  assert.match(briefingScript(briefingFacts(tools), { owner: "Sharma ji" }).lines[0], /^Namaste Sharma ji, /, "no double ji");
  const quiet = briefingScript(briefingFacts(shop().tools), { lang: "hinglish" }).lines;
  assert.deepEqual(quiet, [
    "Namaste ji, Counterbook se aaj ka hisaab.",
    "Aaj koi sale record nahi hui.",
    "Kisi ka udhaar baaki nahi hai.",
    "Kal koi delivery ya booking nahi hai.",
    "Shubh ratri!",
  ]);
});

test("call times must be real 24-hour times", () => {
  for (const ok of ["21:00", "00:00", "23:59", "09:30"]) assert.ok(isCallTime(ok), ok);
  for (const bad of ["24:00", "9:30", "21:60", "21:00:00", "", null, 2100]) assert.ok(!isCallTime(bad), String(bad));
  assert.equal(DEFAULT_CALL_TIME, "21:00");
});

test("the call's script and settings over HTTP", async () => {
  const { db } = busyDay();
  const server = createServer(createApp({ db, client: createDemoClient(), demo: true }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body) => fetch(`${base}/api/briefing/settings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  try {
    const state = await (await fetch(`${base}/api/state`)).json();
    assert.deepEqual(state.call, { enabled: true, time: "21:00" }, "on at 9 PM unless changed");

    const hinglish = await (await fetch(`${base}/api/briefing?lang=hinglish`)).json();
    assert.match(hinglish.lines[0], /^Namaste Rakesh ji/);
    assert.equal(hinglish.text, hinglish.lines.join(" "));
    assert.equal(hinglish.facts.low_stock[0], "Toor dal 1kg");
    const english = await (await fetch(`${base}/api/briefing?lang=english`)).json();
    assert.match(english.lines[0], /^Hello Rakesh/);
    const unknown = await (await fetch(`${base}/api/briefing?lang=klingon`)).json();
    assert.match(unknown.lines[0], /^Namaste/, "falls back to Hinglish");

    assert.deepEqual((await (await post({ enabled: false, time: "20:30" })).json()).call, { enabled: false, time: "20:30" });
    assert.deepEqual((await (await fetch(`${base}/api/state`)).json()).call, { enabled: false, time: "20:30" }, "saved with the shop");
    assert.equal((await post({ enabled: true, time: "25:00" })).status, 400);
    assert.equal((await post({ enabled: "yes", time: "20:00" })).status, 400);
    const form = await fetch(`${base}/api/briefing/settings`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" });
    assert.equal(form.status, 415, "other sites can't change it with a plain form");
  } finally {
    server.close();
  }
});

test("settings survive reopening an older database", () => {
  const db = openDb(":memory:");
  const row = db.prepare("SELECT call_enabled, call_time FROM business WHERE id = 1").get();
  assert.deepEqual({ ...row }, { call_enabled: 1, call_time: null });
});
