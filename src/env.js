// Settings were called MUNSHI_* before the app was renamed Countr. Accept the old names too,
// so an existing .env or hosting setup keeps working. Import this before anything reads settings.
for (const [key, value] of Object.entries(process.env)) {
  if (key.startsWith("MUNSHI_")) {
    const renamed = `COUNTR_${key.slice("MUNSHI_".length)}`;
    if (process.env[renamed] === undefined) process.env[renamed] = value;
  }
}
