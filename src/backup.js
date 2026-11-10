// Daily copies of the shop database, so one bad disk or mistake can't lose the books.
// Run on its own (`npm run backup`) for a copy right now.
import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, backupTo } from "./db.js";
import { localDate } from "./tools.js";

const PATTERN = /^munshi-(\d{4}-\d{2}-\d{2})\.db$/;

/** Makes today's backup if it doesn't exist yet and keeps only the newest `keep`. Returns the path or null. */
export function dailyBackup(db, dir, { keep = 14, now = new Date() } = {}) {
  const file = join(dir, `munshi-${localDate(now)}.db`);
  let made = null;
  if (!existsSync(file)) {
    backupTo(db, file);
    made = file;
  }
  const old = readdirSync(dir).filter((f) => PATTERN.test(f)).sort().reverse().slice(keep);
  for (const f of old) unlinkSync(join(dir, f));
  return made;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const dbPath = process.env.MUNSHI_DB || join(root, "data", "munshi.db");
  const dir = process.env.MUNSHI_BACKUP_DIR || join(dirname(dbPath), "backups");
  const db = openDb(dbPath);
  const file = join(dir, `munshi-${new Date().toISOString().replace(/[:.]/g, "-")}.db`);
  backupTo(db, file);
  console.log(`Backup saved: ${file}`);
}
