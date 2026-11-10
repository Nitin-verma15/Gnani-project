import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { openDb } from "../src/db.js";
import { createTools, TOOL_DEFINITIONS } from "../src/tools.js";
import { runTurn } from "../src/agent.js";
import { createApp } from "../src/server.js";
import { createGeminiClient, toGeminiTools, toGeminiContents, GeminiApiError, geminiFriendlyError } from "../src/gemini.js";

/** A stand-in for Google's API: answers from a script and records every request. */
function fakeGemini(responses, { retryDelays = [] } = {}) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const next = responses.shift();
    if (next.status) return new Response(JSON.stringify({ error: { message: next.message } }), { status: next.status });
    return new Response(JSON.stringify(next), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return { requests, client: createGeminiClient({ apiKey: "test-key", model: "gemini-3.8-flash", fetchImpl, retryDelays }) };
}

test("a busy Gemini is tried again before giving up, and then explained plainly", async () => {
  const db = openDb(":memory:");
  const tools = createTools(db);
  const busy = { status: 503, message: "This model is currently experiencing high demand." };
  const { client, requests } = fakeGemini([busy, busy, reply([{ text: "Ho gaya." }])], { retryDelays: [1, 1] });
  assert.equal((await runTurn({ db, client, tools, text: "hi" })).reply, "Ho gaya.");
  assert.equal(requests.length, 3);

  const stillBusy = fakeGemini([busy, busy, busy], { retryDelays: [1, 1] });
  await assert.rejects(runTurn({ db, client: stillBusy.client, tools, text: "hi" }), (err) => err.status === 503);
  assert.match(geminiFriendlyError(new GeminiApiError(503, "busy")), /busy/);

  const noKey = fakeGemini([{ status: 400, message: "API key not valid." }], { retryDelays: [1, 1] });
  await assert.rejects(runTurn({ db, client: noKey.client, tools, text: "hi" }), (err) => err.status === 400);
  assert.equal(noKey.requests.length, 1, "a bad key isn't retried");
});

const reply = (parts, finishReason = "STOP") => ({ candidates: [{ content: { role: "model", parts }, finishReason }] });

test("tool schemas are converted to the subset Gemini accepts", () => {
  const [{ functionDeclarations }] = toGeminiTools(TOOL_DEFINITIONS);
  assert.equal(functionDeclarations.length, TOOL_DEFINITIONS.length);
  const text = JSON.stringify(functionDeclarations);
  assert.doesNotMatch(text, /additionalProperties|strict/);
  const sale = functionDeclarations.find((d) => d.name === "record_sale");
  assert.equal(sale.parameters.properties.gst_rate.enum, undefined, "number enums become a description");
  assert.match(sale.parameters.properties.gst_rate.description, /One of: 0, 5, 12, 18, 28/);
  assert.deepEqual(sale.parameters.properties.items.items.required, ["item_name", "quantity"]);
  assert.equal(functionDeclarations.find((d) => d.name === "list_pending_payments").parameters, undefined);
  assert.deepEqual(functionDeclarations.find((d) => d.name === "record_payment").parameters.properties.method.enum, ["cash", "upi", "card", "bank", "other"]);
});

test("a Gemini tool round trip records the entry and returns the signature and id exactly", async () => {
  const db = openDb(":memory:");
  const tools = createTools(db);
  const { client, requests } = fakeGemini([
    reply([{ functionCall: { id: "call-1", name: "record_sale", args: { amount: 500, paid_amount: 0, customer_name: "Ramesh" } }, thoughtSignature: "SIG_A" }]),
    reply([{ text: "Ramesh ka ₹500 udhaar likh diya.", thoughtSignature: "SIG_B" }]),
  ]);
  const events = [];
  const { reply: text, actionIds } = await runTurn({ db, client, tools, text: "Ramesh ko 500 udhaar", emit: (e) => events.push(e) });

  assert.equal(text, "Ramesh ka ₹500 udhaar likh diya.");
  assert.equal(actionIds.length, 1);
  assert.equal(tools.glance().outstanding, 500);
  assert.ok(events.some((e) => e.type === "text" && /udhaar/.test(e.delta)));

  const [first, second] = requests;
  assert.match(first.url, /\/v1beta\/models\/gemini-3\.8-flash:generateContent$/);
  assert.equal(first.headers["x-goog-api-key"], "test-key");
  assert.doesNotMatch(first.url, /test-key/, "the key never goes in the URL");
  assert.match(first.body.systemInstruction.parts[0].text, /You are Munshi/);
  assert.match(first.body.contents[0].parts[0].text, /<context>/);
  assert.equal(first.body.contents[0].parts[1].text, "Ramesh ko 500 udhaar");

  const [, model, results] = second.body.contents;
  assert.equal(model.role, "model");
  assert.deepEqual(model.parts[0], { functionCall: { name: "record_sale", args: { amount: 500, paid_amount: 0, customer_name: "Ramesh" }, id: "call-1" }, thoughtSignature: "SIG_A" });
  assert.equal(results.role, "user");
  const fr = results.parts[0].functionResponse;
  assert.equal(fr.id, "call-1");
  assert.equal(fr.name, "record_sale");
  assert.equal(fr.response.customer_balance, 500);
});

test("parallel calls go back as one turn, with the signature only where it came", async () => {
  const db = openDb(":memory:");
  const tools = createTools(db);
  const { client, requests } = fakeGemini([
    reply([
      { functionCall: { id: "a", name: "record_expense", args: { amount: 100, category: "rent" } }, thoughtSignature: "SIG" },
      { functionCall: { id: "b", name: "record_expense", args: { amount: 200, category: "stock" } } },
    ]),
    reply([{ text: "Done." }]),
  ]);
  await runTurn({ db, client, tools, text: "two expenses" });
  const [, model, results] = requests[1].body.contents;
  assert.equal(model.parts[0].thoughtSignature, "SIG");
  assert.equal(model.parts[1].thoughtSignature, undefined);
  assert.deepEqual(results.parts.map((p) => p.functionResponse.id), ["a", "b"]);
  assert.equal(tools.glance().expenses_today, 300);
});

test("tool errors reach Gemini as an error response", async () => {
  const db = openDb(":memory:");
  const tools = createTools(db);
  const { client, requests } = fakeGemini([
    reply([{ functionCall: { id: "x", name: "record_payment", args: { amount: 50, customer_name: "Nobody" } } }]),
    reply([{ text: "Kaun?" }]),
  ]);
  await runTurn({ db, client, tools, text: "Nobody ne 50 diye" });
  assert.match(requests[1].body.contents[2].parts[0].functionResponse.response.error, /No customer/);
});

test("a safety stop or blocked prompt becomes the polite refusal", async () => {
  const db = openDb(":memory:");
  const tools = createTools(db);
  const { client } = fakeGemini([reply([], "SAFETY"), { promptFeedback: { blockReason: "OTHER" } }]);
  assert.match((await runTurn({ db, client, tools, text: "..." })).reply, /Sorry/);
  assert.match((await runTurn({ db, client, tools, text: "..." })).reply, /Sorry/);
});

test("turns from the same side are joined, so Gemini always sees them alternate", () => {
  const contents = toGeminiContents([
    { role: "user", content: [{ type: "text", text: "a" }] },
    { role: "user", content: [{ type: "text", text: "b" }] },
    { role: "assistant", content: [{ type: "thinking", thinking: "", signature: "claude" }, { type: "text", text: "c" }] },
  ]);
  assert.deepEqual(contents, [
    { role: "user", parts: [{ text: "a" }, { text: "b" }] },
    { role: "model", parts: [{ text: "c" }] },
  ]);
});

test("Claude and Gemini keep separate conversations in the same database", async () => {
  const db = openDb(":memory:");
  const tools = createTools(db);
  const claude = {
    beta: { messages: { stream: () => ({ on() { return this; }, finalMessage: async () => ({ stop_reason: "end_turn", content: [{ type: "thinking", thinking: "", signature: "s" }, { type: "text", text: "Hi" }] }) }) } },
  };
  await runTurn({ db, client: claude, tools, text: "first, with Claude" });
  const { client, requests } = fakeGemini([reply([{ text: "Namaste" }])]);
  await runTurn({ db, client, tools, text: "then Gemini" });
  assert.equal(requests[0].body.contents.length, 1, "Gemini starts its own thread");
  assert.doesNotMatch(JSON.stringify(requests[0].body), /first, with Claude/);
});

test("Gemini failures become plain messages, and the free-limit case says so", async () => {
  assert.match(geminiFriendlyError(new GeminiApiError(429, "quota")), /free limit/);
  assert.match(geminiFriendlyError(new GeminiApiError(400, "API key not valid. Please pass a valid API key.")), /GEMINI_API_KEY/);
  assert.match(geminiFriendlyError(new GeminiApiError(404, "not found")), /GEMINI_MODEL/);

  const { client } = fakeGemini([{ status: 429, message: "Resource has been exhausted" }]);
  const server = createServer(createApp({ db: openDb(":memory:"), client, demo: false }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/chat`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "hi" }),
    });
    const events = (await res.text()).split("\n\n").filter(Boolean).map((l) => JSON.parse(l.replace(/^data: /, "")));
    assert.equal(events.at(-1).type, "error");
    assert.match(events.at(-1).message, /free limit/);
    assert.doesNotMatch(events.at(-1).message, /exhausted/, "Google's raw error stays in the server log");
  } finally {
    server.close();
  }
});
