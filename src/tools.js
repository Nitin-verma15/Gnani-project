import { tx } from "./db.js";

const TIME_ZONE = "Asia/Kolkata";
const MAX_RUPEES = 1_000_000_000;

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

function toPaise(value, label, { allowZero = false } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new ToolError(`${label} must be a number.`);
  if (value < 0 || (value === 0 && !allowZero)) throw new ToolError(`${label} must be more than zero.`);
  if (value > MAX_RUPEES) throw new ToolError(`${label} looks too large (${value}). Confirm the amount with the owner.`);
  return Math.round(value * 100);
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
  tool("record_sale", "Record a sale. Set paid_amount below amount for udhaar (credit); the difference is added to the customer's balance. A new customer is created automatically if the name isn't found.", {
    amount: { type: "number", description: "Total sale value in rupees." },
    paid_amount: { type: "number", description: "Rupees received now. Equal to amount if fully paid, 0 if fully on udhaar." },
    ...CUSTOMER_REF,
    description: { type: "string", description: "What was sold, if mentioned." },
    date: DATE("Date of the sale"),
  }, ["amount", "paid_amount"]),
  tool("record_expense", "Record money the business spent: rent, stock purchase, salary, electricity and so on.", {
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
  tool("get_business_summary", "Sales, money collected, expenses, udhaar given, top customers and expense categories for a date range, compared with the previous period of the same length.", {
    from: DATE("First day of the range"),
    to: DATE("Last day of the range"),
  }),
  tool("list_transactions", "List individual ledger entries, newest first.", {
    kind: { type: "string", enum: ["sale", "expense", "payment"] },
    from: { type: "string", description: "First day, YYYY-MM-DD." },
    to: { type: "string", description: "Last day, YYYY-MM-DD." },
    limit: { type: "integer", description: "Maximum rows. Default 20, maximum 100." },
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
  tool("update_business_profile", "Save the business's name, type or owner's name. Include only the fields being changed.", {
    name: { type: "string" },
    type: { type: "string", description: "e.g. kirana store, salon, cafe, boutique, repair shop." },
    owner_name: { type: "string" },
  }),
  tool("undo_last_action", "Reverse an entry you recorded. Without action_id, reverses the most recent one. Use when the owner says something was wrong or asks to cancel it.", {
    action_id: { type: "integer" },
  }),
];

// Undo operations are stored as data, so only these targets are ever writable.
const UNDO_TARGETS = {
  transactions: [], customers: ["phone", "notes"], orders: ["status"],
  appointments: ["status"], notes: [], business: ["name", "type", "owner_name"],
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

  const logAction = (summary, undoOps) => ({
    id: insert("INSERT INTO actions (summary, undo_ops, created_at) VALUES (?, ?, ?)", summary, JSON.stringify(undoOps), stamp()),
    summary,
  });

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

  const handlers = {
    record_sale(input) {
      const amount = toPaise(input.amount, "amount");
      const paid = toPaise(input.paid_amount, "paid_amount", { allowZero: true });
      if (paid > amount) throw new ToolError("paid_amount can't be more than amount. For money toward old udhaar, use record_payment too.");
      if (paid < amount && !input.customer_id && !input.customer_name?.trim()) {
        throw new ToolError("Udhaar needs a customer. Ask the owner who took it.");
      }
      const date = pastOrToday(input.date);
      return tx(db, () => {
        const ops = [];
        const { customer, created } = resolveOrCreate(input, ops);
        const id = insert(
          `INSERT INTO transactions (kind, customer_id, amount_paise, paid_paise, description, occurred_on, created_at)
           VALUES ('sale', ?, ?, ?, ?, ?, ?)`, customer?.id ?? null, amount, paid, input.description ?? null, date, stamp());
        ops.unshift({ op: "void", table: "transactions", id });
        const who = customer ? ` to ${customer.name}` : "";
        const credit = amount - paid;
        const summary = `Sale ${formatRupees(amount)}${who}${credit ? `, ${formatRupees(credit)} on udhaar` : ""}`;
        return {
          action: logAction(summary, ops),
          result: {
            recorded: summary, date, new_customer_created: created,
            customer_balance: customer ? rupees(balancePaise(customer.id)) : undefined,
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
          const phone = input.phone ?? c.phone;
          const notes = input.notes ?? c.notes;
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
        const id = insert("INSERT INTO customers (name, phone, notes, created_at) VALUES (?, ?, ?, ?)", name, input.phone ?? null, input.notes ?? null, stamp());
        const summary = `Added customer ${name}`;
        return { action: logAction(summary, [{ op: "void", table: "customers", id }]), result: { recorded: summary, customer_id: id } };
      });
    },

    find_customers({ query, inactive_for_days }) {
      const q = query?.trim();
      const rows = all(
        `SELECT c.id, c.name, c.phone, MAX(t.occurred_on) AS last_activity,
                COALESCE(SUM(CASE WHEN t.kind = 'sale' THEN t.amount_paise END), 0) AS spent,
                COALESCE(SUM(CASE t.kind WHEN 'sale' THEN t.amount_paise - t.paid_paise
                                         WHEN 'payment' THEN -t.amount_paise ELSE 0 END), 0) AS balance
           FROM customers c
           LEFT JOIN transactions t ON t.customer_id = c.id AND t.voided_at IS NULL
          WHERE c.voided_at IS NULL
            AND (?1 IS NULL OR instr(lower(c.name), lower(?1)) > 0 OR instr(COALESCE(c.phone, ''), ?1) > 0)
          GROUP BY c.id ORDER BY spent DESC LIMIT 200`, q || null);
      const cutoff = inactive_for_days != null ? addDays(today(), -inactive_for_days) : null;
      const customers = rows
        .filter((r) => !cutoff || !r.last_activity || r.last_activity <= cutoff)
        .slice(0, 50)
        .map((r) => ({
          customer_id: r.id, name: r.name, phone: r.phone, last_activity: r.last_activity,
          total_spent: rupees(r.spent), balance: rupees(r.balance),
        }));
      return { result: { customers } };
    },

    get_customer_details(input) {
      const c = resolveCustomer(input);
      if (!c) throw new ToolError("Customer not found. Try find_customers, or ask the owner for the spelling.");
      const recent = all(
        `SELECT kind, amount_paise, paid_paise, description, method, occurred_on FROM transactions
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
      const rows = all(
        `SELECT c.id, c.name, c.phone, MAX(t.occurred_on) AS last_activity,
                SUM(CASE t.kind WHEN 'sale' THEN t.amount_paise - t.paid_paise
                                WHEN 'payment' THEN -t.amount_paise ELSE 0 END) AS balance
           FROM customers c JOIN transactions t ON t.customer_id = c.id AND t.voided_at IS NULL
          WHERE c.voided_at IS NULL GROUP BY c.id HAVING balance > 0 ORDER BY balance DESC`);
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
          total_outstanding_now: rupees(outstandingPaise()),
        },
      };
    },

    list_transactions({ kind, from, to, limit }) {
      if (from) checkDate(from, "from");
      if (to) checkDate(to, "to");
      const cap = Math.min(Math.max(limit ?? 20, 1), 100);
      const rows = all(
        `SELECT t.*, c.name AS customer FROM transactions t LEFT JOIN customers c ON c.id = t.customer_id
          WHERE t.voided_at IS NULL AND (?1 IS NULL OR t.kind = ?1)
            AND (?2 IS NULL OR t.occurred_on >= ?2) AND (?3 IS NULL OR t.occurred_on <= ?3)
          ORDER BY t.occurred_on DESC, t.id DESC LIMIT ?4`, kind ?? null, from ?? null, to ?? null, cap);
      return { result: { transactions: rows.map(presentTransaction) } };
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
      const rows = all(
        `SELECT o.id, o.description, o.amount_paise, o.status, o.due_on, c.name AS customer
           FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
          WHERE o.voided_at IS NULL AND (?1 IS NULL AND o.status IN ('open', 'ready') OR o.status = ?1)
          ORDER BY o.due_on IS NULL, o.due_on LIMIT 100`, status ?? null);
      return { result: { orders: rows.map(presentOrder) } };
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
      return tx(db, () => {
        run("UPDATE appointments SET status = ? WHERE id = ?", status, appointment_id);
        const summary = `Appointment "${appt.service}" marked ${status}`;
        return { action: logAction(summary, [{ op: "set", table: "appointments", id: appointment_id, column: "status", value: appt.status }]), result: { recorded: summary } };
      });
    },

    list_appointments({ from, to }) {
      const start = from ? checkDate(from, "from") : today();
      const end = to ? checkDate(to, "to") : start;
      const rows = all(
        `SELECT a.id, a.service, a.starts_at, a.status, c.name AS customer
           FROM appointments a LEFT JOIN customers c ON c.id = a.customer_id
          WHERE a.voided_at IS NULL AND substr(a.starts_at, 1, 10) BETWEEN ? AND ?
          ORDER BY a.starts_at LIMIT 100`, start, end);
      return { result: { appointments: rows } };
    },

    remember_note(input) {
      const text = requireText(input.text, "text");
      return tx(db, () => {
        const id = insert("INSERT INTO notes (text, created_at) VALUES (?, ?)", text, stamp());
        return { action: logAction(`Remembered: ${text}`, [{ op: "void", table: "notes", id }]), result: { recorded: true } };
      });
    },

    update_business_profile(input) {
      const fields = ["name", "type", "owner_name"].filter((f) => input[f]?.trim());
      if (!fields.length) throw new ToolError("Provide at least one field to change.");
      return tx(db, () => {
        const before = one("SELECT * FROM business WHERE id = 1");
        const ops = fields.map((column) => {
          run(`UPDATE business SET ${column} = ? WHERE id = 1`, input[column].trim());
          return { op: "set", table: "business", id: 1, column, value: before[column] };
        });
        return { action: logAction(`Updated business profile (${fields.join(", ").replace("_", " ")})`, ops), result: { recorded: true } };
      });
    },

    undo_last_action({ action_id }) {
      const target = action_id != null
        ? one("SELECT * FROM actions WHERE id = ?", action_id)
        : one("SELECT * FROM actions WHERE undone_at IS NULL ORDER BY id DESC LIMIT 1");
      if (!target) throw new ToolError("Nothing to undo.");
      return { result: undoAction(target.id, { seen: true }), undone: target.id };
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

  const outstandingPaise = () => one(
    `SELECT COALESCE(SUM(b), 0) AS total FROM (
       SELECT SUM(CASE t.kind WHEN 'sale' THEN t.amount_paise - t.paid_paise
                              WHEN 'payment' THEN -t.amount_paise ELSE 0 END) AS b
         FROM transactions t JOIN customers c ON c.id = t.customer_id
        WHERE t.voided_at IS NULL AND c.voided_at IS NULL GROUP BY t.customer_id HAVING b > 0)`).total;

  const customerInUse = (id) => one(
    `SELECT (SELECT COUNT(*) FROM transactions WHERE customer_id = ?1 AND voided_at IS NULL)
          + (SELECT COUNT(*) FROM orders WHERE customer_id = ?1 AND voided_at IS NULL)
          + (SELECT COUNT(*) FROM appointments WHERE customer_id = ?1 AND voided_at IS NULL) AS n`, id).n > 0;

  function undoAction(id, { seen }) {
    return tx(db, () => {
      const action = one("SELECT * FROM actions WHERE id = ?", id);
      if (!action) throw new ToolError(`No action with id ${id}.`);
      if (action.undone_at) throw new ToolError(`Already undone: ${action.summary}`);
      let keptCustomer = false;
      for (const op of JSON.parse(action.undo_ops)) {
        const columns = UNDO_TARGETS[op.table];
        if (!columns) throw new Error(`Refusing undo on ${op.table}`);
        if (op.op === "void") {
          // A customer created by this action may have other entries by now.
          if (op.table === "customers" && customerInUse(op.id)) { keptCustomer = true; continue; }
          run(`UPDATE ${op.table} SET voided_at = ? WHERE id = ?`, stamp(), op.id);
        } else if (op.op === "set" && columns.includes(op.column)) {
          run(`UPDATE ${op.table} SET ${op.column} = ? WHERE id = ?`, op.value, op.id);
        } else {
          throw new Error(`Refusing undo op ${JSON.stringify(op)}`);
        }
      }
      run("UPDATE actions SET undone_at = ?, undo_seen = ? WHERE id = ?", stamp(), seen ? 1 : 0, id);
      return { undone: action.summary, note: keptCustomer ? "The customer was kept because they have other entries." : undefined };
    });
  }

  function glance() {
    const t = periodTotals(today(), today());
    return {
      sales_today: t.sales, expenses_today: t.expenses, outstanding: rupees(outstandingPaise()),
      appointments_today: one("SELECT COUNT(*) AS n FROM appointments WHERE voided_at IS NULL AND status = 'booked' AND substr(starts_at, 1, 10) = ?", today()).n,
      open_orders: one("SELECT COUNT(*) AS n FROM orders WHERE voided_at IS NULL AND status IN ('open', 'ready')").n,
    };
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
    today,
    profile: () => one("SELECT name, type, owner_name FROM business WHERE id = 1"),
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
    kind: t.kind, date: t.occurred_on, amount: rupees(t.amount_paise),
    on_udhaar: t.kind === "sale" ? rupees(t.amount_paise - t.paid_paise) : undefined,
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
