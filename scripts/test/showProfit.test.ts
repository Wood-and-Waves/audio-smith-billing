// The take-home math is an ESTIMATE Dan parameterizes — the rate is his
// CPA's number, never the app's. Pure, so the asymmetry that makes it
// honest (reimbursed expenses net to zero, my-cost ones don't) is pinned
// here without a database.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { showProfit } from '../../lib/showProfit.ts'

test('profit, set-aside and take-home for a plain show', () => {
  // $600 day, no expenses, 30%
  assert.deepEqual(
    showProfit({ revenueCents: 60000, expensesPaidCents: 0, setasideBp: 3000 }),
    { profitCents: 60000, setasideCents: 18000, takeHomeCents: 42000 },
  )
})

test('a reimbursed expense nets to zero: only labor is profit', () => {
  // $780 labor + $120 reimbursed baggage billed = $900 revenue; Dan paid the $120.
  const p = showProfit({ revenueCents: 90000, expensesPaidCents: 12000, setasideBp: 3000 })
  assert.equal(p.profitCents, 78000, 'profit is the labor, the reimbursement washed out')
})

test('a per-diem show: allowance in, my-cost meals out — the margin is the profit', () => {
  // $600 day + $65 per-diem line = $665 revenue; $41.20 of meals Dan paid, never billed.
  const p = showProfit({ revenueCents: 66500, expensesPaidCents: 4120, setasideBp: 0 })
  assert.equal(p.profitCents, 62380)
  assert.equal(p.setasideCents, 0, 'rate unset: no invented estimate')
  assert.equal(p.takeHomeCents, 62380)
})

test('set-aside rounds like money everywhere else (half away from zero)', () => {
  // 33.33% of $100.01 = 3333.3333 cents -> 3333
  assert.equal(
    showProfit({ revenueCents: 10001, expensesPaidCents: 0, setasideBp: 3333 }).setasideCents,
    3333,
  )
})

test('a loss sets nothing aside', () => {
  const p = showProfit({ revenueCents: 10000, expensesPaidCents: 15000, setasideBp: 3000 })
  assert.deepEqual(p, { profitCents: -5000, setasideCents: 0, takeHomeCents: -5000 })
})
