import { tx } from "./db.js";

const TIME_ZONE = "Asia/Kolkata";
const MAX_RUPEES = 1_000_000_000;
const MAX_QTY = 1_000_000;
const GST_RATES = [0, 5, 12, 18, 28];
const GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const UPI_ID = /^[\w.-]{2,256}@[a-zA-Z][\w]{1,63}$/;

/** A problem the assistant should read and act on, usually by asking the owner. */
export class ToolError extends Error {}

export const localDate = (date) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE }).format(date);

export const addDays = (isoDate, days) => {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

const daysBetween = (from, to) =>
  Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86_400_000);

const rupees = (paise) => (paise ?? 0) / 100;
export const formatRupees = (paise) =>
  `₹${rupees(paise).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const formatQty = (qty) => Number(qty.toFixed(3)).toLocaleString("en-IN");

function toPaise(value, label, { allowZero = false } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new ToolError(`${label} must be a number.`);
  if (value < 0 || (value === 0 && !allowZero)) throw new ToolError(`${label} must be more than zero.`);
  if (value > MAX_RUPEES) throw new ToolError(`${label} looks too large (${value}). Confirm the amount with the owner.`);
  return Math.round(value * 100);
}

function toQty(value, label, { signed = false } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new ToolError(`${label} must be a number.`);
  if (value === 0 || (!signed && value < 0)) throw new ToolError(`${label} must be more than zero.`);
  if (Math.abs(value) > MAX_QTY) throw new ToolError(`${label} looks too large (${value}). Confirm it with the owner.`);
  return Math.round(value * 1000) / 1000;
}

function checkDate(value, label = "date") {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? "")) throw new ToolError(`${label} must be YYYY-MM-DD.`);
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) {
    throw new ToolError(`${label} is not a real date: ${value}.`);
  }
  return value;
}

function checkDateTime(value) {
  if (!/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/.test(value ?? "")) {
    throw new ToolError("starts_at must be YYYY-MM-DDTHH:MM in 24-hour local time.");
  }
  checkDate(value.slice(0, 10), "starts_at");
  return value;
}

function requireText(value, label) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new ToolError(`${label} is required.`);
  return text;
}

/** WhatsApp "click to chat" link. The owner sends it from their own phone; nothing is sent by Munshi. */
export function whatsappLink(phone, text) {
  let digits = String(phone ?? "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  if (digits.length === 10) digits = `91${digits}`;
  if (digits.length < 11 || digits.length > 15) digits = ""; // let the owner pick the contact
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

/** Standard UPI deep link, which any UPI app on a phone opens with the amount filled in. */
export function upiLink(business, paise, note) {
  if (!business?.upi_id) return null;
  const params = new URLSearchParams({ pa: business.upi_id, pn: business.name || "Shop", cu: "INR" });
  if (paise > 0) params.set("am", (paise / 100).toFixed(2));
  if (note) params.set("tn", note.slice(0, 80));
  return `upi://pay?${params}`;
}

/** Splits a GST-inclusive amount into taxable value and CGST/SGST halves, in paise. */
export function gstBreakup(amountPaise, rate) {
  if (!rate) return null;
  const taxable = Math.round(amountPaise * 100 / (100 + rate));
  const tax = amountPaise - taxable;
  const cgst = Math.floor(tax / 2);
  return { rate, taxable, cgst, sgst: tax - cgst, tax };
}

const CUSTOMER_REF = {
  customer_id: { type: "integer", description: "Use when you already know the exact customer, for example after a disambiguation." },
  customer_name: { type: "string", description: "Customer name in Roman script, e.g. 'Ramesh' even if the owner said रमेश." },
};

const tool = (name, description, properties, required = []) => ({
  name,
  description,
  strict: true,
  input_schema: { type: "object", properties, required, additionalProperties: false },
});

const DATE = (what) => ({ type: "string", description: `${what}, YYYY-MM-DD. Defaults to today.` });

export const TOOL_DEFINITIONS = [
  tool("record_sale", "Record a sale. Give paid_in_full: true when fully paid; otherwise give paid_amount (0 if fully on udhaar), and the difference is added to the customer's balance. A new customer is created automatically if the name isn't found. If stock items are named, their stock goes down, and amount can be left out when every item has a price. Every sale gets a printable bill.", {
    amount: { type: "number", description: "Total sale value in rupees, including any GST. Leave out only when items with saved prices are given." },
    paid_in_full: { type: "boolean", description: "true when the customer paid the whole amount now." },
    paid_amount: { type: "number", description: "Rupees received now, when not paid in full. 0 if fully on udhaar." },
    ...CUSTOMER_REF,
    items: {
      type: "array",
      description: "Stock items sold, if the owner names them.",
      items: {
        type: "object",
        properties: {
          item_name: { type: "string", description: "Item name as saved in stock." },
          quantity: { type: "number", description: "How many units were sold." },
        },
        required: ["item_name", "quantity"],
        additionalProperties: false,
      },
    },
    gst_rate: { type: "number", enum: GST_RATES, description: "GST percent included in the amount, only if the owner mentions GST or the shop always charges it." },
    description: { type: "string", description: "What was sold, if mentioned." },
    date: DATE("Date of the sale"),
  }),
  tool("record_expense", "Record money the business spent: rent, stock purchase, salary, electricity and so on. For stock that should be counted, use adjust_stock with a cost instead.", {
    amount: { type: "number", description: "Rupees spent." },
    category: { type: "string", description: "Short English category: rent, stock, salary, electricity, transport, other." },
    description: { type: "string" },
    date: DATE("Date of the expense"),
  }, ["amount", "category"]),
  tool("record_payment", "Record a customer paying back udhaar. Fails if the customer isn't found, so a payment is never credited to the wrong person.", {
    amount: { type: "number", description: "Rupees received." },
    ...CUSTOMER_REF,
    method: { type: "string", enum: ["cash", "upi", "card", "bank", "other"] },
    date: DATE("Date of the payment"),
  }, ["amount"]),
  tool("add_customer", "Add a customer, or update the phone or notes of one that already exists under this exact name.", {
    name: { type: "string", description: "Name in Roman script." },
    phone: { type: "string" },
    notes: { type: "string", description: "Lasting facts about this customer." },
  }, ["name"]),
  tool("find_customers", "Search customers by name or phone, or find those who haven't visited recently. Returns balance, total spent and last activity for each.", {
    query: { type: "string", description: "Part of a name in Roman script, or part of a phone number." },
    inactive_for_days: { type: "integer", description: "Only customers with no activity for at least this many days." },
  }),
  tool("get_customer_details", "Full picture of one customer: balance, lifetime spend, recent transactions, open orders and upcoming appointments.", CUSTOMER_REF),
  tool("list_pending_payments", "Everyone who owes money, largest first, with days since their last activity, plus the total outstanding.", {}),
  tool("draft_reminder", "Prepare a polite WhatsApp payment reminder for a customer who owes money, with the shop's UPI ID if saved. The owner sends it by tapping the link; nothing is sent automatically.", CUSTOMER_REF),
  tool("get_business_summary", "Sales, money collected, expenses, udhaar given, top customers and expense categories for a date range, compared with the previous period of the same length.", {
    from: DATE("First day of the range"),
    to: DATE("Last day of the range"),
  }),
  tool("list_transactions", "List individual ledger entries, newest first. Sales include sale_id, for share_bill.", {
    kind: { type: "string", enum: ["sale", "expense", "payment"] },
    from: { type: "string", description: "First day, YYYY-MM-DD." },
    to: { type: "string", description: "Last day, YYYY-MM-DD." },
    limit: { type: "integer", description: "Maximum rows. Default 20, maximum 100." },
  }),
  tool("share_bill", "Get the printable bill for a sale, and a WhatsApp link to send it to the customer.", {
    sale_id: { type: "integer" },
  }, ["sale_id"]),
  tool("set_item", "Add a stock item, or change an existing item's unit, price or low-stock level. quantity_on_hand sets the counted stock, for example after the owner counts the shelf.", {
    name: { type: "string", description: "Item name in Roman script, e.g. 'Basmati rice 1kg'." },
    unit: { type: "string", description: "pcs, kg, packet, litre, box and so on." },
    price: { type: "number", description: "Selling price per unit in rupees." },
    low_stock_at: { type: "number", description: "Warn when stock falls to this many units or fewer." },
    quantity_on_hand: { type: "number", description: "Counted stock right now." },
  }, ["name"]),
  tool("adjust_stock", "Stock coming in or going out other than a sale: a delivery from the supplier (positive), or damaged, used or returned goods (negative). Give cost for a purchase and it is also recorded as a stock expense.", {
    item_name: { type: "string" },
    quantity: { type: "number", description: "Positive when stock comes in, negative when it goes out." },
    reason: { type: "string", enum: ["purchase", "damaged", "used", "returned", "correction"] },
    cost: { type: "number", description: "Rupees paid for a purchase, if mentioned." },
  }, ["item_name", "quantity", "reason"]),
  tool("list_stock", "Stock on hand for each item, with price and a low-stock flag.", {
    query: { type: "string", description: "Part of an item name." },
    low_only: { type: "boolean", description: "Only items at or below their low-stock level." },
  }),
  tool("create_order", "Create an order to be fulfilled later, such as a tailoring job or a bulk delivery. This does not record a sale.", {
    description: { type: "string", description: "What was ordered." },
    ...CUSTOMER_REF,
    amount: { type: "number", description: "Agreed price in rupees, if known." },
    due_on: { type: "string", description: "Due date, YYYY-MM-DD, if known." },
  }, ["description"]),
  tool("update_order_status", "Change an order's status.", {
    order_id: { type: "integer" },
    status: { type: "string", enum: ["open", "ready", "delivered", "cancelled"] },
  }, ["order_id", "status"]),
  tool("list_orders", "List orders, soonest due first. Without a status, returns open and ready orders.", {
    status: { type: "string", enum: ["open", "ready", "delivered", "cancelled"] },
  }),
  tool("create_appointment", "Book an appointment. The result warns if another booking starts at the same time.", {
    service: { type: "string" },
    starts_at: { type: "string", description: "YYYY-MM-DDTHH:MM, 24-hour local time." },
    ...CUSTOMER_REF,
  }, ["service", "starts_at"]),
  tool("update_appointment_status", "Change an appointment's status.", {
    appointment_id: { type: "integer" },
    status: { type: "string", enum: ["booked", "done", "cancelled", "no_show"] },
  }, ["appointment_id", "status"]),
  tool("list_appointments", "List appointments in a date range, earliest first.", {
    from: DATE("First day"),
    to: { type: "string", description: "Last day, YYYY-MM-DD. Defaults to the same as from." },
  }),
  tool("remember_note", "Save a lasting fact or preference the owner wants remembered, such as a supplier's name or closing day. It appears in your context on every message.", {
    text: { type: "string" },
  }, ["text"]),
  tool("update_business_profile", "Save the business's details. Include only the fields being changed. GSTIN and UPI ID appear on bills and reminders.", {
    name: { type: "string" },
    type: { type: "string", description: "e.g. kirana store, salon, cafe, boutique, repair shop." },
    owner_name: { type: "string" },
    phone: { type: "string" },
    address: { type: "string" },
    gstin: { type: "string", description: "15-character GST number." },
    upi_id: { type: "string", description: "e.g. sharmastore@okaxis" },
  }),
  tool("undo_last_action", "Reverse an entry you recorded. Without action_id, reverses the most recent one from today; for anything older, it tells you what it found so you can confirm with the owner and retry with action_id. Use when the owner says something was wrong or asks to cancel it.", {
    action_id: { type: "integer" },
  }),
];

const PROFILE_FIELDS = ["name", "type", "owner_name", "phone", "address", "gstin", "upi_id"];

// Undo operations are stored as data, so only these targets are ever writable.
const UNDO_TARGETS = {
  transactions: [], customers: ["phone", "notes"], orders: ["status"],
  appointments: ["status"], notes: [], business: PROFILE_FIELDS,
  items: ["unit", "price_paise", "low_at"], stock_moves: [],
};

export function createTools(db, { now = () => new Date() } = {}) {
  const today = () => localDate(now());
  const stamp = () => now().toISOString();
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const insert = (sql, ...args) => Number(run(sql, ...args).lastInsertRowid);

  const balancePaise = (customerId) => one(
    `SELECT COALESCE(SUM(CASE kind WHEN 'sale' THEN amount_paise - paid_paise
                                   WHEN 'payment' THEN -amount_paise ELSE 0 END), 0) AS b
       FROM transactions WHERE customer_id = ? AND voided_at IS NULL`, customerId).b;

  const onHand = (itemId) => one(
    "SELECT COALESCE(SUM(qty), 0) AS q FROM stock_moves WHERE item_id = ? AND voided_at IS NULL", itemId).q;

  const profile = () => one(`SELECT ${PROFILE_FIELDS.join(", ")} FROM business WHERE id = 1`);

  const logAction = (summary, undoOps) => ({
    id: insert("INSERT INTO actions (summary, undo_ops, created_at) VALUES (?, ?, ?)", summary, JSON.stringify(undoOps), stamp()),
    summary,
  });

  const billLink = (saleId) => ({ kind: "bill", label: "Bill", url: `/bill/${saleId}` });

  function matchCustomers(name) {
    const exact = all("SELECT * FROM customers WHERE voided_at IS NULL AND name = ? COLLATE NOCASE", name);
    if (exact.length) return exact;
    return all("SELECT * FROM customers WHERE voided_at IS NULL AND instr(lower(name), lower(?)) > 0", name);
  }

  /** Returns a customer or null. Throws when the name could be more than one person. */
  function resolveCustomer({ customer_id, customer_name }) {
    if (customer_id != null) {
      const found = one("SELECT * FROM customers WHERE id = ? AND voided_at IS NULL", customer_id);
      if (!found) throw new ToolError(`No customer with id ${customer_id}.`);
      return found;
    }
    const name = customer_name?.trim();
    if (!name) return null;
    const matches = matchCustomers(name);
    if (matches.length > 1) {
      const options = matches.map((c) => ({ customer_id: c.id, name: c.name, phone: c.phone, balance: rupees(balancePaise(c.id)) }));
      throw new ToolError(`"${name}" matches more than one customer. Ask the owner which one, then retry with customer_id: ${JSON.stringify(options)}`);
    }
    return matches[0] ?? null;
  }

  function resolveOrCreate(input, undoOps) {
    const found = resolveCustomer(input);
    if (found) return { customer: found, created: false };
    const name = input.customer_name?.trim();
    if (!name) return { customer: null, created: false };
    const id = insert("INSERT INTO customers (name, created_at) VALUES (?, ?)", name, stamp());
    undoOps.push({ op: "void", table: "customers", id });
    return { customer: { id, name }, created: true };
  }

  function resolveItem(rawName) {
    const name = requireText(rawName, "item_name");
    const exact = all("SELECT * FROM items WHERE voided_at IS NULL AND name = ? COLLATE NOCASE", name);
    const matches = exact.length ? exact : all("SELECT * FROM items WHERE voided_at IS NULL AND instr(lower(name), lower(?)) > 0", name);
    if (matches.length > 1) {
      throw new ToolError(`"${name}" matches more than one stock item: ${JSON.stringify(matches.map((i) => i.name))}. Ask the owner which one.`);
    }
    if (!matches.length) throw new ToolError(`No stock item called "${name}". Check list_stock, or add it with set_item first.`);
    return matches[0];
  }

  /** A warning for the assistant when an item has run low or below zero. */
  function stockWarning(item) {
    const qty = onHand(item.id);
    if (qty < 0) return `${item.name} now shows ${formatQty(qty)} ${item.unit}, below zero, so the count is probably off. Suggest the owner counts it.`;
    if (item.low_at != null && qty <= item.low_at) return `${item.name} is low: ${formatQty(qty)} ${item.unit} left. Mention it.`;
    return null;
  }

  const handlers = {
    record_sale(input) {
      if (input.paid_in_full !== true && input.paid_amount == null) {
        throw new ToolError("Say whether it was paid: paid_in_full: true, or paid_amount (0 if all on udhaar).");
      }
      const lines = (input.items ?? []).map((line) => {
        const item = resolveItem(line.item_name);
        return { item, qty: toQty(line.quantity, `quantity of ${item.name}`) };
      });
      let amount;
      if (input.amount != null) {
        amount = toPaise(input.amount, "amount");
      } else {
        if (!lines.length) throw new ToolError("amount is required.");
        const unpriced = lines.filter((l) => l.item.price_paise == null).map((l) => l.item.name);
        if (unpriced.length) throw new ToolError(`No saved price for ${unpriced.join(", ")}. Ask the owner for the total, or save a price with set_item.`);
        amount = lines.reduce((sum, l) => sum + Math.round(l.item.price_paise * l.qty), 0);
        if (amount <= 0) throw new ToolError("The items add up to zero. Ask the owner for the total.");
      }
      const paid = input.paid_in_full === true ? amount : toPaise(input.paid_amount, "paid_amount", { allowZero: true });
      if (paid > amount) throw new ToolError(`paid_amount can't be more than the sale (${formatRupees(amount)}). For money toward old udhaar, use record_payment too.`);
      if (paid < amount && !input.customer_id && !input.customer_name?.trim()) {
        throw new ToolError("Udhaar needs a customer. Ask the owner who took it.");
      }
      if (input.gst_rate != null && !GST_RATES.includes(input.gst_rate)) throw new ToolError(`gst_rate must be one of ${GST_RATES.join(", ")}.`);
      const date = pastOrToday(input.date);
      const description = input.description?.trim()
        || (lines.length ? lines.map((l) => `${formatQty(l.qty)} ${l.item.unit} ${l.item.name}`).join(", ") : null);
      return tx(db, () => {
        const ops = [];
        const { customer, created } = resolveOrCreate(input, ops);
        const id = insert(
          `INSERT INTO transactions (kind, customer_id, amount_paise, paid_paise, description, occurred_on, created_at, gst_rate)
           VALUES ('sale', ?, ?, ?, ?, ?, ?, ?)`, customer?.id ?? null, amount, paid, description, date, stamp(), input.gst_rate || null);
        const moveOps = lines.map((l) => ({
          op: "void", table: "stock_moves",
          id: insert("INSERT INTO stock_moves (item_id, qty, reason, transaction_id, created_at) VALUES (?, ?, 'sale', ?, ?)", l.item.id, -l.qty, id, stamp()),
        }));
        ops.unshift({ op: "void", table: "transactions", id }, ...moveOps);
        const who = customer ? ` to ${customer.name}` : "";
        const credit = amount - paid;
        const summary = `Sale ${formatRupees(amount)}${who}${credit ? `, ${formatRupees(credit)} on udhaar` : ""}`;
        const warnings = lines.map((l) => stockWarning(l.item)).filter(Boolean);
        return {
          action: logAction(summary, ops),
          links: [billLink(id)],
          result: {
            recorded: summary, sale_id: id, date, new_customer_created: created,
            amount: rupees(amount), description: description ?? undefined,
            customer_balance: customer ? rupees(balancePaise(customer.id)) : undefined,
            warning: warnings.length ? warnings.join(" ") : undefined,
          },
        };
      });
    },

    record_expense(input) {
      const amount = toPaise(input.amount, "amount");
      const category = requireText(input.category, "category").toLowerCase();
      const date = pastOrToday(input.date);
      return tx(db, () => {
        const id = insert(
          `INSERT INTO transactions (kind, amount_paise, category, description, occurred_on, created_at)
           VALUES ('expense', ?, ?, ?, ?, ?)`, amount, category, input.description ?? null, date, stamp());
        const summary = `Expense ${formatRupees(amount)}, ${category}`;
        return { action: logAction(summary, [{ op: "void", table: "transactions", id }]), result: { recorded: summary, date } };
      });
    },

    record_payment(input) {
      const amount = toPaise(input.amount, "amount");
      const date = pastOrToday(input.date);
      const customer = resolveCustomer(input);
      if (!customer) {
        throw new ToolError(`No customer found${input.customer_name ? ` named "${input.customer_name}"` : ""}. Ask the owner who paid, or check the spelling with find_customers.`);
      }
      return tx(db, () => {
        const id = insert(
          `INSERT INTO transactions (kind, customer_id, amount_paise, method, occurred_on, created_at)
           VALUES ('payment', ?, ?, ?, ?, ?)`, customer.id, amount, input.method ?? null, date, stamp());
        const summary = `Payment ${formatRupees(amount)} from ${customer.name}`;
        const balance = balancePaise(customer.id);
        return {
          action: logAction(summary, [{ op: "void", table: "transactions", id }]),
          result: {
            recorded: summary, date, remaining_balance: rupees(balance),
            warning: balance < 0 ? `This is ${formatRupees(-balance)} more than was owed, so it is held as an advance. Mention this to the owner.` : undefined,
          },
        };
      });
    },

    add_customer(input) {
      const name = requireText(input.name, "name");
      return tx(db, () => {
        const existing = all("SELECT * FROM customers WHERE voided_at IS NULL AND name = ? COLLATE NOCASE", name);
        if (existing.length > 1) throw new ToolError(`There are already ${existing.length} customers named ${name}.`);
        if (existing[0]) {
          const c = existing[0];
          const phone = input.phone?.trim() || c.phone;
          const notes = input.notes?.trim() || c.notes;
          if (phone === c.phone && notes === c.notes) {
            return { result: { recorded: `${c.name} is already saved, nothing changed`, customer_id: c.id, already_existed: true } };
          }
          run("UPDATE customers SET phone = ?, notes = ? WHERE id = ?", phone, notes, c.id);
          const summary = `Updated customer ${c.name}`;
          return {
            action: logAction(summary, [
              { op: "set", table: "customers", id: c.id, column: "phone", value: c.phone },
              { op: "set", table: "customers", id: c.id, column: "notes", value: c.notes },
            ]),
            result: { recorded: summary, customer_id: c.id, already_existed: true },
          };
        }
        const id = insert("INSERT INTO customers (name, phone, notes, created_at) VALUES (?, ?, ?, ?)", name, input.phone?.trim() || null, input.notes?.trim() || null, stamp());
        const summary = `Added customer ${name}`;
        return { action: logAction(summary, [{ op: "void", table: "customers", id }]), result: { recorded: summary, customer_id: id } };
      });
    },

    find_customers({ query, inactive_for_days }) {
      const q = query?.trim();
      if (inactive_for_days != null && (!Number.isInteger(inactive_for_days) || inactive_for_days < 0)) {
        throw new ToolError("inactive_for_days must be a whole number of days.");
      }
      const cutoff = inactive_for_days != null ? addDays(today(), -inactive_for_days) : null;
      // The inactivity filter runs before the limit, so quiet low spenders aren't cut off.
      const rows = all(
        `SELECT c.id, c.name, c.phone, MAX(t.occurred_on) AS last_activity,
                COALESCE(SUM(CASE WHEN t.kind = 'sale' THEN t.amount_paise END), 0) AS spent,
                COALESCE(SUM(CASE t.kind WHEN 'sale' THEN t.amount_paise - t.paid_paise
                                         WHEN 'payment' THEN -t.amount_paise ELSE 0 END), 0) AS balance
           FROM customers c
           LEFT JOIN transactions t ON t.customer_id = c.id AND t.voided_at IS NULL
          WHERE c.voided_at IS NULL
            AND (?1 IS NULL OR instr(lower(c.name), lower(?1)) > 0 OR instr(COALESCE(c.phone, ''), ?1) > 0)
          GROUP BY c.id
         HAVING ?2 IS NULL OR last_activity IS NULL OR last_activity <= ?2
          ORDER BY spent DESC LIMIT 50`, q || null, cutoff);
      return {
        result: {
          customers: rows.map((r) => ({
            customer_id: r.id, name: r.name, phone: r.phone, last_activity: r.last_activity,
            total_spent: rupees(r.spent), balance: rupees(r.balance),
          })),
        },
      };
    },

    get_customer_details(input) {
      const c = resolveCustomer(input);
      if (!c) throw new ToolError("Customer not found. Try find_customers, or ask the owner for the spelling.");
      const recent = all(
        `SELECT id, kind, amount_paise, paid_paise, description, method, occurred_on, gst_rate FROM transactions
          WHERE customer_id = ? AND voided_at IS NULL ORDER BY occurred_on DESC, id DESC LIMIT 15`, c.id);
      const spent = one("SELECT COALESCE(SUM(amount_paise), 0) AS s FROM transactions WHERE customer_id = ? AND kind = 'sale' AND voided_at IS NULL", c.id).s;
      return {
        result: {
          customer_id: c.id, name: c.name, phone: c.phone, notes: c.notes,
          balance: rupees(balancePaise(c.id)), total_spent: rupees(spent),
          recent_transactions: recent.map(presentTransaction),
          open_orders: all("SELECT id, description, amount_paise, status, due_on FROM orders WHERE customer_id = ? AND voided_at IS NULL AND status IN ('open', 'ready')", c.id).map(presentOrder),
          upcoming_appointments: all("SELECT id, service, starts_at, status FROM appointments WHERE customer_id = ? AND voided_at IS NULL AND status = 'booked' AND substr(starts_at, 1, 10) >= ? ORDER BY starts_at", c.id, today()),
        },
      };
    },

    list_pending_payments() {
      const rows = pendingRows();
      return {
        result: {
          total_outstanding: rupees(rows.reduce((sum, r) => sum + r.balance, 0)),
          customers: rows.map((r) => ({
            customer_id: r.id, name: r.name, phone: r.phone, owes: rupees(r.balance),
            last_activity: r.last_activity, days_since_activity: daysBetween(r.last_activity, today()),
          })),
        },
      };
    },

    draft_reminder(input) {
      const c = resolveCustomer(input);
      if (!c) throw new ToolError("Customer not found. Try find_customers, or ask the owner for the spelling.");
      const balance = balancePaise(c.id);
      if (balance <= 0) throw new ToolError(`${c.name} doesn't owe anything right now, so there's nothing to remind them about.`);
      const reminder = reminderFor(c, balance);
      return {
        links: [{ kind: "whatsapp", label: `WhatsApp ${c.name}`, url: reminder.whatsapp_url }],
        result: {
          message: reminder.message,
          owes: rupees(balance),
          has_phone: Boolean(c.phone),
          note: c.phone
            ? "A WhatsApp button is now on screen. Tell the owner to tap it to send; you haven't sent anything."
            : "No phone number is saved, so WhatsApp will ask the owner to pick the contact. Offer to save the number.",
        },
      };
    },

    get_business_summary({ from, to }) {
      const start = from ? checkDate(from, "from") : today();
      const end = to ? checkDate(to, "to") : (from ? start : today());
      if (end < start) throw new ToolError("to can't be before from.");
      const span = daysBetween(start, end) + 1;
      const current = periodTotals(start, end);
      const previous = periodTotals(addDays(start, -span), addDays(start, -1));
      return {
        result: {
          from: start, to: end, days: span, ...current,
          previous_period: { from: addDays(start, -span), to: addDays(start, -1), ...previous },
          expenses_by_category: all(
            `SELECT COALESCE(category, 'other') AS category, SUM(amount_paise) AS p FROM transactions
              WHERE kind = 'expense' AND voided_at IS NULL AND occurred_on BETWEEN ? AND ?
              GROUP BY 1 ORDER BY p DESC`, start, end).map((r) => ({ category: r.category, amount: rupees(r.p) })),
          top_customers: all(
            `SELECT c.name, SUM(t.amount_paise) AS p FROM transactions t JOIN customers c ON c.id = t.customer_id
              WHERE t.kind = 'sale' AND t.voided_at IS NULL AND t.occurred_on BETWEEN ? AND ?
              GROUP BY c.id ORDER BY p DESC LIMIT 5`, start, end).map((r) => ({ name: r.name, sales: rupees(r.p) })),
          gst_collected: rupees(gstCollected(start, end)),
          total_outstanding_now: rupees(outstandingPaise()),
        },
      };
    },

    list_transactions({ kind, from, to, limit }) {
      if (from) checkDate(from, "from");
      if (to) checkDate(to, "to");
      return { result: { transactions: transactionRows({ kind, from, to, limit }).map(presentTransaction) } };
    },

    share_bill({ sale_id }) {
      const bill = billData(sale_id);
      if (!bill) throw new ToolError(`No sale with id ${sale_id}. Use list_transactions to find it.`);
      if (bill.voided) throw new ToolError("That sale was undone, so it has no bill.");
      const links = [billLink(sale_id)];
      if (bill.customer?.phone) {
        const text = `Namaste ${bill.customer.name} ji, ${bill.business.name || "our shop"} se aapka bill: ${bill.number}, ${formatRupees(bill.amount)}, ${bill.date}.`;
        links.push({ kind: "whatsapp", label: `Send to ${bill.customer.name}`, url: whatsappLink(bill.customer.phone, text) });
      }
      return {
        links,
        result: {
          bill_number: bill.number, amount: rupees(bill.amount), customer: bill.customer?.name,
          note: "The bill is on screen as a button the owner can open and print or share.",
        },
      };
    },

    set_item(input) {
      const name = requireText(input.name, "name");
      const unit = input.unit?.trim() || null;
      const price = input.price != null ? toPaise(input.price, "price") : null;
      const lowAt = input.low_stock_at != null ? toQty(input.low_stock_at, "low_stock_at", { signed: true }) : null;
      if (lowAt != null && lowAt < 0) throw new ToolError("low_stock_at can't be negative.");
      const counted = input.quantity_on_hand != null ? input.quantity_on_hand : null;
      if (counted != null && (typeof counted !== "number" || !Number.isFinite(counted) || counted < 0 || counted > MAX_QTY)) {
        throw new ToolError("quantity_on_hand must be zero or more.");
      }
      return tx(db, () => {
        const existing = all("SELECT * FROM items WHERE voided_at IS NULL AND name = ? COLLATE NOCASE", name);
        if (existing.length > 1) throw new ToolError(`There are ${existing.length} items named ${name}.`);
        const ops = [];
        let item = existing[0];
        let created = false;
        if (item) {
          const changes = { unit, price_paise: price, low_at: lowAt };
          for (const [column, value] of Object.entries(changes)) {
            if (value == null || value === item[column]) continue;
            run(`UPDATE items SET ${column} = ? WHERE id = ?`, value, item.id);
            ops.push({ op: "set", table: "items", id: item.id, column, value: item[column] });
          }
          item = one("SELECT * FROM items WHERE id = ?", item.id);
        } else {
          const id = insert("INSERT INTO items (name, unit, price_paise, low_at, created_at) VALUES (?, ?, ?, ?, ?)", name, unit ?? "pcs", price, lowAt, stamp());
          ops.push({ op: "void", table: "items", id });
          item = one("SELECT * FROM items WHERE id = ?", id);
          created = true;
        }
        if (counted != null) {
          const diff = Math.round((counted - onHand(item.id)) * 1000) / 1000;
          if (diff !== 0) {
            const moveId = insert("INSERT INTO stock_moves (item_id, qty, reason, created_at) VALUES (?, ?, 'count', ?)", item.id, diff, stamp());
            ops.unshift({ op: "void", table: "stock_moves", id: moveId });
          }
        }
        if (!ops.length) return { result: { recorded: `${item.name} is already saved like that, nothing changed`, ...presentItem(item, onHand(item.id)) } };
        const summary = created ? `Added stock item ${item.name}` : `Updated stock item ${item.name}`;
        return {
          action: logAction(`${summary}${counted != null ? `, ${formatQty(counted)} ${item.unit} in stock` : ""}`, ops),
          result: { recorded: summary, ...presentItem(item, onHand(item.id)) },
        };
      });
    },

    adjust_stock(input) {
      const item = resolveItem(input.item_name);
      const qty = toQty(input.quantity, "quantity", { signed: true });
      const reason = requireText(input.reason, "reason");
      if ((reason === "purchase" && qty < 0) || (["damaged", "used", "returned"].includes(reason) && qty > 0)) {
        throw new ToolError(`For ${reason}, quantity should be ${reason === "purchase" ? "positive (stock coming in)" : "negative (stock going out)"}.`);
      }
      const cost = input.cost != null ? toPaise(input.cost, "cost") : null;
      return tx(db, () => {
        const ops = [];
        const moveId = insert("INSERT INTO stock_moves (item_id, qty, reason, created_at) VALUES (?, ?, ?, ?)", item.id, qty, reason, stamp());
        ops.push({ op: "void", table: "stock_moves", id: moveId });
        if (cost != null) {
          const txId = insert(
            `INSERT INTO transactions (kind, amount_paise, category, description, occurred_on, created_at)
             VALUES ('expense', ?, 'stock', ?, ?, ?)`, cost, `${formatQty(qty)} ${item.unit} ${item.name}`, today(), stamp());
          run("UPDATE stock_moves SET transaction_id = ? WHERE id = ?", txId, moveId);
          ops.push({ op: "void", table: "transactions", id: txId });
        }
        const sign = qty > 0 ? "+" : "−";
        const summary = `Stock ${sign}${formatQty(Math.abs(qty))} ${item.unit} ${item.name} (${reason})${cost != null ? `, ${formatRupees(cost)} spent` : ""}`;
        return {
          action: logAction(summary, ops),
          result: { recorded: summary, ...presentItem(item, onHand(item.id)), warning: stockWarning(item) ?? undefined },
        };
      });
    },

    list_stock({ query, low_only }) {
      const items = stockRows(query).filter((i) => !low_only || i.low);
      return { result: { items, low_count: items.filter((i) => i.low).length } };
    },

    create_order(input) {
      const description = requireText(input.description, "description");
      const amount = input.amount != null ? toPaise(input.amount, "amount") : null;
      const due = input.due_on ? checkDate(input.due_on, "due_on") : null;
      return tx(db, () => {
        const ops = [];
        const { customer } = resolveOrCreate(input, ops);
        const id = insert("INSERT INTO orders (customer_id, description, amount_paise, due_on, created_at) VALUES (?, ?, ?, ?, ?)", customer?.id ?? null, description, amount, due, stamp());
        ops.unshift({ op: "void", table: "orders", id });
        const summary = `Order: ${description}${customer ? ` for ${customer.name}` : ""}${due ? `, due ${due}` : ""}`;
        return { action: logAction(summary, ops), result: { recorded: summary, order_id: id } };
      });
    },

    update_order_status({ order_id, status }) {
      const order = one("SELECT * FROM orders WHERE id = ? AND voided_at IS NULL", order_id);
      if (!order) throw new ToolError(`No order with id ${order_id}. Use list_orders to find it.`);
      if (order.status === status) return { result: { recorded: `Order "${order.description}" is already ${status}` } };
      return tx(db, () => {
        run("UPDATE orders SET status = ? WHERE id = ?", status, order_id);
        const summary = `Order "${order.description}" marked ${status}`;
        return {
          action: logAction(summary, [{ op: "set", table: "orders", id: order_id, column: "status", value: order.status }]),
          result: { recorded: summary, reminder: status === "delivered" ? "Delivering an order does not record a sale. Ask the owner if one should be recorded." : undefined },
        };
      });
    },

    list_orders({ status }) {
      return { result: { orders: orderRows(status).map(presentOrder) } };
    },

    create_appointment(input) {
      const service = requireText(input.service, "service");
      const startsAt = checkDateTime(input.starts_at);
      return tx(db, () => {
        const ops = [];
        const { customer } = resolveOrCreate(input, ops);
        const clashes = all(
          `SELECT a.id, a.service, c.name AS customer FROM appointments a LEFT JOIN customers c ON c.id = a.customer_id
            WHERE a.starts_at = ? AND a.status = 'booked' AND a.voided_at IS NULL`, startsAt);
        const id = insert("INSERT INTO appointments (customer_id, service, starts_at, created_at) VALUES (?, ?, ?, ?)", customer?.id ?? null, service, startsAt, stamp());
        ops.unshift({ op: "void", table: "appointments", id });
        const summary = `Appointment: ${service}${customer ? ` for ${customer.name}` : ""}, ${startsAt.replace("T", " ")}`;
        return {
          action: logAction(summary, ops),
          result: { recorded: summary, appointment_id: id, warning: clashes.length ? `Another booking starts at this time: ${JSON.stringify(clashes)}. Tell the owner.` : undefined },
        };
      });
    },

    update_appointment_status({ appointment_id, status }) {
      const appt = one("SELECT * FROM appointments WHERE id = ? AND voided_at IS NULL", appointment_id);
      if (!appt) throw new ToolError(`No appointment with id ${appointment_id}. Use list_appointments to find it.`);
      if (appt.status === status) return { result: { recorded: `Appointment "${appt.service}" is already ${status}` } };
      return tx(db, () => {
        run("UPDATE appointments SET status = ? WHERE id = ?", status, appointment_id);
        const summary = `Appointment "${appt.service}" marked ${status}`;
        return { action: logAction(summary, [{ op: "set", table: "appointments", id: appointment_id, column: "status", value: appt.status }]), result: { recorded: summary } };
      });
    },

    list_appointments({ from, to }) {
      const start = from ? checkDate(from, "from") : today();
      const end = to ? checkDate(to, "to") : start;
      return { result: { appointments: appointmentRows(start, end) } };
    },

    remember_note(input) {
      const text = requireText(input.text, "text");
      return tx(db, () => {
        const id = insert("INSERT INTO notes (text, created_at) VALUES (?, ?)", text, stamp());
        return { action: logAction(`Remembered: ${text}`, [{ op: "void", table: "notes", id }]), result: { recorded: true } };
      });
    },

    update_business_profile(input) {
      const values = {};
      for (const field of PROFILE_FIELDS) {
        const value = typeof input[field] === "string" ? input[field].trim() : "";
        if (value) values[field] = value;
      }
      if (values.gstin) {
        values.gstin = values.gstin.toUpperCase().replace(/\s/g, "");
        if (!GSTIN.test(values.gstin)) throw new ToolError(`"${input.gstin}" doesn't look like a GSTIN (15 characters, like 07ABCDE1234F1Z5). Check it with the owner.`);
      }
      if (values.upi_id) {
        values.upi_id = values.upi_id.replace(/\s/g, "").toLowerCase();
        if (!UPI_ID.test(values.upi_id)) throw new ToolError(`"${input.upi_id}" doesn't look like a UPI ID (like name@okaxis). Check it with the owner.`);
      }
      const fields = Object.keys(values);
      if (!fields.length) throw new ToolError("Provide at least one field to change.");
      return tx(db, () => {
        const before = profile();
        const changed = fields.filter((f) => before[f] !== values[f]);
        if (!changed.length) return { result: { recorded: "Already saved like that, nothing changed" } };
        const ops = changed.map((column) => {
          run(`UPDATE business SET ${column} = ? WHERE id = 1`, values[column]);
          return { op: "set", table: "business", id: 1, column, value: before[column] };
        });
        return { action: logAction(`Updated business profile (${changed.map((f) => f.replace("_", " ")).join(", ")})`, ops), result: { recorded: true } };
      });
    },

    undo_last_action({ action_id }) {
      if (action_id == null) {
        const latest = one("SELECT * FROM actions WHERE undone_at IS NULL ORDER BY id DESC LIMIT 1");
        if (!latest) throw new ToolError("Nothing to undo.");
        const day = localDate(new Date(latest.created_at));
        if (day !== today()) {
          throw new ToolError(`Nothing was recorded today. The most recent entry is from ${day}: "${latest.summary}". Check with the owner that this is the one, then retry with action_id ${latest.id}.`);
        }
        action_id = latest.id;
      }
      return { result: undoAction(action_id, { seen: true }), undone: action_id };
    },
  };

  function pastOrToday(date) {
    const value = date ? checkDate(date) : today();
    if (value > today()) throw new ToolError(`${value} is in the future. Money can only be recorded for today or earlier. Check the date with the owner.`);
    return value;
  }

  function periodTotals(start, end) {
    const r = one(
      `SELECT COALESCE(SUM(CASE WHEN kind = 'sale' THEN amount_paise END), 0) AS sales,
              COALESCE(SUM(CASE WHEN kind = 'sale' THEN paid_paise END), 0) AS paid_at_sale,
              COALESCE(SUM(CASE WHEN kind = 'payment' THEN amount_paise END), 0) AS payments,
              COALESCE(SUM(CASE WHEN kind = 'expense' THEN amount_paise END), 0) AS expenses,
              COUNT(CASE WHEN kind = 'sale' THEN 1 END) AS sale_count
         FROM transactions WHERE voided_at IS NULL AND occurred_on BETWEEN ? AND ?`, start, end);
    return {
      sales: rupees(r.sales), number_of_sales: r.sale_count, expenses: rupees(r.expenses),
      sales_minus_expenses: rupees(r.sales - r.expenses),
      udhaar_given: rupees(r.sales - r.paid_at_sale), udhaar_collected: rupees(r.payments),
      cash_received: rupees(r.paid_at_sale + r.payments),
    };
  }

  const gstCollected = (start, end) => all(
    `SELECT amount_paise, gst_rate FROM transactions
      WHERE kind = 'sale' AND voided_at IS NULL AND gst_rate > 0 AND occurred_on BETWEEN ? AND ?`, start, end)
    .reduce((sum, r) => sum + gstBreakup(r.amount_paise, r.gst_rate).tax, 0);

  const outstandingPaise = () => one(
    `SELECT COALESCE(SUM(b), 0) AS total FROM (
       SELECT SUM(CASE t.kind WHEN 'sale' THEN t.amount_paise - t.paid_paise
                              WHEN 'payment' THEN -t.amount_paise ELSE 0 END) AS b
         FROM transactions t JOIN customers c ON c.id = t.customer_id
        WHERE t.voided_at IS NULL AND c.voided_at IS NULL GROUP BY t.customer_id HAVING b > 0)`).total;

  const pendingRows = () => all(
    `SELECT c.id, c.name, c.phone, MAX(t.occurred_on) AS last_activity,
            SUM(CASE t.kind WHEN 'sale' THEN t.amount_paise - t.paid_paise
                            WHEN 'payment' THEN -t.amount_paise ELSE 0 END) AS balance
       FROM customers c JOIN transactions t ON t.customer_id = c.id AND t.voided_at IS NULL
      WHERE c.voided_at IS NULL GROUP BY c.id HAVING balance > 0 ORDER BY balance DESC`);

  function transactionRows({ kind, from, to, limit } = {}) {
    const cap = Math.min(Math.max(limit ?? 20, 1), 100);
    return all(
      `SELECT t.*, c.name AS customer FROM transactions t LEFT JOIN customers c ON c.id = t.customer_id
        WHERE t.voided_at IS NULL AND (?1 IS NULL OR t.kind = ?1)
          AND (?2 IS NULL OR t.occurred_on >= ?2) AND (?3 IS NULL OR t.occurred_on <= ?3)
        ORDER BY t.occurred_on DESC, t.id DESC LIMIT ?4`, kind ?? null, from ?? null, to ?? null, cap);
  }

  const orderRows = (status) => all(
    `SELECT o.id, o.description, o.amount_paise, o.status, o.due_on, c.name AS customer
       FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
      WHERE o.voided_at IS NULL AND (?1 IS NULL AND o.status IN ('open', 'ready') OR o.status = ?1)
      ORDER BY o.due_on IS NULL, o.due_on LIMIT 100`, status ?? null);

  const appointmentRows = (start, end) => all(
    `SELECT a.id, a.service, a.starts_at, a.status, c.name AS customer
       FROM appointments a LEFT JOIN customers c ON c.id = a.customer_id
      WHERE a.voided_at IS NULL AND substr(a.starts_at, 1, 10) BETWEEN ? AND ?
      ORDER BY a.starts_at LIMIT 100`, start, end);

  function stockRows(query) {
    const q = query?.trim();
    return all(
      `SELECT i.*, COALESCE(SUM(m.qty), 0) AS on_hand
         FROM items i LEFT JOIN stock_moves m ON m.item_id = i.id AND m.voided_at IS NULL
        WHERE i.voided_at IS NULL AND (?1 IS NULL OR instr(lower(i.name), lower(?1)) > 0)
        GROUP BY i.id ORDER BY i.name COLLATE NOCASE LIMIT 300`, q || null)
      .map((i) => presentItem(i, i.on_hand));
  }

  function reminderFor(customer, balance) {
    const b = profile();
    const shop = b.name || "hamari dukaan";
    const lines = [
      `Namaste ${customer.name} ji, ${shop} mein aapka ${formatRupees(balance)} baaki hai.`,
      "Jab suvidha ho, kripya chuka dijiye. Dhanyavaad!",
    ];
    if (b.upi_id) lines.push(`UPI: ${b.upi_id}`);
    return { message: lines.join(" "), whatsapp_url: whatsappLink(customer.phone, lines.join("\n")) };
  }

  /** Everything a bill shows, or null if there's no such sale. */
  function billData(saleId) {
    const t = one("SELECT * FROM transactions WHERE id = ? AND kind = 'sale'", saleId);
    if (!t) return null;
    const customer = t.customer_id ? one("SELECT id, name, phone FROM customers WHERE id = ?", t.customer_id) : null;
    const lines = all(
      `SELECT i.name, i.unit, i.price_paise, -m.qty AS qty FROM stock_moves m JOIN items i ON i.id = m.item_id
        WHERE m.transaction_id = ? AND m.reason = 'sale' ORDER BY m.id`, saleId);
    const business = profile();
    const due = t.amount_paise - t.paid_paise;
    return {
      id: t.id, number: `INV-${String(t.id).padStart(5, "0")}`, date: t.occurred_on, voided: Boolean(t.voided_at),
      business, customer, description: t.description, lines,
      amount: t.amount_paise, paid: t.paid_paise, due,
      gst: gstBreakup(t.amount_paise, t.gst_rate),
      upi_url: due > 0 ? upiLink(business, due, `INV-${t.id}`) : null,
    };
  }

  const customerInUse = (id) => one(
    `SELECT (SELECT COUNT(*) FROM transactions WHERE customer_id = ?1 AND voided_at IS NULL)
          + (SELECT COUNT(*) FROM orders WHERE customer_id = ?1 AND voided_at IS NULL)
          + (SELECT COUNT(*) FROM appointments WHERE customer_id = ?1 AND voided_at IS NULL) AS n`, id).n > 0;

  const itemInUse = (id) => one("SELECT COUNT(*) AS n FROM stock_moves WHERE item_id = ? AND voided_at IS NULL", id).n > 0;

  function undoAction(id, { seen }) {
    return tx(db, () => {
      const action = one("SELECT * FROM actions WHERE id = ?", id);
      if (!action) throw new ToolError(`No action with id ${id}.`);
      if (action.undone_at) throw new ToolError(`Already undone: ${action.summary}`);
      const kept = [];
      for (const op of JSON.parse(action.undo_ops)) {
        const columns = UNDO_TARGETS[op.table];
        if (!columns) throw new Error(`Refusing undo on ${op.table}`);
        if (op.op === "void") {
          // Something created by this action may have other entries by now.
          if (op.table === "customers" && customerInUse(op.id)) { kept.push("The customer was kept because they have other entries."); continue; }
          if (op.table === "items" && itemInUse(op.id)) { kept.push("The stock item was kept because it has other stock entries."); continue; }
          run(`UPDATE ${op.table} SET voided_at = ? WHERE id = ?`, stamp(), op.id);
        } else if (op.op === "set" && columns.includes(op.column)) {
          run(`UPDATE ${op.table} SET ${op.column} = ? WHERE id = ?`, op.value, op.id);
        } else {
          throw new Error(`Refusing undo op ${JSON.stringify(op)}`);
        }
      }
      run("UPDATE actions SET undone_at = ?, undo_seen = ? WHERE id = ?", stamp(), seen ? 1 : 0, id);
      return { undone: action.summary, note: kept.length ? kept.join(" ") : undefined };
    });
  }

  function glance() {
    const t = periodTotals(today(), today());
    return {
      sales_today: t.sales, expenses_today: t.expenses, outstanding: rupees(outstandingPaise()),
      appointments_today: one("SELECT COUNT(*) AS n FROM appointments WHERE voided_at IS NULL AND status = 'booked' AND substr(starts_at, 1, 10) = ?", today()).n,
      open_orders: one("SELECT COUNT(*) AS n FROM orders WHERE voided_at IS NULL AND status IN ('open', 'ready')").n,
      low_stock: stockRows().filter((i) => i.low).length,
    };
  }

  /** Everything the shop panel beside the assistant shows. */
  function overview() {
    const pending = pendingRows().map((r) => ({
      customer_id: r.id, name: r.name, phone: r.phone, owes: rupees(r.balance),
      days_since_activity: daysBetween(r.last_activity, today()),
      whatsapp_url: reminderFor(r, r.balance).whatsapp_url,
    }));
    const week = addDays(today(), 6);
    return {
      today: today(),
      pending,
      stock: stockRows(),
      recent: transactionRows({ limit: 30 }).map((t) => ({ ...presentTransaction(t), bill_url: t.kind === "sale" ? `/bill/${t.id}` : undefined })),
      orders: orderRows().map(presentOrder),
      appointments: appointmentRows(today(), week),
      week: periodTotals(addDays(today(), -6), today()),
      days: Array.from({ length: 7 }, (_, i) => {
        const day = addDays(today(), i - 6);
        const totals = periodTotals(day, day);
        return { day, sales: totals.sales, expenses: totals.expenses };
      }),
    };
  }

  /** Rows for the CSV export, including undone entries so nothing silently disappears. */
  function exportRows(kind) {
    if (kind === "transactions") {
      return all(
        `SELECT t.id, t.occurred_on AS date, t.kind, c.name AS customer, t.amount_paise / 100.0 AS amount,
                CASE t.kind WHEN 'sale' THEN t.paid_paise / 100.0 END AS paid_now,
                CASE t.kind WHEN 'sale' THEN (t.amount_paise - t.paid_paise) / 100.0 END AS on_udhaar,
                t.gst_rate, t.category, t.description, t.method, t.created_at,
                CASE WHEN t.voided_at IS NULL THEN '' ELSE 'undone' END AS status
           FROM transactions t LEFT JOIN customers c ON c.id = t.customer_id ORDER BY t.occurred_on, t.id`);
    }
    if (kind === "customers") {
      return all(
        `SELECT c.id, c.name, c.phone, c.notes, c.created_at,
                COALESCE(SUM(CASE t.kind WHEN 'sale' THEN t.amount_paise - t.paid_paise
                                         WHEN 'payment' THEN -t.amount_paise ELSE 0 END), 0) / 100.0 AS balance
           FROM customers c LEFT JOIN transactions t ON t.customer_id = c.id AND t.voided_at IS NULL
          WHERE c.voided_at IS NULL GROUP BY c.id ORDER BY c.name COLLATE NOCASE`);
    }
    if (kind === "stock") {
      return stockRows().map(({ item_id, name, unit, on_hand, price, low_stock_at }) => ({ item_id, name, unit, on_hand, price, low_stock_at }));
    }
    return null;
  }

  return {
    /** Runs one tool. Expected problems come back as { error } for the assistant to handle. */
    run(name, input) {
      const handler = handlers[name];
      if (!handler) return { error: `Unknown tool ${name}` };
      const required = TOOL_DEFINITIONS.find((t) => t.name === name).input_schema.required;
      const missing = required.filter((field) => input?.[field] == null);
      if (missing.length) return { error: `Missing required field: ${missing.join(", ")}.` };
      try {
        return handler(input ?? {});
      } catch (err) {
        if (err instanceof ToolError) return { error: err.message };
        throw err;
      }
    },
    undoAction,
    glance,
    overview,
    billData,
    exportRows,
    today,
    profile,
    /** Saves profile fields from the settings form, with the same checks and Undo as the tool. */
    updateProfile(fields) {
      return this.run("update_business_profile", fields);
    },
    notes: () => all("SELECT text FROM notes WHERE voided_at IS NULL ORDER BY id DESC LIMIT 30").map((n) => n.text),
    recentActions: (limit = 10) => all("SELECT summary, created_at FROM actions WHERE undone_at IS NULL ORDER BY id DESC LIMIT ?", limit),
    takeUnseenUndos() {
      const rows = all("SELECT id, summary FROM actions WHERE undo_seen = 0");
      if (rows.length) run("UPDATE actions SET undo_seen = 1 WHERE undo_seen = 0");
      return rows.map((r) => r.summary);
    },
    actionsById(ids) {
      return ids.map((id) => one("SELECT id, summary, undone_at FROM actions WHERE id = ?", id)).filter(Boolean);
    },
  };
}

function presentTransaction(t) {
  return {
    sale_id: t.kind === "sale" ? t.id : undefined,
    kind: t.kind, date: t.occurred_on, amount: rupees(t.amount_paise),
    on_udhaar: t.kind === "sale" ? rupees(t.amount_paise - t.paid_paise) : undefined,
    gst_rate: t.gst_rate || undefined,
    customer: t.customer ?? undefined, category: t.category ?? undefined,
    description: t.description ?? undefined, method: t.method ?? undefined,
  };
}

function presentOrder(o) {
  return {
    order_id: o.id, description: o.description, customer: o.customer ?? undefined,
    amount: o.amount_paise != null ? rupees(o.amount_paise) : undefined, status: o.status, due_on: o.due_on,
  };
}

function presentItem(item, qty) {
  return {
    item_id: item.id, name: item.name, unit: item.unit,
    on_hand: Math.round(qty * 1000) / 1000,
    price: item.price_paise != null ? rupees(item.price_paise) : undefined,
    low_stock_at: item.low_at ?? undefined,
    low: item.low_at != null ? qty <= item.low_at : qty <= 0,
  };
}
