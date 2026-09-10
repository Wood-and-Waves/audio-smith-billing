# Receipt Backfill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Attach a year of emailed receipts to the bank rows they belong to, auto-filing only what is unambiguous.

**Architecture:** A thin imperative import script around pure, `node --test`-able modules — the `scripts/import/ynab-backfill.mjs` shape. PDFs are read as text (no OCR), split per page with `pdf-lib`, matched on exact amount within 4 days, and either filed to the bank row or queued into `receipt_inbox`.

**Tech Stack:** TypeScript, Node's built-in test runner, `pdfjs-dist` (text layer), `pdf-lib` (page split), `pg`, Supabase Storage, the Anthropic API for the page map.

**Spec:** `docs/superpowers/specs/2026-09-10-receipt-backfill-design.md`

## Global Constraints

- `lib/*.ts` modules are PURE: no `@/` imports, no JSX, relative `.ts` imports (`import { addDays } from './dates.ts'`), and **no clock reads** — `today` is always a parameter.
- Tests are `node --test` only, in `scripts/test/<module>.test.ts`. Run with bare `npm test` — **never piped**.
- The type gate is a COLD `rm -f tsconfig.tsbuildinfo .next/cache/.tsbuildinfo && npx tsc --noEmit`. `npm test` does not type-check.
- `npm run build` must pass. **Never `npm run dev`.**
- Migrations are ADDITIVE (the 0020 rule) and **go to prod BEFORE the branch merges**.
- Money is integer cents everywhere. `pg.types.setTypeParser(20, Number)` in any script.
- Import scripts: dry run by DEFAULT, `--commit` to write, `--prod` prints the target before doing anything.

---

### Task 1: `lib/expenseManifest.ts` — parse his expense spreadsheet

**Files:**
- Create: `lib/expenseManifest.ts`
- Test: `scripts/test/expenseManifest.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `parseExpenseManifest(rows: readonly (readonly ManifestCell[])[]): ManifestParse`, with
  `ManifestCell = { x: number; text: string }`,
  `ManifestItem = { vendor: string; amountCents: number; column: 'food' | 'ride' | 'baggage' }`
  and `ManifestParse = { items: ManifestItem[]; totals: { food: number; ride: number; baggage: number; stated: number | null }; foots: boolean }`.

**CORRECTED 2026-09-10, mid-implementation.** This plan originally specified
`(textLines: readonly string[])`. That interface CANNOT work, and the reason is
worth keeping: with the Ride column empty — which it is on every bundle examined
— the flattened line

    The Well $19.98 United $60.00

is ambiguous. The second amount could be Ride or Baggage, and only its x
position (564, under Baggage's Amount anchor at 560) decides. Text alone loses
the columns the whole document is built on.

So the module takes POSITIONED cells: one array per visual row, each cell
`{ x, text }`, x ascending — exactly what `page.getTextContent()` yields when
items are grouped by rounded `transform[5]` and sorted by `transform[4]`.
Reading the PDF still stays outside this module.

**Column assignment is by nearest anchor, never by fixed coordinates.** The two
bundles use different scales (Praxis's Food amounts sit at x≈204, IllumiNations'
at x≈164), so anchors must be read from the page:
- The `Where / Amount / Rcpt` row gives three groups of sub-anchors, in x order:
  food, ride, baggage. A data cell belongs to the group minimising
  `min(|x - whereX|, |x - amountX|)`.
- The `Food Total / Ride Total / Baggage Total [/ Total]` row gives the anchors
  for the stated-totals row directly beneath it. The fourth `Total` column is
  OPTIONAL — Praxis has it, IllumiNations does not.
- Within a row and group: the cell matching `/^\$[\d,]+\.\d{2}$/` is the
  amount; the remaining cells joined with a space are the vendor.

- [ ] **Step 1: Write the failing tests**

```ts
// Parsing the expense spreadsheet Dan attaches to an invoice.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseExpenseManifest } from '../../lib/expenseManifest.ts'

// Praxis page 1 and IllumiNations page 2, captured verbatim from pdfjs on
// 2026-09-10. Do not tidy these: the differing x scales are the point, and
// "United $10.00" on the last Praxis row is an inflight snack sitting in the
// FOOD column, which is why column comes from position and never from a name.
const c = (x: number, text: string): ManifestCell => ({ x, text })

const PRAXIS: ManifestCell[][] = [
  [c(153, "Food Total"), c(351, "Ride Total"), c(507, "Baggage Total"), c(671, "Total")],
  [c(160, "$266.21"), c(363, "$0.00"), c(523, "$120.00"), c(665, "$386.21")],
  [c(111, "Where"), c(200, "Amount"), c(260, "Rcpt"), c(308, "Where"), c(380, "Amount"), c(440, "Rcpt"), c(488, "Where"), c(560, "Amount"), c(620, "Rcpt")],
  [c(106, "The Well"), c(204, "$19.98"), c(489, "United"), c(564, "$60.00")],
  [c(96, "Auntie Anne's"), c(204, "$12.28"), c(489, "United"), c(564, "$60.00")],
  [c(81, "Meritage Blend Cafe"), c(206, "$8.98")],
  [c(81, "Meritage Blend Cafe"), c(206, "$8.98")],
  [c(92, "Butters Burgers"), c(204, "$35.23")],
  [c(81, "The Meritage Resort"), c(204, "$24.38")],
  [c(97, "Ben & Jerry's"), c(204, "$12.65")],
  [c(81, "The Meritage Resort"), c(204, "$62.20")],
  [c(81, "The Meritage Resort"), c(204, "$24.38")],
  [c(81, "The Meritage Resort"), c(204, "$47.15")],
  [c(111, "United"), c(204, "$10.00")],
]

// No fourth "Total" column, and a different x scale entirely.
const ILLUMINATIONS: ManifestCell[][] = [
  [c(124, "Food Total"), c(295, "Ride Total"), c(433, "Baggage Total")],
  [c(130, "$190.34"), c(305, "$0.00"), c(447, "$120.00")],
  [c(86, "Where"), c(160, "Amount"), c(214, "Rcpt"), c(256, "Where"), c(320, "Amount"), c(373, "Rcpt"), c(416, "Where"), c(480, "Amount"), c(533, "Rcpt")],
  [c(79, "Empanada"), c(164, "$13.39"), c(416, "United"), c(483, "$60.00")],
  [c(62, "Dave's Hot Chicken"), c(164, "$23.09"), c(416, "United"), c(483, "$60.00")],
  [c(84, "Fiddlers"), c(164, "$67.25")],
  [c(76, "Dairy Queen"), c(166, "$7.90")],
  [c(64, "Southern Grounds"), c(166, "$5.18")],
  [c(74, "Auntie Annes"), c(164, "$11.16")],
  [c(85, "Hudson"), c(164, "$31.19")],
  [c(80, "Starbucks"), c(166, "$4.76")],
  [c(80, "Starbucks"), c(164, "$12.14")],
  [c(80, "Starbucks"), c(166, "$4.76")],
  [c(80, "Starbucks"), c(166, "$4.76")],
  [c(80, "Starbucks"), c(166, "$4.76")],
]

test('every line is read, with its amount in cents', () => {
  const m = parseExpenseManifest(PRAXIS)
  assert.equal(m.items.length, 13)
  assert.deepEqual(m.items[0], { vendor: 'The Well', amountCents: 1998, column: 'food' })
})

test('a bundle with no fourth Total column reads the same way', () => {
  const m = parseExpenseManifest(ILLUMINATIONS)
  assert.equal(m.items.length, 14)
  assert.equal(m.totals.food, 19034)
  assert.equal(m.totals.baggage, 12000)
  assert.equal(m.totals.stated, null)
  assert.equal(m.foots, true)
})

test('the columns foot, which is the check the whole backfill leans on', () => {
  const m = parseExpenseManifest(PRAXIS)
  assert.equal(m.totals.food, 26621)
  assert.equal(m.totals.baggage, 12000)
  assert.equal(m.totals.ride, 0)
  assert.equal(m.foots, true)
})

test('the two baggage lines are baggage and the inflight United is food', () => {
  const m = parseExpenseManifest(PRAXIS)
  const bags = m.items.filter(i => i.column === 'baggage')
  assert.equal(bags.length, 2)
  assert.ok(bags.every(b => b.amountCents === 6000))
  assert.ok(m.items.some(i => i.column === 'food' && i.amountCents === 1000))
})

test('a table that does not foot says so rather than throwing', () => {
  const bad = PRAXIS.map(r => [...r])
  bad[1][0] = c(160, '$999.99')
  const m = parseExpenseManifest(bad)
  assert.equal(m.foots, false)
  assert.equal(m.items.length, 13)
})

test('an empty page is empty, not an error', () => {
  const m = parseExpenseManifest([])
  assert.deepEqual(m.items, [])
  assert.equal(m.foots, false)
})

test('a page that is not a manifest at all yields nothing', () => {
  const m = parseExpenseManifest([[c(70, 'Thanks!')], [c(70, 'Dan Smith')]])
  assert.deepEqual(m.items, [])
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../../lib/expenseManifest.ts'`.

- [ ] **Step 3: Implement**

Parse rules, in order:
1. Find the header row containing a `Food Total` cell — anything before it is
   noise. Record each header cell's x as that column's total-anchor.
2. The next row holds the stated totals; assign each to the nearest
   total-anchor. A fourth `Total` anchor, when present, fills `totals.stated`.
3. Find the `Where / Amount / Rcpt` row and record three groups of sub-anchors
   in x order: food, ride, baggage.
4. For every row after it, assign each cell to the group minimising
   `min(|x - whereX|, |x - amountX|)`. Within a row+group, the money-shaped cell
   is the amount and the rest joined by a space is the vendor. A group with no
   amount yields no item.
5. `foots` is `items summed per column === stated totals per column`.

Return zeros and an empty list for any page without the header row.

- [ ] **Step 4: Green**

Run: `npm test` — all pass, output pristine.

- [ ] **Step 5: Commit**

```bash
git add lib/expenseManifest.ts scripts/test/expenseManifest.test.ts
git commit -m "Parse the expense spreadsheet Dan attaches to an invoice"
```

---

### Task 2: The auto-file rule

**Files:**
- Create: `lib/receiptAutoFile.ts`
- Test: `scripts/test/receiptAutoFile.test.ts`
- **Do NOT touch `lib/receiptMatch.ts`.** `RECEIPT_MATCH_DAYS` stays at 10.

**Interfaces:**
- Consumes: `ReceiptMatch` from `./receiptMatch.ts`.
- Produces: `decideReceiptFiling(matches: readonly ReceiptMatch[]): FilingDecision`
  where `FilingDecision = { action: 'file'; txnId: string } | { action: 'queue'; reason: 'no-charge' | 'ambiguous' | 'taken' }`.

The window is NOT changing. Dan considered 4 days and settled on keeping 10,
and measurement says it makes no difference here: both real bundles give
identical results at ±4 and ±10 (IllumiNations 6/2/6, Praxis 10/3/0), because
the candidate set is already bounded by the show's own window.

- [ ] **Step 1: Write the failing tests**

```ts
// Deciding whether a receipt files itself or waits for Dan.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideReceiptFiling } from '../../lib/receiptAutoFile.ts'
import { type ReceiptMatch } from '../../lib/receiptMatch.ts'

const match = (o: Partial<ReceiptMatch> & { txnId: string }): ReceiptMatch => ({
  date: '2026-05-18', payee: 'The Well', amountCents: 1998,
  daysApart: 0, alreadyHasReceipt: false, ...o,
})

test('one clean candidate files itself', () => {
  assert.deepEqual(decideReceiptFiling([match({ txnId: 't1' })]),
    { action: 'file', txnId: 't1' })
})

test('no candidate waits — a prepaid Starbucks receipt has no bank row at all', () => {
  assert.deepEqual(decideReceiptFiling([]), { action: 'queue', reason: 'no-charge' })
})

test('two candidates is a genuine tie and waits', () => {
  // Two Auntie Anne's charges four days apart, both $11.16. Real case.
  const d = decideReceiptFiling([match({ txnId: 'a' }), match({ txnId: 'b', daysApart: 4 })])
  assert.deepEqual(d, { action: 'queue', reason: 'ambiguous' })
})

test('a row that already carries a receipt is never overwritten', () => {
  const d = decideReceiptFiling([match({ txnId: 't1', alreadyHasReceipt: true })])
  assert.deepEqual(d, { action: 'queue', reason: 'taken' })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../../lib/receiptAutoFile.ts'`.

- [ ] **Step 3: Implement `lib/receiptAutoFile.ts`**

```ts
// Whether a receipt files itself, or waits for Dan.
//
// The rule is deliberately narrow. Dan's decision (2026-09-10) was "auto-file
// exact matches, queue the rest", and the measurement behind it matters: six of
// IllumiNations' fourteen receipts have NO bank row, because a single $25.00
// Starbucks card reload covers five of them. A receipt with no charge is a
// normal outcome, never a near-miss to force onto the closest row.
//
// Pure: no database, no clock.

import { type ReceiptMatch } from './receiptMatch.ts'

export type FilingDecision =
  | { action: 'file'; txnId: string }
  | { action: 'queue'; reason: 'no-charge' | 'ambiguous' | 'taken' }

export function decideReceiptFiling(matches: readonly ReceiptMatch[]): FilingDecision {
  if (matches.length === 0) return { action: 'queue', reason: 'no-charge' }
  if (matches.length > 1) return { action: 'queue', reason: 'ambiguous' }
  const only = matches[0]
  if (only.alreadyHasReceipt) return { action: 'queue', reason: 'taken' }
  return { action: 'file', txnId: only.txnId }
}
```

- [ ] **Step 4: Green**

Run: `npm test` — all pass, output pristine. `receiptMatch.test.ts` is untouched
and its 10/11-day boundary tests still pass.

- [ ] **Step 5: Commit**

```bash
git add lib/receiptAutoFile.ts scripts/test/receiptAutoFile.test.ts
git commit -m "Auto-file only an unambiguous receipt"
```

---

### Task 3: `lib/receiptPageMap.ts` — validate the page identification

**Files:**
- Create: `lib/receiptPageMap.ts`
- Test: `scripts/test/receiptPageMap.test.ts`

**Interfaces:**
- Produces: `PAGE_MAP_SCHEMA` (the structured-output schema), and
  `readPageMap(raw: unknown, opts: { pageCount: number }): { pages: PageEntry[] } | { error: string }`
  where `PageEntry = { page: number; vendor: string; amountCents: number }`.

The model call itself lives in the script, the way `ynab-backfill.mjs` keeps its
I/O in the shell. This module is the schema plus the validator, so the fragile
part is pinned by tests.

- [ ] **Step 1: Write the failing tests**

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readPageMap } from '../../lib/receiptPageMap.ts'

const ok = { pages: [
  { page: 3, vendor: 'Starbucks', amount: '4.76' },
  { page: 4, vendor: 'Dairy Queen', amount: '7.90' },
] }

test('a good map reads through, amounts in cents', () => {
  const r = readPageMap(ok, { pageCount: 16 })
  assert.ok(!('error' in r))
  assert.deepEqual(r.pages[0], { page: 3, vendor: 'Starbucks', amountCents: 476 })
})

test('a page beyond the document is refused', () => {
  const r = readPageMap({ pages: [{ page: 99, vendor: 'x', amount: '1.00' }] }, { pageCount: 16 })
  assert.ok('error' in r)
  assert.match(r.error, /page/i)
})

test('the same page claimed twice is refused', () => {
  const dup = { pages: [ok.pages[0], { ...ok.pages[0] }] }
  const r = readPageMap(dup, { pageCount: 16 })
  assert.ok('error' in r)
  assert.match(r.error, /twice|duplicate/i)
})

test('junk is an error, never a throw', () => {
  for (const bad of [null, {}, { pages: 'no' }, { pages: [{ page: 1 }] }]) {
    assert.ok('error' in readPageMap(bad, { pageCount: 4 }))
  }
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Reuse `normalizeAmountCents` from `./receiptExtraction.ts` rather than writing a
second money parser. Reject: a non-array `pages`, a missing field, a page below
1 or above `pageCount`, a duplicate page, an unparseable amount.

- [ ] **Step 4: Green, then commit**

```bash
npm test
git add lib/receiptPageMap.ts scripts/test/receiptPageMap.test.ts
git commit -m "Validate the page map before a receipt image is trusted"
```

---

### Task 4: Migration 0052 — one email, many receipts

**Files:**
- Create: `scripts/sql/migrations/0052_receipt_inbox_part.sql`

Queued receipts belong in `/money/receipts`, where Dan already files by hand.
`receipt_inbox_msg_uniq` is `unique (owner_id, gmail_message_id)`, so one email
cannot yield many rows today.

- [ ] **Step 1: Write the migration**

```sql
-- 0052 — one email can hold many receipts
--
-- 0050 assumed one forwarded receipt per email, and its unique key says so:
-- (owner_id, gmail_message_id). That is wrong for the way Dan actually sends
-- expenses to a client — IllumiNations is ONE 16-page PDF holding an invoice
-- and fourteen receipts.
--
-- `part` is the index of a receipt within its message. Existing rows keep 0 and
-- their uniqueness is unchanged; the widened key is what lets a bundle explode.
-- ADDITIVE, per the 0020 rule: no column is dropped and no row is rewritten.

alter table receipt_inbox add column part int not null default 0;

comment on column receipt_inbox.part is
  'Index of this receipt within its Gmail message. 0 for a message that carried a single receipt, which is every row written before migration 0052.';

alter table receipt_inbox drop constraint receipt_inbox_msg_uniq;
alter table receipt_inbox add constraint receipt_inbox_msg_uniq
  unique (owner_id, gmail_message_id, part);
```

- [ ] **Step 2: Apply to DEV and confirm**

```bash
npm run db:migrate
```

- [ ] **Step 3: Apply to PROD — this happens BEFORE the branch merges**

```bash
npm run db:migrate -- --prod
```

- [ ] **Step 4: Commit**

```bash
git add scripts/sql/migrations/0052_receipt_inbox_part.sql
git commit -m "Let one email hold many receipts (0052)"
```

---

### Task 5: `scripts/import/receipt-backfill.mjs`

**Files:**
- Create: `scripts/import/receipt-backfill.mjs`
- Create: `scripts/import/out/receipt-bundles-2026.json` (gitignored — real billing data)

**Interfaces:**
- Consumes: `parseExpenseManifest`, `decideReceiptFiling`, `readPageMap`,
  `proposeReceiptMatches`, `RECEIPT_MATCH_DAYS` (unchanged, 10).

**Only Streamline bundles carry a spreadsheet.** Every other client reimburses
travel only and settles the rest by per diem, so their bundles hold a few
airline/baggage/rideshare documents and no manifest — those queue whole. A
non-Streamline show having no meal receipts is correct, not a gap.

Read `scripts/import/ynab-backfill.mjs` first and follow its shape exactly.
Import pure modules by relative path; `lib/gmail.ts` is `import 'server-only'`
and **cannot be imported here** — do the token refresh and attachment fetch
inline against `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` / `GMAIL_REFRESH_TOKEN`.

The input JSON lists each bundle: `{ gmailMessageId, attachmentMatch, show,
windowStart, windowEnd }`.

- [ ] **Step 1: Fetch and read**

For each bundle: refresh a Gmail token, walk the message payload for the
attachment whose filename matches, download it, and read every page's text with
`pdfjs-dist/legacy/build/pdf.mjs` (`getTextContent`, grouping items into visual
lines by rounded `transform[5]`, sorted by `transform[4]`).

- [ ] **Step 2: Parse and verify**

Run each page through `parseExpenseManifest`; the manifest page is the first that
returns items. **If `foots` is false, skip the whole bundle and report it.** A
bundle we cannot verify is never partially filed.

- [ ] **Step 3: Map pages to receipts**

Send the bundle PDF to the model as a `document` content block with
`PAGE_MAP_SCHEMA`, then `readPageMap(raw, { pageCount })`. If it errors, or its
entry count disagrees with the manifest's item count, queue the whole bundle.

- [ ] **Step 4: Match and decide**

For each manifest item, pull candidate charges from `ledger_transactions`
(`kind = 'expense'`, dated `windowStart - RECEIPT_MATCH_DAYS` to
`windowEnd + RECEIPT_MATCH_DAYS`), call `proposeReceiptMatches`, then
`decideReceiptFiling`. **Claim a matched row so a later item cannot match it
twice** — two Starbucks receipts at $4.76 must not both file to one charge.

- [ ] **Step 5: Split, upload, write**

Extract the receipt's page with `pdf-lib` (`PDFDocument.copyPages`), upload to
the `receipts` bucket under `{owner_id}/backfill/`, then:
- `action: 'file'` → set `receipt_original` (and `receipt_path` only when the
  file is an image) on the bank row, exactly as `fileReceiptToTransaction` does.
- `action: 'queue'` → insert a `receipt_inbox` row with `status 'new'`, the
  bundle's `gmail_message_id`, the item's index as `part`, and the split page as
  `primary_path`.

Dry run prints all of this and writes nothing.

- [ ] **Step 6: Verify against prod, then commit**

```bash
node --env-file=.env.local scripts/import/receipt-backfill.mjs --prod
```

Expect, from the two bundles already measured: Praxis 10 filed / 3 queued / 0
missing, IllumiNations 6 filed / 2 queued / 6 no-charge. **If those numbers
differ, stop and find out why before committing** — they were measured directly
against prod on 2026-09-10.

```bash
node --env-file=.env.local scripts/import/receipt-backfill.mjs --prod --commit
git add scripts/import/receipt-backfill.mjs
git commit -m "Backfill a year of receipts onto the bank rows they belong to"
```

---

## Verification

1. `npm test` — bare, never piped. Every new module's tests pass, output pristine.
2. Cold type gate: `rm -f tsconfig.tsbuildinfo .next/cache/.tsbuildinfo && npx tsc --noEmit`
3. `npm run build`. **Never `npm run dev`.**
4. Prod migration 0052 applied BEFORE merge; confirm with
   `npm run db:sql -- --prod` on a file selecting `part` from `receipt_inbox`.
5. Dry run against prod matches the measured counts above.
6. After `--commit`: every filed bank row has a `receipt_original` under
   `{owner_id}/backfill/`; no row that already had a receipt was touched;
   `receipt_inbox` holds one `status 'new'` row per queued item.
7. Open `/money/receipts` and confirm the queued items render and file by hand.

## Risks

- **This writes to Dan's live books.** The dry run is not optional.
- A wrong page map attaches the wrong image to a real charge. That is why the
  map is validated, the manifest must foot, and a disagreeing count queues the
  whole bundle rather than guessing.
