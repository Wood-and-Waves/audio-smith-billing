# Accountant reports — Phase 1: date ranges and the quarterly figure

**Status:** design agreed 2026-09-09, not built.

## Why

Dan: *"It is for estimated quarterly taxes. I need to give information to my
accountant."* Asked what his CPA actually wants, he named all four of: a number
to pay each quarter, a P&L for the period, a transaction spreadsheet, and a
year-end package.

That is a subsystem, not a feature, so it is phased. **This spec covers Phase 1
only.**

- **Phase 1 (this spec)** — any date range drives the Reports page, with quarter
  shortcuts. Answers "what do I send in for Q3" and gives a P&L for any period.
- **Phase 2** — getting it out: a CSV of transactions for the range, and a
  printable P&L.
- **Phase 3** — the year-end package: full-year P&L, owner draws, deductible
  totals, mileage (blocked on MileIQ), any 1099/W-9 bits.

## The one rule that is about liability, not code

**The app reports PROFIT for the period. It does not compute a tax figure.**

The forecast's 15% set-aside is a planning estimate Dan configured, and it is
fine there. A document handed to an accountant is different: it states income,
expenses and net, and the tax calculation belongs to the CPA. Agreed with Dan
explicitly. If a set-aside figure ever appears on this screen it is labelled as
his own configured estimate and never as an amount due.

## What already exists

`/money/reports` renders three sections from `lib/ledgerReports.ts`, scoped to a
calendar year chosen by `?year=` arrows:

- **Totals** — `plSummary(txns, categories)`: income, expenses, net, owner pay
  (excluded from expenses), deductible expenses.
- **Spend by category** — `spendByCategory(txns, categories)`.
- **By month** — `monthlyTotals(txns, year)`: always twelve rows.

There is **no export of any kind** today. Nothing leaves the screen.

**Two of the three are already range-agnostic.** `plSummary` and
`spendByCategory` take whatever transactions they are given. Only `filterYear`
and `monthlyTotals` know about calendar years — which is why Phase 1 is a small
change to the arithmetic and a larger one to the UI.

## Phase 1 design

### The arithmetic (`lib/ledgerReports.ts`)

Two changes, both additive in spirit:

```ts
/** Inclusive on both ends; `from` and `to` are 'YYYY-MM-DD'. */
export function filterRange<T extends { date: string }>(
  txns: T[], from: string, to: string,
): T[]

/** The months the range touches, in order — three for a quarter, twelve for a
 *  year, one for a range inside a single month. */
export function monthlyTotals(txns: ReportTxn[], from: string, to: string): MonthTotals[]
```

`filterYear` is REPLACED by `filterRange`, and `monthlyTotals` changes signature
rather than gaining a sibling. **Deliberately not** keeping year-shaped versions
alongside range-shaped ones: two sets of nearly identical money arithmetic is
how the two drift apart, and there is exactly one caller.

String comparison is the whole implementation — `'YYYY-MM-DD'` sorts
lexicographically, which is why every date in this app is stored that way.

### Quarters (`lib/dates.ts` or a small pure helper)

Calendar quarters, because that is what estimated federal tax uses:

```
Q1  Jan 1 – Mar 31    Q2  Apr 1 – Jun 30
Q3  Jul 1 – Sep 30    Q4  Oct 1 – Dec 31
```

A pure `quarterRange(year, q)` returning `{ from, to }`, and `quarterOf(date)`
for labelling. No payment due dates in the app: they are IRS deadlines that
shift for weekends and holidays, and a wrong one printed next to a number Dan
is about to send would be worse than no date at all.

### The picker

Replaces the `?year=` arrows on `/money/reports`. Carries the range in the URL
as `?from=YYYY-MM-DD&to=YYYY-MM-DD`, the same idiom `/money/budget` already uses
for `?m=` and `?f=`, so a range survives a refresh and can be bookmarked.

- Two date inputs, start and end.
- One-click shortcuts: **Q1 Q2 Q3 Q4** for the year in view, and **whole year**.
- **Default on landing is the current calendar year**, so nothing changes for
  Dan until he reaches for a shortcut.
- An absent, malformed, or reversed range (`to < from`) falls back to the
  current year rather than rendering an error — this screen has no destructive
  action and an unreadable URL should not cost him the page.

Every section then follows the one range: totals, spend by category, and By
month, which becomes three rows for a quarter instead of twelve.

### Two things that would otherwise surprise him

- **Reimbursable show costs stay in expenses.** On cash basis both the cost and
  the client's reimbursement are real money that moved; dropping one side would
  overstate profit. This is the opposite of the forecast's overhead treatment,
  where reimbursable costs are excluded precisely because the forecast's income
  does not include reimbursements. Same money, different question.
- **Every total goes through `explodeForReports`**, so a split parent's kind
  cannot stand in for its legs'. The page already does this; the range work must
  not route around it. This exact defect was caught in review on the forecast
  earlier the same day.

## Testing

`lib/ledgerReports.ts` is pure and already covered. New cases:

- `filterRange` — a quarter; a range crossing a year boundary; a single day
  (from === to); an empty range with no matching rows; boundary inclusion, i.e.
  a transaction dated exactly on `from` and one exactly on `to` are BOTH in.
- `monthlyTotals` — three rows for a quarter; twelve for a year; one for a range
  inside a single month; a range crossing a year boundary emits months in order
  across it.
- `quarterRange` — all four quarters, including Q1 starting Jan 1 and Q4 ending
  Dec 31.

Gates per commit: `npm test`, cold `npx tsc --noEmit`, `npm run build`.

## Deliberately NOT in Phase 1

- Any export — CSV or print. That is Phase 2, and it is the half that makes this
  a deliverable rather than a screen.
- Any tax figure. See the liability rule above.
- Payment due dates.
- Accrual basis. Dan is cash basis, confirmed 2026-08-25.
- A new Money tab. The range drives the existing Reports page; an eighth tab
  duplicating this arithmetic was considered and rejected.

## No migration

Phase 1 reads what the ledger already holds. Nothing is stored.
