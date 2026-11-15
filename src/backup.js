// Daily copies of the shop database, so one bad disk or mistake can't lose the books.
// Run on its own (`npm run backup`) for a copy right now.
import { singleShopDbPath } from "./env.js";
import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, backupTo } from "./db.js";
import { localDate } from "./tools.js";

// Backups made under the app's older names (countr-, munshi-) count too.
const PATTERN = /^(?:counterbook|countr|munshi)-(\d{4}-\d{2}-\d{2})\.db$/;

/** Makes today's backup if it doesn't exist yet and keeps only the newest `keep`. Returns the path or null. */
export function dailyBackup(db, dir, { keep = 14, now = new Date() } = {}) {
  const file = join(dir, `counterbook-${localDate(now)}.db`);
  let made = null;
  if (!existsSync(file)) {
    backupTo(db, file);
    made = file;
  }
  // Newest first by date, not by name, since the prefixes differ.
  const byDate = (f) => f.match(PATTERN)[1];
  const old = readdirSync(dir).filter((f) => PATTERN.test(f))
    .sort((a, b) => byDate(b).localeCompare(byDate(a)) || b.localeCompare(a)).slice(keep);
  for (const f of old) unlinkSync(join(dir, f));
  return made;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const dbPath = process.env.COUNTERBOOK_DB || singleShopDbPath(join(root, "data"));
  const dir = process.env.COUNTERBOOK_BACKUP_DIR || join(dirname(dbPath), "backups");
  const db = openDb(dbPath);
  const file = join(dir, `counterbook-${new Date().toISOString().replace(/[:.]/g, "-")}.db`);
  backupTo(db, file);
  console.log(`Backup saved: ${file}`);
}
