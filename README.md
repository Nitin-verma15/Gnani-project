# Munshi

A voice-first AI assistant for small business owners in India. The owner talks or types in English, Hindi or Hinglish, and the assistant keeps the books: customers, sales, expenses, udhaar, orders and appointments. It answers questions from the real numbers.

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

To go live, create a `.env` file from `.env.example`, add these keys and restart. Each works without the other:

| Key | Powers | Get it from | Without it |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | The assistant (Claude) | [console.anthropic.com](https://console.anthropic.com) | Demo mode |
| `GNANI_API_KEY` | Voice in and out ([Gnani](https://docs.gnani.ai/api/introduction/introduction) Prisma and Timbre) | [app.gnani.ai/voice](https://app.gnani.ai/voice/) | The browser's built-in speech |

The panel on the site says which voice is active. Both keys stay on the server and never reach the browser.

Optional sample data (a made-up kirana store, only added to an empty database):

```bash
npm run seed
```

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

## How it's put together

| Path | What it does |
|---|---|
| [src/agent.js](src/agent.js) | The system prompt and the conversation loop with Claude |
| [src/tools.js](src/tools.js) | Everything the assistant can do: 18 tools over the ledger |
| [src/db.js](src/db.js) | SQLite schema |
| [src/server.js](src/server.js) | HTTP API and streaming replies |
| [src/gnani.js](src/gnani.js) | Gnani Prisma speech-to-text and Timbre text-to-speech |
| [public/audio.js](public/audio.js) | Turns microphone samples into the WAV files Gnani accepts |
| [src/demo.js](src/demo.js) | The stand-in used when there's no API key |
| [public/](public/) | The website, including the live assistant and voice |
| [public/scene.js](public/scene.js) | The 3D ledger, drawn with three.js. Skipped if the device has no WebGL |
| [public/motion.js](public/motion.js) | Draggable cards, tilt and scroll reveals. Respects the reduced-motion setting |
| [public/romanize.js](public/romanize.js) | Shows Hindi-script speech in English letters, so all on-screen text is Roman |

Decisions worth knowing before you change things:

- **Money is whole paise, and balances are never stored.** A customer's udhaar is always calculated from the ledger, so it can't drift out of step.
- **Writes happen straight away, with Undo.** Asking for confirmation on every voice entry would be tiresome, so each entry shows a card with an Undo button and the assistant reads back what it recorded. Nothing is deleted: undo marks rows as voided.
- **The model never does the arithmetic.** Figures come from tools, which also refuse unsafe guesses: an ambiguous name returns the candidates, and a payment from an unknown customer is rejected.
- **Conversation history is append-only**, because replayed thinking blocks are only valid against unchanged history. A new thread starts each day (India time). Longer-term memory comes from the ledger, saved notes and a recent-activity list in the context block.

## Credits

- 3D: [three.js](https://threejs.org), MIT licence, included in `public/vendor`.
- Photos: [Pexels](https://www.pexels.com/license/), loaded from Pexels when the page opens, so they need internet. Each photo's card credits its photographer and links to its page.

## Known limits

This is a first version to run on your own machine, not something to put online yet.

- **No login and a single business.** The server only listens on this computer for that reason. Going online needs accounts, per-business data and HTTPS. Phones also need HTTPS for the microphone.
- **Voice is one clip at a time.** Each spoken message is recorded, then sent to Gnani's REST API (30 seconds at most). Gnani also offers WebSocket streaming, which would show words as they're spoken and feel faster. Recording stops on a fixed loudness threshold, which may need tuning for a noisy shop.
- **Without a Gnani key, voice falls back to the browser's speech features**, which work best in Chrome and Edge.
- **Data leaves this computer.** Messages, plus the business data the assistant looks up, go to the Anthropic API. Voice recordings, reply text and customer names go to Gnani. Check this suits your customers' data and India's DPDP Act before real use.
- **Not built yet:** stock tracking, GST and invoices, sending WhatsApp reminders, taking payments, data export and backups. The assistant is told to say so rather than pretend.
- **Accounting figures are simple.** "Sales minus expenses" isn't profit in the accounting sense, since stock purchases count as expenses when they happen.
