// Expenses to invoice lines. Pure — no database, no images, no clock.
//
// The figures in the first test are the real Napa trip from the Gig Expense
// Calc sheet: $266.21 of food, $120.00 of baggage, and no rides at all.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  expenseLines, expensesMissingReceipts, CATEGORY_LABEL, type ExpenseLike,
} from '../../lib/expenses.ts'
import { formatUSD, lineTotal } from '../../lib/money.ts'
import {
  computeShowLines, mergeLines, type ShowRates, type BucketLine,
} from '../../lib/showBuckets.ts'
import type { ShowRuleset, ShowDayLike } from '../../lib/payroll.ts'

const exp = (over: Partial<ExpenseLike> = {}): ExpenseLike => ({
  id: 'e1',
  category: 'meals',
  where_spent: 'HMS Host',
  amount_cents: 2669,
  spent_on: '2026-05-17',
  receipt_path: 'owner/show/e1-enhanced.jpg',
  billable: true,
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

test('a my-cost expense never becomes an invoice line', () => {
  const lines = expenseLines([
    exp({ amount_cents: 2000 }),
    exp({ id: 'e2', amount_cents: 1875, billable: false }),
  ])
  assert.equal(lines.length, 1)
  assert.equal(lines[0].unit_price_cents, 2000, 'only the billable amount')
})

test('a show with only my-cost expenses produces no expense lines at all', () => {
  assert.deepEqual(expenseLines([exp({ billable: false })]), [])
})

test('a my-cost expense without a receipt never blocks billing', () => {
  const missing = expensesMissingReceipts([
    exp({ id: 'b1', receipt_path: null }),                      // billable, blocks
    exp({ id: 'm1', receipt_path: null, billable: false }),     // my-cost, ignored
  ])
  assert.deepEqual(missing.map((e) => e.id), ['b1'])
})

// Regression for the preview/invoice parity bug: a $5,850 preview against a
// $6,226.21 invoice, because one of the two `...expenseLines(...)` spreads
// was missing. Both call sites are modelled exactly as they build their
// arrays, not simplified:
//   - preview (app/shows/page.tsx, app/shows/[id]/page.tsx): per show,
//     [...computeShowLines(...), ...expenseLines(...)], the per-show arrays
//     then merged together.
//   - billing (billShows, app/shows/actions.ts): computeShowLines(...) and
//     expenseLines(...) pushed as two SEPARATE array entries per show, all
//     shows' entries then merged together.
// Two shows share a day rate (so Day Rate actually merges into one line)
// and both carry $19.98 of meals (so Meal Expenses actually merges into
// one line too) — otherwise the merge step would be a no-op and this test
// would pass even with a shape bug.
test("the preview's flat sequence and billShows' grouped sequence agree", () => {
  const rates: ShowRates = {
    day_rate_cents: 70000, travel_rate_cents: 35000, pm_rate_cents: 7000,
    ot_rate_cents: 0, dt_rate_cents: 0, meal_penalty_cents: 0, rate_card_name: null,
  }
  const rules: ShowRuleset = {
    overtime_after_hours: 11, double_time_enabled: false, double_time_after_hours: 14,
    meal_penalty_enabled: false, meal_penalty_grace_hours: 6,
    minimum_meal_break_enabled: true, minimum_meal_break_minutes: 60,
    meal_break_deduction_cap: 60, short_turn_penalty_enabled: false,
    short_turn_rest_hours: 10, continuous_time_enabled: false,
  }

  const dayA: ShowDayLike = {
    id: 'da', date: '2026-06-01', pay_as_half_day: false, travel_in: false, travel_out: false,
    punches: [
      { punch_type: 'start', punched_at: '2026-06-01T13:00:00Z' },
      { punch_type: 'end', punched_at: '2026-06-01T23:00:00Z' },
    ],
  }
  const dayB: ShowDayLike = {
    id: 'db', date: '2026-06-08', pay_as_half_day: false, travel_in: false, travel_out: false,
    punches: [
      { punch_type: 'start', punched_at: '2026-06-08T13:00:00Z' },
      { punch_type: 'end', punched_at: '2026-06-08T23:00:00Z' },
    ],
  }

  const expensesA: ExpenseLike[] = [
    exp({ id: 'a1', category: 'meals', where_spent: 'Diner', amount_cents: 1200 }),
    exp({ id: 'a2', category: 'meals', where_spent: 'Cafe', amount_cents: 798 }),
    // My-cost: must not reach either shape's expenseLines output, so it must
    // not move either total below.
    exp({ id: 'a3', category: 'meals', where_spent: 'Personal Snack', amount_cents: 5000, billable: false }),
  ]
  const expensesB: ExpenseLike[] = [
    exp({ id: 'b1', category: 'meals', where_spent: 'Grill', amount_cents: 1998 }),
    exp({ id: 'b2', category: 'meals', where_spent: 'Personal Coffee', amount_cents: 4200, billable: false }),
  ]

  // preview's shape: per show, computeShowLines then expenseLines spread
  // flat into one array, then merged across shows.
  const previewA = [...computeShowLines([dayA], [], rates, rules), ...expenseLines(expensesA)]
  const previewB = [...computeShowLines([dayB], [], rates, rules), ...expenseLines(expensesB)]
  const previewMerged = mergeLines([previewA, previewB])
  const previewTotal =
    previewMerged.reduce((t, l) => t + lineTotal(l.qty_hundredths, l.unit_price_cents), 0)

  // billShows' shape: computeShowLines and expenseLines pushed as separate
  // array entries per show, all shows' entries then merged.
  const perShow: BucketLine[][] = []
  perShow.push(computeShowLines([dayA], [], rates, rules))
  perShow.push(expenseLines(expensesA))
  perShow.push(computeShowLines([dayB], [], rates, rules))
  perShow.push(expenseLines(expensesB))
  const billingMerged = mergeLines(perShow)
  const billingTotal =
    billingMerged.reduce((t, l) => t + lineTotal(l.qty_hundredths, l.unit_price_cents), 0)

  assert.deepEqual(previewMerged, billingMerged, 'the two shapes must merge to identical lines')
  assert.equal(previewTotal, billingTotal, 'the two shapes must total identically')

  // Prove the merge is not a no-op: Day Rate (same $700 both shows) and
  // Meal Expenses (both shows total $19.98) each collapse from two lines
  // into one, so dropping either expenseLines() spread would change both
  // the line count and the total, not just leave a line out silently.
  assert.equal(billingMerged.length, 2)
  const dayRate = billingMerged.find((l) => l.description === 'Day Rate')
  const meals = billingMerged.find((l) => l.description === 'Meal Expenses')
  assert.equal(dayRate?.qty_hundredths, 200)
  assert.equal(meals?.qty_hundredths, 200)
  assert.equal(meals?.unit_price_cents, 1998)
  // Unchanged from before the my-cost fixtures were added: the $50 and $42
  // my-cost rows must not appear in either shape's total.
  assert.equal(formatUSD(billingTotal), '$1,439.96') // 2 x $700 day rate + $19.98 x 2 meals
})
