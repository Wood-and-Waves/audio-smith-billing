// Pins decideIncomeRoleChange's (lib/incomeRoleGuard.ts) decision matrix —
// the guard that stops flipping a category to budget_role 'income' from
// silently rewriting every month buildBudget's spendingIds covers. Exactly
// the five cases the final review asked for: assignments refuse, a target
// refuses, neither allows it, a failed read refuses rather than waving it
// through, and a category that's already income is never blocked.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideIncomeRoleChange, INCOME_ROLE_CHANGE_REFUSAL } from '../../lib/incomeRoleGuard.ts'

const NO_ROWS = { data: [], error: null }
const NO_TARGET = { data: [], error: null }

test('a category with assignments refuses the change to income', () => {
  const moves = { data: [{ id: 'move-1' }], error: null }
  assert.deepEqual(
    decideIncomeRoleChange('spending', moves, NO_TARGET),
    { error: INCOME_ROLE_CHANGE_REFUSAL },
  )
})

test('a category with a target refuses the change to income', () => {
  const targets = { data: [{ id: 'target-1' }], error: null }
  assert.deepEqual(
    decideIncomeRoleChange('spending', NO_ROWS, targets),
    { error: INCOME_ROLE_CHANGE_REFUSAL },
  )
})

test('a category with neither moves nor a target allows the change', () => {
  assert.equal(decideIncomeRoleChange('spending', NO_ROWS, NO_TARGET), null)
})

test('a failed moves read refuses rather than waving it through', () => {
  // moves.data is null (as a real failed Postgrest call would report) — a
  // presence check on data alone would read this as "no moves" and let the
  // write through. The error must win first.
  const moves = { data: null, error: { message: 'connection reset' } }
  assert.deepEqual(
    decideIncomeRoleChange('spending', moves, NO_TARGET),
    { error: 'connection reset' },
  )
})

test('a failed targets read refuses rather than waving it through, even with moves.data empty', () => {
  const targets = { data: null, error: { message: 'timeout' } }
  assert.deepEqual(
    decideIncomeRoleChange('spending', NO_ROWS, targets),
    { error: 'timeout' },
  )
})

test('changing a category to income when it is already income is not blocked', () => {
  // Deliberately handed moves/targets that WOULD refuse a spending->income
  // transition (and one that even errors) — proving the already-income
  // short-circuit fires before either read is consulted, not just when
  // both happen to come back empty.
  const moves = { data: [{ id: 'move-1' }], error: null }
  const targets = { data: null, error: { message: 'connection reset' } }
  assert.equal(decideIncomeRoleChange('income', moves, targets), null)
})
