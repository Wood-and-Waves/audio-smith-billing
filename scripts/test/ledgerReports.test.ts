import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  filterRange, plSummary, spendByCategory, incomeByCategory, monthlyTotals,
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

test('incomeByCategory totals income per category, skipping every other kind', () => {
  const rows: ReportTxn[] = [
    { date: '2026-05-01', amount_cents: 60000, kind: 'income', category_id: 'inc' },
    { date: '2026-05-02', amount_cents: 40000, kind: 'income', category_id: 'inc' },
    { date: '2026-05-03', amount_cents: -1000, kind: 'expense', category_id: 'meals' },
    { date: '2026-05-04', amount_cents: -200000, kind: 'owner_pay', category_id: null },
  ]
  const { rows: out, uncategorizedCents } = incomeByCategory(rows, CATS)
  assert.equal(out.length, 1)
  assert.equal(out[0].category.id, 'inc')
  assert.equal(out[0].earnedCents, 100000)
  assert.equal(uncategorizedCents, 0)
})

test('incomeByCategory collects uncategorized income separately', () => {
  const rows: ReportTxn[] = [
    { date: '2026-05-01', amount_cents: 25000, kind: 'income', category_id: null },
  ]
  const { rows: out, uncategorizedCents } = incomeByCategory(rows, CATS)
  assert.deepEqual(out, [])
  assert.equal(uncategorizedCents, 25000)
})

test('incomeByCategory omits categories with no income in range', () => {
  const { rows: out } = incomeByCategory([], CATS)
  assert.deepEqual(out, [])
})

// --- refunds -----------------------------------------------------------------
//
// A positive amount in an EXPENSE category is a refund, not revenue. Five
// Amazon refunds sat in Audio Tools and a Hartford refund in Insurance, and
// both printed in the Income section of his P&L under an expense category's
// name (2026-09-10). A refund reduces the expense it refunded.

const refundCats: ReportCategory[] = [
  { id: 'show', name: 'Show Income', grp: 'Income', sort: 1, deductible: false },
  { id: 'tools', name: 'Audio Tools', grp: 'Purchases', sort: 1, deductible: true },
  { id: 'ins', name: 'Insurance', grp: 'Bills', sort: 1, deductible: true },
]

const refundTxns: ReportTxn[] = [
  { date: '2026-03-01', amount_cents: 100000, kind: 'income', category_id: 'show' },
  { date: '2026-03-02', amount_cents: -50000, kind: 'expense', category_id: 'tools' },
  { date: '2026-03-03', amount_cents: 1947, kind: 'income', category_id: 'tools' },
  { date: '2026-03-04', amount_cents: -20000, kind: 'expense', category_id: 'ins' },
  { date: '2026-03-05', amount_cents: 3500, kind: 'income', category_id: 'ins' },
]

test('a refund reduces its category instead of appearing as income', () => {
  const { rows } = spendByCategory(refundTxns, refundCats)
  const tools = rows.find(r => r.category.id === 'tools')
  assert.equal(tools?.spentCents, 50000 - 1947)
  const income = incomeByCategory(refundTxns, refundCats)
  assert.deepEqual(income.rows.map(r => r.category.id), ['show'])
})

test('income in an Income-group category is still income', () => {
  const { rows } = incomeByCategory(refundTxns, refundCats)
  assert.equal(rows.find(r => r.category.id === 'show')?.earnedCents, 100000)
})

test('the summary drops refunds from BOTH sides, leaving net untouched', () => {
  const s = plSummary(refundTxns, refundCats)
  assert.equal(s.incomeCents, 100000)
  assert.equal(s.expenseCents, 70000 - 1947 - 3500)
  assert.equal(s.netCents, 100000 - (70000 - 1947 - 3500))
  // The whole point: treating them as income would give the same net.
  assert.equal(s.netCents, (100000 + 1947 + 3500) - 70000)
})

test('a refund of a deductible purchase reduces the deductible total', () => {
  const s = plSummary(refundTxns, refundCats)
  assert.equal(s.deductibleCents, 70000 - 1947 - 3500)
})

test('uncategorized income is still income — nothing can be assumed about it', () => {
  const s = plSummary(
    [{ date: '2026-03-01', amount_cents: 5000, kind: 'income', category_id: null }], refundCats)
  assert.equal(s.incomeCents, 5000)
  assert.equal(s.uncategorizedCount, 1)
})

test('a category refunded to exactly zero drops out rather than printing $0.00', () => {
  const { rows } = spendByCategory([
    { date: '2026-03-02', amount_cents: -1947, kind: 'expense', category_id: 'tools' },
    { date: '2026-03-03', amount_cents: 1947, kind: 'income', category_id: 'tools' },
  ], refundCats)
  assert.equal(rows.find(r => r.category.id === 'tools'), undefined)
})
