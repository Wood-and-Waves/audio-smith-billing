# Business Envelopes Implementation Plan (Money wave C)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Context (serves as spec — Dan approved the shape and manual funding):** the budgeting layer the vision promised, YNAB Rule 1 scoped to the business checking account. The account's WORKING balance divides into named envelopes (seeded with Dan's own YNAB Savings funds: Taxes, Tax Prep, Retained Earnings — editable) plus **Available to allocate** (red when over-allocated). Every allocation is an immutable move (YNAB's money-movement pattern) between Available and envelopes, so history is never a mystery. The Taxes envelope IS the tax jar: the show Profit card's set-aside number guides the manual move in; IRS payments guide moves out. NO auto-funding, NO envelope-category linkage, NO targets in v1 — those grow later (auto-feed with the invoice bridge).

**Goal:** `/money/budget` — allocate the business balance into envelopes with a logged move history.

**Tiering:** T1 controller (migration). T2 exact-code → cheap (controller verifies fidelity). T3 actions + T4 UI → mid; ONE combined review after T4 (this rides an already-capstoned branch; the new math is pure-tested).

## Global Constraints

- Money/budget is Dan-only. Integer cents; `formatUSD`; paged loads for anything unbounded (moves!). Pure math in `lib/envelopes.ts`, tested. Moves are IMMUTABLE (no update/delete actions — a mistaken move is corrected by a counter-move; comment this).
- An envelope with moves cannot be deleted (FK restrict) — hide instead, like categories. Available is represented as NULL envelope ids on a move's from/to.
- Available to allocate = working balance − net allocated; envelope↔envelope moves never change Available.

---

### Task 1 (CONTROLLER): Migration 0030

`ledger_envelopes` (id, owner_id, name non-blank, sort int default 0, hidden bool default false, created_at; unique (owner_id, name)); `ledger_envelope_moves` (id, owner_id, from_envelope_id fk null=Available, to_envelope_id fk null=Available, amount_cents bigint check > 0, moved_on date, note text, created_at; checks: from/to not both null, from distinct from to; fks on delete restrict). Standard RLS blocks. Applied to DEV.

---

### Task 2 (cheap model): Envelope math (pure, exact code)

**Files:** Create `lib/envelopes.ts`; Test `scripts/test/envelopes.test.ts`.

- [ ] **Step 1:** `lib/envelopes.ts` — verbatim:

```ts
// Envelope arithmetic — YNAB's Rule 1 applied to the business checking
// account. An envelope's balance is nothing but the sum of the immutable
// moves that touched it; Available to allocate is whatever the account's
// working balance hasn't been given a job. A move between two envelopes
// changes neither Available nor the total — money just changes jobs.
//
// No '@/' imports and no JSX — exercised by node --test.

export type EnvelopeMoveLike = {
  /** null = the Available pool. */
  from_envelope_id: string | null
  /** null = the Available pool. */
  to_envelope_id: string | null
  /** Always positive; direction lives in from/to. */
  amount_cents: number
}

export function envelopeBalances(moves: EnvelopeMoveLike[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const m of moves) {
    if (m.to_envelope_id !== null) {
      out.set(m.to_envelope_id, (out.get(m.to_envelope_id) ?? 0) + m.amount_cents)
    }
    if (m.from_envelope_id !== null) {
      out.set(m.from_envelope_id, (out.get(m.from_envelope_id) ?? 0) - m.amount_cents)
    }
  }
  return out
}

/** Net cents moved OUT of Available into envelopes, over all time. */
export function netAllocated(moves: EnvelopeMoveLike[]): number {
  let net = 0
  for (const m of moves) {
    if (m.to_envelope_id !== null && m.from_envelope_id === null) net += m.amount_cents
    if (m.from_envelope_id !== null && m.to_envelope_id === null) net -= m.amount_cents
  }
  return net
}

export function availableToAllocate(
  workingBalanceCents: number, moves: EnvelopeMoveLike[],
): number {
  return workingBalanceCents - netAllocated(moves)
}
```

- [ ] **Step 2:** `scripts/test/envelopes.test.ts` — verbatim:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { envelopeBalances, netAllocated, availableToAllocate } from '../../lib/envelopes.ts'

const M = (from: string | null, to: string | null, amount_cents: number) =>
  ({ from_envelope_id: from, to_envelope_id: to, amount_cents })

const MOVES = [
  M(null, 'tax', 180000),    // fund Taxes from Available
  M(null, 'gear', 50000),    // fund Gear
  M('gear', 'tax', 10000),   // rob Gear to top up Taxes
  M('tax', null, 40000),     // release back to Available (IRS payment made)
]

test('an envelope balance is the sum of the moves that touched it', () => {
  const b = envelopeBalances(MOVES)
  assert.equal(b.get('tax'), 180000 + 10000 - 40000)
  assert.equal(b.get('gear'), 50000 - 10000)
})

test('envelope-to-envelope moves never change what is allocated', () => {
  assert.equal(netAllocated(MOVES), 180000 + 50000 - 40000)
  assert.equal(netAllocated([M('a', 'b', 99999)]), 0)
})

test('available is the working balance minus the net allocation', () => {
  assert.equal(availableToAllocate(1582033, MOVES), 1582033 - 190000)
})

test('over-allocation goes negative rather than clamping — the red is the point', () => {
  assert.equal(availableToAllocate(100000, [M(null, 'tax', 150000)]), -50000)
})

test('no moves: everything is available and no envelope has a balance', () => {
  assert.equal(availableToAllocate(123456, []), 123456)
  assert.equal(envelopeBalances([]).size, 0)
})
```

- [ ] **Step 3:** Gates (`npm test` +5 over 400, cold-cache tsc/build clean); commit `"Money: envelope math (pure)"`.

---

### Task 3 (mid model): Envelope actions

**Files:** Modify `app/money/actions.ts` only. Mirror the file's patterns exactly.

- `ensureDefaultEnvelopes(): Promise<Fail | { ok: true; seeded: number }>` — seeds `['Taxes', 'Tax Prep', 'Retained Earnings']` (sort 0..2 — Dan's actual YNAB Savings funds) when the owner has zero envelopes; 23505-tolerant; NO revalidatePath (called during render, same as ensureDefaultCategories — copy its comment rationale).
- `saveEnvelope(input: { id: string | null; name: string; hidden: boolean }): Promise<Fail | { ok: true }>` — create (sort = max+1) / rename+hide; 23505 → `You already have an envelope named "<name>".`
- `moveEnvelopeMoney(input: { fromEnvelopeId: string | null; toEnvelopeId: string | null; amountCents: number; note: string }): Promise<Fail | { ok: true }>` — validation: integer amount > 0 (`'Enter an amount to move.'`); not both null (`'Pick where the money moves.'`); from ≠ to; FK-ownership check (belongsToCaller pattern) on each non-null envelope id; insert with `moved_on: todayInChicago()`; revalidatePath('/money'). Moves are immutable — no update/delete actions; comment that a mistake is corrected by a counter-move (the history stays honest).

Gates; commit `"Money: envelope actions"`.

---

### Task 4 (mid model): The Budget page

**Files:** Create `app/money/budget/page.tsx`, `components/BudgetPanel.tsx`; Modify `app/money/page.tsx` (header gains "Budget" link beside Reports), `app/shows/[id]/page.tsx` (the Profit card's set-aside row gains a muted `→ Taxes envelope` Link to `/money/budget` — one line, Dan's workflow loop).

- Server page (force-dynamic; auth/error like /money): account (first non-closed; none → empty state linking /money); working balance from the PAGED full transaction load (mirror /money); `ensureDefaultEnvelopes()` then envelopes (unhidden, sort order; plus hidden ones only if they carry a nonzero balance — an emptied hidden envelope disappears, a funded one must stay visible); ALL moves via a paged load; compute `envelopeBalances` + `availableToAllocate`.
- `BudgetPanel` ('use client'):
  - **Available to allocate** — large `formatUSD`, `text-good` when > 0, muted when 0, `text-danger` + "over-allocated" note when negative.
  - Envelope rows (name · balance · rename inline · hide toggle — hide only when balance is 0, else disabled with a title explaining) + an add-envelope row.
  - **Move money:** From Select (Available + envelopes w/ balances in labels), To Select (same), amount, optional note → `moveEnvelopeMoney` → refresh. Guard the obvious in-UI (same from/to disabled) but trust the server.
  - **Recent moves:** last ~20, newest first: "$X · Available → Taxes · date · note", muted list. (History is the audit trail — no edit/delete.)
- Style: existing tokens/idioms; mobile-sane.

Gates (tests unchanged from T2's count; `/money/budget` in the route list); commit `"Money: budget page — envelopes and available to allocate"`.

---

## Verification

Gates green; combined review of T3+T4; sandbox: Budget shows Available = working balance; fund Taxes with a show's set-aside number; env→env move leaves Available unchanged; over-allocate → red; hide blocked on funded envelope; recent moves log reads right; the show card's set-aside links here.

## Out of scope

Auto-funding from paid invoices (bridge wave), envelope↔category linkage, targets/goals, envelope spending drawdown from transactions.
