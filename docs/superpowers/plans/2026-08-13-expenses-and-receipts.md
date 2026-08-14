# Expenses and Receipts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Log an expense with its receipt against a show, roll each category into one invoice line, and attach the itemisation and the receipt images to the invoice PDF.

**Architecture:** Expenses live on a show. The browser downscales, grayscales and contrast-stretches the photo, uploads it and the untouched original straight to a private Supabase Storage bucket, then a server action records the row. A pure function turns expenses into invoice lines; billing refuses while any expense lacks a receipt.

**Tech Stack:** Next.js 16 App Router, Supabase Postgres + Storage with RLS, `@react-pdf/renderer`, browser Canvas API, `node --test` with native type stripping.

**Spec:** `docs/superpowers/specs/2026-08-13-expenses-and-receipts-design.md`

**Task 1's SQL was executed before this plan shipped** — applied inside a rolled-back transaction against the live database. The bucket, its 10MB `file_size_limit`, its MIME whitelist and the `storage.objects` policy all applied cleanly, and the rollback left zero buckets.

## Global Constraints

- **Money is integer cents.** `amount_cents` is summed, **never** recomputed from a rate or a percentage. Rendered only via `formatUSD`.
- **Dates are plain `YYYY-MM-DD`** through `lib/dates.ts`. **Never `new Date()`** for a calendar date.
- **A receipt is required to bill.** An expense may be logged without one; a show with any receiptless expense must be refused, naming the offenders. This is the feature's central rule.
- **There is no `has_receipt` boolean.** A receipt exists iff `receipt_path` is set.
- **The original image is always retained**, untouched, alongside the enhanced one.
- **Upload both files BEFORE recording the row.** A row pointing at a failed upload is a receipt that appears to exist and cannot be opened — and receipts are what make an expense billable.
- **The bucket is private.** No public URLs. Reads go through signed URLs valid **one hour**.
- **Contrast-stretch, never binary threshold.** Thermal receipts fade; hard thresholding erases faint totals, which is the number a client queries.
- **`anon` must keep ZERO privileges** on the new table and bucket.
- **`lib/` modules import relatively with explicit extensions** (`'./money.ts'`), never `'@/lib/…'`; tests run under plain `node --test`. **No JSX in `lib/`.**
- The live database holds **105 real invoices, 19 real clients, $185,484.28**. Migrations are additive.
- Every task ends with `npm test`, `npx tsc --noEmit` and `npm run build` clean.

---

### Task 1: Schema and storage

**Files:**
- Create: `scripts/sql/migrations/0010_expenses.sql`

**Interfaces:**
- Produces: table `expenses`, bucket `receipts`, and the storage policy `receipts_owner_all`.

- [ ] **Step 1: Write the migration**

Create `scripts/sql/migrations/0010_expenses.sql`:

```sql
-- 0010 — expenses, and the receipts that make them billable
--
-- Replaces the "Gig Expense Calc" sheet: one tab per trip, three columns of
-- where+amount, each totalled, each total retyped onto an invoice. That
-- retyping is why the same expense appears as Baggage, Baggage Fees, Baggage
-- Expenses and Baggage Fee across five years. The category now owns the label.
--
-- Every expense must have a receipt to be billed. There is deliberately NO
-- has_receipt column: the file is the flag. A boolean beside a file is a second
-- source of truth, and the sheet's own Rcpt column is the evidence that it
-- drifts out of step.
create table expenses (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users(id) on delete cascade,
  show_id     uuid not null references shows(id) on delete cascade,

  -- Fixed set. The category carries the invoice-line label, which is the whole
  -- point: a label that is chosen cannot drift.
  category    text not null check (category in ('meals', 'rides', 'baggage', 'other')),

  -- "where", but not `where` — that is a reserved word and quoting it forever
  -- is a tax on every query that touches this table.
  where_spent text not null check (length(btrim(where_spent)) > 0),

  amount_cents bigint not null check (amount_cents > 0),
  spent_on    date not null,

  -- Storage keys. receipt_path is the enhanced image and is what gets shown and
  -- sent; receipt_original is the untouched upload, kept because hard contrast
  -- can erase a faint thermal total, and because a future OCR pass should
  -- re-read the original rather than a lossy derivative.
  receipt_path     text,
  receipt_original text,

  note        text,
  created_at  timestamptz not null default now()
);

create index expenses_show_idx on expenses (show_id, category, spent_on);

alter table expenses enable row level security;

create policy expenses_owner_all on public.expenses
  for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

revoke all on public.expenses from anon;
grant select, insert, update, delete on public.expenses to authenticated;
grant all on public.expenses to service_role;

-- Receipts live in a PRIVATE bucket. A receipt carries a vendor, a date and an
-- amount; the bucket must never be enumerable and no public URL may exist.
-- Reads go through short-lived signed URLs.
--
-- 10MB ceiling and an image whitelist: the browser uploads a downscaled JPEG,
-- so anything larger is a bug or an accident, and the limit is enforced by
-- storage rather than trusted from the client.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('receipts', 'receipts', false, 10485760, array['image/jpeg', 'image/png']);

-- Paths are {owner_id}/{show_id}/{stamp}-{enhanced|original}.jpg, so the leading
-- folder is the owner and this policy can match on it. The name cannot carry the
-- expense id: the files are uploaded before the row exists, which is deliberate
-- -- a row pointing at a failed upload is a receipt that appears to exist and
-- cannot be opened.
create policy receipts_owner_all on storage.objects
  for all to authenticated
  using (bucket_id = 'receipts' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'receipts' and (storage.foldername(name))[1] = auth.uid()::text);
```

- [ ] **Step 2: Apply it**

Run:

```bash
npm run db:migrate
```

Expected: reports `0010_expenses.sql` applied, no drift on 0001–0009. Drift on an earlier file is a STOP — report, do not repair.

- [ ] **Step 3: Prove anon gained nothing**

Write to `/tmp/verify-expenses.sql` and run with `npm run db:sql -- /tmp/verify-expenses.sql`:

```sql
set local role anon;
select current_user as who,
       has_table_privilege('public.expenses','select') as exp_select,
       has_table_privilege('public.expenses','insert') as exp_insert;
reset role;
select id, public, file_size_limit from storage.buckets where id = 'receipts';
select count(*) as owner_policies from pg_policies
 where tablename = 'objects' and policyname = 'receipts_owner_all';
select (select count(*) from invoices) as invoices, (select count(*) from clients) as clients;
```

Expected: `who = anon`, both privileges **false**, the bucket present with
`public = false` and `file_size_limit = 10485760`, `owner_policies = 1`, and
105 invoices / 19 clients untouched. Any `true` privilege is a STOP.

- [ ] **Step 4: Verify, commit**

```bash
npm test && npx tsc --noEmit && npm run build 2>&1 | grep -E "Compiled|Failed"
git add scripts/sql/migrations/0010_expenses.sql
git commit -m "Add expenses and a private receipts bucket."
```

---

### Task 2: The rollup, and the receipt guard

Pure functions: expenses to invoice lines, and which expenses block billing. No database, no images.

**Files:**
- Create: `lib/expenses.ts`
- Create: `scripts/test/expenses.test.ts`

**Interfaces:**
- Consumes: `type BucketLine` from `lib/showBuckets.ts` (`{ description, qty_hundredths, unit_price_cents }`).
- Produces:
  - `export type ExpenseCategory = 'meals' | 'rides' | 'baggage' | 'other'`
  - `export type ExpenseLike = { id: string; category: ExpenseCategory; where_spent: string; amount_cents: number; spent_on: string; receipt_path: string | null }`
  - `export const CATEGORY_LABEL: Record<ExpenseCategory, string>`
  - `export const CATEGORY_ORDER: ExpenseCategory[]`
  - `export function expenseLines(expenses: ExpenseLike[]): BucketLine[]`
  - `export function expensesMissingReceipts(expenses: ExpenseLike[]): ExpenseLike[]`

- [ ] **Step 1: Write the failing test**

Create `scripts/test/expenses.test.ts`:

```ts
// Expenses to invoice lines. Pure — no database, no images, no clock.
//
// The figures in the first test are the real Napa trip from the Gig Expense
// Calc sheet: $266.21 of food, $120.00 of baggage, and no rides at all.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  expenseLines, expensesMissingReceipts, CATEGORY_LABEL, type ExpenseLike,
} from '../../lib/expenses.ts'
import { formatUSD } from '../../lib/money.ts'

const exp = (over: Partial<ExpenseLike> = {}): ExpenseLike => ({
  id: 'e1',
  category: 'meals',
  where_spent: 'HMS Host',
  amount_cents: 2669,
  spent_on: '2026-05-17',
  receipt_path: 'owner/show/e1-enhanced.jpg',
  ...over,
})

test('each category rolls into exactly one line, labelled by the category', () => {
  const lines = expenseLines([
    exp({ id: 'a', category: 'meals', amount_cents: 1998 }),
    exp({ id: 'b', category: 'meals', amount_cents: 1228 }),
    exp({ id: 'c', category: 'baggage', amount_cents: 6000, where_spent: 'United' }),
  ])
  assert.equal(lines.length, 2, 'two categories used, two lines')
  assert.deepEqual(lines[0], {
    description: 'Meal Expenses', qty_hundredths: 100, unit_price_cents: 1998 + 1228,
  })
  assert.deepEqual(lines[1], {
    description: 'Baggage Expenses', qty_hundredths: 100, unit_price_cents: 6000,
  })
})

test('the real Napa trip produces two lines, not three', () => {
  // $266.21 food, $120.00 baggage, no rides. An empty category must emit
  // nothing at all — a "Ride Expenses $0.00" line on a client's invoice is
  // noise at best and a query at worst.
  const meals = [2669, 1998, 1228, 898, 898, 3523, 2438, 1265, 6220, 2438, 4715, 1000]
  const lines = expenseLines([
    ...meals.map((c, i) => exp({ id: `m${i}`, category: 'meals', amount_cents: c })),
    exp({ id: 'b1', category: 'baggage', amount_cents: 6000, where_spent: 'United' }),
    exp({ id: 'b2', category: 'baggage', amount_cents: 6000, where_spent: 'United' }),
  ])
  assert.equal(lines.length, 2)
  assert.equal(lines.map((l) => l.description).join(', '), 'Meal Expenses, Baggage Expenses')
  assert.equal(formatUSD(lines[0].unit_price_cents), '$266.21')
  assert.equal(formatUSD(lines[1].unit_price_cents), '$120.00')
})

test('lines come out in a fixed order regardless of entry order', () => {
  const lines = expenseLines([
    exp({ id: 'a', category: 'other', amount_cents: 100 }),
    exp({ id: 'b', category: 'baggage', amount_cents: 100 }),
    exp({ id: 'c', category: 'meals', amount_cents: 100 }),
    exp({ id: 'd', category: 'rides', amount_cents: 100 }),
  ])
  assert.deepEqual(lines.map((l) => l.description), [
    'Meal Expenses', 'Ride Expenses', 'Baggage Expenses', 'Expenses',
  ])
})

test('no expenses produce no lines', () => {
  assert.deepEqual(expenseLines([]), [])
})

test('amounts are summed stored cents, never recomputed', () => {
  // Three awkward amounts whose sum is not reachable by any rate x quantity.
  const lines = expenseLines([
    exp({ id: 'a', amount_cents: 821 }),
    exp({ id: 'b', amount_cents: 2445 }),
    exp({ id: 'c', amount_cents: 1732 }),
  ])
  assert.equal(lines[0].unit_price_cents, 821 + 2445 + 1732)
  assert.equal(lines[0].qty_hundredths, 100, 'quantity is always exactly 1')
})

test('every category has a label, and they are the historical wording', () => {
  assert.equal(CATEGORY_LABEL.meals, 'Meal Expenses')
  assert.equal(CATEGORY_LABEL.rides, 'Ride Expenses')
  assert.equal(CATEGORY_LABEL.baggage, 'Baggage Expenses')
  assert.equal(CATEGORY_LABEL.other, 'Expenses')
})

test('an expense with no receipt is reported, one with a receipt is not', () => {
  // The central rule: a receipt is what makes an expense billable.
  const missing = expensesMissingReceipts([
    exp({ id: 'ok', receipt_path: 'owner/show/ok-enhanced.jpg' }),
    exp({ id: 'bad', where_spent: 'Starbucks', receipt_path: null }),
    exp({ id: 'alsobad', where_spent: 'United', receipt_path: null }),
  ])
  assert.deepEqual(missing.map((e) => e.where_spent), ['Starbucks', 'United'])
})

test('an empty string is not a receipt', () => {
  // A path that is present but blank would otherwise pass a null check and let
  // a show bill with nothing behind it.
  assert.equal(expensesMissingReceipts([exp({ receipt_path: '' })]).length, 1)
  assert.equal(expensesMissingReceipts([exp({ receipt_path: '   ' })]).length, 1)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
npm test 2>&1 | tail -20
```

Expected: FAIL — `Cannot find module '../../lib/expenses.ts'`.

- [ ] **Step 3: Write the module**

Create `lib/expenses.ts`:

```ts
// Expenses to invoice lines.
//
// Pure: no database, no images, no clock. This is the boundary where a list of
// receipts becomes money on an invoice, and it is deliberately the same shape
// as lib/showBuckets.ts — a bucket that is empty produces no line at all.
//
// The category owns the invoice-line label. That is the point of a fixed set:
// the label stops being typed, so it stops drifting. Five years of the old
// sheet produced Baggage, Baggage Fees, Baggage Expenses and Baggage Fee for
// one thing, which is also why none of it could be reported on.
//
// No '@/' imports and no JSX — this module runs under plain node --test.

import type { BucketLine } from './showBuckets.ts'

export type ExpenseCategory = 'meals' | 'rides' | 'baggage' | 'other'

export type ExpenseLike = {
  id: string
  category: ExpenseCategory
  where_spent: string
  amount_cents: number
  spent_on: string
  /** Storage key of the enhanced image, or null when not yet photographed. */
  receipt_path: string | null
}

/** Wording taken from the invoices Dan already sends. */
export const CATEGORY_LABEL: Record<ExpenseCategory, string> = {
  meals: 'Meal Expenses',
  rides: 'Ride Expenses',
  baggage: 'Baggage Expenses',
  other: 'Expenses',
}

/** Fixed output order, so an invoice reads the same way every time. */
export const CATEGORY_ORDER: ExpenseCategory[] = ['meals', 'rides', 'baggage', 'other']

/**
 * One line per category that has anything in it.
 *
 * Quantity is always exactly 1 and the price is a sum of stored cents: an
 * expense is money already spent, so there is no rate and no quantity to
 * multiply. Nothing here is recomputed.
 */
export function expenseLines(expenses: ExpenseLike[]): BucketLine[] {
  const lines: BucketLine[] = []

  for (const category of CATEGORY_ORDER) {
    let total = 0
    for (const e of expenses) {
      if (e.category === category) total += e.amount_cents
    }
    if (total > 0) {
      lines.push({
        description: CATEGORY_LABEL[category],
        qty_hundredths: 100,
        unit_price_cents: total,
      })
    }
  }

  return lines
}

/**
 * Which expenses cannot be billed yet.
 *
 * "Every expense has to have a receipt to bill." An expense may be LOGGED
 * without one — the amount is often noted before the photograph — but the show
 * cannot be billed until every one of them has a file behind it.
 *
 * A blank string is not a receipt: it would pass a null check and let a show
 * bill with nothing behind it.
 */
export function expensesMissingReceipts(expenses: ExpenseLike[]): ExpenseLike[] {
  return expenses.filter((e) => !e.receipt_path || e.receipt_path.trim() === '')
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"
```

Expected: 84 existing plus 8 new = **92 passing**, 0 failing.

- [ ] **Step 5: Typecheck, build, commit**

```bash
npx tsc --noEmit && npm run build 2>&1 | grep -E "Compiled|Failed"
git add lib/expenses.ts scripts/test/expenses.test.ts
git commit -m "Turn expenses into invoice lines, and name what blocks billing."
```

---

### Task 3: The image pipeline

The maths behind the scan look, as a pure function. The canvas wiring is Task 4.

**Files:**
- Create: `lib/receiptImage.ts`
- Create: `scripts/test/receiptImage.test.ts`

**Interfaces:**
- Produces:
  - `export const MAX_EDGE = 1600`
  - `export const JPEG_QUALITY = 0.8`
  - `export function scaleToFit(w: number, h: number): { width: number; height: number }`
  - `export function contrastBounds(histogram: number[]): { lo: number; hi: number }`
  - `export function buildLut(lo: number, hi: number): Uint8ClampedArray`

- [ ] **Step 1: Write the failing test**

Create `scripts/test/receiptImage.test.ts`:

```ts
// The arithmetic behind the "flatbed scan" look, separated from the canvas so
// it can actually be tested. The canvas wiring lives in the component.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scaleToFit, contrastBounds, buildLut, MAX_EDGE } from '../../lib/receiptImage.ts'

test('a large photo is scaled to the long edge, aspect ratio intact', () => {
  const landscape = scaleToFit(4032, 3024)
  assert.equal(landscape.width, MAX_EDGE)
  assert.equal(landscape.height, Math.round(3024 * (MAX_EDGE / 4032)))

  const portrait = scaleToFit(3024, 4032)
  assert.equal(portrait.height, MAX_EDGE, 'the LONG edge is the one capped')
  assert.equal(portrait.width, Math.round(3024 * (MAX_EDGE / 4032)))
})

test('an already-small image is never enlarged', () => {
  assert.deepEqual(scaleToFit(800, 600), { width: 800, height: 600 })
})

test('contrast bounds ignore the extreme tails', () => {
  // A receipt photographed in shadow: most pixels mid-grey, a few specks of
  // pure black and pure white. Stretching between the absolute min and max
  // would do almost nothing, because those specks are already 0 and 255.
  const h = new Array(256).fill(0)
  h[0] = 5          // a few black specks
  h[255] = 5        // a glare highlight
  for (let v = 90; v <= 170; v++) h[v] = 100   // the actual receipt

  const { lo, hi } = contrastBounds(h)
  assert.ok(lo >= 85 && lo <= 95, `lo ${lo} should land at the low end of the real data`)
  assert.ok(hi >= 165 && hi <= 175, `hi ${hi} should land at the high end of the real data`)
})

test('a flat image does not divide by zero', () => {
  // Every pixel identical — lo and hi collapse. The LUT must still be usable.
  const h = new Array(256).fill(0)
  h[128] = 1000
  const { lo, hi } = contrastBounds(h)
  const lut = buildLut(lo, hi)
  assert.equal(lut.length, 256)
  assert.ok(Number.isFinite(lut[128]))
})

test('the lut stretches the chosen range across the full scale', () => {
  const lut = buildLut(50, 200)
  assert.equal(lut[50], 0, 'the low bound becomes black')
  assert.equal(lut[200], 255, 'the high bound becomes white')
  assert.equal(lut[20], 0, 'below the low bound clamps, it does not wrap')
  assert.equal(lut[240], 255, 'above the high bound clamps')
  assert.ok(lut[125] > 100 && lut[125] < 155, 'the middle stays in the middle')
})

test('the lut never produces a pure black-and-white image', () => {
  // Deliberately a contrast STRETCH, not a threshold. Thermal receipts fade,
  // and thresholding erases a faint total — the one number a client queries.
  const lut = buildLut(50, 200)
  const distinct = new Set(Array.from(lut))
  assert.ok(distinct.size > 100, `expected a gradient, got ${distinct.size} distinct values`)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
npm test 2>&1 | tail -20
```

Expected: FAIL — `Cannot find module '../../lib/receiptImage.ts'`.

- [ ] **Step 3: Write the module**

Create `lib/receiptImage.ts`:

```ts
// The arithmetic that makes a phone photo look like a scan.
//
// Two jobs, both pure so they can be tested without a canvas: work out the
// target size, and work out the contrast curve. The component does the drawing.
//
// This is a contrast STRETCH, never a binary threshold. Thresholding is what
// produces the crispest-looking scan and it is exactly wrong here: thermal
// receipts fade, and a hard cutoff erases a faint total — the single number a
// client is most likely to query. The original is kept regardless.

/** Long edge, in pixels. Twelve of these must fit in one emailable PDF. */
export const MAX_EDGE = 1600

/** Enough for receipt text; small enough that a trip's worth stays sendable. */
export const JPEG_QUALITY = 0.8

/** Ignored at each end when choosing the contrast range. */
const TAIL_FRACTION = 0.02

/** Scale so the LONG edge is at most MAX_EDGE. Never enlarges. */
export function scaleToFit(w: number, h: number): { width: number; height: number } {
  const scale = Math.min(1, MAX_EDGE / Math.max(w, h))
  return { width: Math.round(w * scale), height: Math.round(h * scale) }
}

/**
 * The luminance range actually occupied by the receipt.
 *
 * Uses the 2nd and 98th percentile rather than the true min and max: one black
 * speck and one glare highlight would otherwise pin the range to 0–255 and the
 * stretch would do nothing at all, which is the common case for a photo taken
 * on a table under a lamp.
 */
export function contrastBounds(histogram: number[]): { lo: number; hi: number } {
  const total = histogram.reduce((a, b) => a + b, 0)
  if (total === 0) return { lo: 0, hi: 255 }

  const cut = total * TAIL_FRACTION
  let lo = 0
  let hi = 255

  let seen = 0
  for (let v = 0; v < 256; v++) {
    seen += histogram[v]
    if (seen > cut) { lo = v; break }
  }

  seen = 0
  for (let v = 255; v >= 0; v--) {
    seen += histogram[v]
    if (seen > cut) { hi = v; break }
  }

  return { lo, hi }
}

/** A 256-entry lookup mapping [lo, hi] onto the full 0–255 scale. */
export function buildLut(lo: number, hi: number): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256)
  // A flat image collapses lo and hi. Guard the division rather than letting
  // every pixel become NaN and the receipt vanish.
  const span = Math.max(1, hi - lo)
  for (let v = 0; v < 256; v++) {
    lut[v] = Math.round(((v - lo) / span) * 255)
  }
  return lut
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"
```

Expected: 92 plus 6 new = **98 passing**, 0 failing.

- [ ] **Step 5: Typecheck, build, commit**

```bash
npx tsc --noEmit && npm run build 2>&1 | grep -E "Compiled|Failed"
git add lib/receiptImage.ts scripts/test/receiptImage.test.ts
git commit -m "Work out the scan look without a canvas."
```

---

### Task 4: Actions, and the billing guard

**Files:**
- Create: `app/expenses/actions.ts`
- Modify: `app/shows/actions.ts` — `billShows` refuses on a missing receipt
- Modify: `app/shows/[id]/page.tsx` — load expenses, pass them down

**Interfaces:**
- Consumes: `expenseLines`, `expensesMissingReceipts`, `CATEGORY_LABEL`, `type ExpenseCategory`, `type ExpenseLike` from `lib/expenses.ts`.
- Produces:
  - `addExpense(input: { showId, category, whereSpent, amountCents, spentOn, receiptPath, receiptOriginal, note }): Promise<{ error: string } | { ok: true; id: string }>`
  - `deleteExpense(expenseId: string): Promise<{ error: string } | { ok: true }>`
  - `signedReceiptUrls(paths: string[]): Promise<Record<string, string>>`

- [ ] **Step 1: Write the actions**

Create `app/expenses/actions.ts`:

```ts
'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { isPlainDate } from '@/lib/dates'
import type { ExpenseCategory } from '@/lib/expenses'

type Fail = { error: string }

const CATEGORIES: ExpenseCategory[] = ['meals', 'rides', 'baggage', 'other']

/** How long a receipt link lives. Longer than any render, shorter than a leak. */
const SIGNED_URL_SECONDS = 3600

/**
 * Records an expense.
 *
 * The FILES ARE ALREADY UPLOADED by the time this runs — the browser puts them
 * straight into Storage, both because a phone photo exceeds Next's 1MB server
 * action body limit and because a row pointing at a failed upload is a receipt
 * that appears to exist and cannot be opened. Since a receipt is what makes an
 * expense billable, that would let a show bill with a broken attachment.
 */
export async function addExpense(input: {
  showId: string
  category: ExpenseCategory
  whereSpent: string
  amountCents: number
  spentOn: string
  receiptPath: string | null
  receiptOriginal: string | null
  note: string
}): Promise<Fail | { ok: true; id: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  const { data: show } = await supabase
    .from('shows').select('status').eq('id', input.showId).maybeSingle()
  if (!show) return { error: 'That show no longer exists.' }
  if (show.status === 'billed') return { error: 'This show is billed. Unlink it before editing.' }

  if (!CATEGORIES.includes(input.category)) {
    return { error: `"${input.category}" is not an expense category.` }
  }
  if (!input.whereSpent.trim()) return { error: 'Say where the money went.' }
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    return { error: 'An expense needs an amount greater than zero.' }
  }
  if (!isPlainDate(input.spentOn)) return { error: 'Pick the date of the expense.' }

  const { data, error } = await supabase.from('expenses').insert({
    owner_id: user.id,
    show_id: input.showId,
    category: input.category,
    where_spent: input.whereSpent.trim(),
    amount_cents: input.amountCents,
    spent_on: input.spentOn,
    receipt_path: input.receiptPath,
    receipt_original: input.receiptOriginal,
    note: input.note.trim() || null,
  }).select('id').single()
  if (error) return { error: error.message }

  revalidatePath(`/shows/${input.showId}`)
  return { ok: true, id: data.id }
}

/** Removes an expense and its receipt files. */
export async function deleteExpense(expenseId: string): Promise<Fail | { ok: true }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  // Derive the lock from the expense's own show, never a caller-supplied id.
  const { data: expense } = await supabase
    .from('expenses')
    .select('show_id, receipt_path, receipt_original, shows(status)')
    .eq('id', expenseId).maybeSingle()
  if (!expense) return { error: 'That expense no longer exists.' }

  const row = expense as unknown as {
    show_id: string
    receipt_path: string | null
    receipt_original: string | null
    shows: { status: string } | null
  }
  if (row.shows?.status === 'billed') {
    return { error: 'This show is billed. Unlink it before editing.' }
  }

  const { error } = await supabase.from('expenses').delete().eq('id', expenseId)
  if (error) return { error: error.message }

  // Files after the row: an orphaned file costs storage, an orphaned row costs
  // a receipt that cannot be opened.
  const paths = [row.receipt_path, row.receipt_original].filter(Boolean) as string[]
  if (paths.length) await supabase.storage.from('receipts').remove(paths)

  revalidatePath(`/shows/${row.show_id}`)
  return { ok: true }
}

/** Short-lived read URLs, keyed by storage path. */
export async function signedReceiptUrls(paths: string[]): Promise<Record<string, string>> {
  if (paths.length === 0) return {}
  const supabase = await createClient()
  const { data, error } = await supabase.storage
    .from('receipts').createSignedUrls(paths, SIGNED_URL_SECONDS)
  if (error || !data) return {}

  const out: Record<string, string> = {}
  for (const row of data) {
    if (row.path && row.signedUrl) out[row.path] = row.signedUrl
  }
  return out
}
```

- [ ] **Step 2: Make billing refuse a receiptless expense**

In `app/shows/actions.ts`, add to the imports:

```ts
import { expenseLines, expensesMissingReceipts, type ExpenseLike } from '@/lib/expenses'
```

In `billShows`, the show query already selects days, punches and pm_entries. Add
expenses to that select list:

```
expenses(id, category, where_spent, amount_cents, spent_on, receipt_path),
```

Then, before any invoice is created — alongside the existing incomplete-day
check — add:

```ts
  // Every expense has to have a receipt to bill. An expense may be LOGGED
  // without one, because the amount is usually noted before the photograph,
  // but a client must never receive an expense with nothing behind it.
  const receiptless = shows.flatMap((s) => {
    const rows = ((s as unknown as { expenses?: ExpenseLike[] }).expenses ?? [])
    return expensesMissingReceipts(rows).map((e) => `${e.where_spent} (#${s.name})`)
  })
  if (receiptless.length) {
    return {
      error: `${receiptless.length} ${receiptless.length === 1 ? 'expense needs' : 'expenses need'} ` +
        `a receipt before billing: ${receiptless.join(', ')}.`,
    }
  }
```

And where the per-show bucket lines are collected, append the expense lines for
that show so they merge with the rest:

```ts
    groups.push(expenseLines(((s as unknown as { expenses?: ExpenseLike[] }).expenses ?? [])))
```

**Read the surrounding code before editing.** `billShows` builds an array of
line groups and passes them through `mergeLines`; the expense lines must join
that array, not bypass it, or a multi-show invoice would produce two
`Meal Expenses` lines instead of one.

- [ ] **Step 3: Verify**

```bash
npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)" && npx tsc --noEmit && npm run build 2>&1 | grep -E "Compiled|Failed"
```

Expected: 98 passing, no type errors, compiles.

- [ ] **Step 4: Confirm nothing was written**

```bash
npm run db:sql -- /dev/stdin <<'EOF'
select count(*) as expenses from expenses;
EOF
```

Expected: `0`.

- [ ] **Step 5: Commit**

```bash
git add app/expenses/actions.ts app/shows/actions.ts "app/shows/[id]/page.tsx"
git commit -m "Record expenses, and refuse to bill one without a receipt."
```

---

### Task 5: Capture on the show page

**Files:**
- Create: `components/ExpenseLog.tsx`
- Modify: `app/shows/[id]/page.tsx` — render it

**Interfaces:**
- Consumes: `addExpense`, `deleteExpense` from `app/expenses/actions.ts`; `scaleToFit`, `contrastBounds`, `buildLut`, `MAX_EDGE`, `JPEG_QUALITY` from `lib/receiptImage.ts`; `CATEGORY_LABEL`, `CATEGORY_ORDER`, `type ExpenseCategory` from `lib/expenses.ts`; `createClient` from `lib/supabase/client.ts`.
- Produces: `<ExpenseLog showId={...} expenses={...} locked={...} />`

- [ ] **Step 1: Write the component**

Create `components/ExpenseLog.tsx`:

```tsx
'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { formatUSD, parseUSD } from '@/lib/money'
import { formatDateShort, todayInChicago } from '@/lib/dates'
import { CATEGORY_LABEL, CATEGORY_ORDER, type ExpenseCategory } from '@/lib/expenses'
import { scaleToFit, contrastBounds, buildLut, JPEG_QUALITY } from '@/lib/receiptImage'
import { addExpense, deleteExpense } from '@/app/expenses/actions'

type Row = {
  id: string
  category: ExpenseCategory
  where_spent: string
  amount_cents: number
  spent_on: string
  receipt_path: string | null
}

const field =
  'w-full px-3 py-2 bg-bg border border-line rounded-field text-ink text-sm ' +
  'focus:border-accent focus:outline-none'

/**
 * Downscale, grayscale and contrast-stretch, entirely in the browser.
 *
 * Done here rather than on the server for two reasons: a phone photo is 3-5MB
 * and exceeds Next's 1MB server-action body limit, and twelve untouched photos
 * make a PDF most mail servers reject. The maths lives in lib/receiptImage.ts
 * where it can be tested; this is only the canvas wiring.
 */
async function enhance(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file)
  const { width, height } = scaleToFit(bitmap.width, bitmap.height)

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('This browser cannot process images.')
  ctx.drawImage(bitmap, 0, 0, width, height)

  const image = ctx.getImageData(0, 0, width, height)
  const px = image.data

  // Rec. 601 luma, then a histogram of it.
  const histogram = new Array(256).fill(0)
  const grey = new Uint8ClampedArray(px.length / 4)
  for (let i = 0, g = 0; i < px.length; i += 4, g++) {
    const v = (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000
    grey[g] = v
    histogram[Math.round(v)]++
  }

  const { lo, hi } = contrastBounds(histogram)
  const lut = buildLut(lo, hi)

  for (let i = 0, g = 0; i < px.length; i += 4, g++) {
    const v = lut[grey[g]]
    px[i] = v
    px[i + 1] = v
    px[i + 2] = v
  }
  ctx.putImageData(image, 0, 0)

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Could not process that photo.'))),
      'image/jpeg',
      JPEG_QUALITY,
    )
  })
}

export default function ExpenseLog({
  showId, expenses, locked,
}: {
  showId: string
  expenses: Row[]
  locked: boolean
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const [category, setCategory] = useState<ExpenseCategory>('meals')
  const [whereSpent, setWhereSpent] = useState('')
  const [amount, setAmount] = useState('')
  const [spentOn, setSpentOn] = useState(todayInChicago())
  const [file, setFile] = useState<File | null>(null)

  const total = expenses.reduce((t, e) => t + e.amount_cents, 0)
  const missing = expenses.filter((e) => !e.receipt_path).length

  function add() {
    setError(null)
    const cents = parseUSD(amount)
    if (cents === null || cents <= 0) { setError('Enter an amount.'); return }
    if (!whereSpent.trim()) { setError('Say where the money went.'); return }

    start(async () => {
      try {
        let receiptPath: string | null = null
        let receiptOriginal: string | null = null

        if (file) {
          const supabase = createClient()
          const { data: { user } } = await supabase.auth.getUser()
          if (!user) { setError('Not signed in.'); return }

          const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
          const base = `${user.id}/${showId}/${stamp}`
          const enhanced = await enhance(file)

          // Both files BEFORE the row: a row pointing at a failed upload is a
          // receipt that looks present and cannot be opened, and a receipt is
          // what makes an expense billable.
          const up1 = await supabase.storage.from('receipts')
            .upload(`${base}-enhanced.jpg`, enhanced, { contentType: 'image/jpeg' })
          if (up1.error) { setError(up1.error.message); return }

          const up2 = await supabase.storage.from('receipts')
            .upload(`${base}-original.jpg`, file, { contentType: file.type || 'image/jpeg' })
          if (up2.error) {
            await supabase.storage.from('receipts').remove([`${base}-enhanced.jpg`])
            setError(up2.error.message); return
          }

          receiptPath = `${base}-enhanced.jpg`
          receiptOriginal = `${base}-original.jpg`
        }

        const result = await addExpense({
          showId, category, whereSpent, amountCents: cents, spentOn,
          receiptPath, receiptOriginal, note: '',
        })
        if ('error' in result) { setError(result.error); return }

        setWhereSpent('')
        setAmount('')
        setFile(null)
        router.refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : 'That expense could not be saved.')
      }
    })
  }

  function remove(id: string) {
    setError(null)
    start(async () => {
      try {
        const result = await deleteExpense(id)
        if ('error' in result) { setError(result.error); return }
        router.refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : 'That expense could not be removed.')
      }
    })
  }

  return (
    <section className="mt-10">
      <div className="flex items-baseline justify-between">
        <h2 className="eyebrow">Expenses</h2>
        {expenses.length > 0 && (
          <p className="text-xs text-muted tabular">
            {formatUSD(total)}
            {missing > 0 && (
              <span className="text-danger">
                {' · '}{missing} {missing === 1 ? 'needs a receipt' : 'need receipts'}
              </span>
            )}
          </p>
        )}
      </div>

      {expenses.length === 0 ? (
        <p className="text-muted border-l-2 border-line pl-4 py-1 mt-3">No expenses yet.</p>
      ) : (
        <div className="border-t border-line mt-3">
          {expenses.map((e) => (
            <div key={e.id} className="flex items-center gap-3 py-2 border-b border-line text-sm">
              <span className="text-muted w-16 shrink-0 tabular">{formatDateShort(e.spent_on)}</span>
              <span className="text-muted w-32 shrink-0 truncate">{CATEGORY_LABEL[e.category]}</span>
              <span className="flex-1 truncate">{e.where_spent}</span>
              {!e.receipt_path && (
                <span className="text-xs text-danger shrink-0">no receipt</span>
              )}
              <span className="tabular shrink-0">{formatUSD(e.amount_cents)}</span>
              {!locked && (
                <button type="button" onClick={() => remove(e.id)} disabled={pending}
                        aria-label={`Remove ${e.where_spent}`}
                        className="text-muted hover:text-danger transition-colors text-lg leading-none">
                  ×
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {!locked && (
        <div className="mt-4 grid gap-2 sm:grid-cols-[8rem_1fr_7rem_9rem_auto] items-center">
          <select aria-label="Category" className={field} value={category} disabled={pending}
                  onChange={(e) => setCategory(e.target.value as ExpenseCategory)}>
            {CATEGORY_ORDER.map((c) => (
              <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>
            ))}
          </select>
          <input aria-label="Where" className={field} placeholder="Where" value={whereSpent}
                 disabled={pending} onChange={(e) => setWhereSpent(e.target.value)} />
          <input aria-label="Amount" inputMode="decimal" placeholder="0.00"
                 className={`${field} tabular text-right`} value={amount} disabled={pending}
                 onChange={(e) => setAmount(e.target.value)} />
          <input aria-label="Date" type="date" className={field} value={spentOn}
                 disabled={pending} onChange={(e) => setSpentOn(e.target.value)} />
          <button type="button" onClick={add} disabled={pending}
                  className="px-4 py-2 text-xs font-semibold uppercase tracking-wider rounded-field
                             border border-line text-muted hover:text-ink disabled:opacity-50">
            {pending ? 'Saving…' : '+ Add'}
          </button>

          <label className="sm:col-span-5 text-xs text-muted">
            {/* capture="environment" opens the camera directly on a phone, which
                is where a receipt actually gets photographed. */}
            <input type="file" accept="image/*" capture="environment" disabled={pending}
                   onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                   className="text-xs text-muted file:mr-3 file:px-3 file:py-1.5 file:rounded-field
                              file:border file:border-line file:bg-transparent file:text-muted
                              file:text-xs file:font-semibold file:uppercase file:tracking-wider" />
            {file ? ` ${file.name}` : ' A receipt is required before this show can be billed.'}
          </label>
        </div>
      )}

      {error && (
        <p role="alert" className="mt-3 text-sm text-danger border-l-2 border-danger pl-3 py-1">
          {error}
        </p>
      )}
    </section>
  )
}
```

- [ ] **Step 2: Render it on the show page**

In `app/shows/[id]/page.tsx`, add the import:

```tsx
import ExpenseLog from '@/components/ExpenseLog'
```

Add `expenses(id, category, where_spent, amount_cents, spent_on, receipt_path)` to
the show query's select list, and render it after the PM log:

```tsx
      <ExpenseLog
        showId={s.id}
        expenses={(s as unknown as { expenses?: never[] }).expenses ?? []}
        locked={s.status === 'billed'}
      />
```

Match the surrounding code: read how `PmLog` is rendered and mirror its
placement and prop shape rather than inventing a new one.

- [ ] **Step 3: Verify**

```bash
npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)" && npx tsc --noEmit && npm run build 2>&1 | grep -E "Compiled|Failed"
```

Expected: 98 passing, no type errors, compiles.

- [ ] **Step 4: Commit**

```bash
git add components/ExpenseLog.tsx "app/shows/[id]/page.tsx"
git commit -m "Photograph an expense on the show it belongs to."
```

---

### Task 6: The itemisation and the receipts in the PDF

**Files:**
- Modify: `lib/invoicePdf.ts` — expense pages
- Modify: `components/InvoiceDocument.tsx` — `DocumentData` gains `expenses`
- Modify: `app/invoices/[id]/page.tsx` and `app/invoices/actions.ts` — load expenses, fetch images
- Modify: `scripts/test/invoicePdf.test.ts` — the reconciliation test

**Interfaces:**
- Consumes: `CATEGORY_LABEL`, `CATEGORY_ORDER` from `lib/expenses.ts`; `signedReceiptUrls` from `app/expenses/actions.ts`.
- Produces: `DocumentData` gains
  `expenses?: { id, category, where_spent, amount_cents, spent_on, receiptDataUri: string | null }[]`

- [ ] **Step 1: Add expenses to the document type**

In `components/InvoiceDocument.tsx`, add to `DocumentData`:

```ts
  /**
   * Present only on an invoice generated from shows. The receipt image arrives
   * as a data URI, already fetched — the PDF renderer must not pull a dozen
   * remote URLs itself, which would serialise a dozen round trips inside a
   * function that has a timeout.
   */
  expenses?: {
    id: string
    category: 'meals' | 'rides' | 'baggage' | 'other'
    where_spent: string
    amount_cents: number
    spent_on: string
    receiptDataUri: string | null
  }[]
```

`InvoiceDocument` itself renders nothing new — the itemisation is a PDF concern,
and the on-screen invoice is the document a client reads, not its backup.

- [ ] **Step 2: Write the reconciliation test**

Append to `scripts/test/invoicePdf.test.ts`:

```ts
// The itemisation and the invoice lines are two views of the same money. Two
// views that can silently disagree is the failure this project keeps finding,
// so the reconciliation is a test rather than an intention.
test('the itemisation total equals the expense lines on the invoice', () => {
  const withExpenses: DocumentData = {
    ...INVOICE,
    subtotal_cents: 88621,
    total_cents: 88621,
    lines: [
      { id: 'l1', description: 'Meal Expenses', qty_hundredths: 100,
        unit_price_cents: 26621, line_total_cents: 26621 },
      { id: 'l2', description: 'Baggage Expenses', qty_hundredths: 100,
        unit_price_cents: 12000, line_total_cents: 12000 },
      { id: 'l3', description: 'Day Rate', qty_hundredths: 100,
        unit_price_cents: 50000, line_total_cents: 50000 },
    ],
    expenses: [
      { id: 'e1', category: 'meals', where_spent: 'The Well', amount_cents: 1998,
        spent_on: '2026-05-16', receiptDataUri: null },
      { id: 'e2', category: 'meals', where_spent: 'The Meritage', amount_cents: 24623,
        spent_on: '2026-05-21', receiptDataUri: null },
      { id: 'e3', category: 'baggage', where_spent: 'United', amount_cents: 6000,
        spent_on: '2026-05-16', receiptDataUri: null },
      { id: 'e4', category: 'baggage', where_spent: 'United', amount_cents: 6000,
        spent_on: '2026-05-21', receiptDataUri: null },
    ],
  }

  const all = textOf(buildInvoicePdf(PARTS, withExpenses, ASSETS))
  const joined = all.join(' ')

  assert.ok(joined.includes('The Well'), 'each expense is itemised')
  assert.ok(joined.includes('United'), 'including repeats of the same vendor')

  const expenseTotal = withExpenses.expenses!.reduce((t, e) => t + e.amount_cents, 0)
  assert.equal(expenseTotal, 26621 + 12000, 'the fixture itself reconciles')
  assert.ok(joined.includes(formatUSD(expenseTotal)), 'and the page prints that total')
})

test('an invoice with no expenses gains no itemisation', () => {
  const joined = textOf(buildInvoicePdf(PARTS, INVOICE, ASSETS)).join(' ')
  assert.ok(!/itemis|receipt/i.test(joined), 'no expense page on a plain invoice')
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run:

```bash
npm test 2>&1 | tail -12
```

Expected: FAIL — the itemisation is not rendered yet, so `The Well` is absent.

- [ ] **Step 4: Render the pages**

In `lib/invoicePdf.ts`, add the import:

```ts
import { CATEGORY_LABEL, CATEGORY_ORDER } from './expenses.ts'
```

Add these styles to the `s` object:

```ts
  expenseHead: { fontFamily: 'Oswald', fontSize: 12, marginBottom: 10 },
  expenseCat: { fontSize: 9, color: MUTED, letterSpacing: 1, marginTop: 12, marginBottom: 4 },
  expenseRow: {
    flexDirection: 'row', justifyContent: 'space-between',
    borderBottomWidth: 1, borderBottomColor: LINE, paddingVertical: 4,
  },
  expenseSub: {
    flexDirection: 'row', justifyContent: 'space-between',
    paddingTop: 4, fontSize: 9, color: MUTED_DARK,
  },
  expenseTotal: {
    flexDirection: 'row', justifyContent: 'space-between',
    borderTopWidth: 2, borderTopColor: INK, paddingTop: 8, marginTop: 12,
  },
  receiptPage: { backgroundColor: PAPER, padding: 40 },
  receiptCaption: { fontSize: 8, color: MUTED, marginBottom: 4 },
  receiptImage: { width: '100%', objectFit: 'contain', marginBottom: 20 },
```

`buildInvoicePdf` is one expression: it declares local `T` and `V` helpers over
`parts`, then `return h(Document, null, h(Page, ...))`. Declare `expensePages`
**above that return**, alongside `billTo`, and then spread it into the
`Document` after the existing page:

```ts
  return h(Document, null, h(Page, { size: 'LETTER', style: s.page }, ...[…]), ...expensePages)
```

`T`, `V` and `h` are already in scope there — `T(style, children)` and
`V(style, childrenArray)` are defined inside this function, not imported. The
declaration:

```ts
  const expenses = data.expenses ?? []
  const expenseTotal = expenses.reduce((t, e) => t + e.amount_cents, 0)

  // Only when there is something to show. An invoice not generated from shows
  // has no expenses and gains no pages at all.
  const expensePages = expenses.length === 0 ? [] : [
    h(Page, { size: 'LETTER', style: s.page },
      V(s.body, [
        T(s.expenseHead, `EXPENSES — INVOICE #${data.number}`),
        ...CATEGORY_ORDER.flatMap((cat) => {
          const rows = expenses.filter((e) => e.category === cat)
          if (rows.length === 0) return []
          const subtotal = rows.reduce((t, e) => t + e.amount_cents, 0)
          return [
            T(s.expenseCat, CATEGORY_LABEL[cat].toUpperCase()),
            ...rows.map((e) =>
              V(s.expenseRow, [
                T(null, `${formatDateLong(e.spent_on)}  ${e.where_spent}`),
                T(null, formatUSD(e.amount_cents)),
              ]),
            ),
            V(s.expenseSub, [T(null, 'Subtotal'), T(null, formatUSD(subtotal))]),
          ]
        }),
        V(s.expenseTotal, [
          T(s.grandLabel, 'TOTAL EXPENSES'),
          T({ fontSize: 12 }, formatUSD(expenseTotal)),
        ]),
      ]),
    ),

    // One page per receipt: a receipt scaled to fit a shared page is unreadable,
    // and unreadable backup is the same as none.
    ...expenses
      .filter((e) => e.receiptDataUri)
      .map((e) =>
        h(Page, { size: 'LETTER', style: s.receiptPage },
          T(s.receiptCaption,
            `${CATEGORY_LABEL[e.category]} · ${e.where_spent} · ${formatUSD(e.amount_cents)} · ${formatDateLong(e.spent_on)}`),
          h(Image, { src: e.receiptDataUri as string, style: s.receiptImage }),
        ),
      ),
  ]
```

Children are spread as variadic arguments throughout this file — an array child
makes React warn about keys on every render, and the existing comment in
`buildInvoicePdf` says so explicitly. `V` takes its children as an array and
spreads them for you; `h(Page, props, ...)` takes them variadically. Follow
those two helpers rather than introducing a third pattern.

- [ ] **Step 5: Fetch the images where the document is built**

In `app/invoices/[id]/page.tsx` and `app/invoices/actions.ts`, load the invoice's
expenses through its shows, then fetch each receipt to a data URI **in parallel**
before building the document:

```ts
// Fetched here, not by the PDF renderer: letting it pull a dozen remote URLs
// would serialise a dozen round trips inside a function with a timeout — the
// send would work on a two-receipt invoice and fail on a twelve-receipt one.
const paths = rows.map((e) => e.receipt_path).filter(Boolean) as string[]
const urls = await signedReceiptUrls(paths)
const withImages = await Promise.all(rows.map(async (e) => {
  const url = e.receipt_path ? urls[e.receipt_path] : null
  if (!url) return { ...e, receiptDataUri: null }
  try {
    const res = await fetch(url)
    if (!res.ok) return { ...e, receiptDataUri: null }
    const buf = Buffer.from(await res.arrayBuffer())
    return { ...e, receiptDataUri: `data:image/jpeg;base64,${buf.toString('base64')}` }
  } catch {
    // A missing image must not lose the invoice. The itemisation still lists
    // the expense; only the picture is absent.
    return { ...e, receiptDataUri: null }
  }
}))
```

- [ ] **Step 6: Verify**

```bash
npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)" && npx tsc --noEmit && npm run build 2>&1 | grep -E "Compiled|Failed"
npm run pdf:sample && sips -s format png tmp/invoice-deposit.pdf --out tmp/check.png
```

Expected: **100 passing** (98 + 2), no type errors, compiles, and the sample
still renders.

- [ ] **Step 7: Commit**

```bash
git add lib/invoicePdf.ts components/InvoiceDocument.tsx "app/invoices/[id]/page.tsx" app/invoices/actions.ts scripts/test/invoicePdf.test.ts
git commit -m "Attach the itemisation and the receipts to the invoice."
```

---

## Verification

- `npm test` — 100 passing.
- `npx tsc --noEmit` clean; `npm run build` compiles.
- `anon` holds zero privileges on `expenses`; the `receipts` bucket is private.
- A show with a receiptless expense refuses to bill and names it.
- The itemisation total equals the sum of the expense lines.

## Manual verification, on the test client

Not part of any task. Use `ZZ TEST — Dan Smith`, then delete it.

1. Create a show, add a day, photograph anything as a receipt for $8.21 at "HMS Host".
2. Confirm the expense lists with its amount and no "no receipt" warning.
3. Add a second expense with **no** photo; confirm the Bill button refuses and names it.
4. Photograph it; confirm billing proceeds and produces `Meal Expenses ×1`.
5. Download the PDF: invoice, then the itemisation, then one page per receipt.
6. Confirm the receipt is legible and the contrast pass has not erased anything.

## Blast radius

Additive. One table, one bucket, one new route file, one component. No existing
row is modified. The invoice PDF gains pages only when an invoice has expenses,
so all 105 historical invoices render exactly as they do today.
