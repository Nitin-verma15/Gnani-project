import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.js";
import { dailyBackup } from "../src/backup.js";
import { singleShopDbPath } from "../src/env.js";

const envModule = new URL("../src/env.js", import.meta.url).href;

/** Imports env.js in a fresh process with the given settings and returns what it resolved. */
function resolvedSettings(env) {
  const script = `await import(${JSON.stringify(envModule)}); console.log(JSON.stringify({ host: process.env.COUNTERBOOK_HOST ?? null, pin: process.env.COUNTERBOOK_PIN ?? null }));`;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { PATH: process.env.PATH, ...env }, encoding: "utf8",
  });
  return JSON.parse(out);
}

test("settings saved under the old names still work", () => {
  assert.deepEqual(resolvedSettings({ COUNTR_HOST: "0.0.0.0" }), { host: "0.0.0.0", pin: null });
  assert.deepEqual(resolvedSettings({ MUNSHI_PIN: "1234" }), { host: null, pin: "1234" });
  // The current name wins, then the more recent old name.
  assert.deepEqual(resolvedSettings({ COUNTERBOOK_HOST: "a", COUNTR_HOST: "b", MUNSHI_HOST: "c" }).host, "a");
  assert.deepEqual(resolvedSettings({ COUNTR_HOST: "b", MUNSHI_HOST: "c" }).host, "b");
});

test("a single-shop database saved under an old name is still found", () => {
  const dir = mkdtempSync(join(tmpdir(), "counterbook-rename-"));
  assert.equal(singleShopDbPath(dir), join(dir, "counterbook.db"));
  writeFileSync(join(dir, "countr.db"), "");
  assert.equal(singleShopDbPath(dir), join(dir, "countr.db"));
  writeFileSync(join(dir, "counterbook.db"), "");
  assert.equal(singleShopDbPath(dir), join(dir, "counterbook.db"));
});

test("old backups are kept or pruned by date, whatever name they were saved under", () => {
  const dir = mkdtempSync(join(tmpdir(), "counterbook-backups-"));
  writeFileSync(join(dir, "munshi-2026-11-01.db"), "");
  writeFileSync(join(dir, "countr-2026-11-12.db"), "");
  writeFileSync(join(dir, "countr-2026-11-05.db"), "");
  dailyBackup(openDb(":memory:"), dir, { keep: 2, now: new Date("2026-11-14T06:00:00Z") });
  assert.deepEqual(readdirSync(dir).sort(), ["counterbook-2026-11-14.db", "countr-2026-11-12.db"]);
});
