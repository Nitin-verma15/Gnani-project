# Munshi

A voice-first AI assistant for small business owners in India. The owner talks or types in English, Hindi or Hinglish, and the assistant keeps the books: customers, sales, expenses, udhaar, stock, orders and appointments. It answers questions from the real numbers, prints bills with GST, and drafts WhatsApp payment reminders with the shop's UPI ID.

Beside the assistant, the **shop book** shows the last 7 days, who owes what (with a Remind button), stock levels, every entry with its bill, open orders and bookings, and the shop's details and data downloads.

"Munshi" (the traditional shop accountant) is a working name.

## Run it

Needs Node 22.13 or newer.

```bash
npm install
```

```bash
npm run seed
```

```bash
npm start
```

Open http://localhost:3000 in Chrome or Edge. `npm run seed` adds a made-up sample shop and is optional. While editing code, use `npm run dev` instead of `npm start`: it restarts the server whenever you save a file.

Your own `.env` (API keys) and `data/` (the shop database) are never committed, so each person keeps their own.

Without an API key the app runs in **demo mode**: a small pattern matcher stands in for the AI, so you can try the interface, but it only understands a few fixed Roman-script phrases.

To go live, create a `.env` file from `.env.example`, add a key and restart. The assistant needs **one** of the first two:

| Key | Powers | Get it from | Cost |
|---|---|---|---|
| `GEMINI_API_KEY` | The assistant, on Google Gemini (`gemini-3.8-flash` by default) | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | Free tier, with rate limits. On the free tier Google may use requests to improve its products. |
| `ANTHROPIC_API_KEY` | The assistant, on Claude | [console.anthropic.com](https://console.anthropic.com) | Paid, per use |
| `GNANI_API_KEY` | Voice in and out ([Gnani](https://docs.gnani.ai/api/introduction/introduction) Prisma and Timbre) | [app.gnani.ai/voice](https://app.gnani.ai/voice/) | Optional; without it the browser's built-in speech is used |

With both AI keys set, Claude is used unless `MUNSHI_PROVIDER=gemini`. The terminal says which AI and voice are active when the server starts. Keys stay on the server and never reach the browser. Each AI keeps its own conversation history, so switching between them is safe; the ledger itself is shared.

Other settings, all optional:

| Setting | What it does |
|---|---|
| `MUNSHI_PIN` | Locks the app behind a PIN (at least 4 characters). Needed before opening it to other devices. |
| `MUNSHI_HOST` | Where the server listens. Default `127.0.0.1` (this computer only). Set `0.0.0.0` to reach it from a phone on the same Wi-Fi; the server refuses to start that way without `MUNSHI_PIN`. |
| `MUNSHI_PROVIDER` | `gemini` or `claude`, when both keys are set. |
| `GEMINI_MODEL`, `GEMINI_THINKING` | Gemini model (default `gemini-3.8-flash`; `gemini-3.5-flash-lite` is faster) and thinking level (`minimal`, `low`, `medium`, `high`). |
| `MUNSHI_MODEL`, `MUNSHI_EFFORT` | Claude model and effort (`low`, `medium`, `high`, `xhigh`, `max`). An invalid effort falls back to `medium` with a warning. |
| `MUNSHI_DB`, `MUNSHI_BACKUP_DIR` | Where the database and its daily backups live. Default `data/munshi.db` and `data/backups/`. |
| `PORT` | Default 3000. |

Run the tests:

```bash
npm test
```

## Things to try with the real assistant

- "Ramesh ko 500 ka saaman udhaar diya"
- "Ramesh ne 200 rupaye de diye"
- "Paid ₹6,500 to the wholesaler yesterday"
- "Is hafte business kaisa raha?"
- "Who hasn't come in for a month?"
- "Kal shaam 5 baje Asha ka haircut book kar do"
- "Remember that Agarwal Traders delivers on Sundays"
- "Galat ho gaya, woh hata do"
- "Sugar add karo, 50 kg hai, 45 rupaye kilo, 15 se kam ho to batana"
- "Lakshmi ko 2 packet dal aur 1 tel becha, paise de diye"
- "Agarwal se 20 packet chawal aaye, 2,000 diye"
- "Kya khatam ho raha hai?"
- "Ramesh ko payment ka reminder bhejo"
- "Mera GST number 07ABCDE1234F1Z5 hai, aur UPI sharmastore@okaxis"
- "Pichli sale ka bill dikhao"

## Your data

- **Daily backups.** Each day the server saves a copy to `data/backups/` and keeps the last 14. `npm run backup` makes one immediately.
- **Downloads.** The shop book's *Shop & data* tab downloads the ledger, customers and stock as CSV (opens in Excel or Google Sheets), or the whole database as a backup file.
- **Restore.** Stop the server, copy a backup over `data/munshi.db`, delete any `munshi.db-wal` and `munshi.db-shm` next to it, and start again.

## How it's put together

| Path | What it does |
|---|---|
| [src/agent.js](src/agent.js) | The system prompt and the conversation loop with the AI |
| [src/gemini.js](src/gemini.js) | Lets Google Gemini run that same loop, translating to and from its API |
| [src/tools.js](src/tools.js) | Everything the assistant can do: 23 tools over the ledger and stock |
| [src/db.js](src/db.js) | SQLite schema, and upgrades for databases from older versions |
| [src/server.js](src/server.js) | HTTP API, streaming replies, PIN lock, bills, exports |
| [src/documents.js](src/documents.js) | Printable bills (with GST) and CSV exports |
| [src/backup.js](src/backup.js) | Daily database backups |
| [public/book.js](public/book.js) | The shop book: 7-day chart, udhaar, stock, entries, orders, settings |
| [src/gnani.js](src/gnani.js) | Gnani Prisma speech-to-text and Timbre text-to-speech |
| [public/audio.js](public/audio.js) | Turns microphone samples into the WAV files Gnani accepts |
| [src/demo.js](src/demo.js) | The stand-in used when there's no API key |
| [public/](public/) | The website, including the live assistant and voice |
| [public/scene.js](public/scene.js) | The 3D ledger, drawn with three.js. Skipped if the device has no WebGL |
| [public/motion.js](public/motion.js) | Draggable cards, tilt and scroll reveals. Respects the reduced-motion setting |
| [public/romanize.js](public/romanize.js) | Shows Hindi-script speech in English letters, so all on-screen text is Roman |

Decisions worth knowing before you change things:

- **Money is whole paise, and balances are never stored.** A customer's udhaar is always calculated from the ledger, so it can't drift out of step. Stock works the same way: quantity on hand is the sum of stock movements, so undoing a sale puts the items back.
- **Munshi never sends anything itself.** Reminders and bills become WhatsApp links the owner taps to send from their own phone, and payments are UPI links the customer's app opens.
- **Writes happen straight away, with Undo.** Asking for confirmation on every voice entry would be tiresome, so each entry shows a card with an Undo button and the assistant reads back what it recorded. Nothing is deleted: undo marks rows as voided.
- **The model never does the arithmetic.** Figures come from tools, which also refuse unsafe guesses: an ambiguous name returns the candidates, and a payment from an unknown customer is rejected.
- **Conversation history is append-only**, because replayed thinking blocks are only valid against unchanged history. A new thread starts each day (India time). Longer-term memory comes from the ledger, saved notes and a recent-activity list in the context block.

## Credits

- 3D: [three.js](https://threejs.org), MIT licence, included in `public/vendor`.
- Photos: [Pexels](https://www.pexels.com/license/), loaded from Pexels when the page opens, so they need internet. Each photo's card credits its photographer and links to its page.

## Known limits

This is built to run on the shop's own computer, not as an online service.

- **One business, one PIN.** `MUNSHI_PIN` protects it on a shop's Wi-Fi, but there are no separate user accounts, and one server holds one business's books. Putting it on the internet would need accounts, per-business data and HTTPS. Phones also need HTTPS for the microphone, so on a phone over plain Wi-Fi, typing works and voice doesn't.
- **Sessions reset on restart.** After the server restarts, everyone enters the PIN again.
- **Voice is one clip at a time.** Each spoken message is recorded, then sent to Gnani's REST API (30 seconds at most). Gnani also offers WebSocket streaming, which would show words as they're spoken and feel faster. Recording stops on a fixed loudness threshold, which may need tuning for a noisy shop.
- **Without a Gnani key, voice falls back to the browser's speech features**, which work best in Chrome and Edge.
- **Data leaves this computer.** Messages, plus the business data the assistant looks up, go to the Anthropic API. Voice recordings, reply text and customer names go to Gnani. Check this suits your customers' data and India's DPDP Act before real use.
- **GST is basic.** Bills show CGST and SGST for an intra-state sale at one rate per sale, with the amount treated as GST-inclusive. There's no IGST, HSN codes or GST return filing; check bills with your CA before relying on them as tax invoices.
- **Payments aren't confirmed automatically.** The UPI link fills in the amount, but the owner still tells Munshi when money arrives.
- **Accounting figures are simple.** "Sales minus expenses" isn't profit in the accounting sense, since stock purchases count as expenses when they happen.
