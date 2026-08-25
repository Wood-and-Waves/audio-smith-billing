// Pins lib/budgetAutoAssign.ts — the pure plan auto-assign later tasks
// consume: which rows get funded, by how much, and the batch's Undo label.
// Same doctrine as budgetMoves.test.ts: this is where the actual branching
// gets pinned, not the server actions that call it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CategoryMonth } from '../../lib/budget.ts'
import { underfundedPlan, autoAssignBatchLabel } from '../../lib/budgetAutoAssign.ts'

// Same fixture idiom as budget.test.ts's own `monthRow`.
const monthRow = (over: Partial<CategoryMonth> = {}): CategoryMonth => ({
  categoryId: 'a', assignedCents: 0, activityCents: 0, availableCents: 0,
  status: { kind: 'none' }, neededCents: 0, targetCents: null, hidden: false, ...over,
})

// ---------------------------------------------------------------------------
// underfundedPlan

test('a row with neededCents: 0 produces nothing, even with negative available', () => {
  const rows = [monthRow({ categoryId: 'a', neededCents: 0, availableCents: -1_000 })]
  assert.deepEqual(underfundedPlan(rows), [])
})

test('a row with positive neededCents maps 1:1 with the exact cents', () => {
  const rows = [monthRow({ categoryId: 'a', neededCents: 12_345 })]
  assert.deepEqual(underfundedPlan(rows), [{ categoryId: 'a', amountCents: 12_345 }])
})

test('a hidden row with neededCents > 0 IS in the plan — hidden is presentation, the money is real', () => {
  const rows = [monthRow({ categoryId: 'a', hidden: true, neededCents: 5_000 })]
  assert.deepEqual(underfundedPlan(rows), [{ categoryId: 'a', amountCents: 5_000 }])
})

test('plan preserves row order and sums to the sum of positive neededCents', () => {
  const rows = [
    monthRow({ categoryId: 'c', neededCents: 300 }),
    monthRow({ categoryId: 'a', neededCents: 0 }),
    monthRow({ categoryId: 'b', neededCents: 100 }),
  ]
  const plan = underfundedPlan(rows)
  assert.deepEqual(plan, [
    { categoryId: 'c', amountCents: 300 },
    { categoryId: 'b', amountCents: 100 },
  ])
  const total = plan.reduce((sum, p) => sum + p.amountCents, 0)
  const expected = rows.filter((r) => r.neededCents > 0).reduce((sum, r) => sum + r.neededCents, 0)
  assert.equal(total, expected)
})

// ---------------------------------------------------------------------------
// autoAssignBatchLabel

test('label for a single category uses the singular noun', () => {
  assert.equal(autoAssignBatchLabel(1, 5_000), 'auto-assign (1 category, $50.00)')
})

test('label for multiple categories uses the plural noun', () => {
  assert.equal(autoAssignBatchLabel(12, 61_200), 'auto-assign (12 categories, $612.00)')
})
