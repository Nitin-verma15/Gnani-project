// Made-up kirana store data for trying the app. The "Try the demo shop" button fills its
// shop with this automatically; `npm run seed` does the same from the command line.
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "./db.js";
import { createTools, addDays } from "./tools.js";

/** Fills an empty shop database with sample data. Returns false if it already had entries. */
export function seedSample(db) {
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM transactions").get();
  if (n > 0) return false;

  const tools = createTools(db);
  const today = tools.today();
  const ago = (days) => addDays(today, -days);
  const run = (name, input) => {
    const out = tools.run(name, input);
    if (out.error) throw new Error(`${name}: ${out.error}`);
  };

  run("update_business_profile", {
    name: "Sharma Kirana Store", type: "kirana store", owner_name: "Sharma ji",
    phone: "90000 00000", address: "12 Main Bazaar, Sample Nagar", upi_id: "sharmastore@upi",
  });
  run("set_item", { name: "Basmati rice 1kg", unit: "packet", price: 120, low_stock_at: 10, quantity_on_hand: 40 });
  run("set_item", { name: "Toor dal 1kg", unit: "packet", price: 160, low_stock_at: 8, quantity_on_hand: 9 });
  run("set_item", { name: "Sunflower oil 1L", unit: "bottle", price: 150, low_stock_at: 6, quantity_on_hand: 18 });
  run("set_item", { name: "Sugar", unit: "kg", price: 45, low_stock_at: 15, quantity_on_hand: 50 });
  run("set_item", { name: "Parle-G biscuit", unit: "packet", price: 10, low_stock_at: 30, quantity_on_hand: 24 });
  run("add_customer", { name: "Ramesh Gupta", phone: "90000 00001" });
  run("add_customer", { name: "Sunita Devi", phone: "90000 00002" });
  run("add_customer", { name: "Imran Khan", phone: "90000 00003" });
  run("add_customer", { name: "Lakshmi Iyer", phone: "90000 00004" });

  const sales = [
    [13, 1800, 1800, null], [12, 950, 950, null], [11, 2200, 1200, "Ramesh Gupta"], [10, 1400, 1400, null],
    [9, 3100, 3100, "Lakshmi Iyer"], [8, 1250, 0, "Imran Khan"], [7, 1650, 1650, null], [6, 2400, 2400, null],
    [5, 1900, 900, "Sunita Devi"], [4, 2750, 2750, null], [3, 3300, 2000, "Ramesh Gupta"], [2, 2100, 2100, null],
    [1, 2600, 2600, null], [0, 1450, 1450, null], [40, 2800, 2800, "Lakshmi Iyer"],
  ];
  for (const [days, amount, paid, customer] of sales) {
    run("record_sale", { amount, paid_amount: paid, date: ago(days), ...(customer ? { customer_name: customer } : {}) });
  }
  run("record_sale", { paid_in_full: true, customer_name: "Lakshmi Iyer", items: [{ item_name: "Basmati rice", quantity: 2 }, { item_name: "Sunflower oil", quantity: 1 }], date: ago(0) });
  run("record_sale", { amount: 590, paid_amount: 590, gst_rate: 18, description: "Gift hamper", date: ago(0) });
  run("record_payment", { amount: 500, customer_name: "Ramesh Gupta", method: "upi", date: ago(2) });
  run("record_expense", { amount: 8000, category: "stock", description: "Weekly wholesale purchase", date: ago(7) });
  run("record_expense", { amount: 6500, category: "stock", description: "Weekly wholesale purchase", date: ago(1) });
  run("record_expense", { amount: 1200, category: "electricity", date: ago(5) });
  run("record_expense", { amount: 350, category: "transport", date: ago(0) });
  run("create_order", { description: "Monthly ration delivery", customer_name: "Lakshmi Iyer", amount: 3500, due_on: addDays(today, 2) });
  run("remember_note", { text: "Wholesale supplier is Agarwal Traders, delivers on Sundays." });

  // Sample entries shouldn't appear as things the owner could undo in conversation.
  db.prepare("UPDATE actions SET undone_at = created_at").run();
  return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const dataDir = process.env.MUNSHI_DATA_DIR || join(root, "data");
  // With shop accounts (the default) this fills the demo shop; in single-shop mode, the one shop.
  const path = process.env.MUNSHI_DB
    || (process.env.MUNSHI_SINGLE_SHOP === "1" ? join(dataDir, "munshi.db") : join(dataDir, "shops", "demo.db"));
  const added = seedSample(openDb(path));
  console.log(added ? `Added sample data for Sharma Kirana Store (all made up) to ${path}.` : "This database already has entries, so nothing was added.");
}
