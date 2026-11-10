-- Mock data for demos: 60 days of a made-up kirana store, dated relative to today
-- (India time), so the numbers always look current. Every name and number is invented.
-- The same seed value gives the same data every time.
--
-- WARNING: this empties every Munshi table first. Run it only on a demo database.

BEGIN;

TRUNCATE stock_moves, items, chat_log, thread_messages, threads, actions, notes,
         appointments, orders, transactions, customers, business RESTART IDENTITY CASCADE;

SELECT setseed(0.1510);

CREATE TEMP TABLE clock ON COMMIT DROP AS
SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date AS today;

-- Text date and timestamp in the app's formats.
CREATE OR REPLACE FUNCTION pg_temp.d(n int) RETURNS text LANGUAGE sql AS
  $$ SELECT to_char((SELECT today FROM clock) - n, 'YYYY-MM-DD') $$;
CREATE OR REPLACE FUNCTION pg_temp.ts(n int, hour int) RETURNS text LANGUAGE sql AS
  $$ SELECT pg_temp.d(n) || 'T' || lpad(hour::text, 2, '0') || ':' || lpad((hour * 7 % 60)::text, 2, '0') || ':00.000Z' $$;

INSERT INTO business (id, name, type, owner_name, phone, address, gstin, upi_id) VALUES
  (1, 'Sharma Kirana Store', 'kirana store', 'Rakesh Sharma', '90000 00000',
   '12 Main Bazaar, Sample Nagar', '07ABCDE1234F1Z5', 'sharmastore@upi');

INSERT INTO customers (name, phone, notes, created_at)
SELECT name, phone, notes, pg_temp.ts(75, 10) FROM (VALUES
  ('Ramesh Gupta',   '90000 00001', 'Takes monthly ration on udhaar, pays after salary'),
  ('Sunita Devi',    '90000 00002', NULL),
  ('Imran Khan',     '90000 00003', 'Prefers UPI'),
  ('Lakshmi Iyer',   '90000 00004', 'Monthly ration delivery'),
  ('Priya Mehta',    '90000 00005', NULL),
  ('Anil Verma',     '90000 00006', NULL),
  ('Fatima Shaikh',  '90000 00007', NULL),
  ('Gurpreet Singh', '90000 00008', 'Runs the dhaba nearby, buys oil in bulk'),
  ('Meena Kumari',   '90000 00009', NULL),
  ('Rohit Yadav',    '90000 00010', NULL),
  ('Kavita Joshi',   '90000 00011', NULL),
  ('Suresh Patel',   '90000 00012', NULL),
  ('Neha Agarwal',   '90000 00013', NULL),
  ('Deepak Chauhan', '90000 00014', NULL),
  ('Pooja Nair',     '90000 00015', 'Used to come weekly'),
  ('Vikram Rao',     '90000 00016', NULL)
) AS c(name, phone, notes);

INSERT INTO items (name, unit, price_paise, low_at, created_at)
SELECT name, unit, price * 100, low_at, pg_temp.ts(75, 9) FROM (VALUES
  ('Basmati rice 1kg',     'packet',  120, 10),
  ('Toor dal 1kg',         'packet',  160,  8),
  ('Sunflower oil 1L',     'bottle',  150,  6),
  ('Sugar',                'kg',       45, 15),
  ('Atta 5kg',             'bag',     260,  5),
  ('Tea 250g',             'packet',  140,  6),
  ('Milk 500ml',           'packet',   30, 20),
  ('Parle-G biscuit',      'packet',   10, 30),
  ('Maggi noodles',        'packet',   14, 24),
  ('Bathing soap',         'pcs',      40, 10),
  ('Detergent 1kg',        'packet',  110,  5),
  ('Salt 1kg',             'packet',   25, 10),
  ('Haldi powder 100g',    'packet',   35,  8),
  ('Eggs (tray of 30)',    'tray',    180,  3)
) AS i(name, unit, price, low_at);

-- Opening stock count, 60 days ago. Purchases later replace exactly what sells each
-- week, so these are also today's counts: Toor dal, Parle-G and eggs end up low.
INSERT INTO stock_moves (item_id, qty, reason, created_at)
SELECT id, qty, 'count', pg_temp.ts(60, 8) FROM (VALUES
  (1, 34), (2, 6), (3, 15), (4, 48), (5, 12), (6, 14), (7, 40),
  (8, 22), (9, 60), (10, 26), (11, 11), (12, 25), (13, 18), (14, 2)
) AS s(id, qty);

-- Sales. Busier on weekends, and growing slightly over the two months.
CREATE TEMP TABLE slots ON COMMIT DROP AS
SELECT ago, slot, random() AS r_cust, random() AS r_pick, random() AS r_item,
       random() AS r_qty, random() AS r_amt, random() AS r_paid, random() AS r_hour
  FROM generate_series(0, 59) AS ago
 CROSS JOIN LATERAL generate_series(
   1, 6 + (CASE WHEN extract(isodow FROM (SELECT today FROM clock) - ago) IN (6, 7) THEN 4 ELSE 0 END) + (59 - ago) / 15
 ) AS slot;

CREATE TEMP TABLE sales ON COMMIT DROP AS
SELECT row_number() OVER (ORDER BY ago DESC, slot) AS id, s.*,
       CASE WHEN s.item_id IS NOT NULL THEN i.price_paise * s.qty
            ELSE (8 + floor(s.r_amt * 140)::bigint) * 1000 END AS amount_paise
  FROM (
    SELECT ago, slot, r_paid, r_hour, r_amt,
           -- About 45% of sales are to a known customer. The last two stopped coming a month ago.
           CASE WHEN r_cust < 0.45 THEN
             CASE WHEN 1 + floor(r_pick * 16)::int >= 15 AND ago < 35 THEN NULL
                  ELSE 1 + floor(r_pick * 16)::int END
           END AS customer_id,
           CASE WHEN r_item < 0.5 THEN 1 + floor(r_pick * 997)::int % 14 END AS item_id,
           1 + floor(r_qty * 3)::int AS qty
      FROM slots
  ) s
  LEFT JOIN items i ON i.id = s.item_id;

-- Some customers take udhaar: nothing paid, or part paid.
INSERT INTO transactions (id, kind, customer_id, amount_paise, paid_paise, description, method, occurred_on, created_at)
SELECT s.id, 'sale', s.customer_id, s.amount_paise,
       CASE WHEN s.customer_id IS NULL OR s.r_paid >= 0.35 THEN s.amount_paise
            WHEN s.r_paid < 0.22 THEN 0
            ELSE (s.amount_paise / 2 / 100) * 100 END,
       CASE WHEN s.item_id IS NOT NULL THEN s.qty || ' ' || i.unit || ' ' || i.name END,
       CASE WHEN s.r_paid >= 0.35 THEN (CASE WHEN s.r_hour < 0.55 THEN 'cash' ELSE 'upi' END) END,
       pg_temp.d(s.ago), pg_temp.ts(s.ago, 8 + floor(s.r_hour * 13)::int)
  FROM sales s LEFT JOIN items i ON i.id = s.item_id;

SELECT setval(pg_get_serial_sequence('transactions', 'id'), (SELECT max(id) FROM transactions));

-- A few bigger GST sales, for bills that show tax.
UPDATE transactions SET gst_rate = 18, description = COALESCE(description, 'Festive gift hamper'),
       amount_paise = amount_paise + 50000, paid_paise = paid_paise + 50000
 WHERE kind = 'sale' AND id % 37 = 0;

INSERT INTO stock_moves (item_id, qty, reason, transaction_id, created_at)
SELECT s.item_id, -s.qty, 'sale', s.id, pg_temp.ts(s.ago, 12)
  FROM sales s WHERE s.item_id IS NOT NULL;

-- Weekly delivery from the wholesaler replaces what sold that week, plus the expense.
CREATE TEMP TABLE weekly ON COMMIT DROP AS
SELECT ago / 7 AS week, item_id, sum(qty) AS qty
  FROM sales WHERE item_id IS NOT NULL GROUP BY 1, 2;

INSERT INTO stock_moves (item_id, qty, reason, created_at)
SELECT item_id, qty, 'purchase', pg_temp.ts(week * 7, 7) FROM weekly;

INSERT INTO transactions (kind, amount_paise, category, description, method, occurred_on, created_at)
SELECT 'expense', (sum(w.qty * i.price_paise) * 0.8)::bigint / 100 * 100, 'stock',
       'Weekly wholesale purchase, Agarwal Traders', 'upi', pg_temp.d(w.week * 7), pg_temp.ts(w.week * 7, 7)
  FROM weekly w JOIN items i ON i.id = w.item_id GROUP BY w.week;

-- Regular running costs.
INSERT INTO transactions (kind, amount_paise, category, description, method, occurred_on, created_at)
SELECT 'expense', amount * 100, category, description, method, pg_temp.d(ago), pg_temp.ts(ago, 18)
  FROM (VALUES
    (55, 15000, 'rent', 'Shop rent', 'bank'), (25, 15000, 'rent', 'Shop rent', 'bank'),
    (52,  1840, 'electricity', 'Electricity bill', 'upi'), (22, 2120, 'electricity', 'Electricity bill', 'upi'),
    (54,  9000, 'salary', 'Helper salary (Raju)', 'cash'), (24, 9000, 'salary', 'Helper salary (Raju)', 'cash')
  ) AS e(ago, amount, category, description, method)
UNION ALL
SELECT 'expense', (250 + (g % 3) * 50) * 100, 'transport', 'Auto for delivery', 'cash', pg_temp.d(g), pg_temp.ts(g, 17)
  FROM generate_series(1, 59, 4) AS g;

-- Customers pay back part of their udhaar, in two instalments.
INSERT INTO transactions (kind, customer_id, amount_paise, method, occurred_on, created_at)
SELECT 'payment', customer_id, part, CASE WHEN customer_id % 2 = 0 THEN 'upi' ELSE 'cash' END,
       -- The two lapsed customers last paid over a month ago, too.
       pg_temp.d(CASE WHEN customer_id >= 15 THEN greatest(ago, 35) ELSE ago END),
       pg_temp.ts(CASE WHEN customer_id >= 15 THEN greatest(ago, 35) ELSE ago END, 19)
  FROM (
    SELECT customer_id, (sum(amount_paise - paid_paise) * 0.3)::bigint / 1000 * 1000 AS part,
           least(max(ago_last), 40) AS first_ago
      FROM (SELECT t.customer_id, t.amount_paise, t.paid_paise,
                   (SELECT today FROM clock) - t.occurred_on::date AS ago_last
              FROM transactions t WHERE t.kind = 'sale' AND t.customer_id IS NOT NULL) x
     GROUP BY customer_id
  ) owed
 CROSS JOIN LATERAL (VALUES (owed.first_ago - 5), (greatest(owed.first_ago - 20, 2))) AS when_(ago)
 WHERE part > 0 AND ago >= 0;

INSERT INTO orders (customer_id, description, amount_paise, status, due_on, created_at) VALUES
  (4,  'Monthly ration delivery',            350000, 'open',      pg_temp.d(-2), pg_temp.ts(3, 11)),
  (8,  '20 litres sunflower oil for dhaba',  300000, 'ready',     pg_temp.d(-1), pg_temp.ts(2, 10)),
  (11, 'Diwali sweets and dry fruit boxes',  420000, 'open',      pg_temp.d(-6), pg_temp.ts(1, 16)),
  (1,  'Monthly ration delivery',            280000, 'delivered', pg_temp.d(9),  pg_temp.ts(12, 11)),
  (6,  'Birthday party snacks',               95000, 'cancelled', pg_temp.d(15), pg_temp.ts(18, 13));

INSERT INTO appointments (customer_id, service, starts_at, status, created_at) VALUES
  (4,  'Home delivery: monthly ration', pg_temp.d(-2) || 'T11:00', 'booked', pg_temp.ts(3, 11)),
  (8,  'Home delivery: oil for dhaba',  pg_temp.d(-1) || 'T09:30', 'booked', pg_temp.ts(2, 10)),
  (13, 'Home delivery: groceries',      pg_temp.d(0)  || 'T18:00', 'booked', pg_temp.ts(0, 9)),
  (1,  'Home delivery: monthly ration', pg_temp.d(9)  || 'T11:00', 'done',   pg_temp.ts(12, 11));

INSERT INTO notes (text, created_at) VALUES
  ('Wholesale supplier is Agarwal Traders, delivers on Sundays.', pg_temp.ts(70, 10)),
  ('Shop is closed on Tuesday afternoons.', pg_temp.ts(65, 10)),
  ('Helper Raju gets salary on the 5th of every month.', pg_temp.ts(60, 10));

COMMIT;
