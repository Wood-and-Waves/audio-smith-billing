# Ledger Spine ("Money") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Money section — one business-checking ledger with manual entry, OFX/QFX import with YNAB-grade dedupe, an editable S-Corp category chart, show tagging, and reconcile — per `docs/superpowers/specs/2026-08-18-ledger-spine-design.md`.

**Architecture:** Migration 0027 (controller-applied, DEV only). Pure libs carry all logic that can be pure: the category seed, balance math, the OFX parser, and the import matcher — each `node --test`ed. Server actions in `app/money/actions.ts` follow the repo's owner-scoped patterns (mirror `app/expenses/actions.ts`). UI is `/money` (register + import + reconcile) and `/money/categories`, plus a `Money` nav item.

**Model tiering (Dan's directive):** exact-code tasks → cheapest model; logic/integration/UI → mid-tier; final whole-branch review → most capable. Task reviews mid-tier.

**Tech Stack:** Next.js 16 App Router, TypeScript, Supabase. Gates: `npm test`, and `npx tsc --noEmit` + `npm run build` **after `rm -f tsconfig.tsbuildinfo .next/cache/.tsbuildinfo`** (stale-cache false passes have bitten this repo).

## Global Constraints

- **Money is Dan's view only** — nothing here may touch any client-facing surface (invoices, PDFs, public links, emails).
- **Reconciled rows are locked server-side** — update/delete actions refuse `cleared='reconciled'`.
- **Re-import is a no-op**: unique partial index on `(owner_id, account_id, import_id) where import_id is not null`, and the matcher never proposes an import_id that already exists on the account.
- Integer cents (signed: + in / − out); plain `YYYY-MM-DD` dates; sign-vs-kind DB checks (income > 0; expense/owner_pay < 0; owner_pay/transfer ⇒ category null).
- Pure libs: no `@/`/JSX/server-only; relative imports; tests use relative `.ts` paths.
- RLS/grants per repo pattern (see `scripts/sql/migrations/0013_rate_cards.sql:38-44`).
- Migration 0027 is applied by the controller to DEV before Task 2 dispatch; never edit an applied migration.

---

### Task 1 (CONTROLLER): Migration 0027

Written and applied by the controller (schema below is the contract for every later task). Tables: `ledger_accounts`, `ledger_categories`, `ledger_transactions`, `ledger_reconciliations` exactly per the spec's Schema section, each with the standard RLS block, plus the unique partial import_id index and the sign/kind check constraints.

---

### Task 2 (cheap model): Category seed + balance math (pure, exact code)

**Files:** Create `lib/ledgerCategories.ts`, `lib/ledgerBalance.ts`; Test `scripts/test/ledgerCategories.test.ts`, `scripts/test/ledgerBalance.test.ts`.

- [ ] **Step 1:** `lib/ledgerCategories.ts` — verbatim:

```ts
// The seed chart of accounts for an S-Corp audio business. A STARTING POINT,
// not doctrine: every row is editable/hideable in /money/categories, and
// Dan's CPA's own chart reshapes it when he gets it. Income categories are
// not deductions, so they carry deductible: false; owner pay is a
// transaction KIND (with a null category), so it has no category here.
//
// No '@/' imports and no JSX — exercised by node --test.

export type CategorySeed = {
  name: string
  grp: string
  sort: number
  deductible: boolean
  is_equipment: boolean
}

const c = (
  name: string, grp: string, sort: number,
  deductible = true, is_equipment = false,
): CategorySeed => ({ name, grp, sort, deductible, is_equipment })

export const DEFAULT_CATEGORIES: CategorySeed[] = [
  c('Show Income', 'Income', 0, false),
  c('Other Income', 'Income', 1, false),
  c('Equipment & Gear', 'Operations', 10, true, true),
  c('Supplies', 'Operations', 11),
  c('Software & Subscriptions', 'Operations', 12),
  c('Phone', 'Operations', 13),
  c('Internet', 'Operations', 14),
  c('Airfare', 'Travel', 20),
  c('Lodging', 'Travel', 21),
  c('Meals', 'Travel', 22),
  c('Ground Transport', 'Travel', 23),
  c('Baggage', 'Travel', 24),
  c('Parking & Tolls', 'Travel', 25),
  c('Insurance', 'Business', 30),
  c('Professional Fees', 'Business', 31),
  c('Bank Fees', 'Business', 32),
  c('Licenses & Dues', 'Business', 33),
  c('Advertising', 'Business', 34),
  c('Education', 'Business', 35),
  c('Home Office Reimbursement', 'Business', 36),
]
```

- [ ] **Step 2:** `lib/ledgerBalance.ts` — verbatim:

```ts
// Balance math for the register header and reconcile. Pure integer cents.
//
// Working balance counts every transaction — it answers "what will the bank
// say once everything lands". Cleared balance counts only what the bank has
// confirmed (cleared or reconciled) — it is the number reconcile compares to
// the statement. No '@/' imports and no JSX — exercised by node --test.

export type BalanceLike = {
  amount_cents: number
  cleared: 'uncleared' | 'cleared' | 'reconciled'
}

export function workingBalance(openingCents: number, txns: BalanceLike[]): number {
  return txns.reduce((t, x) => t + x.amount_cents, openingCents)
}

export function clearedBalance(openingCents: number, txns: BalanceLike[]): number {
  return txns.reduce(
    (t, x) => t + (x.cleared === 'uncleared' ? 0 : x.amount_cents), openingCents)
}
```

- [ ] **Step 3:** Tests — verbatim. `scripts/test/ledgerCategories.test.ts`:

```ts
// The seed chart is data, but data the whole Money section trusts: groups
// drive the editor's sections, deductible drives future CPA reporting, and
// is_equipment surfaces §179 candidates. Pin its shape.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_CATEGORIES } from '../../lib/ledgerCategories.ts'

test('every category has a non-blank name and group', () => {
  for (const cat of DEFAULT_CATEGORIES) {
    assert.ok(cat.name.trim().length > 0)
    assert.ok(cat.grp.trim().length > 0)
  }
})

test('names are unique', () => {
  const names = DEFAULT_CATEGORIES.map((c) => c.name)
  assert.equal(new Set(names).size, names.length)
})

test('income categories are never deductions', () => {
  for (const cat of DEFAULT_CATEGORIES.filter((c) => c.grp === 'Income')) {
    assert.equal(cat.deductible, false, cat.name)
  }
})

test('exactly Equipment & Gear carries the equipment flag', () => {
  const flagged = DEFAULT_CATEGORIES.filter((c) => c.is_equipment)
  assert.deepEqual(flagged.map((c) => c.name), ['Equipment & Gear'])
})

test('sort orders are unique so the editor renders deterministically', () => {
  const sorts = DEFAULT_CATEGORIES.map((c) => c.sort)
  assert.equal(new Set(sorts).size, sorts.length)
})
```

`scripts/test/ledgerBalance.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { workingBalance, clearedBalance } from '../../lib/ledgerBalance.ts'

const T = (amount_cents: number, cleared: 'uncleared' | 'cleared' | 'reconciled') =>
  ({ amount_cents, cleared })

test('working balance counts everything, cleared balance skips uncleared', () => {
  const txns = [T(60000, 'reconciled'), T(-4253, 'cleared'), T(-10000, 'uncleared')]
  assert.equal(workingBalance(1000, txns), 46747)
  assert.equal(clearedBalance(1000, txns), 56747)
})

test('no transactions: both balances are the opening balance', () => {
  assert.equal(workingBalance(123456, []), 123456)
  assert.equal(clearedBalance(123456, []), 123456)
})
```

- [ ] **Step 4:** `npm test` — all green (new tests pass; suite count rises). Then clear TS caches; `npx tsc --noEmit` and `npm run build` clean.
- [ ] **Step 5:** Commit: `git add lib/ledgerCategories.ts lib/ledgerBalance.ts scripts/test/ledgerCategories.test.ts scripts/test/ledgerBalance.test.ts && git commit -m "Ledger: category seed and balance math"`

---

### Task 3 (mid model): OFX parser + import matcher (pure, TDD from exact tests)

**Files:** Create `lib/ofx.ts`, `lib/ledgerImport.ts`; Test `scripts/test/ofx.test.ts`, `scripts/test/ledgerImport.test.ts`.

**Interfaces (later tasks depend on these exact shapes):**

```ts
// lib/ofx.ts
export type ParsedOfxTxn = {
  fitid: string | null
  date: string            // YYYY-MM-DD from DTPOSTED's first 8 digits
  amountCents: number     // TRNAMT × 100, rounded half away from zero
  name: string            // NAME (or empty string)
  memo: string | null     // MEMO when present
}
export type ParsedOfx = { transactions: ParsedOfxTxn[]; ledgerBalanceCents: number | null }
export function parseOfx(text: string): ParsedOfx   // throws Error('Not an OFX file.') when no <OFX> and no <STMTTRN>

// lib/ledgerImport.ts
export type ExistingTxn = {
  id: string; date: string; amount_cents: number
  import_id: string | null; source: 'manual' | 'import'
}
export type ImportPlan = {
  duplicates: ParsedOfxTxn[]
  matches: { row: ParsedOfxTxn; importId: string; existingId: string }[]
  inserts: { row: ParsedOfxTxn; importId: string; kind: 'income' | 'expense' }[]
}
export function planImport(rows: ParsedOfxTxn[], existing: ExistingTxn[]): ImportPlan
```

**Matcher rules (the tests below pin them):** `importId = 'OFX:' + fitid` when fitid is non-null/non-blank, else `'GEN:' + amountCents + ':' + date + ':' + n`. **Updated post-review (c7fb8bf):** n is no longer a plain "counts occurrences, starting at 1" scheme — a fitid-less row is classified by its OCCURRENCE POSITION for its (amount,date) key within the batch, compared against how many rows of that key already exist from prior imports: positions within that existing count read as duplicates (a re-downloaded statement re-sends the same rows in the same order), and only positions beyond it are genuinely new. A genuinely-new occurrence's n is then anchored at maxN — the highest suffix ever issued for that key — not at the existing count, so a surviving higher suffix (from a since-deleted row) is never collided with. A row whose importId already exists among `existing[].import_id` → `duplicates`. Otherwise try to match: candidates are existing **manual** rows with `import_id === null` and the **same amount_cents** and `|date difference| ≤ 10 days`; pick the closest date (tie → the earlier transaction); each existing row can be claimed by at most one import row. Otherwise → `inserts`, `kind` = `income` if amountCents > 0 else `expense`.

- [ ] **Step 1:** Write the four test files' worth of coverage — verbatim tests:

`scripts/test/ofx.test.ts`:

```ts
// Real bank OFX comes in two dialects: 1.x SGML (headers, unclosed leaf
// tags) and 2.x XML (closed tags). Both must parse to the same shape,
// because the import feature cannot care which decade Dan's bank lives in.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseOfx } from '../../lib/ofx.ts'

const SGML = `OFXHEADER:100
DATA:OFXSGML
VERSION:102

<OFX>
<BANKMSGSRSV1><STMTTRNRS><STMTRS>
<BANKTRANLIST>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260810120000[-5:CDT]
<TRNAMT>-42.53
<FITID>2026081001
<NAME>TEST DINER
<MEMO>CARD 1234
</STMTTRN>
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20260812
<TRNAMT>600.00
<FITID>2026081202
<NAME>CLIENT PAYMENT
</STMTTRN>
</BANKTRANLIST>
<LEDGERBAL><BALAMT>1234.56<DTASOF>20260812</LEDGERBAL>
</STMTRS></STMTTRNRS></BANKMSGSRSV1>
</OFX>`

test('parses 1.x SGML: dates, signed cents, fitid, name, memo, ledger balance', () => {
  const { transactions, ledgerBalanceCents } = parseOfx(SGML)
  assert.equal(transactions.length, 2)
  assert.deepEqual(transactions[0], {
    fitid: '2026081001', date: '2026-08-10', amountCents: -4253,
    name: 'TEST DINER', memo: 'CARD 1234',
  })
  assert.deepEqual(transactions[1], {
    fitid: '2026081202', date: '2026-08-12', amountCents: 60000,
    name: 'CLIENT PAYMENT', memo: null,
  })
  assert.equal(ledgerBalanceCents, 123456)
})

const XML = `<?xml version="1.0"?><?OFX OFXHEADER="200" VERSION="211"?>
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20260701</DTPOSTED>
<TRNAMT>-0.01</TRNAMT><FITID>x1</FITID><NAME>PENNY</NAME></STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`

test('parses 2.x XML with closing tags, one-cent amounts exact', () => {
  const { transactions } = parseOfx(XML)
  assert.deepEqual(transactions, [{
    fitid: 'x1', date: '2026-07-01', amountCents: -1, name: 'PENNY', memo: null,
  }])
})

test('a missing FITID becomes null, not an empty string', () => {
  const noId = SGML.replace('<FITID>2026081001\n', '')
  const { transactions } = parseOfx(noId)
  assert.equal(transactions[0].fitid, null)
})

test('floating-point amounts round to exact cents', () => {
  const { transactions } = parseOfx(SGML.replace('-42.53', '-42.535'))
  assert.equal(transactions[0].amountCents, -4254, 'half away from zero')
})

test('not an OFX file throws the friendly error', () => {
  assert.throws(() => parseOfx('Date,Payee,Amount\n...'), /Not an OFX file\./)
})
```

`scripts/test/ledgerImport.test.ts`:

```ts
// The dedupe/match brain. YNAB's rule, proven for a decade: an import row
// either already exists (import_id), adopts a manual twin (same amount,
// ±10 days), or is new. Pure, so every branch is pinned without a database.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planImport } from '../../lib/ledgerImport.ts'
import type { ParsedOfxTxn } from '../../lib/ofx.ts'

const row = (over: Partial<ParsedOfxTxn> = {}): ParsedOfxTxn => ({
  fitid: 'f1', date: '2026-08-10', amountCents: -4253,
  name: 'TEST DINER', memo: null, ...over,
})

test('a row whose import_id already exists is a duplicate', () => {
  const plan = planImport([row()], [{
    id: 'e1', date: '2026-08-10', amount_cents: -4253,
    import_id: 'OFX:f1', source: 'import',
  }])
  assert.equal(plan.duplicates.length, 1)
  assert.equal(plan.matches.length + plan.inserts.length, 0)
})

test('a manual twin within ±10 days is matched and adopts the import id', () => {
  const plan = planImport([row()], [{
    id: 'm1', date: '2026-08-06', amount_cents: -4253, import_id: null, source: 'manual',
  }])
  assert.deepEqual(plan.matches, [{
    row: row(), importId: 'OFX:f1', existingId: 'm1',
  }])
})

test('same amount 11 days away is NOT a match — it inserts', () => {
  const plan = planImport([row()], [{
    id: 'm1', date: '2026-07-30', amount_cents: -4253, import_id: null, source: 'manual',
  }])
  assert.equal(plan.matches.length, 0)
  assert.equal(plan.inserts.length, 1)
})

test('two candidates: the closest date wins; each manual row is claimed once', () => {
  const near = { id: 'near', date: '2026-08-09', amount_cents: -4253, import_id: null, source: 'manual' as const }
  const far = { id: 'far', date: '2026-08-01', amount_cents: -4253, import_id: null, source: 'manual' as const }
  const plan = planImport([row(), row({ fitid: 'f2' })], [near, far])
  assert.equal(plan.matches.length, 2)
  assert.equal(plan.matches[0].existingId, 'near', 'first row takes the closest')
  assert.equal(plan.matches[1].existingId, 'far', 'second row takes what remains')
})

test('an import-sourced or already-linked row is never a match candidate', () => {
  const plan = planImport([row()], [
    { id: 'i1', date: '2026-08-10', amount_cents: -4253, import_id: 'OFX:other', source: 'import' },
  ])
  assert.equal(plan.inserts.length, 1)
})

test('inserts infer kind from the sign', () => {
  const plan = planImport([row({ amountCents: 60000, fitid: 'p' })], [])
  assert.equal(plan.inserts[0].kind, 'income')
})

test('missing fitid falls back to GEN ids with an occurrence counter', () => {
  const a = row({ fitid: null })
  const b = row({ fitid: null })
  const plan = planImport([a, b], [])
  assert.equal(plan.inserts[0].importId, 'GEN:-4253:2026-08-10:1')
  assert.equal(plan.inserts[1].importId, 'GEN:-4253:2026-08-10:2')
})

test('GEN occurrence counting also respects existing GEN ids', () => {
  const plan = planImport([row({ fitid: null })], [{
    id: 'e1', date: '2026-08-10', amount_cents: -4253,
    import_id: 'GEN:-4253:2026-08-10:1', source: 'import',
  }])
  assert.equal(plan.duplicates.length, 0)
  assert.equal(plan.inserts[0].importId, 'GEN:-4253:2026-08-10:2')
})
```

- [ ] **Step 2:** `npm test` — new tests fail (modules missing).
- [ ] **Step 3:** Implement `lib/ofx.ts` and `lib/ledgerImport.ts` to make every test pass. Parser guidance (not prescriptive): strip everything before `<OFX`; case-insensitive; extract `<STMTTRN>…</STMTTRN>` blocks (both dialects close the aggregate); within a block read leaf values with a pattern that stops at `<` or line end, trimming a trailing `</TAG>` if present; DTPOSTED → first 8 digits; TRNAMT via `Math.round(parseFloat(v) * 100)` adjusted for half-away-from-zero on negatives (reuse the technique in `lib/money.ts` `roundCents`); LEDGERBAL's BALAMT the same way. Matcher: date distance via `Date.UTC` on the plain dates. Both modules carry the repo's why-first comment style.
- [ ] **Step 4:** `npm test` all green; clear TS caches; `npx tsc --noEmit` + `npm run build` clean.
- [ ] **Step 5:** Commit: `git add lib/ofx.ts lib/ledgerImport.ts scripts/test/ofx.test.ts scripts/test/ledgerImport.test.ts && git commit -m "Ledger: OFX parser and import matcher"`

---

### Task 4 (mid model): Server actions

**Files:** Create `app/money/actions.ts`. No new tests (repo convention: server actions are not unit-tested; the pure brains already are).

Mirror `app/expenses/actions.ts` exactly in style: `'use server'`, `type Fail = { error: string }`, `createClient` from `@/lib/supabase/server`, getUser guard first, owner-scoped reads/writes, `revalidatePath('/money')` after writes, why-first comments.

Actions (signatures are the contract for Task 5/6):

```ts
createLedgerAccount(input: { name: string; openingBalanceCents: number; openingDate: string }): Promise<Fail | { ok: true; id: string }>
  // validates non-blank name, integer cents, isPlainDate (reuse the repo's date validation approach)
updateLedgerAccount(input: { id: string; name: string; closed: boolean }): Promise<Fail | { ok: true }>
ensureDefaultCategories(): Promise<Fail | { ok: true; seeded: number }>
  // count owner's ledger_categories; when 0, bulk-insert DEFAULT_CATEGORIES (lib/ledgerCategories); idempotent
saveCategory(input: { id: string | null; name: string; grp: string; hidden: boolean; isEquipment: boolean }): Promise<Fail | { ok: true }>
  // null id = create (sort = max+1 in group); non-null = rename/hide/flag
addLedgerTransaction(input: { accountId: string; date: string; amountCents: number; kind: 'income'|'expense'|'owner_pay'|'transfer'; categoryId: string | null; showId: string | null; payee: string; memo: string }): Promise<Fail | { ok: true; id: string }>
  // enforce the sign/kind rules and category-null-for-owner_pay/transfer BEFORE insert, with clear errors
updateLedgerTransaction(input: { id: string; date: string; amountCents: number; kind: ...; categoryId: string | null; showId: string | null; payee: string; memo: string }): Promise<Fail | { ok: true }>
  // read first; refuse when cleared === 'reconciled' ("Reconciled transactions are locked.")
deleteLedgerTransaction(id: string): Promise<Fail | { ok: true }>   // same reconciled refusal
setTransactionCleared(id: string, cleared: 'uncleared' | 'cleared'): Promise<Fail | { ok: true }>
  // never sets 'reconciled' directly (reconcile does), and refuses to touch a reconciled row
importOfx(accountId: string, fileText: string): Promise<Fail | { imported: number; matched: number; duplicates: number; skipped: number }>
  // guard fileText length (2MB cap); parseOfx inside try → Fail on throw; load the account's
  // transactions (id, date, amount_cents, import_id, source); planImport; apply matches
  // (update import_id + cleared='cleared' where still unlinked) then inserts
  // (source='import', cleared='cleared', category null, payee = row.name, memo = row.memo);
  // count and return (skipped = planImport's zero-amount rows). Unique index violations on a race → count as duplicates, not errors.
reconcileAccount(input: { accountId: string; statementBalanceCents: number; reconciledOn: string; createAdjustment: boolean }): Promise<Fail | { ok: true; adjustedCents: number }>
  // compute clearedBalance (lib/ledgerBalance) from opening_balance + rows; diff = statement − cleared;
  // if diff !== 0 and !createAdjustment → Fail naming the formatted difference;
  // if diff !== 0 and createAdjustment → insert an adjustment transaction (payee 'Balance Adjustment',
  // kind by sign, category null, cleared 'cleared') then proceed;
  // mark all rows with cleared='cleared' → 'reconciled', insert ledger_reconciliations row,
  // update account.last_reconciled_at; return adjustedCents = diff
```

Gates: caches cleared, tsc + build clean, `npm test` unchanged. Commit: `"Ledger: money server actions"`.

---

### Task 5 (mid model): Register UI + nav

**Files:** Create `app/money/page.tsx`, `components/MoneyRegister.tsx`; Modify `components/AppShell.tsx` (NAV gains `{ href: '/money', label: 'Money', key: 'money' }` between Shows and Clients).

- Server page: load the owner's account (first non-closed), categories (call `ensureDefaultCategories()` when empty, then load), recent shows (id, name, first date — for the tag Select), and the account's transactions (newest first). No account → render `MoneyRegister` in first-run mode.
- `MoneyRegister` ('use client'): first-run create-account card (name default "Business Checking", opening balance, opening date) → `createLedgerAccount`; header with `formatUSD(workingBalance…)` + cleared balance + last-reconciled date; add row (date defaulting today, payee, amount with sign implied by a kind Select [Income/Expense/Owner pay], category Select (hidden for owner pay), optional show Select, memo) → `addLedgerTransaction` (derive the sign: income positive, others negative — the user types a positive number); list rows: date · payee · category name or an inline category Select when uncategorized · show name chip · signed `formatUSD` amount · cleared checkbox (`setTransactionCleared`) · lock glyph when reconciled · delete (× like ExpenseLog, guarded server-side); an "N uncategorized" counter in the header when > 0.
- Follow the app's list-row idiom exactly (`border-b border-line py-4 pl-3 -ml-3 pr-3`, eyebrow headers, FIELD_FULL, `Select`, useTransition + router.refresh + `{error}` surfacing — ExpenseLog is the style reference).
- Gates: caches cleared, tsc + build clean, tests unchanged. Commit: `"Money: register page and nav"`.

---

### Task 6 (mid model): Import + reconcile UI + categories page

**Files:** Create `components/LedgerImport.tsx`, `components/LedgerReconcile.tsx`, `app/money/categories/page.tsx`, `components/CategoryEditor.tsx`; Modify `app/money/page.tsx` (mount the two panels), `components/MoneyRegister.tsx` only if a shared prop needs threading.

- `LedgerImport`: file input (`.ofx,.qfx` accept), reads the file as text client-side, calls `importOfx`, then shows "Imported N · matched M · duplicates D" and refreshes. Errors surfaced inline.
- `LedgerReconcile`: collapsed "Reconcile" button → panel: statement balance input + date (default today); submit with `createAdjustment: false`; when the action returns the difference error, show it with a second button "Add balance adjustment and reconcile" (`createAdjustment: true`). Success shows "Reconciled" and refreshes.
- `/money/categories` + `CategoryEditor`: grouped list (grp eyebrows), rename inline, hide toggle, equipment flag toggle, add-category row per group; link to it from the register header ("Edit categories"). All via `saveCategory`.
- Gates: caches cleared, tsc + build clean, tests unchanged. Commit: `"Money: import, reconcile and category editor"`.

---

## Verification

All gates green (`npm test` grows by the four new suites; tsc/build clean from cold caches). Then the sandbox walkthrough on dev: create the account → seed categories appear → add a manual transaction → import a fixture OFX (write one to the scratchpad from the test fixture) → watch the manual row match instead of duplicate → re-import the same file → all duplicates → categorize an imported row inline → tag one to a sandbox show → reconcile against the fixture's ledger balance (accept the adjustment path once) → confirm reconciled rows refuse edits. Nav shows Money on desktop + hamburger.

## Blast radius

All new tables/pages; the only existing file touched is AppShell (one nav item). Nothing client-facing. DEV database only until the ship gate (migrate prod 0027 first, then deploy).
