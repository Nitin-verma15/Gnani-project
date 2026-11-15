-- Example questions the shop data can answer. Run any of these in Neon's SQL Editor.

-- 1. Today's takings
SELECT * FROM daily_totals WHERE day = to_char((now() AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD');

-- 2. Who owes money, largest first (the udhaar list)
SELECT name, phone, owes, last_activity FROM customer_balances WHERE owes > 0 ORDER BY owes DESC;

-- 3. Items running low
SELECT name, on_hand, unit, low_at FROM stock_on_hand WHERE is_low ORDER BY name;

-- 4. Sales and expenses for the last 14 days
SELECT day, sales, expenses, number_of_sales FROM daily_totals ORDER BY day DESC LIMIT 14;

-- 5. Best customers this month
SELECT name, total_spent FROM customer_balances ORDER BY total_spent DESC LIMIT 5;

-- 6. Customers who haven't come in for 30 days
SELECT name, phone, last_activity FROM customer_balances
 WHERE last_activity < to_char((now() AT TIME ZONE 'Asia/Kolkata')::date - 30, 'YYYY-MM-DD')
 ORDER BY last_activity;

-- 7. Where the money went, by category
SELECT category, round(sum(amount_paise) / 100.0, 2) AS spent FROM transactions
 WHERE kind = 'expense' AND voided_at IS NULL GROUP BY category ORDER BY spent DESC;

-- 8. Open orders and upcoming deliveries
SELECT o.description, c.name AS customer, round(o.amount_paise / 100.0, 2) AS amount, o.status, o.due_on
  FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
 WHERE o.status IN ('open', 'ready') ORDER BY o.due_on;
