# Accountant reports, Phase 2 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce the two files Dan's accountant actually receives — a transaction CSV and a QuickBooks-style Profit and Loss PDF — for whatever range is selected on `/money/reports`.

**Architecture:** Both outputs put their logic in pure, tested `lib/` modules; the route and the button stay thin. The PDF follows the established `lib/invoicePdf.ts` pattern — built with `createElement`, PDF primitives injected by the caller, so it imports no PDF library and is testable under `node --test`.

**Tech Stack:** Next.js 16 App Router, TypeScript, `@react-pdf/renderer` (lazily imported, already a dependency), `node --test`.

**Spec:** `docs/superpowers/specs/2026-09-09-accountant-reports-phase-2-design.md` — read it first.

## Global Constraints

- **The app reports PROFIT. It computes no tax figure and prints no IRS payment due dates.** Due dates shift for weekends and holidays; a wrong one on a document handed to a CPA is worse than none.
- **Every kind-shaped read of ledger rows goes through `explodeForReports`** (`lib/ledgerSplits.ts`). A split parent keeps its own `kind` while its legs may differ. Never re-derive the explosion rule.
- `lib/*.ts` is PURE: no `@/` imports, no JSX, relative `.ts` imports, no clock reads. **A PDF builder in `lib/` must use `createElement`, never JSX** — Node strips types but does not transform JSX, so a `.tsx` could not be imported by `node --test`.
- Money is integer cents. Dates are `'YYYY-MM-DD'`, compared lexicographically.
- Fail direction: destructure `error` and return BEFORE presence tests.
- Gates before every commit: `npm test`, cold `rm -f tsconfig.tsbuildinfo .next/cache/.tsbuildinfo && npx tsc --noEmit`, `npm run build`.
- **Never pipe `npm test` into anything** — a pipeline's exit code has masked a real failure in this repo before.
- **Never run `npm run dev`.**
- **No migration.** Phase 2 only reads.
- Do not push; the controller pushes.

---

### Task 1: Income by category

**Files:**
- Modify: `lib/ledgerReports.ts`
- Test: `scripts/test/ledgerReports.test.ts`

**Interfaces:**
- Produces, for Task 5: `export function incomeByCategory(txns: ReportTxn[], categories: ReportCategory[]): { rows: CategoryIncome[]; uncategorizedCents: number }` where `export type CategoryIncome = { category: ReportCategory; earnedCents: number }`.

The P&L needs income listed per account. `spendByCategory` already does this for expenses; this mirrors it exactly.

- [ ] **Step 1: Write the failing tests**

Add to `scripts/test/ledgerReports.test.ts`, and add `incomeByCategory` to the existing import from `'../../lib/ledgerReports.ts'`:

```ts
test('incomeByCategory totals income per category, skipping every other kind', () => {
  const rows: ReportTxn[] = [
    { date: '2026-05-01', amount_cents: 60000, kind: 'income', category_id: 'inc' },
    { date: '2026-05-02', amount_cents: 40000, kind: 'income', category_id: 'inc' },
    { date: '2026-05-03', amount_cents: -1000, kind: 'expense', category_id: 'meals' },
    { date: '2026-05-04', amount_cents: -200000, kind: 'owner_pay', category_id: null },
  ]
  const { rows: out, uncategorizedCents } = incomeByCategory(rows, CATS)
  assert.equal(out.length, 1)
  assert.equal(out[0].category.id, 'inc')
  assert.equal(out[0].earnedCents, 100000)
  assert.equal(uncategorizedCents, 0)
})

test('incomeByCategory collects uncategorized income separately', () => {
  const rows: ReportTxn[] = [
    { date: '2026-05-01', amount_cents: 25000, kind: 'income', category_id: null },
  ]
  const { rows: out, uncategorizedCents } = incomeByCategory(rows, CATS)
  assert.deepEqual(out, [])
  assert.equal(uncategorizedCents, 25000)
})

test('incomeByCategory omits categories with no income in range', () => {
  const { rows: out } = incomeByCategory([], CATS)
  assert.deepEqual(out, [])
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `TZ=America/Chicago node --conditions=react-server --test scripts/test/ledgerReports.test.ts`
Expected: FAIL — `incomeByCategory` is not exported.

- [ ] **Step 3: Implement**

In `lib/ledgerReports.ts`, directly beneath `spendByCategory`:

```ts
export type CategoryIncome = { category: ReportCategory; earnedCents: number }

/**
 * spendByCategory's mirror for the income half of a P&L. Income amounts are
 * stored POSITIVE, so unlike spendByCategory there is no sign flip here — the
 * asymmetry is in the ledger, not in this pair of functions.
 */
export function incomeByCategory(
  txns: ReportTxn[], categories: ReportCategory[],
): { rows: CategoryIncome[]; uncategorizedCents: number } {
  const earned = new Map<string, number>()
  let uncategorizedCents = 0
  for (const t of txns) {
    if (t.kind !== 'income') continue
    if (t.category_id === null) { uncategorizedCents += t.amount_cents; continue }
    earned.set(t.category_id, (earned.get(t.category_id) ?? 0) + t.amount_cents)
  }
  const rows = categories
    .filter((c) => (earned.get(c.id) ?? 0) !== 0)
    .sort((a, b) => a.grp.localeCompare(b.grp) || a.sort - b.sort)
    .map((category) => ({ category, earnedCents: earned.get(category.id) as number }))
  return { rows, uncategorizedCents }
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `TZ=America/Chicago node --conditions=react-server --test scripts/test/ledgerReports.test.ts`
Expected: PASS.

- [ ] **Step 5: Gates and commit**

```bash
npm test
rm -f tsconfig.tsbuildinfo .next/cache/.tsbuildinfo && npx tsc --noEmit
npm run build
git add lib/ledgerReports.ts scripts/test/ledgerReports.test.ts
git commit -m "reports: incomeByCategory, spendByCategory's mirror"
```

---

### Task 2: Carry payee and a split marker through the explosion

**Files:**
- Modify: `lib/ledgerSplits.ts` (the `ReportLine` and `ReportTxnForExplode` types, and `explodeForReports`)
- Modify: `scripts/test/ledgerSplits.test.ts` (two `deepEqual` assertions)
- Modify: `app/money/reports/page.tsx` (add `payee` to the transaction select and to the objects handed to `explodeForReports`)

**Interfaces:**
- Produces, for Tasks 3 and 4: `ReportLine` gains `payee: string` and `isSplitLeg: boolean`; `ReportTxnForExplode` gains `payee?: string`.

**Why this task exists:** the CSV needs a payee column, and `explodeForReports` currently drops the parent entirely — a leg has no way back to the payee. The alternative, exploding again inside the CSV code, would duplicate the split rule that the repo forbids duplicating.

**Why `payee` is OPTIONAL on the input:** `app/money/forecast/page.tsx` also calls `explodeForReports`, and its transaction query selects no payee. Making it required would break that page.

- [ ] **Step 1: Write the failing test**

Add to `scripts/test/ledgerSplits.test.ts`:

```ts
test('explodeForReports carries the parent payee onto every leg and marks them', () => {
  // Dan's real March split: $2,912.60 = Owner Investment 2,512.60 + Temporary
  // Transfer 400. A leg with no way back to the payee is a CSV row an
  // accountant cannot identify.
  const txns = [{
    date: '2026-03-05', amountCents: -291260, kind: 'owner_pay',
    categoryId: null, payee: 'Transfer to owner',
    legs: [
      { categoryId: 'owner', amountCents: -251260, kind: 'owner_pay' },
      { categoryId: 'temp', amountCents: -40000, kind: 'expense' },
    ],
  }]
  assert.deepEqual(explodeForReports(txns), [
    { date: '2026-03-05', categoryId: 'owner', amountCents: -251260, kind: 'owner_pay', payee: 'Transfer to owner', isSplitLeg: true },
    { date: '2026-03-05', categoryId: 'temp', amountCents: -40000, kind: 'expense', payee: 'Transfer to owner', isSplitLeg: true },
  ])
})

test('explodeForReports gives an unsplit row isSplitLeg false and an empty payee when none was supplied', () => {
  const txns = [{ date: '2026-05-01', amountCents: -1000, kind: 'expense', categoryId: 'meals' }]
  assert.deepEqual(explodeForReports(txns), [
    { date: '2026-05-01', categoryId: 'meals', amountCents: -1000, kind: 'expense', payee: '', isSplitLeg: false },
  ])
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `TZ=America/Chicago node --conditions=react-server --test scripts/test/ledgerSplits.test.ts`
Expected: FAIL — the returned objects lack `payee` and `isSplitLeg`.

- [ ] **Step 3: Extend the types and the function**

In `lib/ledgerSplits.ts`:

```ts
export type ReportLine = {
  date: string
  amountCents: number
  kind: string
  categoryId: string | null
  /** The parent transaction's payee. Empty when the caller supplied none —
   *  the forecast page reads no payee and does not need one. */
  payee: string
  /** True for a line that came from a split leg. The CSV marks these so a
   *  reader can see why two rows share a date and payee. */
  isSplitLeg: boolean
}
```

```ts
export type ReportTxnForExplode = {
  date: string
  amountCents: number
  kind: string
  categoryId: string | null
  payee?: string
  legs?: { categoryId: string | null; amountCents: number; kind: string }[]
}
```

and in `explodeForReports`, replace the two `lines.push(...)` calls with:

```ts
        lines.push({
          date: txn.date, categoryId: leg.categoryId, amountCents: leg.amountCents,
          kind: leg.kind, payee: txn.payee ?? '', isSplitLeg: true,
        })
```

```ts
    lines.push({
      date: txn.date, categoryId: txn.categoryId, amountCents: txn.amountCents,
      kind: txn.kind, payee: txn.payee ?? '', isSplitLeg: false,
    })
```

- [ ] **Step 4: Update the two pre-existing `deepEqual` assertions**

`scripts/test/ledgerSplits.test.ts` has two `assert.deepEqual(explodeForReports(txns), [...])` calls (around lines 323 and 337). Each expected object now needs two more keys. Add `payee: ''` and `isSplitLeg: true` to every expected object that came from a leg, and `payee: ''` and `isSplitLeg: false` to every expected object that came from an unsplit row. **Change nothing else about those tests** — the dates, categories, amounts and kinds must stay exactly as they are.

- [ ] **Step 5: Give the reports page a payee to pass**

In `app/money/reports/page.tsx`, add `payee` to the transaction select (currently `.select('id, date, amount_cents, kind, category_id')` at line 53) so it reads:

```ts
      .select('id, date, amount_cents, kind, category_id, payee')
```

and include it where the page builds the objects it hands to `explodeForReports`:

```ts
        payee: t.payee ?? '',
```

Add `payee: string | null` to whatever local row type that select feeds.

- [ ] **Step 6: Run the tests and gates**

```bash
TZ=America/Chicago node --conditions=react-server --test scripts/test/ledgerSplits.test.ts
npm test
rm -f tsconfig.tsbuildinfo .next/cache/.tsbuildinfo && npx tsc --noEmit
npm run build
```

Expected: all pass. The Reports screen renders exactly as before — this task adds a field, it changes no figure.

- [ ] **Step 7: Commit**

```bash
git add lib/ledgerSplits.ts scripts/test/ledgerSplits.test.ts app/money/reports/page.tsx
git commit -m "splits: carry payee and a split marker onto every report line"
```

---

### Task 3: The CSV, as a pure module

**Files:**
- Create: `lib/reportCsv.ts`
- Test: `scripts/test/reportCsv.test.ts` (create)

**Interfaces:**
- Consumes: `ReportLine` from `lib/ledgerSplits.ts` (Task 2), `ReportCategory` from `lib/ledgerReports.ts`.
- Produces, for Task 4: `export function transactionsCsv(lines: ReportLine[], categories: ReportCategory[]): string` and `export function csvFilename(from: string, to: string): string`.

- [ ] **Step 1: Write the failing tests**

Create `scripts/test/reportCsv.test.ts`:

```ts
// The transaction export, pinned. This file is opened on someone else's
// machine — Dan's accountant's — so its escaping and its formula guard are
// correctness, not polish.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { transactionsCsv, csvFilename } from '../../lib/reportCsv.ts'
import type { ReportCategory } from '../../lib/ledgerReports.ts'
import type { ReportLine } from '../../lib/ledgerSplits.ts'

const CATS: ReportCategory[] = [
  { id: 'owner', name: 'Owner Investment, Pay, and Personal Expenses', grp: 'Owner Transactions', sort: 0, deductible: false },
  { id: 'temp', name: 'Temporary Transfer', grp: 'Owner Transactions', sort: 1, deductible: false },
  { id: 'meals', name: 'Meals and Entertainment', grp: 'Expenses', sort: 0, deductible: true },
]

const L = (over: Partial<ReportLine> = {}): ReportLine => ({
  date: '2026-05-01', amountCents: -1000, kind: 'expense',
  categoryId: 'meals', payee: 'Uber Eats', isSplitLeg: false, ...over,
})

const lines = (csv: string) => csv.replace(/^﻿/, '').trim().split('\n')

test('the header row names every column, in order', () => {
  assert.equal(lines(transactionsCsv([], CATS))[0], 'Date,Payee,Category,Group,Kind,Amount,Split')
})

test('an empty range produces a header and nothing else', () => {
  assert.equal(lines(transactionsCsv([], CATS)).length, 1)
})

test('a row carries its category name and group, and its amount in dollars', () => {
  assert.equal(lines(transactionsCsv([L()], CATS))[1],
    '2026-05-01,Uber Eats,Meals and Entertainment,Expenses,expense,-10.00,')
})

test('an uncategorized row says so rather than leaving a blank a reader must interpret', () => {
  assert.equal(lines(transactionsCsv([L({ categoryId: null })], CATS))[1],
    '2026-05-01,Uber Eats,(uncategorized),,expense,-10.00,')
})

// Dan's real March split. Two rows, same date and payee, each with its own
// category, and the amounts sum to the parent's 2,912.60.
test('a split becomes one row per leg, marked, and the amounts still sum', () => {
  const out = lines(transactionsCsv([
    L({ date: '2026-03-05', payee: 'Transfer to owner', categoryId: 'owner', amountCents: -251260, kind: 'owner_pay', isSplitLeg: true }),
    L({ date: '2026-03-05', payee: 'Transfer to owner', categoryId: 'temp', amountCents: -40000, kind: 'expense', isSplitLeg: true }),
  ], CATS))
  assert.equal(out[1], '2026-03-05,Transfer to owner,"Owner Investment, Pay, and Personal Expenses",Owner Transactions,owner_pay,-2512.60,split')
  assert.equal(out[2], '2026-03-05,Transfer to owner,Temporary Transfer,Owner Transactions,expense,-400.00,split')
})

// RFC 4180. Dan's payees come from bank exports and contain commas routinely.
test('a field with a comma is quoted', () => {
  assert.match(transactionsCsv([L({ payee: 'WAL-MART, NATIONAL CITY' })], CATS), /"WAL-MART, NATIONAL CITY"/)
})

test('a field with a double quote is quoted and its quotes doubled', () => {
  assert.match(transactionsCsv([L({ payee: 'THE "BEST" DINER' })], CATS), /"THE ""BEST"" DINER"/)
})

test('a field with a newline is quoted', () => {
  assert.match(transactionsCsv([L({ payee: 'LINE ONE\nLINE TWO' })], CATS), /"LINE ONE\nLINE TWO"/)
})

// Excel and Google Sheets EXECUTE a field starting =, +, - or @. Payees come
// from the bank, so they are untrusted text in a file opened elsewhere.
test('a field that a spreadsheet would execute is neutralised', () => {
  for (const bad of ['=SUM(A1:A9)', '+1+1', '-1+1', '@SUM(A1)']) {
    const row = lines(transactionsCsv([L({ payee: bad })], CATS))[1]
    assert.ok(row.includes(`'${bad}`), `expected an apostrophe prefix for ${bad}, got: ${row}`)
  }
})

// A negative amount must NOT be mistaken for a formula — it is the common case.
test('a negative amount is not treated as a formula', () => {
  assert.equal(lines(transactionsCsv([L({ amountCents: -1000 })], CATS))[1].endsWith(',-10.00,'), true)
})

test('the file opens with a UTF-8 BOM so Excel reads accented payees', () => {
  assert.equal(transactionsCsv([], CATS).charCodeAt(0), 0xfeff)
})

test('the filename names the range', () => {
  assert.equal(csvFilename('2026-07-01', '2026-09-30'),
    'smith-audio-transactions-2026-07-01-to-2026-09-30.csv')
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `TZ=America/Chicago node --conditions=react-server --test scripts/test/reportCsv.test.ts`
Expected: FAIL — cannot find module `lib/reportCsv.ts`.

- [ ] **Step 3: Implement**

Create `lib/reportCsv.ts`:

```ts
// The transaction export Dan hands his accountant.
//
// This file is opened on someone ELSE'S machine, which is why two of the
// functions below are about safety rather than formatting: RFC 4180 escaping,
// because his payees arrive from bank exports and contain commas routinely;
// and a formula guard, because Excel and Google Sheets execute a field that
// begins = + - or @, and a payee is untrusted text from an external system.
//
// One row per split leg, by Dan's decision (2026-09-09): the file exists so
// his accountant can check the categorization, and a single parent row would
// show one category for money that went two places. The amount column then
// sums to the real total and reconciles against the P&L.
//
// No '@/' imports and no JSX — exercised by node --test.

import type { ReportCategory } from './ledgerReports.ts'
import type { ReportLine } from './ledgerSplits.ts'

const HEADER = ['Date', 'Payee', 'Category', 'Group', 'Kind', 'Amount', 'Split']

/**
 * A spreadsheet executes a cell beginning = + - or @. Prefixing with an
 * apostrophe forces it to text; Excel and Sheets both strip the apostrophe on
 * display. Applied to TEXT fields only — an amount like -10.00 must stay a
 * number, and it is generated here rather than supplied by anyone.
 */
function neutralise(field: string): string {
  return /^[=+\-@]/.test(field) ? `'${field}` : field
}

/** RFC 4180: quote when the field contains a comma, a quote or a newline. */
function escape(field: string): string {
  return /[",\n\r]/.test(field) ? `"${field.replace(/"/g, '""')}"` : field
}

const text = (field: string) => escape(neutralise(field))
const money = (cents: number) => (cents / 100).toFixed(2)

export function transactionsCsv(lines: ReportLine[], categories: ReportCategory[]): string {
  const byId = new Map(categories.map((c) => [c.id, c]))
  const rows = [HEADER.join(',')]
  for (const l of lines) {
    const category = l.categoryId === null ? null : byId.get(l.categoryId) ?? null
    rows.push([
      l.date,
      text(l.payee),
      text(category ? category.name : '(uncategorized)'),
      text(category ? category.grp : ''),
      l.kind,
      money(l.amountCents),
      l.isSplitLeg ? 'split' : '',
    ].join(','))
  }
  // The BOM is what makes Excel read this as UTF-8 rather than mangling an
  // accented payee.
  return `﻿${rows.join('\n')}\n`
}

export function csvFilename(from: string, to: string): string {
  return `smith-audio-transactions-${from}-to-${to}.csv`
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `TZ=America/Chicago node --conditions=react-server --test scripts/test/reportCsv.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Gates and commit**

```bash
npm test
rm -f tsconfig.tsbuildinfo .next/cache/.tsbuildinfo && npx tsc --noEmit
npm run build
git add lib/reportCsv.ts scripts/test/reportCsv.test.ts
git commit -m "reports: the transaction CSV, escaped and formula-safe"
```

---

### Task 4: Serve the CSV

**Files:**
- Create: `app/money/reports/export/route.ts`
- Modify: `app/money/reports/page.tsx` (a download link beside the picker)

**Interfaces:**
- Consumes: `transactionsCsv`, `csvFilename` (Task 3); `resolveRange` from `lib/reportRange.ts`; `explodeForReports` from `lib/ledgerSplits.ts`; `filterRange` from `lib/ledgerReports.ts`.

- [ ] **Step 1: Write the route**

Create `app/money/reports/export/route.ts`. Model its shape on `app/i/[token]/pdf/route.ts`, which is this repo's existing route handler.

```ts
import { createClient } from '@/lib/supabase/server'
import { todayInChicago } from '@/lib/dates'
import { resolveRange } from '@/lib/reportRange'
import { filterRange } from '@/lib/ledgerReports'
import { explodeForReports } from '@/lib/ledgerSplits'
import { transactionsCsv, csvFilename } from '@/lib/reportCsv'

// The transaction export. Same range contract as the Reports page it is
// launched from: from/to in the query string, resolved through resolveRange so
// a malformed URL yields the current year rather than an error.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return new Response('Not signed in.', { status: 401 })

  const params = new URL(request.url).searchParams
  const { from, to } = resolveRange(
    params.get('from') ?? undefined, params.get('to') ?? undefined, todayInChicago(),
  )

  const { data: txnRows, error: txnError } = await supabase
    .from('ledger_transactions')
    .select('id, date, amount_cents, kind, category_id, payee')
    .gte('date', from).lte('date', to)
    .order('date', { ascending: true })
    .order('id', { ascending: true })
  if (txnError) return new Response(txnError.message, { status: 500 })

  const { data: legRows, error: legError } = await supabase
    .from('ledger_transaction_splits')
    .select('transaction_id, category_id, amount_cents, kind')
  if (legError) return new Response(legError.message, { status: 500 })

  const { data: categoryRows, error: categoryError } = await supabase
    .from('ledger_categories')
    .select('id, name, grp, sort, deductible')
  if (categoryError) return new Response(categoryError.message, { status: 500 })

  const legsByTxnId = new Map<string, { categoryId: string | null; amountCents: number; kind: string }[]>()
  for (const l of legRows ?? []) {
    const list = legsByTxnId.get(l.transaction_id) ?? []
    list.push({ categoryId: l.category_id, amountCents: l.amount_cents, kind: l.kind })
    legsByTxnId.set(l.transaction_id, list)
  }

  const lines = explodeForReports((txnRows ?? []).map((t) => ({
    date: t.date, amountCents: t.amount_cents, kind: t.kind,
    categoryId: t.category_id, payee: t.payee ?? '', legs: legsByTxnId.get(t.id),
  })))

  // filterRange is belt-and-braces over the query's own date bounds: the
  // explosion above cannot move a line's date, but the range contract lives in
  // one place and this keeps the file honest if the query ever changes.
  const csv = transactionsCsv(filterRange(lines, from, to), categoryRows ?? [])

  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${csvFilename(from, to)}"`,
    },
  })
}
```

- [ ] **Step 2: Add the download link to the page**

In `app/money/reports/page.tsx`, inside the shortcut `<nav>` added in Phase 1 — after the "All year" chip, so the row reads as period controls then actions — add:

```tsx
        <a
          href={`/money/reports/export?from=${from}&to=${to}`}
          className="rounded-pill px-3 py-1.5 text-xs font-semibold uppercase tracking-wider
                     text-muted hover:text-ink transition-colors"
        >
          Download CSV
        </a>
```

A plain `<a>`, not a `<Link>`: this is a file download, not a client-side navigation, and Next's router would try to prefetch and render it as a page.

- [ ] **Step 3: Gates**

```bash
npm test
rm -f tsconfig.tsbuildinfo .next/cache/.tsbuildinfo && npx tsc --noEmit
npm run build
```

Expected: all pass, and the build lists `/money/reports/export` as a route.

- [ ] **Step 4: Commit**

```bash
git add app/money/reports/export/route.ts app/money/reports/page.tsx
git commit -m "reports: download the range as a CSV"
```

---

### Task 5: The Profit and Loss PDF

**Files:**
- Create: `lib/profitLossPdf.ts`
- Create: `scripts/test/profitLossPdf.test.ts`
- Create: `components/DownloadPlButton.tsx`
- Modify: `app/money/reports/page.tsx` (render the button beside the CSV link)

**Interfaces:**
- Consumes: `plSummary`, `spendByCategory`, `incomeByCategory` (Task 1) — all from `lib/ledgerReports.ts`.
- Produces: `export function buildProfitLossPdf(parts: PdfParts, data: PlDocumentData): unknown` and `export function plFilename(from: string, to: string): string`.

**Follow the house pattern exactly:** `lib/invoicePdf.ts` builds its document with `createElement`, imports NO PDF library, and takes the primitives as `PdfParts`. That is what makes it testable under `node --test`, and `scripts/test/invoicePdf.test.ts` proves the pattern works. Do the same here. **No JSX in `lib/`** — Node strips types but does not transform JSX.

- [ ] **Step 1: Write the failing tests**

Create `scripts/test/profitLossPdf.test.ts`:

```ts
// The P&L document, pinned. Dan's accountant "likes the style of quickbooks
// printouts", so the structure below is the thing under test: a centred
// heading block, income then expenses with subtotals, Net Income, and the two
// memo lines BELOW the statement rather than inside it.
//
// Like invoicePdf.test.ts, this injects plain objects as the PDF primitives
// and inspects the tree, so no PDF is ever rendered here.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildProfitLossPdf, plFilename, type PlDocumentData } from '../../lib/profitLossPdf.ts'

// Each primitive records its own name so the tree can be searched by text.
const PARTS = {
  Document: 'Document', Page: 'Page', Text: 'Text', View: 'View', Image: 'Image',
} as any

/** Every string anywhere in the built tree, in document order. */
function texts(node: any, out: string[] = []): string[] {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const n of node) texts(n, out); return out }
  if (node.props) texts(node.props.children, out)
  return out
}

const DATA: PlDocumentData = {
  businessName: 'Smith Audio, LLC',
  from: '2026-07-01',
  to: '2026-09-30',
  income: [{ name: 'Show Income', amountCents: 2640776 }],
  totalIncomeCents: 2640776,
  expenseGroups: [
    { group: 'Bills', rows: [{ name: 'Insurance', amountCents: 42700 }], subtotalCents: 42700 },
  ],
  totalExpensesCents: 42700,
  netCents: 2598076,
  ownerPayCents: 750000,
  deductibleCents: 42700,
}

test('the heading block names the business, the report and the period', () => {
  const all = texts(buildProfitLossPdf(PARTS, DATA))
  assert.ok(all.includes('Smith Audio, LLC'))
  assert.ok(all.includes('Profit and Loss'))
  assert.ok(all.some((t) => t.includes('July 1') && t.includes('September 30, 2026')))
})

test('income and expenses each carry a total, and Net Income appears', () => {
  const all = texts(buildProfitLossPdf(PARTS, DATA))
  assert.ok(all.includes('Total Income'))
  assert.ok(all.includes('Total Expenses'))
  assert.ok(all.includes('Net Income'))
  assert.ok(all.includes('$25,980.76'))
})

// Owner draws are equity, not an expense. They must not be inside Expenses or
// they would understate profit; they sit below the statement as a memo.
test('owner pay appears as a memo, after Net Income', () => {
  const all = texts(buildProfitLossPdf(PARTS, DATA))
  const net = all.indexOf('Net Income')
  const owner = all.findIndex((t) => t.startsWith('Owner pay'))
  assert.ok(net > -1 && owner > net, 'owner pay must come after Net Income')
})

test('no tax figure and no payment due date appear anywhere', () => {
  const all = texts(buildProfitLossPdf(PARTS, DATA)).join(' ').toLowerCase()
  assert.equal(all.includes('tax due'), false)
  assert.equal(all.includes('due date'), false)
  assert.equal(all.includes('estimated tax'), false)
})

test('an empty period still renders a statement with zero totals', () => {
  const empty: PlDocumentData = {
    ...DATA, income: [], totalIncomeCents: 0, expenseGroups: [],
    totalExpensesCents: 0, netCents: 0, ownerPayCents: 0, deductibleCents: 0,
  }
  const all = texts(buildProfitLossPdf(PARTS, empty))
  assert.ok(all.includes('Net Income'))
  assert.ok(all.includes('$0.00'))
})

test('the filename names the range', () => {
  assert.equal(plFilename('2026-07-01', '2026-09-30'),
    'smith-audio-profit-and-loss-2026-07-01-to-2026-09-30.pdf')
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `TZ=America/Chicago node --conditions=react-server --test scripts/test/profitLossPdf.test.ts`
Expected: FAIL — cannot find module `lib/profitLossPdf.ts`.

- [ ] **Step 3: Implement the builder**

Create `lib/profitLossPdf.ts`:

```ts
// The Profit and Loss, as a PDF.
//
// Dan's accountant "likes the style of quickbooks printouts" (2026-09-09), so
// this follows their conventions rather than the app's invoice letterhead: the
// business name, the report title and the period CENTRED at the top, no logo,
// accounts down the left with amounts right-aligned, subtotals for each
// section, and Net Income under a rule.
//
// Owner pay and the deductible total sit BELOW the statement as memo lines.
// Draws are equity, not an expense — a real P&L omits them entirely — but the
// accountant wants the figure, so it is present without being counted.
//
// Like lib/invoicePdf.ts, this imports NO PDF library: the caller injects
// Document/Page/Text/View. That is what lets node --test exercise it. And no
// JSX — Node strips types but does not transform JSX.

import { createElement as h } from 'react'
import { formatUSD } from './money.ts'
import { formatDateLong } from './dates.ts'

export type PdfParts = { Document: any; Page: any; Text: any; View: any; Image: any }

export type PlDocumentData = {
  businessName: string
  from: string
  to: string
  income: { name: string; amountCents: number }[]
  totalIncomeCents: number
  expenseGroups: { group: string; rows: { name: string; amountCents: number }[]; subtotalCents: number }[]
  totalExpensesCents: number
  netCents: number
  ownerPayCents: number
  deductibleCents: number
}

const INK = '#121212'
const LINE = '#cbd5e1'
const MUTED = '#737373'

const S = {
  page: { paddingTop: 48, paddingBottom: 48, paddingHorizontal: 56, fontSize: 10, color: INK },
  centre: { textAlign: 'center' as const },
  business: { fontSize: 15, fontWeight: 700, textAlign: 'center' as const },
  title: { fontSize: 12, textAlign: 'center' as const, marginTop: 4 },
  period: { fontSize: 10, textAlign: 'center' as const, marginTop: 2, color: MUTED, marginBottom: 24 },
  section: { fontSize: 10, fontWeight: 700, marginTop: 14, marginBottom: 4 },
  row: { flexDirection: 'row' as const, justifyContent: 'space-between' as const, paddingVertical: 2 },
  account: { paddingLeft: 14 },
  group: { paddingLeft: 7, fontWeight: 700, marginTop: 6 },
  subtotal: {
    flexDirection: 'row' as const, justifyContent: 'space-between' as const,
    borderTopWidth: 1, borderTopColor: LINE, marginTop: 4, paddingTop: 3, fontWeight: 700,
  },
  net: {
    flexDirection: 'row' as const, justifyContent: 'space-between' as const,
    borderTopWidth: 1, borderTopColor: INK, marginTop: 10, paddingTop: 5,
    fontSize: 11, fontWeight: 700,
  },
  memo: { flexDirection: 'row' as const, justifyContent: 'space-between' as const, marginTop: 3, color: MUTED },
  memoBlock: { marginTop: 26 },
}

export function buildProfitLossPdf(parts: PdfParts, data: PlDocumentData) {
  const { Document, Page, Text, View } = parts
  const line = (label: string, cents: number, style: any, key: string) =>
    h(View, { key, style }, h(Text, null, label), h(Text, null, formatUSD(cents)))

  const body: unknown[] = []

  body.push(h(Text, { key: 'biz', style: S.business }, data.businessName))
  body.push(h(Text, { key: 'title', style: S.title }, 'Profit and Loss'))
  body.push(h(Text, { key: 'period', style: S.period },
    `${formatDateLong(data.from)} – ${formatDateLong(data.to)}`))

  body.push(h(Text, { key: 'inc-h', style: S.section }, 'Income'))
  data.income.forEach((r, i) =>
    body.push(line(r.name, r.amountCents, { ...S.row, ...S.account }, `inc-${i}`)))
  body.push(line('Total Income', data.totalIncomeCents, S.subtotal, 'inc-total'))

  body.push(h(Text, { key: 'exp-h', style: S.section }, 'Expenses'))
  data.expenseGroups.forEach((g, gi) => {
    body.push(h(Text, { key: `grp-${gi}`, style: S.group }, g.group))
    g.rows.forEach((r, i) =>
      body.push(line(r.name, r.amountCents, { ...S.row, ...S.account }, `exp-${gi}-${i}`)))
  })
  body.push(line('Total Expenses', data.totalExpensesCents, S.subtotal, 'exp-total'))

  body.push(line('Net Income', data.netCents, S.net, 'net'))

  body.push(h(View, { key: 'memos', style: S.memoBlock },
    line('Owner pay (not an expense)', data.ownerPayCents, S.memo, 'memo-owner'),
    line('Deductible expenses so far', data.deductibleCents, S.memo, 'memo-ded')))

  return h(Document, null, h(Page, { size: 'LETTER', style: S.page }, ...body))
}

export function plFilename(from: string, to: string): string {
  return `smith-audio-profit-and-loss-${from}-to-${to}.pdf`
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `TZ=America/Chicago node --conditions=react-server --test scripts/test/profitLossPdf.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: The download button**

Create `components/DownloadPlButton.tsx`, modelled on `components/DownloadInvoiceButton.tsx`:

```tsx
'use client'

import { useState } from 'react'
import { buildProfitLossPdf, plFilename, type PlDocumentData } from '@/lib/profitLossPdf'

// @react-pdf/renderer is around 2MB, so it is imported on click rather than at
// module scope — the same rule DownloadInvoiceButton follows. Someone only
// reading the Reports page never pays for it.
export default function DownloadPlButton({ data }: { data: PlDocumentData }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function download() {
    setBusy(true)
    setError(null)
    try {
      const { Document, Page, Text, View, Image, pdf } = await import('@react-pdf/renderer')
      const blob = await pdf(
        buildProfitLossPdf({ Document, Page, Text, View, Image }, data) as any,
      ).toBlob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = plFilename(data.from, data.to)
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      setError('Could not build the PDF.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={download}
        disabled={busy}
        className="rounded-pill px-3 py-1.5 text-xs font-semibold uppercase tracking-wider
                   text-muted hover:text-ink transition-colors disabled:opacity-40"
      >
        {busy ? 'Building…' : 'Download P&L'}
      </button>
      {error && <span role="alert" className="text-xs text-danger">{error}</span>}
    </>
  )
}
```

- [ ] **Step 6: Wire it onto the page**

In `app/money/reports/page.tsx`, build the document data from figures the page already has, and render the button next to the CSV link inside the same `<nav>`:

```tsx
        <DownloadPlButton
          data={{
            businessName: settingsRow?.business_name ?? 'Smith Audio, LLC',
            from,
            to,
            income: incomeRows.rows.map((r) => ({ name: r.category.name, amountCents: r.earnedCents })),
            totalIncomeCents: pl.incomeCents,
            expenseGroups: groups.map((g) => ({
              group: g.grp,
              rows: g.rows.map((r) => ({ name: r.category.name, amountCents: r.spentCents })),
              subtotalCents: g.rows.reduce((s, r) => s + r.spentCents, 0),
            })),
            totalExpensesCents: pl.expenseCents,
            netCents: pl.netCents,
            ownerPayCents: pl.ownerPayCents,
            deductibleCents: pl.deductibleCents,
          }}
        />
```

Add `import DownloadPlButton from '@/components/DownloadPlButton'`, and call `incomeByCategory(rangeTxns, categories)` beside the existing `spendByCategory` call (line 264), naming it `incomeRows`.

**The names above are verified against the current file:** `pl` (line 263) is the `plSummary` result, `spend` (264) the `spendByCategory` result, and `groups` (275) the grouped rows, whose shape is `{ grp: string; rows: CategorySpend[] }` — so `g.grp` and `r.category.name` / `r.spentCents` are correct as written.

**The page reads no settings at all today** — confirmed, zero references — so you must add the fetch. Put it in the existing `Promise.all` wave, never a new serial await, and name the columns explicitly:

```ts
    supabase.from('settings').select('business_name').maybeSingle(),
```

Never `select('*')` here: that row also holds `ach_details` and `w9_path`, and this page has no business reading either. Destructure its `error` and return before touching the data, like every other read on the page.

- [ ] **Step 7: Gates and commit**

```bash
npm test
rm -f tsconfig.tsbuildinfo .next/cache/.tsbuildinfo && npx tsc --noEmit
npm run build
git add lib/profitLossPdf.ts scripts/test/profitLossPdf.test.ts components/DownloadPlButton.tsx app/money/reports/page.tsx
git commit -m "reports: a QuickBooks-style Profit and Loss PDF"
```

---

### Task 6: Record it

**Files:**
- Modify: `CLAUDE.md`, `docs/BACKLOG.md`

- [ ] **Step 1: Update the docs**

In `CLAUDE.md`'s current-state section, add one line: `/money/reports` exports the selected range two ways — a transaction CSV (`/money/reports/export`, one row per split leg, RFC 4180 escaped, formula-guarded, UTF-8 BOM) and a QuickBooks-style P&L PDF built by `lib/profitLossPdf.ts` on the `lib/invoicePdf.ts` pattern (createElement, injected primitives, no PDF library import, therefore testable). Note that **`ReportLine` now carries `payee` and `isSplitLeg`**.

In `docs/BACKLOG.md`, under the existing `## Gross earnings by month and by quarter — predicted and actual (2026-09-09, Dan)` heading, record that Phase 2 shipped, pointing at `docs/superpowers/specs/2026-09-09-accountant-reports-phase-2-design.md`, and that **Phase 3 (the year-end package — mileage, blocked on MileIQ, and any 1099/W-9 bits) remains**. Record the two deliberate omissions: emailing either file, and a balance sheet.

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md docs/BACKLOG.md
git commit -m "docs: accountant reports phase 2 shipped"
```

---

## Verification once all six land

- On `/money/reports`, pick **Q3 2026**, click **Download CSV**: the file is named `smith-audio-transactions-2026-07-01-to-2026-09-30.csv`, opens in Excel without mangled characters, and its Amount column sums to the same net the page shows.
- The March split appears as two rows with the same date and payee, different categories, both marked `split`, summing to −2912.60.
- Click **Download P&L**: a PDF whose heading reads Smith Audio, LLC / Profit and Loss / July 1 – September 30, 2026, with Total Income, Total Expenses, Net Income, and owner pay as a memo below.
- A malformed range in the URL exports the current year rather than erroring.

## Deliberately NOT in this plan

- **Emailing either file.** Dan attaches them; a send path means recipients, a template, and a silent delivery failure mode.
- **A balance sheet.** Needs asset and liability accounts the ledger does not model.
- **Phase 3** — the year-end package.
