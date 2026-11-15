// The app was called Munshi, then Countr, before Counterbook. Settings with the old prefixes
// (MUNSHI_*, COUNTR_*) still work, so an existing .env or hosting setup keeps running.
// Import this before anything reads settings.
import { existsSync } from "node:fs";
import { join } from "node:path";

const OLD_PREFIXES = ["COUNTR_", "MUNSHI_"]; // newer first, so it wins if both are set

for (const prefix of OLD_PREFIXES) {
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith(prefix)) continue;
    const renamed = `COUNTERBOOK_${key.slice(prefix.length)}`;
    if (process.env[renamed] === undefined) process.env[renamed] = value;
  }
}

/** The single-shop database file: keeps using a file saved under an older name, if there is one. */
export function singleShopDbPath(dataDir) {
  for (const name of ["counterbook.db", "countr.db", "munshi.db"]) {
    const path = join(dataDir, name);
    if (existsSync(path)) return path;
  }
  return join(dataDir, "counterbook.db");
}
