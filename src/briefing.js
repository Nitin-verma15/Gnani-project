// The nightly hisaab call: a short spoken summary of the day, in the owner's language.
// Kept to a handful of sentences so it reads well aloud and fits one text-to-speech request.
import { addDays } from "./tools.js";

export const DEFAULT_CALL_TIME = "21:00";
const CALL_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_COLLECT = 3;
const MAX_LOW_STOCK = 4;

export const isCallTime = (value) => typeof value === "string" && CALL_TIME.test(value);

/** "Rakesh" becomes "Rakesh ji"; "Sharma ji" stays as it is. */
const withJi = (name) => (/\bji$/i.test(name) ? name : `${name} ji`);

const inr = (rupees) => `₹${Number(rupees).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

/** "A, B and C" in either language. */
function joinList(items, and) {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} ${and} ${items.at(-1)}`;
}

/**
 * Everything the call says, worked out from the shop's books.
 * Returns plain facts, so the wording and the facts can be tested separately.
 */
export function briefingFacts(tools) {
  const today = tools.today();
  const tomorrow = addDays(today, 1);
  const totals = tools.todayTotals();
  const overview = tools.overview();
  const pending = overview.pending; // largest balance first
  return {
    today,
    tomorrow,
    sales: totals.sales,
    number_of_sales: totals.number_of_sales,
    expenses: totals.expenses,
    udhaar_given: totals.udhaar_given,
    udhaar_collected: totals.udhaar_collected,
    collect: pending.slice(0, MAX_COLLECT).map((p) => ({ name: p.name, owes: p.owes })),
    more_to_collect: Math.max(0, pending.length - MAX_COLLECT),
    total_outstanding: pending.reduce((sum, p) => sum + p.owes, 0),
    // Orders due by tomorrow, including any already late, and tomorrow's bookings.
    due: [
      ...overview.orders
        .filter((o) => o.due_on && o.due_on <= tomorrow)
        .map((o) => ({ what: o.description, who: o.customer ?? null, late: o.due_on < today })),
      ...overview.appointments
        .filter((a) => a.status === "booked" && a.starts_at.slice(0, 10) === tomorrow)
        .map((a) => ({ what: a.service, who: a.customer ?? null, at: a.starts_at.slice(11, 16), late: false })),
    ],
    low_stock: overview.stock.filter((i) => i.low).slice(0, MAX_LOW_STOCK).map((i) => i.name),
  };
}

const WORDS = {
  hinglish: {
    hello: (owner) => `Namaste ${owner ? withJi(owner) : "ji"}, Counterbook se aaj ka hisaab.`,
    sales: (n, total) => `Aaj ${n} ${n === 1 ? "sale hui" : "sales hui"}, kul ${inr(total)}.`,
    noSales: "Aaj koi sale record nahi hui.",
    spent: (x) => `Kharcha ${inr(x)} hua.`,
    collected: (x) => `Udhaar mein ${inr(x)} wapas aaye.`,
    given: (x) => `${inr(x)} naya udhaar diya.`,
    collect: (list) => `Kal inse paise lene hain: ${list}.`,
    owes: (name, x) => `${name} ${inr(x)}`,
    more: (n, total) => `Aur ${n} log bhi, kul baaki ${inr(total)}.`,
    nobodyOwes: "Kisi ka udhaar baaki nahi hai.",
    due: (list) => `Kal ke kaam: ${list}.`,
    dueItem: (d) => `${d.who ? `${d.who} ka ` : ""}${d.what}${d.at ? ` ${d.at} baje` : ""}${d.late ? " (pehle se late)" : ""}`,
    noneDue: "Kal koi delivery ya booking nahi hai.",
    low: (list) => `Stock kam hai: ${list}.`,
    bye: "Shubh ratri!",
    and: "aur",
  },
  english: {
    hello: (owner) => `Hello${owner ? ` ${owner}` : ""}, this is Counterbook with today's accounts.`,
    sales: (n, total) => `Today you made ${n} ${n === 1 ? "sale" : "sales"}, worth ${inr(total)} in total.`,
    noSales: "No sales were recorded today.",
    spent: (x) => `You spent ${inr(x)}.`,
    collected: (x) => `${inr(x)} of credit was paid back.`,
    given: (x) => `You gave ${inr(x)} of new credit.`,
    collect: (list) => `Tomorrow, collect from ${list}.`,
    owes: (name, x) => `${name} (${inr(x)})`,
    more: (n, total) => `${n} more ${n === 1 ? "person owes" : "people owe"} too; ${inr(total)} is due in all.`,
    nobodyOwes: "Nobody owes you money right now.",
    due: (list) => `Due tomorrow: ${list}.`,
    dueItem: (d) => `${d.what}${d.who ? ` for ${d.who}` : ""}${d.at ? ` at ${d.at}` : ""}${d.late ? " (already late)" : ""}`,
    noneDue: "Nothing is due tomorrow.",
    low: (list) => `Running low: ${list}.`,
    bye: "Good night!",
    and: "and",
  },
};

/** The call's script: one sentence per line, ready to show and to speak. */
export function briefingScript(facts, { owner = "", lang = "hinglish" } = {}) {
  const w = WORDS[lang] ?? WORDS.hinglish;
  const lines = [w.hello(owner.trim())];
  lines.push(facts.number_of_sales ? w.sales(facts.number_of_sales, facts.sales) : w.noSales);
  const money = [];
  if (facts.expenses > 0) money.push(w.spent(facts.expenses));
  if (facts.udhaar_collected > 0) money.push(w.collected(facts.udhaar_collected));
  if (facts.udhaar_given > 0) money.push(w.given(facts.udhaar_given));
  if (money.length) lines.push(money.join(" "));
  if (facts.collect.length) {
    lines.push(w.collect(joinList(facts.collect.map((c) => w.owes(c.name, c.owes)), w.and)));
    if (facts.more_to_collect) lines.push(w.more(facts.more_to_collect, facts.total_outstanding));
  } else {
    lines.push(w.nobodyOwes);
  }
  lines.push(facts.due.length ? w.due(joinList(facts.due.map(w.dueItem), w.and)) : w.noneDue);
  if (facts.low_stock.length) lines.push(w.low(joinList(facts.low_stock, w.and)));
  lines.push(w.bye);
  return { lines, text: lines.join(" ") };
}
