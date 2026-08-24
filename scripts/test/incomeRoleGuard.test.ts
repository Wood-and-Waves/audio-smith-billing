// Pins decideIncomeRoleChange's (lib/incomeRoleGuard.ts) decision matrix —
// the guard that stops flipping a category to budget_role 'income' from
// silently rewriting every month buildBudget's spendingIds covers. Covers
// every hazard the guard's own header comment names: assignments (moves), a
// target, and — the one the final delta review caught the code skipping —
// the category's own transactions, each with its own fail-closed read, plus
// the already-income no-op that must never be blocked by any of the three.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideIncomeRoleChange, INCOME_ROLE_CHANGE_REFUSAL } from '../../lib/incomeRoleGuard.ts'

const NO_ROWS = { data: [], error: null }
const NO_TARGET = { data: [], error: null }
const NO_TXNS = { data: [], error: null }

test('a category with assignments refuses the change to income', () => {
  const moves = { data: [{ id: 'move-1' }], error: null }
  assert.deepEqual(
    decideIncomeRoleChange('spending', moves, NO_TARGET, NO_TXNS),
    { error: INCOME_ROLE_CHANGE_REFUSAL },
  )
})

test('a category with a target refuses the change to income', () => {
  const targets = { data: [{ id: 'target-1' }], error: null }
  assert.deepEqual(
    decideIncomeRoleChange('spending', NO_ROWS, targets, NO_TXNS),
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
    decideIncomeRoleChange('spending', NO_ROWS, NO_TARGET, transactions),
    { error: INCOME_ROLE_CHANGE_REFUSAL },
  )
})

test('a category with no moves, no target, and no transactions allows the change', () => {
  assert.equal(decideIncomeRoleChange('spending', NO_ROWS, NO_TARGET, NO_TXNS), null)
})

test('a failed moves read refuses rather than waving it through', () => {
  // moves.data is null (as a real failed Postgrest call would report) — a
  // presence check on data alone would read this as "no moves" and let the
  // write through. The error must win first.
  const moves = { data: null, error: { message: 'connection reset' } }
  assert.deepEqual(
    decideIncomeRoleChange('spending', moves, NO_TARGET, NO_TXNS),
    { error: 'connection reset' },
  )
})

test('a failed targets read refuses rather than waving it through, even with moves.data empty', () => {
  const targets = { data: null, error: { message: 'timeout' } }
  assert.deepEqual(
    decideIncomeRoleChange('spending', NO_ROWS, targets, NO_TXNS),
    { error: 'timeout' },
  )
})

test('a failed transactions read refuses rather than waving it through, even with moves and targets empty', () => {
  // Same fail-closed rule as the moves/targets reads above, extended to the
  // third one: a blown-up transactions query must never be read as "no
  // transactions, go ahead."
  const transactions = { data: null, error: { message: 'timeout' } }
  assert.deepEqual(
    decideIncomeRoleChange('spending', NO_ROWS, NO_TARGET, transactions),
    { error: 'timeout' },
  )
})

test('changing a category to income when it is already income is not blocked', () => {
  // Deliberately handed moves/targets/transactions that WOULD refuse a
  // spending->income transition (and some that even error) — proving the
  // already-income short-circuit fires before any of the three reads is
  // consulted, not just when they all happen to come back clean.
  const moves = { data: [{ id: 'move-1' }], error: null }
  const targets = { data: null, error: { message: 'connection reset' } }
  const transactions = { data: [{ id: 'txn-1' }], error: null }
  assert.equal(decideIncomeRoleChange('income', moves, targets, transactions), null)
})
