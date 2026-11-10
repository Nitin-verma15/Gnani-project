// Documents the owner can print, save or share: bills and CSV exports.
import { formatRupees } from "./tools.js";

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ESCAPES[ch]);

const money = (paise) => escapeHtml(formatRupees(paise));
const qty = (n) => Number(Number(n).toFixed(3)).toLocaleString("en-IN");
const longDate = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

/** A self-contained, printable bill. Every value from the database is escaped. */
export function renderBill(bill) {
  const b = bill.business ?? {};
  const shop = b.name || "Your shop";
  const rows = bill.lines.length
    ? bill.lines.map((l) => `
        <tr>
          <td>${escapeHtml(l.name)}</td>
          <td class="num">${escapeHtml(qty(l.qty))} ${escapeHtml(l.unit)}</td>
          <td class="num">${l.price_paise != null ? money(l.price_paise) : "–"}</td>
          <td class="num">${l.price_paise != null ? money(Math.round(l.price_paise * l.qty)) : "–"}</td>
        </tr>`).join("")
    : `<tr><td colspan="3">${escapeHtml(bill.description || "Goods / services")}</td><td class="num">${money(bill.amount)}</td></tr>`;
  const gst = bill.gst
    ? `<tr><td colspan="3">Taxable value</td><td class="num">${money(bill.gst.taxable)}</td></tr>
       <tr><td colspan="3">CGST @ ${bill.gst.rate / 2}%</td><td class="num">${money(bill.gst.cgst)}</td></tr>
       <tr><td colspan="3">SGST @ ${bill.gst.rate / 2}%</td><td class="num">${money(bill.gst.sgst)}</td></tr>`
    : "";
  const due = bill.due > 0
    ? `<tr><td colspan="3">Paid now</td><td class="num">${money(bill.paid)}</td></tr>
       <tr class="due"><td colspan="3">Balance due</td><td class="num">${money(bill.due)}</td></tr>`
    : `<tr><td colspan="3">Paid</td><td class="num">${money(bill.paid)}</td></tr>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(bill.number)} · ${escapeHtml(shop)}</title>
<style>
  :root { --ink: #232120; --muted: #5e5648; --line: #dccbaa; --red: #9b1d19; --paper: #fffdf8; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #e9dfca; color: var(--ink); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  .sheet { position: relative; width: min(720px, 100% - 32px); margin: 24px auto; padding: 36px; background: var(--paper); border-radius: 14px; box-shadow: 0 20px 50px -30px #000; overflow: hidden; }
  header { display: flex; justify-content: space-between; gap: 24px; flex-wrap: wrap; padding-bottom: 20px; border-bottom: 2px solid var(--ink); }
  h1 { margin: 0; font-size: 26px; line-height: 1.1; }
  .meta { text-align: right; color: var(--muted); }
  .meta b { display: block; color: var(--ink); font-size: 18px; }
  .muted { color: var(--muted); }
  .to { margin: 20px 0; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 13px; color: var(--muted); font-weight: 600; border-bottom: 1px solid var(--line); padding: 8px 6px; }
  td { padding: 9px 6px; border-bottom: 1px solid #eee6d4; vertical-align: top; }
  .num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .total td { border-top: 2px solid var(--ink); border-bottom: 0; font-weight: 700; font-size: 18px; }
  .due td { color: #a4261c; font-weight: 700; }
  .pay { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-top: 24px; padding: 14px 16px; border-radius: 10px; background: #fbf0d9; box-shadow: inset 0 0 0 1px #f2d79b; }
  .pay a { color: var(--red); font-weight: 700; }
  footer { margin-top: 28px; color: var(--muted); font-size: 13px; }
  .actions { display: flex; gap: 8px; justify-content: center; margin: 0 auto 32px; }
  .actions button, .actions a { min-height: 44px; padding: 0 18px; border: 0; border-radius: 10px; background: var(--ink); color: #fff; font: 600 15px system-ui, sans-serif; cursor: pointer; display: inline-flex; align-items: center; text-decoration: none; }
  .actions .alt { background: transparent; color: var(--ink); box-shadow: inset 0 0 0 1.5px var(--ink); }
  .void { position: absolute; top: 42%; left: 50%; transform: translate(-50%, -50%) rotate(-18deg); font: 800 110px/1 system-ui, sans-serif; color: rgb(164 38 28 / .18); letter-spacing: .1em; pointer-events: none; }
  @media print { body { background: #fff; } .sheet { box-shadow: none; margin: 0; width: 100%; border-radius: 0; } .actions { display: none; } }
  @media (max-width: 520px) { .sheet { padding: 22px; } .meta { text-align: left; } }
</style>
</head>
<body>
<main class="sheet">
  ${bill.voided ? '<div class="void" aria-label="This sale was undone">VOID</div>' : ""}
  <header>
    <div>
      <h1>${escapeHtml(shop)}</h1>
      ${b.address ? `<div class="muted">${escapeHtml(b.address)}</div>` : ""}
      ${b.phone ? `<div class="muted">Phone: ${escapeHtml(b.phone)}</div>` : ""}
      ${b.gstin ? `<div class="muted">GSTIN: ${escapeHtml(b.gstin)}</div>` : ""}
    </div>
    <div class="meta">
      ${bill.gst ? "Tax invoice" : "Bill"}
      <b>${escapeHtml(bill.number)}</b>
      ${escapeHtml(longDate(bill.date))}
    </div>
  </header>
  <p class="to"><span class="muted">Billed to</span><br><strong>${escapeHtml(bill.customer?.name || "Walk-in customer")}</strong>${bill.customer?.phone ? `<br><span class="muted">${escapeHtml(bill.customer.phone)}</span>` : ""}</p>
  <table>
    <thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Amount</th></tr></thead>
    <tbody>
      ${rows}
      ${gst}
      <tr class="total"><td colspan="3">Total${bill.gst ? " (incl. GST)" : ""}</td><td class="num">${money(bill.amount)}</td></tr>
      ${due}
    </tbody>
  </table>
  ${bill.upi_url ? `<div class="pay"><span>Pay ${money(bill.due)} by UPI to <strong>${escapeHtml(b.upi_id)}</strong></span><a href="${escapeHtml(bill.upi_url)}">Pay with a UPI app</a></div>` : ""}
  <footer>Thank you! · Made with Munshi</footer>
</main>
<div class="actions">
  <button type="button" onclick="print()">Print or save as PDF</button>
  <a class="alt" href="/app">Back to Munshi</a>
</div>
</body>
</html>`;
}

const csvCell = (value) => {
  if (value == null) return "";
  let text = String(value);
  // Stops a spreadsheet from running a cell that starts like a formula.
  if (/^[=+\-@\t\r]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/** CSV with a byte-order mark, so Excel reads ₹ and Hindi names correctly. */
export function toCsv(rows) {
  if (!rows.length) return "﻿";
  const columns = Object.keys(rows[0]);
  const lines = [columns.join(","), ...rows.map((row) => columns.map((c) => csvCell(row[c])).join(","))];
  return `﻿${lines.join("\r\n")}\r\n`;
}
