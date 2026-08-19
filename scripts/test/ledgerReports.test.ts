import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  filterYear, plSummary, spendByCategory, monthlyTotals,
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
  const p = plSummary(filterYear(SAMPLE, 2026), CATS)
  assert.equal(p.incomeCents, 60000)
  assert.equal(p.expenseCents, 4253 + 62000 + 1500)
  assert.equal(p.netCents, 60000 - 67753)
  assert.equal(p.ownerPayCents, 200000)
})

test('the deductible subtotal never guesses about uncategorized rows', () => {
  const p = plSummary(filterYear(SAMPLE, 2026), CATS)
  assert.equal(p.deductibleCents, 4253 + 62000, 'the $15.00 uncategorized row is NOT counted')
  assert.equal(p.uncategorizedCount, 1)
})

test('spend by category: grouped order, zero-spend omitted, uncategorized bucketed', () => {
  const { rows, uncategorizedCents } = spendByCategory(filterYear(SAMPLE, 2026), CATS)
  assert.deepEqual(rows.map((r) => r.category.id), ['gear', 'meals'], 'Operations before Travel')
  assert.equal(rows[0].spentCents, 62000)
  assert.equal(rows[1].spentCents, 4253)
  assert.equal(uncategorizedCents, 1500)
})

test('monthly totals cover all 12 months and exclude other years', () => {
  const months = monthlyTotals(SAMPLE, 2026)
  assert.equal(months.length, 12)
  assert.deepEqual(months[4], { month: '2026-05', incomeCents: 60000, expenseCents: 4253 })
  assert.equal(months[5].expenseCents, 62000 + 1500)
  assert.equal(months.reduce((t, m) => t + m.expenseCents, 0), 67753, 'last December stays out')
})

test('filterYear is a plain prefix match on the date', () => {
  assert.equal(filterYear(SAMPLE, 2025).length, 1)
})
