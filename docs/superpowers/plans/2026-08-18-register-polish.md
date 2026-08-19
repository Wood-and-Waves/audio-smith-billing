# Register Polish Implementation Plan (Money wave A)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Context (serves as the spec — this wave refines the shipped ledger spine, no new design surface):** Dan's verdict on the spine: "good start, pretty raw." Four dead-ends make it raw: no way to edit a transaction (typo = delete + re-add, and imported TRANSFER TO PERSONAL rows can't become owner pay), no payee memory (every TRAVEL DINER categorized by hand forever), no bulk categorization, and reconcile makes him re-type a statement balance the imported file already carries. This wave fixes exactly those four. Dashboard is wave B.

**Goal:** Make the register feel finished: edit rows (incl. kind → owner pay), payee-memory auto-categorization on import, one-click "apply to N more" after categorizing, and reconcile prefilled from the import's ending balance.

**Tech/process:** as the ledger-spine plan (gates incl. cold-cache tsc/build; tiering: exact-code → cheap, logic/UI → mid; reviews mid; the opus whole-branch review happens after wave B, before any ship gate).

## Global Constraints

- Money stays Dan-only; reconciled rows stay immutable except categorization; all prior invariants hold (signs/kinds, import idempotence, paged reads).
- Payee memory is a CONVENIENCE: it only fills `category_id` on NEW imported income/expense rows and never overwrites an existing category, never touches kind, never teaches from owner_pay/transfer/uncategorized rows.
- `updateLedgerTransaction` (already implemented, currently unwired) is the edit contract — do not fork a second update path.
- Pure logic in tested libs; no `@/`/JSX in libs.

---

### Task 1 (cheap model): Payee memory (pure, exact code)

**Files:** Create `lib/payeeMemory.ts`; Test `scripts/test/payeeMemory.test.ts`.

- [ ] **Step 1:** `lib/payeeMemory.ts` — verbatim:

```ts
// Payee memory: the one YNAB convenience that turns categorizing a monthly
// import from 28 chores into 5. When a payee has been categorized before,
// the newest categorized row teaches the category, and imports of that payee
// arrive pre-categorized. A convenience, never an authority: it only fills
// category on NEW rows, never overwrites, never touches kind, and never
// learns from owner-pay/transfer rows (those carry no category by design)
// or from uncategorized rows (nothing to teach).
//
// No '@/' imports and no JSX — exercised by node --test.

export type PayeeMemoryRow = {
  payee: string
  category_id: string | null
  kind: string
  date: string
}

/** Case-insensitive, whitespace-collapsed — "Travel  Diner " teaches "TRAVEL DINER". */
export function normalizePayee(payee: string): string {
  return payee.trim().replace(/\s+/g, ' ').toLowerCase()
}

/**
 * normalized payee -> category_id, taught by the NEWEST categorized
 * income/expense row for that payee (ties broken by array order: later
 * wins, so callers should pass rows oldest-first or any stable order —
 * the date comparison does the real work).
 */
export function rememberedCategories(rows: PayeeMemoryRow[]): Map<string, string> {
  const best = new Map<string, { date: string; category: string }>()
  for (const r of rows) {
    if (r.category_id === null) continue
    if (r.kind !== 'income' && r.kind !== 'expense') continue
    const key = normalizePayee(r.payee)
    if (key === '') continue
    const prev = best.get(key)
    if (!prev || r.date >= prev.date) best.set(key, { date: r.date, category: r.category_id })
  }
  const out = new Map<string, string>()
  for (const [k, v] of best) out.set(k, v.category)
  return out
}
```

- [ ] **Step 2:** `scripts/test/payeeMemory.test.ts` — verbatim:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizePayee, rememberedCategories } from '../../lib/payeeMemory.ts'

const R = (payee: string, category_id: string | null, kind = 'expense', date = '2026-08-01') =>
  ({ payee, category_id, kind, date })

test('a categorized payee is remembered, case- and space-insensitively', () => {
  const m = rememberedCategories([R('Travel  Diner ', 'cat-meals')])
  assert.equal(m.get(normalizePayee('TRAVEL DINER')), 'cat-meals')
})

test('the newest categorization wins', () => {
  const m = rememberedCategories([
    R('Gear Outlet', 'cat-supplies', 'expense', '2026-05-01'),
    R('Gear Outlet', 'cat-equipment', 'expense', '2026-07-01'),
  ])
  assert.equal(m.get('gear outlet'), 'cat-equipment')
})

test('uncategorized rows teach nothing', () => {
  const m = rememberedCategories([R('Mystery Vendor', null)])
  assert.equal(m.get('mystery vendor'), undefined)
})

test('owner-pay and transfer rows never teach', () => {
  const m = rememberedCategories([
    R('Transfer to Personal', 'cat-anything', 'owner_pay'),
    R('Transfer to Personal', 'cat-other', 'transfer'),
  ])
  assert.equal(m.size, 0)
})

test('a blank payee teaches nothing', () => {
  assert.equal(rememberedCategories([R('   ', 'cat-x')]).size, 0)
})
```

- [ ] **Step 3:** `npm test` (all green, +5), cold-cache `npx tsc --noEmit` + `npm run build` clean.
- [ ] **Step 4:** Commit: `git add lib/payeeMemory.ts scripts/test/payeeMemory.test.ts && git commit -m "Money: payee memory (pure)"`

---

### Task 2 (mid model): Action wiring

**Files:** Modify `app/money/actions.ts` only.

- [ ] `importOfx`: after `planImport`, build `rememberedCategories` from the already-loaded existing rows — NOTE: the paged existing-row load must additionally select `payee, category_id, kind` (extend the column list; the pure matcher's `ExistingTxn` type is structurally narrower, which is fine) — and set each insert's `category_id` to the remembered value for `normalizePayee(row.name)` when present (income/expense inserts only; leave null otherwise). Return gains `statementBalanceCents: number | null` from `parseOfx`'s `ledgerBalanceCents`, and `autoCategorized: number` (how many inserts got a remembered category).
- [ ] `setTransactionCategory(id, categoryId, applyToSamePayee = false)`: third optional param. When true and `categoryId` is non-null: after updating the target row, update every OTHER row on the same account with the same normalized payee, `category_id is null`, kind income/expense (any cleared state — categorization is allowed on reconciled rows by design). Because normalization can't run in SQL, load candidate rows (id, payee) with the paged pattern, filter in JS via `normalizePayee`, update by id list (`.in('id', ids)`). Return gains `applied: number` (0 when the flag is off or nothing matched).
- [ ] `updateLedgerTransaction`: no signature change — confirm it still compiles and validates kind/sign/category rules (it's about to gain its first caller).
- [ ] Gates (tests unchanged at Task 1's count, cold-cache tsc/build clean); commit `"Money: payee memory wiring, apply-to-same-payee, import balance"`.

---

### Task 3 (mid model): Register UI

**Files:** Modify `components/MoneyRegister.tsx`, `components/LedgerImport.tsx`, `components/LedgerReconcile.tsx`, `app/money/page.tsx` (whatever coordination the prefill needs — a small client wrapper is acceptable).

- [ ] **Edit a row:** each non-reconciled row gains an "Edit" affordance that expands the row into an inline form mirroring the add row (date, payee, positive amount + kind Select incl. Owner pay, category Select hidden+cleared for owner pay, show Select, memo) prefilled from the row (amount shown positive; sign re-derived from kind on save) → `updateLedgerTransaction` → refresh. Cancel restores the row. Reconciled rows: no Edit (category picker already exists for them).
- [ ] **Owner-pay flip is just an edit** (kind Select) — verify the flow: an imported TRANSFER TO PERSONAL row → Edit → kind Owner pay → category clears → save.
- [ ] **Apply-to-more:** after the inline category picker succeeds, if other uncategorized rows share the payee (client-side count from the loaded rows), show a one-line prompt "Applied. N more '<payee>' rows are uncategorized — [Apply to all]" → `setTransactionCategory(id, categoryId, true)` → refresh with the applied count shown briefly. (Also fine: call with the flag in one step via a second button in the picker area — implementer's judgment, but the two-step confirm is preferred so bulk changes are never a surprise.)
- [ ] **Import → reconcile handoff:** `LedgerImport`'s summary line gains "Statement balance $X" when `statementBalanceCents` is non-null, plus a "Reconcile now" button that opens the reconcile panel prefilled with that balance (and today's date). Lift whatever state this needs into a small client coordinator; do not persist it.
- [ ] **Auto-categorized visibility:** the import summary appends "· N auto-categorized" when > 0.
- [ ] Gates (tests unchanged, cold-cache tsc/build clean); commit `"Money: row editing, apply-to-more, reconcile prefill"`.

---

## Verification

Gates green; sandbox walkthrough: edit a typo'd manual row; flip the four TRANSFER TO PERSONAL rows to Owner pay (category clears, deductions untouched); categorize one TRAVEL DINER row → "apply to all" catches the rest; re-import the statement → duplicates only; delete a categorized row, re-import → the reinserted row arrives auto-categorized (payee memory); import summary shows the statement balance → Reconcile now → prefilled $15,820.33 → matches.

## Out of scope (wave B+)

Dashboard/reports, CPA export, invoice/expense bridge, the pre-prod hardening list.
