// Pins decideIncomeRoleChange's (lib/incomeRoleGuard.ts) decision matrix —
// the guard that stops flipping a category to budget_role 'income' from
// silently rewriting every month buildBudget's spendingIds covers. Covers
// every hazard the guard's own header comment names: assignments (moves), a
// target, the category's own transactions (the one the final delta review
// caught the code skipping), and — the one Wave C's final review caught —
// a category referenced only through split legs, each with its own
// fail-closed read, plus the already-income no-op that must never be
// blocked by any of the four.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideIncomeRoleChange, INCOME_ROLE_CHANGE_REFUSAL } from '../../lib/incomeRoleGuard.ts'

const NO_ROWS = { data: [], error: null }
const NO_TARGET = { data: [], error: null }
const NO_TXNS = { data: [], error: null }
const NO_SPLITS = { data: [], error: null }

test('a category with assignments refuses the change to income', () => {
  const moves = { data: [{ id: 'move-1' }], error: null }
  assert.deepEqual(
    decideIncomeRoleChange('spending', moves, NO_TARGET, NO_TXNS, NO_SPLITS),
    { error: INCOME_ROLE_CHANGE_REFUSAL },
  )
})

test('a category with a target refuses the change to income', () => {
  const targets = { data: [{ id: 'target-1' }], error: null }
  assert.deepEqual(
    decideIncomeRoleChange('spending', NO_ROWS, targets, NO_TXNS, NO_SPLITS),
    { error: INCOME_ROLE_CHANGE_REFUSAL },
  )
})

test('a category with transactions refuses the change to income', () => {
  // The hazard lib/incomeRoleGuard.ts's own header comment leads with: the
  // moment the role flips, a transaction in this category stops counting as
  // `activity` and becomes `income(m)` instead (lib/budget.ts's incomeBy).
  // Newly reachable since migration 0041 restored eight categories that will
  // carry transactions long before they ever carry an assignment or a target.
  const transactions = { data: [{ id: 'txn-1' }], error: null }
  assert.deepEqual(
    decideIncomeRoleChange('spending', NO_ROWS, NO_TARGET, transactions, NO_SPLITS),
    { error: INCOME_ROLE_CHANGE_REFUSAL },
  )
})

test('a category referenced only by split legs refuses the change to income', () => {
  // Wave C final review (I3): a split parent's own category_id is forced to
  // null the instant it has legs (migration 0042), so a category named ONLY
  // through ledger_transaction_splits rows — never through a plain
  // transaction's category_id — is invisible to the `transactions` read
  // above and would otherwise sail through this guard while still carrying
  // real leg activity that Ready to Assign would silently start counting
  // the moment the role flips.
  const splits = { data: [{ id: 'leg-1' }], error: null }
  assert.deepEqual(
    decideIncomeRoleChange('spending', NO_ROWS, NO_TARGET, NO_TXNS, splits),
    { error: INCOME_ROLE_CHANGE_REFUSAL },
  )
})

test('a category with no moves, target, transactions, or splits allows the change', () => {
  assert.equal(decideIncomeRoleChange('spending', NO_ROWS, NO_TARGET, NO_TXNS, NO_SPLITS), null)
})

test('a failed moves read refuses rather than waving it through', () => {
  // moves.data is null (as a real failed Postgrest call would report) — a
  // presence check on data alone would read this as "no moves" and let the
  // write through. The error must win first.
  const moves = { data: null, error: { message: 'connection reset' } }
  assert.deepEqual(
    decideIncomeRoleChange('spending', moves, NO_TARGET, NO_TXNS, NO_SPLITS),
    { error: 'connection reset' },
  )
})

test('a failed targets read refuses rather than waving it through, even with moves.data empty', () => {
  const targets = { data: null, error: { message: 'timeout' } }
  assert.deepEqual(
    decideIncomeRoleChange('spending', NO_ROWS, targets, NO_TXNS, NO_SPLITS),
    { error: 'timeout' },
  )
})

test('a failed transactions read refuses rather than waving it through, even with moves and targets empty', () => {
  // Same fail-closed rule as the moves/targets reads above, extended to the
  // third one: a blown-up transactions query must never be read as "no
  // transactions, go ahead."
  const transactions = { data: null, error: { message: 'timeout' } }
  assert.deepEqual(
    decideIncomeRoleChange('spending', NO_ROWS, NO_TARGET, transactions, NO_SPLITS),
    { error: 'timeout' },
  )
})

test('a failed splits read refuses rather than waving it through, even with the other three clean', () => {
  // Same fail-closed rule, extended to the fourth read (I3): a blown-up
  // splits query must never be read as "no legs reference this category, go
  // ahead" just because moves/targets/transactions all came back empty.
  const splits = { data: null, error: { message: 'connection reset' } }
  assert.deepEqual(
    decideIncomeRoleChange('spending', NO_ROWS, NO_TARGET, NO_TXNS, splits),
    { error: 'connection reset' },
  )
})

test('changing a category to income when it is already income is not blocked', () => {
  // Deliberately handed moves/targets/transactions/splits that WOULD refuse
  // a spending->income transition (and some that even error) — proving the
  // already-income short-circuit fires before any of the four reads is
  // consulted, not just when they all happen to come back clean.
  const moves = { data: [{ id: 'move-1' }], error: null }
  const targets = { data: null, error: { message: 'connection reset' } }
  const transactions = { data: [{ id: 'txn-1' }], error: null }
  const splits = { data: [{ id: 'leg-1' }], error: null }
  assert.equal(decideIncomeRoleChange('income', moves, targets, transactions, splits), null)
})
