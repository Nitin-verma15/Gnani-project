# Counterbook: the shop counter that listens

**Live:** https://countr-qb4l.onrender.com (open **Try the demo shop**, no sign-up needed)

## The problem
India has millions of small shops: kirana stores, salons, tailors, repair shops. Most still keep accounts in a paper *bahi-khata* or in their head. Credit (*udhaar*) slips get lost, stock runs out without warning, and at the end of the day nobody knows the real profit. Bookkeeping apps exist, but they expect forms, menus and English typing from someone standing at a busy counter.

## Our solution
**Counterbook** is a voice-first AI bookkeeper. The owner simply says what happened, the way they would tell a helper:

> "Ramesh ko 500 ka saaman udhaar diya" · "2 kg sugar becha, paise mil gaye" · "Aaj ka hisaab batao"

Counterbook writes it into the ledger, reads it back, and lets the owner undo it with one tap. It answers questions from the real numbers, never from guesses.

## What it does
- **Udhaar tracking:** every credit sale and repayment, with balances worked out from the ledger, plus polite WhatsApp reminders that include the shop's UPI ID.
- **Stock:** sales take items off the shelf, deliveries add them back, and it warns when stock runs low.
- **Bills with GST:** a printable bill for every sale, with CGST and SGST worked out.
- **Plain answers:** "Is hafte business kaisa raha?" gives sales, spending and dues compared with last week.
- **Safe by design:** it asks which Ramesh if there are two, refuses future dates, and every entry can be undone.
- **Hinglish and English:** for speaking, and for the whole website (one switch).

## Powered by Gnani.ai
- **Gnani Prisma (speech-to-text):** hears mixed Hindi-English counter talk, with shop and customer names passed as key terms for accuracy.
- **Gnani Timbre (text-to-speech):** speaks the answer back, so the owner never has to read a screen.
- **Gemini** understands the request and calls 23 bookkeeping tools; the ledger itself is plain, auditable database rows.

## Built as a real product
Shop registration and sign-in, with separate books for every shop. Hashed passwords, CSV export, full backups and automatic daily backups. Works on phones, and is deployed on Render with an optional Vercel front. 91 automated tests.

## Impact
Counterbook turns a shopkeeper's voice into accurate books in seconds, with no typing and no training. That means less lost udhaar, better stock decisions and a clear daily *hisaab* for the millions of shops that paper and complex apps leave behind.

**Code:** https://github.com/Nitin-verma15/Gnani-project
