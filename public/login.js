// The sign-in and register page. On success it goes to the dashboard at /app.
const $ = (id) => document.getElementById(id);
const post = (url, body) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

function selectTab(which) {
  for (const [tab, form] of [["auth-tab-signin", "signin-form"], ["auth-tab-register", "register-form"]]) {
    const on = form === `${which}-form`;
    $(tab).setAttribute("aria-selected", String(on));
    $(tab).tabIndex = on ? 0 : -1;
    $(form).hidden = !on;
  }
  $("auth-error").textContent = "";
  history.replaceState(null, "", which === "register" ? "/signup" : "/login");
}

async function submit(url, body, button) {
  $("auth-error").textContent = "";
  button.disabled = true;
  try {
    const res = await post(url, body);
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || "Couldn't sign in. Please try again.");
    location.href = "/app";
  } catch (err) {
    $("auth-error").textContent = err.message === "Failed to fetch" ? "Couldn't reach the server. Is it running?" : err.message;
    button.disabled = false;
  }
}

$("auth-tab-signin").addEventListener("click", () => selectTab("signin"));
$("auth-tab-register").addEventListener("click", () => selectTab("register"));
for (const tab of ["auth-tab-signin", "auth-tab-register"]) {
  $(tab).addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const next = tab === "auth-tab-signin" ? "register" : "signin";
    selectTab(next);
    $(`auth-tab-${next}`).focus();
  });
}
for (const [form, url] of [["signin-form", "/api/auth/login"], ["register-form", "/api/auth/register"]]) {
  $(form).addEventListener("submit", (event) => {
    event.preventDefault();
    submit(url, Object.fromEntries(new FormData(event.currentTarget)), event.currentTarget.querySelector("button"));
  });
}
$("demo-shop").addEventListener("click", (event) => submit("/api/auth/demo", {}, event.currentTarget));

// /signup opens on the register form, /login on sign in.
selectTab(location.pathname === "/signup" || location.hash === "#register" ? "register" : "signin");
($("signin-form").hidden ? $("register-form") : $("signin-form")).querySelector("input").focus();

// Already signed in, or a single-shop setup without accounts: straight to the dashboard.
fetch("/api/state").then((r) => r.json()).then((state) => {
  if (state.auth !== "accounts" || state.signedIn) location.replace("/app");
}).catch(() => {});
