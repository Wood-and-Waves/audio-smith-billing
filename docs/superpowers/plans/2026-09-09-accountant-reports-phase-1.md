# Accountant reports, Phase 1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let any date range drive `/money/reports`, with one-click calendar-quarter shortcuts, so Dan can read off the figures his accountant needs for estimated quarterly taxes.

**Architecture:** A new pure module owns quarters and range resolution. `lib/ledgerReports.ts` swaps its two year-shaped functions for range-shaped ones — the other two were already range-agnostic. The page reads `?from=&to=` and every section follows the one range.

**Tech Stack:** Next.js 16 App Router (server components), TypeScript, `node --test`.

**Spec:** `docs/superpowers/specs/2026-09-09-accountant-reports-design.md` — read it first; it carries the liability rule and the two surprises.

## Global Constraints

- **The app reports PROFIT for the period. It does NOT compute a tax figure.** No tax number, no payment due dates. That belongs to the CPA.
- **Reimbursable show costs stay in expenses.** Cash basis: both the cost and the client's reimbursement are real money that moved. This is the OPPOSITE of the forecast's overhead treatment, deliberately.
- **Every total goes through `explodeForReports`** — a split parent's kind must never stand in for its legs'. The page already does this; do not route around it.
- `lib/*.ts` is pure: no `@/` imports, no JSX, relative `.ts` imports (`import { addMonths } from './dates.ts'` is the house idiom — see `lib/budget.ts:22`), and no clock reads (`today` is always a parameter).
- Money is integer cents. Dates are `'YYYY-MM-DD'` strings, compared lexicographically.
- Gates before every commit: `npm test`, cold `rm -f tsconfig.tsbuildinfo .next/cache/.tsbuildinfo && npx tsc --noEmit`, `npm run build`.
- **Never pipe `npm test` into anything** — a pipeline's exit code has masked a real failure in this repo before. Run it bare and read the output.
- **Never run `npm run dev`.**
- **No migration.** Phase 1 only reads what the ledger already holds.
- Do not push; the controller pushes.

---

### Task 1: Quarters and range resolution

**Files:**
- Create: `lib/reportRange.ts`
- Test: `scripts/test/reportRange.test.ts` (create)

**Interfaces:**
- Consumes: `isPlainDate` from `lib/dates.ts`.
- Produces, for Tasks 2 and 3:
  - `export type DateRange = { from: string; to: string }`
  - `export function quarterRange(year: number, q: 1 | 2 | 3 | 4): DateRange`
  - `export function yearRange(year: number): DateRange`
  - `export function resolveRange(from: string | undefined, to: string | undefined, today: string): DateRange`

- [ ] **Step 1: Write the failing tests**

Create `scripts/test/reportRange.test.ts`:

```ts
// Calendar quarters and the Reports screen's range, pinned. Dan needs these
// figures for estimated quarterly taxes, so a wrong quarter boundary is a
// wrong number sent to the IRS.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { quarterRange, yearRange, resolveRange } from '../../lib/reportRange.ts'

test('the four calendar quarters have the boundaries the IRS uses', () => {
  assert.deepEqual(quarterRange(2026, 1), { from: '2026-01-01', to: '2026-03-31' })
  assert.deepEqual(quarterRange(2026, 2), { from: '2026-04-01', to: '2026-06-30' })
  assert.deepEqual(quarterRange(2026, 3), { from: '2026-07-01', to: '2026-09-30' })
  assert.deepEqual(quarterRange(2026, 4), { from: '2026-10-01', to: '2026-12-31' })
})

// No quarter ends in February, so a leap year cannot move any boundary here.
test('a leap year moves no quarter boundary', () => {
  assert.deepEqual(quarterRange(2028, 1), { from: '2028-01-01', to: '2028-03-31' })
})

test('a year range spans January 1 to December 31', () => {
  assert.deepEqual(yearRange(2026), { from: '2026-01-01', to: '2026-12-31' })
})

test('resolveRange passes a good range through untouched', () => {
  assert.deepEqual(
    resolveRange('2026-07-01', '2026-09-30', '2026-09-09'),
    { from: '2026-07-01', to: '2026-09-30' },
  )
})

// The screen has no destructive action, so an unreadable URL must not cost
// Dan the page — every bad input falls back to the current year.
test('resolveRange falls back to the current year on anything unusable', () => {
  const y2026 = { from: '2026-01-01', to: '2026-12-31' }
  assert.deepEqual(resolveRange(undefined, undefined, '2026-09-09'), y2026)
  assert.deepEqual(resolveRange('2026-07-01', undefined, '2026-09-09'), y2026)
  assert.deepEqual(resolveRange(undefined, '2026-09-30', '2026-09-09'), y2026)
  assert.deepEqual(resolveRange('garbage', '2026-09-30', '2026-09-09'), y2026)
  assert.deepEqual(resolveRange('2026-07-01', '2026-13-45', '2026-09-09'), y2026)
})

// A reversed range would silently report zero of everything, which reads as
// "you earned nothing this quarter" rather than as a broken URL.
test('resolveRange refuses a reversed range', () => {
  assert.deepEqual(
    resolveRange('2026-09-30', '2026-07-01', '2026-09-09'),
    { from: '2026-01-01', to: '2026-12-31' },
  )
})

test('a single-day range is legitimate and passes through', () => {
  assert.deepEqual(
    resolveRange('2026-09-09', '2026-09-09', '2026-09-09'),
    { from: '2026-09-09', to: '2026-09-09' },
  )
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `TZ=America/Chicago node --conditions=react-server --test scripts/test/reportRange.test.ts`
Expected: FAIL — cannot find module `lib/reportRange.ts`.

- [ ] **Step 3: Implement**

Create `lib/reportRange.ts`:

```ts
// Calendar quarters and the Reports screen's date range, pure.
//
// Calendar quarters because that is what US estimated federal tax uses, and
// this exists so Dan can hand his accountant a quarter's figures (2026-09-09:
// "It is for estimated quarterly taxes. I need to give information to my
// accountant.").
//
// NO PAYMENT DUE DATES live here, deliberately. They shift for weekends and
// holidays, and a wrong one printed beside a number Dan is about to send would
// be worse than no date at all.
//
// No '@/' imports and no JSX — exercised by node --test, same as lib/dates.ts.

import { isPlainDate } from './dates.ts'

export type DateRange = { from: string; to: string }

// Written out rather than computed from month lengths: no quarter ends in
// February, so a leap year can never move a boundary, and the literal table is
// the thing a reader can check against a tax form at a glance.
const Q_FROM = ['01-01', '04-01', '07-01', '10-01'] as const
const Q_TO = ['03-31', '06-30', '09-30', '12-31'] as const

/** Inclusive on both ends. */
export function quarterRange(year: number, q: 1 | 2 | 3 | 4): DateRange {
  return { from: `${year}-${Q_FROM[q - 1]}`, to: `${year}-${Q_TO[q - 1]}` }
}

/** Inclusive on both ends. */
export function yearRange(year: number): DateRange {
  return { from: `${year}-01-01`, to: `${year}-12-31` }
}

/**
 * The range the Reports page should show, from its URL parameters.
 *
 * Every unusable input falls back to the current calendar year rather than
 * erroring: this screen has no destructive action, and an unreadable URL
 * should not cost Dan the page. A REVERSED range is refused for a sharper
 * reason — it would report zero of everything, which reads as "you earned
 * nothing this quarter" instead of as a broken link.
 */
export function resolveRange(
  from: string | undefined, to: string | undefined, today: string,
): DateRange {
  const fallback = yearRange(Number(today.slice(0, 4)))
  if (!from || !to) return fallback
  if (!isPlainDate(from) || !isPlainDate(to)) return fallback
  if (to < from) return fallback
  return { from, to }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `TZ=America/Chicago node --conditions=react-server --test scripts/test/reportRange.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Gates and commit**

```bash
npm test
rm -f tsconfig.tsbuildinfo .next/cache/.tsbuildinfo && npx tsc --noEmit
npm run build
git add lib/reportRange.ts scripts/test/reportRange.test.ts
git commit -m "reports: calendar quarters and range resolution"
```

---

### Task 2: Range-shaped report arithmetic

**Files:**
- Modify: `lib/ledgerReports.ts` (replace `filterYear`; change `monthlyTotals`'s signature)
- Modify: `scripts/test/ledgerReports.test.ts`
- Modify: `app/money/reports/page.tsx:258` and `:261` (call sites only — the screen must look identical after this task)

**Interfaces:**
- Consumes: `yearRange` from `lib/reportRange.ts` (Task 1).
- Produces, for Task 3:
  - `export function filterRange<T extends { date: string }>(txns: T[], from: string, to: string): T[]`
  - `export function monthlyTotals(txns: ReportTxn[], from: string, to: string): MonthTotals[]`

`filterYear` is REMOVED, not kept alongside. There is exactly one caller, and two sets of nearly identical money arithmetic is how the two drift apart.

- [ ] **Step 1: Write the failing tests**

In `scripts/test/ledgerReports.test.ts`, change the import line to:

```ts
import {
  filterRange, plSummary, spendByCategory, monthlyTotals,
  type ReportTxn, type ReportCategory,
} from '../../lib/ledgerReports.ts'
```

Replace the three existing `filterYear(SAMPLE, 2026)` calls (lines 29, 37, 43) with `filterRange(SAMPLE, '2026-01-01', '2026-12-31')`, and the `monthlyTotals(SAMPLE, 2026)` call (line 51) with `monthlyTotals(SAMPLE, '2026-01-01', '2026-12-31')`. Leave every assertion in those tests exactly as it is — the same range must produce the same numbers.

Replace the test named `'filterYear is a plain prefix match on the date'` (line 58) with:

```ts
test('filterRange is inclusive at BOTH ends', () => {
  const rows: ReportTxn[] = [
    T({ date: '2026-06-30' }), T({ date: '2026-07-01' }),
    T({ date: '2026-09-30' }), T({ date: '2026-10-01' }),
  ]
  const q3 = filterRange(rows, '2026-07-01', '2026-09-30')
  assert.deepEqual(q3.map((r) => r.date), ['2026-07-01', '2026-09-30'])
})

test('filterRange spans a year boundary', () => {
  const rows: ReportTxn[] = [
    T({ date: '2025-11-15' }), T({ date: '2025-12-31' }),
    T({ date: '2026-01-01' }), T({ date: '2026-02-14' }),
  ]
  assert.equal(filterRange(rows, '2025-12-01', '2026-01-31').length, 2)
})

test('filterRange returns nothing for a range with no rows in it', () => {
  assert.deepEqual(filterRange(SAMPLE, '2024-01-01', '2024-12-31'), [])
})
```

And add these `monthlyTotals` cases:

```ts
test('monthlyTotals emits one row per month the range touches — three for a quarter', () => {
  const months = monthlyTotals(SAMPLE, '2026-04-01', '2026-06-30')
  assert.deepEqual(months.map((m) => m.month), ['2026-04', '2026-05', '2026-06'])
})

test('monthlyTotals emits a single row when the range sits inside one month', () => {
  const months = monthlyTotals(SAMPLE, '2026-05-01', '2026-05-31')
  assert.deepEqual(months.map((m) => m.month), ['2026-05'])
  assert.equal(months[0].incomeCents, 60000)
})

test('monthlyTotals crosses a year boundary in order', () => {
  const months = monthlyTotals(SAMPLE, '2025-12-01', '2026-02-28')
  assert.deepEqual(months.map((m) => m.month), ['2025-12', '2026-01', '2026-02'])
  assert.equal(months[0].expenseCents, 9999) // the 2025-12-30 row in SAMPLE
})

// A row inside the range's months but outside its DAYS must not be counted:
// the range is days, and the month rows are only how it is displayed.
test('monthlyTotals respects the day boundaries, not just the months', () => {
  const rows: ReportTxn[] = [
    T({ kind: 'income', amount_cents: 10000, category_id: 'inc', date: '2026-05-01' }),
    T({ kind: 'income', amount_cents: 50000, category_id: 'inc', date: '2026-05-20' }),
  ]
  const months = monthlyTotals(rows, '2026-05-10', '2026-05-31')
  assert.equal(months.length, 1)
  assert.equal(months[0].incomeCents, 50000)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `TZ=America/Chicago node --conditions=react-server --test scripts/test/ledgerReports.test.ts`
Expected: FAIL — `filterRange` is not exported, and `monthlyTotals` still takes a year.

- [ ] **Step 3: Implement**

In `lib/ledgerReports.ts`, add the file's first import at the top:

```ts
import { addMonths } from './dates.ts'
```

Replace `filterYear` with:

```ts
/**
 * Every row inside an inclusive date range. Dates are 'YYYY-MM-DD', which
 * sorts lexicographically — that is why the whole app stores them that way,
 * and why this needs no date parsing.
 *
 * Replaced filterYear on 2026-09-09: the Reports screen stopped being a
 * calendar-year screen when Dan needed quarters for his accountant.
 */
export function filterRange<T extends { date: string }>(
  txns: T[], from: string, to: string,
): T[] {
  return txns.filter((t) => t.date >= from && t.date <= to)
}
```

Replace `monthlyTotals`'s body and signature with:

```ts
/**
 * One row per month the range touches, in order — three for a quarter, twelve
 * for a year, one for a range inside a single month.
 *
 * Rows are bucketed by month for display, but membership is decided by the
 * range's DAYS: a transaction in the right month but outside the range is not
 * counted. A quarter that started mid-month would otherwise quietly include
 * the days before it.
 */
export function monthlyTotals(txns: ReportTxn[], from: string, to: string): MonthTotals[] {
  const out: MonthTotals[] = []
  const lastMonth = to.slice(0, 7)
  for (let m = from.slice(0, 7); m <= lastMonth; m = addMonths(m, 1)) {
    out.push({ month: m, incomeCents: 0, expenseCents: 0 })
  }
  const indexOf = new Map(out.map((row, i) => [row.month, i]))
  for (const t of txns) {
    if (t.date < from || t.date > to) continue
    const i = indexOf.get(t.date.slice(0, 7))
    if (i === undefined) continue
    if (t.kind === 'income') out[i].incomeCents += t.amount_cents
    else if (t.kind === 'expense') out[i].expenseCents += -t.amount_cents
  }
  return out
}
```

- [ ] **Step 4: Keep the page compiling and looking identical**

In `app/money/reports/page.tsx`, add to the imports:

```ts
import { yearRange } from '@/lib/reportRange'
```

change the `lib/ledgerReports` import to name `filterRange` instead of `filterYear`, and replace the two call sites (currently lines 258 and 261):

```ts
  const { from, to } = yearRange(year)
  const yearTxns = filterRange(allTxns, from, to)
```

```ts
  const months = monthlyTotals(allTxns, from, to)
```

Declare `const { from, to } = yearRange(year)` once, above both. **This task changes no behaviour on screen** — the page still shows a calendar year chosen by the `?year=` arrows. Task 3 replaces the control.

- [ ] **Step 5: Run the tests and gates**

```bash
TZ=America/Chicago node --conditions=react-server --test scripts/test/ledgerReports.test.ts
npm test
rm -f tsconfig.tsbuildinfo .next/cache/.tsbuildinfo && npx tsc --noEmit
npm run build
```
Expected: all pass; `grep -rn "filterYear" lib app scripts` returns nothing.

- [ ] **Step 6: Commit**

```bash
git add lib/ledgerReports.ts scripts/test/ledgerReports.test.ts app/money/reports/page.tsx
git commit -m "reports: range-shaped arithmetic, replacing the year-shaped pair"
```

---

### Task 3: The range picker drives the page

**Files:**
- Modify: `app/money/reports/page.tsx`
- Modify: `CLAUDE.md`, `docs/BACKLOG.md`

**Interfaces:**
- Consumes: `resolveRange`, `quarterRange`, `yearRange` from `lib/reportRange.ts`; `filterRange` and `monthlyTotals` from `lib/ledgerReports.ts`.
- Produces: nothing later tasks import.

- [ ] **Step 1: Read the range from the URL**

Change the page's `searchParams` type and the year derivation. Replace:

```ts
  searchParams: Promise<{ year?: string }>
```

with:

```ts
  searchParams: Promise<{ from?: string; to?: string }>
```

and replace the `currentYear` / `parsedYear` / `year` block (currently lines 143-145) with:

```ts
  const today = todayInChicago()
  const { from, to } = resolveRange(params.from, params.to, today)
  // The year the shortcut buttons offer: the one the current range starts in,
  // so stepping from Q4 2026 to Q1 2026 is one click rather than a year hunt.
  const shortcutYear = Number(from.slice(0, 4))
```

Delete the now-unused `const { from, to } = yearRange(year)` line Task 2 added, and keep `filterRange(allTxns, from, to)` and `monthlyTotals(allTxns, from, to)` as they are — they already take the range.

Add to the imports:

```ts
import { resolveRange, quarterRange, yearRange } from '@/lib/reportRange'
import { formatDateShort } from '@/lib/dates'
```

(`formatDateShort` is already exported from `lib/dates.ts`; the page currently imports only `todayInChicago` from it.)

- [ ] **Step 2: Replace the year arrows with the picker**

Replace the whole `<div className="flex items-center gap-4">…</div>` block inside the header (the `‹ {year} ›` links, currently lines 273-291) with:

```tsx
        {/* A plain GET form: this is a server component and the range lives in
            the URL, so no client JavaScript is needed to change it. */}
        <form method="get" action="/money/reports" className="flex flex-wrap items-end gap-3">
          <label className="text-xs text-muted">
            <span className="eyebrow block mb-1">From</span>
            <input type="date" name="from" defaultValue={from} className={FIELD} />
          </label>
          <label className="text-xs text-muted">
            <span className="eyebrow block mb-1">To</span>
            <input type="date" name="to" defaultValue={to} className={FIELD} />
          </label>
          <button
            type="submit"
            className="rounded-field border border-line px-3 py-2 text-xs font-semibold
                       uppercase tracking-wider hover:text-accent transition-colors"
          >
            Show
          </button>
        </form>
```

and directly beneath the header, add the shortcut row:

```tsx
      <nav aria-label="Report period" className="-ml-3 mb-10 flex flex-wrap gap-2">
        {([1, 2, 3, 4] as const).map((q) => {
          const r = quarterRange(shortcutYear, q)
          const active = r.from === from && r.to === to
          return (
            <Link
              key={q}
              href={`/money/reports?from=${r.from}&to=${r.to}`}
              aria-current={active ? 'true' : undefined}
              className={`rounded-pill px-3 py-1.5 text-xs font-semibold uppercase tracking-wider
                          transition-colors ${
                            active ? 'bg-accent-wash text-accent' : 'text-muted hover:text-ink'
                          }`}
            >
              Q{q} {shortcutYear}
            </Link>
          )
        })}
        {(() => {
          const r = yearRange(shortcutYear)
          const active = r.from === from && r.to === to
          return (
            <Link
              href={`/money/reports?from=${r.from}&to=${r.to}`}
              aria-current={active ? 'true' : undefined}
              className={`rounded-pill px-3 py-1.5 text-xs font-semibold uppercase tracking-wider
                          transition-colors ${
                            active ? 'bg-accent-wash text-accent' : 'text-muted hover:text-ink'
                          }`}
            >
              All {shortcutYear}
            </Link>
          )
        })()}
      </nav>
```

`FIELD` comes from `@/components/ui/field` — add it to the imports if the page does not already have it. The `-ml-3` on the chip row is the repo's standing rule for chip navs: `px-3` on the first chip otherwise sets its text 12px inside the page's left edge (see CLAUDE.md).

- [ ] **Step 3: Make the totals heading name the range**

Replace the totals heading (currently `{year === currentYear ? 'This year' : \`${year} totals\`}`) with:

```tsx
        <h2 className="eyebrow mb-4">{formatDateShort(from)} – {formatDateShort(to)}</h2>
```

- [ ] **Step 4: Gates**

```bash
npm test
rm -f tsconfig.tsbuildinfo .next/cache/.tsbuildinfo && npx tsc --noEmit
npm run build
```

Expected: all pass. Also run `grep -n "year" app/money/reports/page.tsx` and confirm no reference to the deleted `year`/`currentYear`/`parsedYear` variables survives.

- [ ] **Step 5: Record it**

In `CLAUDE.md`'s current-state section, add one line: `/money/reports` takes any date range via `?from=&to=` with calendar-quarter shortcuts; `lib/reportRange.ts` owns quarters and range resolution; **the app reports profit and never computes a tax figure**, and carries no IRS payment due dates because they shift for weekends and holidays.

In `docs/BACKLOG.md`, under the existing `## Gross earnings by month and by quarter — predicted and actual (2026-09-09, Dan)` heading, add a note that Phase 1 shipped, pointing at `docs/superpowers/specs/2026-09-09-accountant-reports-design.md`, and that **Phase 2 (a CSV of transactions for the range, and a printable P&L) and Phase 3 (the year-end package) remain** — Phase 2 being the half that makes this a deliverable rather than a screen.

- [ ] **Step 6: Commit**

```bash
git add app/money/reports/page.tsx CLAUDE.md docs/BACKLOG.md
git commit -m "reports: any date range, with calendar-quarter shortcuts"
```

---

## Verification once all three land

- `/money/reports` opens on the current calendar year, exactly as it does today.
- Clicking **Q3 2026** shows July 1 – September 30 in the totals heading, three rows under By month, and Spend by category scoped to those three months.
- A hand-typed range crossing a year boundary (e.g. 2025-12-01 to 2026-02-28) shows three month rows in order.
- A reversed or garbled range falls back to the current year rather than erroring or showing zeroes.

## Deliberately NOT in this plan

- **Any export** — CSV or print. That is Phase 2, and it is what turns this from a screen into something Dan hands over.
- **Any tax figure, and any payment due date.** See the Global Constraints.
- **A new Money tab.** The range drives the existing Reports page.
