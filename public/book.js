// The shop book: a live view of the ledger beside the assistant. It refreshes whenever
// the assistant writes something (app.js fires "munshi:refresh"). Nothing here is
// needed for the assistant itself to work.
import { romanize } from "/romanize.js";

const $ = (id) => document.getElementById(id);
const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2, minimumFractionDigits: 0 });
const dayName = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-IN", { weekday: "short", timeZone: "UTC" });
const shortDate = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
const qty = (n) => Number(n).toLocaleString("en-IN", { maximumFractionDigits: 3 });

/** Small DOM helper: el("p", { className: "x" }, "text", child) */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key in node && key !== "role") node[key] = value;
    else node.setAttribute(key, value);
  }
  node.append(...children.filter((c) => c != null && c !== false));
  return node;
}

// Only links Munshi itself makes are ever turned into clickable addresses.
export const safeUrl = (url) => (typeof url === "string" && /^(\/bill\/\d+|https:\/\/wa\.me\/\d*\?text=|upi:\/\/pay\?)/.test(url) ? url : null);

function empty(title, hint) {
  return el("div", { className: "empty" }, el("p", { className: "empty-title" }, title), el("p", { className: "hint" }, hint));
}

function tryButton(text) {
  return el("button", { type: "button", className: "try-chip", onclick: () => dispatchEvent(new CustomEvent("munshi:say", { detail: { text } })) }, `Try: "${text}"`);
}

/* ---------- Week chart ---------- */

let lastDays = [];

function renderWeek(data) {
  $("week-sales").textContent = inr.format(data.week.sales);
  $("week-expenses").textContent = inr.format(data.week.expenses);
  $("week-collected").textContent = inr.format(data.week.udhaar_collected);
  lastDays = data.days;
  const max = Math.max(1, ...data.days.flatMap((d) => [d.sales, d.expenses]));
  const chart = $("week-chart");
  chart.replaceChildren(...data.days.map((d, i) => {
    const bar = (value, kind) => el("span", {
      className: `bar bar-${kind}`,
      style: `height: ${value > 0 ? Math.max(3, (value / max) * 100) : 0}%`,
    });
    const isToday = i === data.days.length - 1;
    return el("div", {
      className: `day${isToday ? " today" : ""}`,
      tabIndex: 0,
      "data-index": i,
      "aria-label": `${shortDate(d.day)}: sales ${inr.format(d.sales)}, spent ${inr.format(d.expenses)}`,
    },
    el("div", { className: "bars" }, bar(d.sales, "sales"), bar(d.expenses, "expenses")),
    el("span", { className: "day-label" }, isToday ? "Today" : dayName(d.day)));
  }));
  $("week-table").tBodies[0].replaceChildren(...data.days.map((d) => el("tr", {},
    el("th", { scope: "row" }, shortDate(d.day)),
    el("td", { className: "num" }, inr.format(d.sales)),
    el("td", { className: "num" }, inr.format(d.expenses)))));
}

function setUpChartHover() {
  const chart = $("week-chart");
  const tip = $("chart-tip");
  const show = (dayEl) => {
    const d = lastDays[Number(dayEl.dataset.index)];
    if (!d) return;
    tip.replaceChildren(
      el("b", {}, shortDate(d.day)),
      el("span", {}, el("i", { className: "swatch swatch-sales" }), `Sales ${inr.format(d.sales)}`),
      el("span", {}, el("i", { className: "swatch swatch-expenses" }), `Spent ${inr.format(d.expenses)}`),
    );
    tip.hidden = false;
    const box = dayEl.getBoundingClientRect();
    const parent = tip.offsetParent?.getBoundingClientRect() ?? { left: 0, top: 0 };
    const left = box.left - parent.left + box.width / 2;
    tip.style.left = `${Math.min(Math.max(left, 70), (tip.offsetParent?.clientWidth ?? 300) - 70)}px`;
    tip.style.top = `${box.top - parent.top - 8}px`;
  };
  const hide = () => { tip.hidden = true; };
  chart.addEventListener("pointerover", (e) => { const d = e.target.closest(".day"); if (d) show(d); });
  chart.addEventListener("pointerleave", hide);
  chart.addEventListener("focusin", (e) => { const d = e.target.closest(".day"); if (d) show(d); });
  chart.addEventListener("focusout", hide);

  const toggle = $("week-table-toggle");
  toggle.addEventListener("click", () => {
    const showTable = toggle.getAttribute("aria-pressed") !== "true";
    toggle.setAttribute("aria-pressed", String(showTable));
    toggle.textContent = showTable ? "Show as chart" : "Show as table";
    $("week-table").hidden = !showTable;
    chart.hidden = showTable;
    document.querySelector(".week .legend").hidden = showTable;
  });
}

/* ---------- Panels ---------- */

function renderUdhaar(pending) {
  $("count-udhaar").textContent = pending.length ? String(pending.length) : "";
  if (!pending.length) {
    return $("panel-udhaar").replaceChildren(empty("Nobody owes you anything.", "Credit sales show up here, biggest first."), tryButton("Ramesh ko 500 udhaar diya"));
  }
  const total = pending.reduce((sum, p) => sum + p.owes, 0);
  $("panel-udhaar").replaceChildren(
    el("p", { className: "panel-total" }, "Total due ", el("strong", {}, inr.format(total))),
    el("ul", { className: "rows" }, ...pending.map((p) => el("li", { className: "row" },
      el("span", { className: "avatar", "aria-hidden": "true" }, romanize(p.name).trim()[0]?.toUpperCase() ?? "?"),
      el("span", { className: "row-main" },
        el("span", { className: "row-title" }, romanize(p.name)),
        el("span", { className: "row-sub" }, p.days_since_activity > 0 ? `Last seen ${p.days_since_activity} day${p.days_since_activity === 1 ? "" : "s"} ago` : "Seen today",
          p.days_since_activity >= 30 ? el("span", { className: "badge badge-warn" }, "30+ days") : null)),
      el("span", { className: "row-amount" }, inr.format(p.owes)),
      safeUrl(p.whatsapp_url)
        ? el("a", { className: "row-action wa", href: safeUrl(p.whatsapp_url), target: "_blank", rel: "noopener", "aria-label": `Send a WhatsApp reminder to ${romanize(p.name)}` }, "Remind")
        : null))),
  );
}

function renderStock(stock) {
  const low = stock.filter((i) => i.low).length;
  $("count-stock").textContent = low ? `${low} low` : "";
  $("count-stock").classList.toggle("count-warn", low > 0);
  if (!stock.length) {
    return $("panel-stock").replaceChildren(empty("No stock items yet.", "Tell Munshi what you sell and how many you have."), tryButton("Sugar add karo, 50 kg hai, 45 rupaye kilo"));
  }
  const sorted = [...stock].sort((a, b) => Number(b.low) - Number(a.low) || a.name.localeCompare(b.name));
  $("panel-stock").replaceChildren(el("ul", { className: "rows" }, ...sorted.map((i) => {
    const level = i.low_stock_at ? Math.min(1, Math.max(0, i.on_hand / (i.low_stock_at * 3))) : null;
    return el("li", { className: `row${i.low ? " row-low" : ""}` },
      el("span", { className: "row-main" },
        el("span", { className: "row-title" }, romanize(i.name), i.low ? el("span", { className: "badge badge-warn" }, i.on_hand <= 0 ? "Out" : "Low") : null),
        el("span", { className: "row-sub" }, i.price != null ? `${inr.format(i.price)} / ${i.unit}` : "No price saved",
          i.low_stock_at != null ? ` · warn at ${qty(i.low_stock_at)}` : ""),
        level != null ? el("span", { className: "meter", "aria-hidden": "true" }, el("i", { style: `width: ${level * 100}%` })) : null),
      el("span", { className: "row-amount" }, `${qty(i.on_hand)} `, el("small", {}, i.unit)));
  })));
}

const KIND_LABEL = { sale: "Sale", expense: "Spent", payment: "Received" };

function renderEntries(recent) {
  if (!recent.length) {
    return $("panel-entries").replaceChildren(empty("No entries yet.", "Sales, expenses and payments appear here as you speak them."), tryButton("1000 ki sale"));
  }
  $("panel-entries").replaceChildren(el("ul", { className: "rows" }, ...recent.map((t) => el("li", { className: "row" },
    el("span", { className: `kind kind-${t.kind}` }, KIND_LABEL[t.kind]),
    el("span", { className: "row-main" },
      el("span", { className: "row-title" }, romanize(t.customer || t.description || t.category || KIND_LABEL[t.kind])),
      el("span", { className: "row-sub" }, shortDate(t.date),
        t.on_udhaar ? ` · ${inr.format(t.on_udhaar)} on udhaar` : "",
        t.gst_rate ? ` · GST ${t.gst_rate}%` : "",
        t.category && t.kind === "expense" ? ` · ${t.category}` : "",
        t.method ? ` · ${t.method.toUpperCase()}` : "")),
    el("span", { className: `row-amount${t.kind === "expense" ? " minus" : ""}` }, `${t.kind === "expense" ? "−" : ""}${inr.format(t.amount)}`),
    safeUrl(t.bill_url) ? el("a", { className: "row-action", href: safeUrl(t.bill_url), target: "_blank", rel: "noopener", "aria-label": `Open the bill for this ${inr.format(t.amount)} sale` }, "Bill") : null))));
}

function renderPlans(orders, appointments) {
  const parts = [];
  parts.push(el("h3", { className: "panel-heading" }, "Open orders"));
  parts.push(orders.length
    ? el("ul", { className: "rows" }, ...orders.map((o) => el("li", { className: "row" },
      el("span", { className: `badge badge-${o.status}` }, o.status),
      el("span", { className: "row-main" },
        el("span", { className: "row-title" }, romanize(o.description)),
        el("span", { className: "row-sub" }, [o.customer && romanize(o.customer), o.due_on && `due ${shortDate(o.due_on)}`].filter(Boolean).join(" · "))),
      o.amount != null ? el("span", { className: "row-amount" }, inr.format(o.amount)) : null)))
    : el("p", { className: "hint" }, "No open orders."));
  parts.push(el("h3", { className: "panel-heading" }, "Bookings this week"));
  parts.push(appointments.length
    ? el("ul", { className: "rows" }, ...appointments.map((a) => el("li", { className: `row${a.status !== "booked" ? " row-done" : ""}` },
      el("span", { className: "when" }, el("b", {}, a.starts_at.slice(11, 16)), el("small", {}, shortDate(a.starts_at.slice(0, 10)))),
      el("span", { className: "row-main" },
        el("span", { className: "row-title" }, romanize(a.service)),
        el("span", { className: "row-sub" }, [a.customer && romanize(a.customer), a.status !== "booked" && a.status.replace("_", " ")].filter(Boolean).join(" · "))))))
    : el("p", { className: "hint" }, "Nothing booked in the next 7 days."));
  $("panel-plans").replaceChildren(...parts);
}

/* ---------- Tabs ---------- */

function setUpTabs() {
  const tabs = [...document.querySelectorAll('.tabs [role="tab"]')];
  const select = (tab, focus = false) => {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
      $(t.getAttribute("aria-controls")).hidden = !on;
    }
    if (focus) tab.focus();
    const strip = tab.parentElement;
    strip.scrollTo({ left: tab.offsetLeft - strip.clientWidth / 2 + tab.offsetWidth / 2 });
    try { sessionStorage.setItem("munshi-tab", tab.id); } catch { /* fine */ }
  };
  tabs.forEach((tab, i) => {
    tab.addEventListener("click", () => select(tab));
    tab.addEventListener("keydown", (e) => {
      const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
      if (step) select(tabs[(i + step + tabs.length) % tabs.length], true);
      if (e.key === "Home") select(tabs[0], true);
      if (e.key === "End") select(tabs.at(-1), true);
    });
  });
  let saved = null;
  try { saved = sessionStorage.getItem("munshi-tab"); } catch { /* fine */ }
  const start = tabs.find((t) => t.id === saved);
  if (start) select(start);
}

/* ---------- Settings ---------- */

function fillProfile(business) {
  const form = $("profile-form");
  for (const [key, value] of Object.entries(business ?? {})) {
    if (form.elements[key] && document.activeElement !== form.elements[key]) form.elements[key].value = value ?? "";
  }
}

function setUpProfileForm() {
  const form = $("profile-form");
  const status = $("profile-status");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(form));
    status.textContent = "Saving…";
    status.className = "form-status";
    try {
      const res = await fetch("/api/profile", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error);
      fillProfile(out.business);
      status.textContent = out.action ? "Saved." : "Nothing changed.";
      dispatchEvent(new CustomEvent("munshi:business", { detail: out.business }));
    } catch (err) {
      status.textContent = err.message || "Couldn't save. Please try again.";
      status.className = "form-status form-error";
    }
  });
  $("lock").addEventListener("click", async () => {
    await fetch("/api/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => {});
    location.reload();
  });
}

/* ---------- Loading ---------- */

let loading = null;
let again = false;

async function refresh() {
  if (loading) { again = true; return; }
  loading = (async () => {
    try {
      const res = await fetch("/api/overview");
      if (!res.ok) return;
      const data = await res.json();
      renderWeek(data);
      renderUdhaar(data.pending);
      renderStock(data.stock);
      renderEntries(data.recent);
      renderPlans(data.orders, data.appointments);
    } catch (err) {
      console.error(err);
    }
  })();
  await loading;
  loading = null;
  if (again) { again = false; refresh(); }
}

setUpTabs();
setUpChartHover();
setUpProfileForm();
addEventListener("munshi:refresh", refresh);
addEventListener("munshi:ready", (e) => {
  fillProfile(e.detail.business);
  $("lock").hidden = !e.detail.pin;
  refresh();
});
addEventListener("munshi:business", (e) => fillProfile(e.detail));
