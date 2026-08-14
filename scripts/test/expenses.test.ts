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
  const meals = [1998, 1228, 898, 898, 3523, 2438, 1265, 6220, 2438, 4715, 1000]
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
