import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import Anthropic from "@anthropic-ai/sdk";
import { openDb } from "../src/db.js";
import { createTools, TOOL_DEFINITIONS } from "../src/tools.js";
import { runTurn, MODEL } from "../src/agent.js";
import { createApp } from "../src/server.js";
import { createDemoClient } from "../src/demo.js";

/** A client that plays back scripted responses and records each request. */
function scriptedClient(responses) {
  const requests = [];
  return {
    requests,
    beta: {
      messages: {
        stream(params) {
          // Snapshot now: the agent keeps appending to the same array.
          requests.push(JSON.parse(JSON.stringify(params)));
          const next = responses.shift();
          return {
            on() { return this; },
            finalMessage: async () => {
              if (next instanceof Error) throw next;
              return next;
            },
          };
        },
      },
    },
  };
}

const say = (text) => ({ stop_reason: "end_turn", content: [{ type: "text", text }] });
const use = (...calls) => ({
  stop_reason: "tool_use",
  content: [
    { type: "thinking", thinking: "", signature: "sig" },
    ...calls.map(([name, input], i) => ({ type: "tool_use", id: `t${i}`, name, input })),
  ],
});

function setup(responses) {
  const db = openDb(":memory:");
  const client = scriptedClient(responses);
  return { db, client, tools: createTools(db) };
}

test("a tool round trip records the entry and sends the result back", async () => {
  const { db, client, tools } = setup([use(["record_sale", { amount: 500, paid_amount: 0, customer_name: "Ramesh" }]), say("Ho gaya.")]);
  const events = [];
  const { reply, actionIds } = await runTurn({ db, client, tools, text: "Ramesh ko 500 udhaar", emit: (e) => events.push(e) });

  assert.equal(reply, "Ho gaya.");
  assert.equal(actionIds.length, 1);
  assert.equal(tools.glance().outstanding, 500);
  assert.ok(events.some((e) => e.type === "action" && /₹500/.test(e.action.summary)));

  const [first, second] = client.requests;
  assert.equal(first.model, MODEL);
  assert.equal(first.tools.length, TOOL_DEFINITIONS.length);
  assert.match(first.messages[0].content[0].text, /<context>/);
  assert.equal(first.messages[0].content[1].text, "Ramesh ko 500 udhaar");
  const result = second.messages.at(-1).content[0];
  assert.equal(result.tool_use_id, "t0");
  assert.equal(JSON.parse(result.content).customer_balance, 500);
});

test("parallel tool results go back in a single message", async () => {
  const { db, client, tools } = setup([use(["record_expense", { amount: 100, category: "rent" }], ["record_expense", { amount: 200, category: "stock" }]), say("Done.")]);
  await runTurn({ db, client, tools, text: "two expenses" });
  const last = client.requests[1].messages.at(-1);
  assert.equal(last.role, "user");
  assert.deepEqual(last.content.map((b) => b.tool_use_id), ["t0", "t1"]);
});

test("tool errors reach the model as errors", async () => {
  const { db, client, tools } = setup([use(["record_payment", { amount: 50, customer_name: "Nobody" }]), say("Kaun?")]);
  await runTurn({ db, client, tools, text: "Nobody ne 50 diye" });
  const result = client.requests[1].messages.at(-1).content[0];
  assert.equal(result.is_error, true);
  assert.match(result.content, /No customer/);
});

test("history is append-only and thinking blocks are replayed unchanged across turns", async () => {
  const { db, client, tools } = setup([use(["record_expense", { amount: 100, category: "rent" }]), say("One."), say("Two.")]);
  await runTurn({ db, client, tools, text: "first" });
  await runTurn({ db, client, tools, text: "second" });
  const earlier = client.requests[1].messages;
  const later = client.requests[2].messages;
  assert.deepEqual(later.slice(0, earlier.length), earlier);
  assert.equal(later[1].content[0].type, "thinking");
  assert.equal(later[1].content[0].signature, "sig");
});

test("the context block stays out of the system prompt so the cache prefix is stable", async () => {
  const { db, client, tools } = setup([say("One."), say("Two.")]);
  await runTurn({ db, client, tools, text: "first", now: new Date("2026-11-09T05:00:00Z") });
  await runTurn({ db, client, tools, text: "second", now: new Date("2026-11-09T09:00:00Z") });
  assert.equal(client.requests[0].system, client.requests[1].system);
  assert.deepEqual(client.requests[0].tools, client.requests[1].tools);
});

test("an Undo button press is told to the model on the next turn", async () => {
  const { db, client, tools } = setup([use(["record_expense", { amount: 100, category: "rent" }]), say("Done."), say("OK.")]);
  const { actionIds } = await runTurn({ db, client, tools, text: "100 rent" });
  tools.undoAction(actionIds[0], { seen: false });
  await runTurn({ db, client, tools, text: "next" });
  const context = client.requests[2].messages.at(-1).content[0].text;
  assert.match(context, /tapped Undo/);
  assert.match(context, /Expense ₹100/);
});

test("a refusal isn't stored in history and doesn't run tools", async () => {
  const { db, client, tools } = setup([{
    stop_reason: "refusal",
    content: [{ type: "tool_use", id: "x", name: "record_expense", input: { amount: 1, category: "x" } }],
  }]);
  const { reply } = await runTurn({ db, client, tools, text: "..." });
  assert.match(reply, /Sorry/);
  assert.equal(tools.glance().expenses_today, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM thread_messages WHERE role = 'assistant'").get().n, 0);
});

test("tool input cut off at max_tokens isn't run", async () => {
  const { db, client, tools } = setup([{
    stop_reason: "max_tokens",
    content: [{ type: "tool_use", id: "x", name: "record_expense", input: { amount: 1, category: "x" } }],
  }]);
  await assert.rejects(runTurn({ db, client, tools, text: "..." }), /truncated/);
  assert.equal(tools.glance().expenses_today, 0);
});

test("a failure after a tool ran keeps the entry and a usable conversation", async () => {
  const { db, client, tools } = setup([use(["record_expense", { amount: 100, category: "rent" }]), new Error("network"), say("Back.")]);
  await assert.rejects(runTurn({ db, client, tools, text: "first" }), /network/);
  assert.equal(tools.glance().expenses_today, 100);
  await runTurn({ db, client, tools, text: "second" });
  // tool_use must still be answered by its tool_result, or the API would reject the history.
  const roles = client.requests[2].messages.map((m) => m.content[0].type);
  assert.deepEqual(roles, ["text", "thinking", "tool_result", "text"]);
});

test("the loop stops if the model keeps calling tools", async () => {
  const forever = Array.from({ length: 30 }, () => use(["get_business_summary", {}]));
  const { db, client, tools } = setup(forever);
  const { reply } = await runTurn({ db, client, tools, text: "..." });
  assert.equal(client.requests.length, 10);
  assert.match(reply, /couldn't finish/);
});

async function withServer(client, fn, { demo = false } = {}) {
  const db = openDb(":memory:");
  const server = createServer(createApp({ db, client, demo }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    server.close();
  }
}

const post = (url, body) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function chat(base, text) {
  const raw = await (await post(`${base}/api/chat`, { text })).text();
  return raw.split("\n\n").filter(Boolean).map((line) => JSON.parse(line.replace(/^data: /, "")));
}

test("demo mode works over HTTP from message to undo", async () => {
  await withServer(createDemoClient(), async (base) => {
    const events = await chat(base, "Ramesh ko 1,500 udhaar diya");
    const action = events.find((e) => e.type === "action").action;
    assert.equal(events.at(-1).type, "done");
    assert.equal(events.at(-1).glance.outstanding, 1500);

    const state = await (await fetch(`${base}/api/state`)).json();
    assert.equal(state.demo, true);
    assert.equal(state.messages.length, 2);
    assert.equal(state.messages[1].actions[0].id, action.id);

    const undone = await (await post(`${base}/api/actions/${action.id}/undo`, {})).json();
    assert.equal(undone.glance.outstanding, 0);
    assert.equal((await post(`${base}/api/actions/${action.id}/undo`, {})).status, 409);
  }, { demo: true });
});

test("demo mode handles its advertised phrases", async () => {
  await withServer(createDemoClient(), async (base) => {
    const reply = async (text) => (await chat(base, text)).at(-1).reply;
    assert.match(await reply("Ramesh ko 500 udhaar diya"), /Sale ₹500 to Ramesh/);
    assert.match(await reply("Ramesh ne 200 diye"), /Baaki ₹300/);
    assert.match(await reply("300 ka kharcha"), /Expense ₹300/);
    assert.match(await reply("1000 ki sale"), /Sale ₹1,000/);
    assert.match(await reply("kitna udhaar baaki hai"), /₹300/);
    assert.match(await reply("aaj ka hisaab"), /sale ₹1,500, kharcha ₹300/);
    assert.match(await reply("undo"), /hata diya/);
    assert.match(await reply("mausam kaisa hai"), /Demo mode/);
  }, { demo: true });
});

test("API failures become plain messages and keep already saved entries", async () => {
  const authError = new Anthropic.AuthenticationError(401, {}, "bad key", new Headers());
  const client = scriptedClient([use(["record_expense", { amount: 100, category: "rent" }]), authError]);
  await withServer(client, async (base) => {
    const last = (await chat(base, "100 rent")).at(-1);
    assert.equal(last.type, "error");
    assert.match(last.message, /ANTHROPIC_API_KEY/);
    assert.doesNotMatch(last.message, /401/);
    assert.equal(last.glance.expenses_today, 100);
    const { messages } = await (await fetch(`${base}/api/state`)).json();
    assert.equal(messages.at(-1).actions.length, 1, "the entry still has its Undo after reload");
  });
});

test("the server rejects bad requests and other hosts", async () => {
  await withServer(createDemoClient(), async (base) => {
    assert.equal((await post(`${base}/api/chat`, { text: "   " })).status, 400);
    assert.equal((await post(`${base}/api/chat`, { text: "x".repeat(4001) })).status, 413);
    const form = await fetch(`${base}/api/chat`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: '{"text":"hi"}' });
    assert.equal(form.status, 415, "plain cross-site form posts are refused");
    assert.equal((await fetch(`${base}/../package.json`)).status, 404);
  });
  // fetch won't let us spoof Host, so call the handler directly.
  const handler = createApp({ db: openDb(":memory:"), client: createDemoClient(), demo: true });
  let status;
  const res = { writeHead: (s) => { status = s; }, end() {}, headersSent: false };
  await handler({ method: "GET", url: "/api/state", headers: { host: "evil.example" } }, res);
  assert.equal(status, 403);
});

test("the real SDK sends a valid-looking request and parses a streamed tool call", async () => {
  const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  const start = (stop) => ({ id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 }, ...stop });
  const toolTurn = sse([
    { type: "message_start", message: start() },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "record_expense", input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"amount": 300,' } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: ' "category": "transport"}' } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: "message_stop" },
  ]);
  const textTurn = sse([
    { type: "message_start", message: start() },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "₹300 " } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "likh diya." } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: "message_stop" },
  ]);

  const seen = [];
  const turns = [toolTurn, textTurn];
  const api = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    seen.push({ url: req.url, headers: req.headers, body: JSON.parse(raw) });
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(turns.shift());
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));

  try {
    const db = openDb(":memory:");
    const tools = createTools(db);
    const client = new Anthropic({ apiKey: "test-key", baseURL: `http://127.0.0.1:${api.address().port}` });
    const deltas = [];
    const { reply } = await runTurn({
      db, client, tools, text: "300 transport",
      emit: (e) => { if (e.type === "text") deltas.push(e.delta); },
    });

    assert.equal(reply, "₹300 likh diya.");
    assert.deepEqual(deltas, ["₹300 ", "likh diya."]);
    assert.equal(tools.glance().expenses_today, 300);

    const { url, headers, body } = seen[0];
    assert.match(url, /^\/v1\/messages/);
    assert.match(headers["anthropic-beta"], /server-side-fallback-2026-07-01/);
    assert.equal(body.model, "claude-opus-5-5");
    assert.equal(body.stream, true);
    assert.equal(body.fallbacks, "default");
    assert.equal(body.betas, undefined, "betas travel as a header, not in the body");
    assert.deepEqual(body.output_config, { effort: "medium" });
    assert.equal(body.thinking, undefined);
    assert.ok(body.tools.every((t) => t.strict === true));

    // The replayed tool call must carry parsed input and no SDK-internal fields.
    const replayed = seen[1].body.messages[1].content[0];
    assert.deepEqual(Object.keys(replayed).sort(), ["id", "input", "name", "type"]);
    assert.deepEqual(replayed.input, { amount: 300, category: "transport" });
  } finally {
    api.close();
  }
});
