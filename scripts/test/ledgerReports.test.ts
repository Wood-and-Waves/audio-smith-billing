import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  filterRange, plSummary, spendByCategory, monthlyTotals,
  type ReportTxn, type ReportCategory,
} from '../../lib/ledgerReports.ts'

const CATS: ReportCategory[] = [
  { id: 'inc', name: 'Show Income', grp: 'Income', sort: 0, deductible: false },
  { id: 'meals', name: 'Meals', grp: 'Travel', sort: 22, deductible: true },
  { id: 'gear', name: 'Equipment & Gear', grp: 'Operations', sort: 10, deductible: true },
]

const T = (over: Partial<ReportTxn>): ReportTxn => ({
  date: '2026-05-10', amount_cents: -1000, kind: 'expense', category_id: 'meals', ...over,
})

const SAMPLE: ReportTxn[] = [
  T({ kind: 'income', amount_cents: 60000, category_id: 'inc', date: '2026-05-01' }),
  T({ amount_cents: -4253, category_id: 'meals', date: '2026-05-06' }),
  T({ amount_cents: -62000, category_id: 'gear', date: '2026-06-08' }),
  T({ amount_cents: -1500, category_id: null, date: '2026-06-09' }),        // uncategorized expense
  T({ kind: 'owner_pay', amount_cents: -200000, category_id: null, date: '2026-06-15' }),
  T({ kind: 'transfer', amount_cents: -5000, category_id: null, date: '2026-06-16' }),
  T({ amount_cents: -9999, category_id: 'meals', date: '2025-12-30' }),     // last year
]

test('the P&L keeps owner pay and transfers out of income and expenses', () => {
  const p = plSummary(filterRange(SAMPLE, '2026-01-01', '2026-12-31'), CATS)
  assert.equal(p.incomeCents, 60000)
  assert.equal(p.expenseCents, 4253 + 62000 + 1500)
  assert.equal(p.netCents, 60000 - 67753)
  assert.equal(p.ownerPayCents, 200000)
})

test('the deductible subtotal never guesses about uncategorized rows', () => {
  const p = plSummary(filterRange(SAMPLE, '2026-01-01', '2026-12-31'), CATS)
  assert.equal(p.deductibleCents, 4253 + 62000, 'the $15.00 uncategorized row is NOT counted')
  assert.equal(p.uncategorizedCount, 1)
})

test('spend by category: grouped order, zero-spend omitted, uncategorized bucketed', () => {
  const { rows, uncategorizedCents } = spendByCategory(filterRange(SAMPLE, '2026-01-01', '2026-12-31'), CATS)
  assert.deepEqual(rows.map((r) => r.category.id), ['gear', 'meals'], 'Operations before Travel')
  assert.equal(rows[0].spentCents, 62000)
  assert.equal(rows[1].spentCents, 4253)
  assert.equal(uncategorizedCents, 1500)
})

test('monthly totals cover all 12 months and exclude other years', () => {
  const months = monthlyTotals(SAMPLE, '2026-01-01', '2026-12-31')
  assert.equal(months.length, 12)
  assert.deepEqual(months[4], { month: '2026-05', incomeCents: 60000, expenseCents: 4253 })
  assert.equal(months[5].expenseCents, 62000 + 1500)
  assert.equal(months.reduce((t, m) => t + m.expenseCents, 0), 67753, 'last December stays out')
})

test('filterRange is inclusive at BOTH ends', () => {
  const rows: ReportTxn[] = [
    T({ date: '2026-06-30' }), T({ date: '2026-07-01' }),
    T({ date: '2026-09-30' }), T({ date: '2026-10-01' }),
  ]
  const q3 = filterRange(rows, '2026-07-01', '2026-09-30')
  assert.deepEqual(q3.map((r) => r.date), ['2026-07-01', '2026-09-30'])
})

test('filterRange spans a year boundary', () => {
  const rows: ReportTxn[] = [
    T({ date: '2025-11-15' }), T({ date: '2025-12-31' }),
    T({ date: '2026-01-01' }), T({ date: '2026-02-14' }),
  ]
  assert.equal(filterRange(rows, '2025-12-01', '2026-01-31').length, 2)
})

test('filterRange returns nothing for a range with no rows in it', () => {
  assert.deepEqual(filterRange(SAMPLE, '2024-01-01', '2024-12-31'), [])
})

test('monthlyTotals emits one row per month the range touches — three for a quarter', () => {
  const months = monthlyTotals(SAMPLE, '2026-04-01', '2026-06-30')
  assert.deepEqual(months.map((m) => m.month), ['2026-04', '2026-05', '2026-06'])
})

test('monthlyTotals emits a single row when the range sits inside one month', () => {
  const months = monthlyTotals(SAMPLE, '2026-05-01', '2026-05-31')
  assert.deepEqual(months.map((m) => m.month), ['2026-05'])
  assert.equal(months[0].incomeCents, 60000)
})

test('monthlyTotals crosses a year boundary in order', () => {
  const months = monthlyTotals(SAMPLE, '2025-12-01', '2026-02-28')
  assert.deepEqual(months.map((m) => m.month), ['2025-12', '2026-01', '2026-02'])
  assert.equal(months[0].expenseCents, 9999) // the 2025-12-30 row in SAMPLE
})

// A row inside the range's months but outside its DAYS must not be counted:
// the range is days, and the month rows are only how it is displayed.
test('monthlyTotals respects the day boundaries, not just the months', () => {
  const rows: ReportTxn[] = [
    T({ kind: 'income', amount_cents: 10000, category_id: 'inc', date: '2026-05-01' }),
    T({ kind: 'income', amount_cents: 50000, category_id: 'inc', date: '2026-05-20' }),
  ]
  const months = monthlyTotals(rows, '2026-05-10', '2026-05-31')
  assert.equal(months.length, 1)
  assert.equal(months[0].incomeCents, 50000)
})
