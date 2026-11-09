import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { createTools, TOOL_DEFINITIONS } from "../src/tools.js";

let tools;
// 2026-11-09 23:00 UTC is already 10 Nov in India; dates must follow IST.
const now = () => new Date("2026-11-09T23:00:00Z");
const TODAY = "2026-11-10";

beforeEach(() => {
  tools = createTools(openDb(":memory:"), { now });
});

const ok = (name, input) => {
  const out = tools.run(name, input);
  assert.equal(out.error, undefined, `unexpected error: ${out.error}`);
  return out;
};
const owes = () => ok("list_pending_payments", {}).result;

test("the business day follows India time, not UTC", () => {
  assert.equal(tools.today(), TODAY);
  assert.equal(ok("record_sale", { amount: 100, paid_amount: 100 }).result.date, TODAY);
});

test("every tool in the schema has a handler", () => {
  for (const def of TOOL_DEFINITIONS) {
    assert.doesNotMatch(tools.run(def.name, {}).error ?? "", /Unknown tool/, def.name);
    assert.equal(def.input_schema.additionalProperties, false);
  }
});

test("udhaar builds up from credit sales and falls with payments", () => {
  ok("record_sale", { amount: 500, paid_amount: 200, customer_name: "Ramesh" });
  assert.equal(owes().customers[0].owes, 300);
  ok("record_sale", { amount: 100, paid_amount: 0, customer_name: "ramesh" });
  assert.equal(owes().total_outstanding, 400, "same person despite different case");
  assert.equal(ok("record_payment", { amount: 150, customer_name: "Ramesh" }).result.remaining_balance, 250);
});

test("paying more than is owed is held as an advance and flagged", () => {
  ok("record_sale", { amount: 100, paid_amount: 0, customer_name: "Sita" });
  const { result } = ok("record_payment", { amount: 150, customer_name: "Sita" });
  assert.equal(result.remaining_balance, -50);
  assert.match(result.warning, /advance/);
  assert.equal(owes().total_outstanding, 0, "an advance must not offset what others owe");
});

test("an advance from one customer doesn't reduce total outstanding", () => {
  ok("record_sale", { amount: 100, paid_amount: 0, customer_name: "A" });
  ok("record_payment", { amount: 500, customer_name: "A" });
  ok("record_sale", { amount: 300, paid_amount: 0, customer_name: "B" });
  assert.equal(owes().total_outstanding, 300);
  assert.equal(tools.glance().outstanding, 300);
});

test("fractional rupees don't drift", () => {
  for (let i = 0; i < 3; i++) ok("record_sale", { amount: 0.1, paid_amount: 0, customer_name: "Asha" });
  assert.equal(owes().total_outstanding, 0.3);
});

test("bad money and dates are rejected without writing anything", () => {
  const cases = [
    ["record_sale", { amount: -5, paid_amount: 0 }],
    ["record_sale", { amount: 0, paid_amount: 0 }],
    ["record_sale", { amount: 100, paid_amount: 200 }],
    ["record_sale", { amount: 100, paid_amount: 50 }], // udhaar with nobody to owe it
    ["record_expense", { amount: 100, category: "rent", date: "2026-02-31" }],
    ["record_expense", { amount: 100, category: "rent", date: "2026-11-11" }], // future
    ["record_expense", { amount: Number.NaN, category: "rent" }],
    ["record_expense", { amount: 2e9, category: "rent" }],
    ["create_appointment", { service: "Haircut", starts_at: "tomorrow 5pm" }],
  ];
  for (const [name, input] of cases) assert.ok(tools.run(name, input).error, JSON.stringify(input));
  const summary = ok("get_business_summary", {}).result;
  assert.equal(summary.sales + summary.expenses, 0);
});

test("an ambiguous name asks rather than guesses", () => {
  ok("record_sale", { amount: 100, paid_amount: 0, customer_name: "Ramesh Gupta" });
  ok("record_sale", { amount: 200, paid_amount: 0, customer_name: "Ramesh Kumar" });
  const before = owes().total_outstanding;
  const out = tools.run("record_payment", { amount: 50, customer_name: "Ramesh" });
  assert.match(out.error, /more than one/);
  assert.match(out.error, /Ramesh Kumar/);
  assert.equal(owes().total_outstanding, before);
  // An ambiguous sale must not quietly create a third Ramesh either.
  assert.match(tools.run("record_sale", { amount: 10, paid_amount: 0, customer_name: "Ramesh" }).error, /more than one/);
  assert.equal(ok("find_customers", { query: "ramesh" }).result.customers.length, 2);
});

test("a payment from an unknown customer is refused, never auto-created", () => {
  assert.match(tools.run("record_payment", { amount: 50, customer_name: "Nobody" }).error, /No customer/);
  assert.equal(ok("find_customers", {}).result.customers.length, 0);
});

test("undo reverses a sale and the customer it created", () => {
  ok("record_sale", { amount: 500, paid_amount: 0, customer_name: "Mohan" });
  assert.match(ok("undo_last_action", {}).result.undone, /Sale ₹500 to Mohan/);
  assert.equal(owes().total_outstanding, 0);
  assert.equal(ok("find_customers", {}).result.customers.length, 0);
});

test("undo keeps a customer who has other entries", () => {
  const first = ok("record_sale", { amount: 500, paid_amount: 0, customer_name: "Mohan" });
  ok("record_sale", { amount: 200, paid_amount: 0, customer_name: "Mohan" });
  const out = tools.undoAction(first.action.id, { seen: false });
  assert.match(out.note, /kept/);
  assert.equal(owes().customers[0].owes, 200);
});

test("the same action can't be undone twice", () => {
  const { action } = ok("record_expense", { amount: 100, category: "rent" });
  tools.undoAction(action.id, { seen: false });
  assert.match(tools.run("undo_last_action", { action_id: action.id }).error, /Already undone/);
});

test("undo restores a previous status and profile", () => {
  const { result } = ok("create_order", { description: "Blouse", customer_name: "Asha", amount: 800 });
  ok("update_order_status", { order_id: result.order_id, status: "ready" });
  ok("undo_last_action", {});
  assert.equal(ok("list_orders", {}).result.orders[0].status, "open");

  ok("update_business_profile", { name: "First" });
  ok("update_business_profile", { name: "Second" });
  ok("undo_last_action", {});
  assert.equal(tools.profile().name, "First");
});

test("the button's undo is reported to the assistant exactly once", () => {
  const { action } = ok("record_expense", { amount: 100, category: "rent" });
  tools.undoAction(action.id, { seen: false });
  assert.deepEqual(tools.takeUnseenUndos(), ["Expense ₹100, rent"]);
  assert.deepEqual(tools.takeUnseenUndos(), []);
});

test("the summary compares with the previous period and ignores voided entries", () => {
  ok("record_sale", { amount: 1000, paid_amount: 1000, date: "2026-11-09" });
  ok("record_sale", { amount: 2000, paid_amount: 500, customer_name: "Asha" });
  ok("record_expense", { amount: 300, category: "stock" });
  const { action } = ok("record_expense", { amount: 999, category: "mistake" });
  tools.undoAction(action.id, { seen: true });

  const s = ok("get_business_summary", {}).result;
  assert.equal(s.sales, 2000);
  assert.equal(s.expenses, 300);
  assert.equal(s.udhaar_given, 1500);
  assert.equal(s.cash_received, 500);
  assert.equal(s.previous_period.sales, 1000);
  assert.deepEqual(s.expenses_by_category, [{ category: "stock", amount: 300 }]);
  assert.deepEqual(s.top_customers, [{ name: "Asha", sales: 2000 }]);
});

test("find_customers can spot customers who stopped coming", () => {
  ok("record_sale", { amount: 100, paid_amount: 100, customer_name: "Old", date: "2026-09-01" });
  ok("record_sale", { amount: 100, paid_amount: 100, customer_name: "Recent" });
  const names = ok("find_customers", { inactive_for_days: 30 }).result.customers.map((c) => c.name);
  assert.deepEqual(names, ["Old"]);
});

test("double-booking is recorded but flagged", () => {
  ok("create_appointment", { service: "Haircut", starts_at: "2026-11-10T17:00", customer_name: "Asha" });
  const { result } = ok("create_appointment", { service: "Facial", starts_at: "2026-11-10T17:00", customer_name: "Sita" });
  assert.match(result.warning, /Asha/);
  assert.equal(tools.glance().appointments_today, 2);
});

test("SQL metacharacters in names are treated as plain text", () => {
  ok("add_customer", { name: "O'Brien %_" });
  assert.equal(ok("find_customers", { query: "%" }).result.customers.length, 1);
  assert.equal(ok("find_customers", { query: "z%" }).result.customers.length, 0);
  assert.equal(ok("get_customer_details", { customer_name: "O'Brien %_" }).result.name, "O'Brien %_");
});
