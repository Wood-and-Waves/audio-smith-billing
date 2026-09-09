# Accountant reports — Phase 2: the CSV and the printable P&L

**Status:** design agreed 2026-09-09, not built. Phase 1 shipped the same day
(`d515941..f0e76b6`).

## Why

Phase 1 put any date range on `/money/reports` with calendar-quarter shortcuts,
so Dan can read off the figures for his estimated quarterly taxes. **Phase 2 is
the half his accountant actually receives** — Phase 1 is a screen, Phase 2 is a
deliverable.

Two files, from whatever range is selected:

- **A CSV of transactions**, so the CPA can check the categorization rather than
  trust a summary.
- **A printable Profit and Loss**, because Dan's accountant *"likes the style of
  quickbooks printouts."*

## The liability rule carries forward from Phase 1

**The app reports PROFIT. It computes no tax figure and prints no IRS payment
due dates.** Due dates shift for weekends and holidays; a wrong one printed on a
document handed to a CPA would be worse than none.

## Part 1 — the transaction CSV

### Columns

`Date, Payee, Category, Group, Kind, Amount, Split`

- **Amount** stays signed exactly as the ledger stores it — negative is money
  out. The column then sums to the real total and reconciles against the P&L.
  Two columns (debit/credit) were considered and rejected: one signed column is
  what every spreadsheet sums without instruction.
- **Split** is empty for an ordinary row and marks the parts of a split.
- **Every kind is included** — income, expense, owner_pay and transfer. Someone
  checking categorization must be able to see owner draws and transfers, not
  just the two kinds that reach the P&L.

### Splits: one row per part

Dan's decision, and the file's whole purpose forces it. His March split is
$2,912.60 = Owner Investment $2,512.60 + Temporary Transfer $400. It appears as
**two rows**, same date and payee, each with its own category, marked as parts of
one split. A single parent row would show one category for money that went two
places — exactly what the accountant is reading the file to verify.

Rows come from `explodeForReports` (`lib/ledgerSplits.ts`), the same helper every
category-reading consumer uses. A split parent's own line is suppressed in favour
of its legs, so the amount column never double-counts.

### Two hazards this file has that a screen does not

- **Escaping (RFC 4180).** A field containing a comma, a double quote, or a
  newline is wrapped in double quotes, and inner quotes are doubled. Dan's payees
  come from bank imports and contain commas routinely (`WAL-MART #5023 NATIONAL
  CITY CA` is tame; others are not).
- **Formula injection.** A field beginning `=`, `+`, `-` or `@` is executed by
  Excel and Google Sheets when the file is opened. Payees arrive from an external
  system — the bank — so they are untrusted text. Any such field is prefixed with
  a single apostrophe, which spreadsheets strip on display. This costs one line
  and closes a real hole in a file that will be opened on someone else's machine.

A UTF-8 BOM is written at the start so Excel reads accented payees correctly
rather than mangling them.

### Delivery

A server route: `GET /money/reports/export?from=&to=`, returning
`text/csv` with

```
Content-Disposition: attachment; filename="smith-audio-transactions-2026-07-01-to-2026-09-30.csv"
```

The range comes from the URL the user is already on, so the button is a plain
link and needs no client JavaScript. The route resolves its range through
`resolveRange` exactly as the page does, so a malformed URL yields the current
year rather than an error. It is owner-scoped through the normal Supabase client;
an unauthenticated request gets whatever the app's existing auth gives every other
route, never a file.

## Part 2 — the Profit and Loss PDF

### Shape, following QuickBooks

Centred at the top, no logo — QuickBooks P&L printouts do not carry one:

```
              Smith Audio, LLC
              Profit and Loss
        July 1 – September 30, 2026
```

The business name comes from `settings.business_name`, which already exists.

Then accounts down the left, amounts right-aligned:

- **Income** — each income category with its total, then **Total Income**
- **Expenses** — grouped as Dan's categories already are (Bills, Expenses,
  Purchases…), each category listed under its group, then **Total Expenses**
- **Net Income**, with a rule above it

Below the statement, separated by a gap, two memo lines:

- **Owner pay** — draws are equity, not an expense, and `plSummary` already
  excludes them. A real P&L would omit them entirely, but the CPA wants the
  figure, so it sits below the statement rather than inside it.
- **Deductible expenses so far** — likewise a memo, driven by the category flags.

### One new pure function

`lib/ledgerReports.ts` gains `incomeByCategory(txns, categories)`, mirroring the
existing `spendByCategory`. Everything else the document needs — totals, owner
pay, deductible, the expense grouping — already exists.

### Delivery

Generated in the browser on click, reusing the pattern
`components/DownloadInvoiceButton.tsx` established: `@react-pdf/renderer` is
around 2MB and is imported inside the click handler, never at module scope, so it
costs nothing to someone only reading the page.

Filename: `smith-audio-profit-and-loss-2026-07-01-to-2026-09-30.pdf`.

## Testing

Both halves put their logic in pure, tested functions; the PDF component and the
route stay thin.

- **CSV escaping** — a payee containing a comma; one containing a double quote;
  one containing a newline; and the four formula-injection prefixes.
- **CSV rows** — Dan's real March split producing two rows whose amounts sum to
  $2,912.60; all four kinds present; an empty range producing a header row and
  nothing else.
- **`incomeByCategory`** — mirrors `spendByCategory`'s existing cases, including
  an income category with no transactions in range.

Gates per commit: `npm test`, cold `npx tsc --noEmit`, `npm run build`.

## No migration

Phase 2 reads what the ledger already holds. Nothing is stored.

## Deliberately NOT in Phase 2

- **Emailing either file.** Dan can attach them. A send path means recipients,
  a template, and a delivery failure mode, for no gain over the mail client he
  already uses.
- **A balance sheet.** Not asked for, and it needs asset and liability accounts
  the ledger does not model.
- **Phase 3** — the year-end package (mileage, blocked on MileIQ; 1099/W-9 bits).
