// The two formulas that run the budget screen, pinned.
//
// A wrong number here is a wrong number in Dan's books, and the whole point of
// this screen is that it reconciles against YNAB — so the rollover rule and the
// Ready to Assign rule each get their own tests, including the cases that only
// show up once a year.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildBudget,
  type BudgetCategory, type BudgetMove, type BudgetTxn, type CategoryTarget,
} from '../../lib/budget.ts'

const cat = (id: string, over: Partial<BudgetCategory> = {}): BudgetCategory => ({
  id, name: id, grp: 'Bills', sort: 0, hidden: false, budgetRole: 'spending', ...over,
})

const assign = (month: string, to: string, amountCents: number): BudgetMove =>
  ({ month, fromCategoryId: null, toCategoryId: to, amountCents })

const spend = (month: string, categoryId: string | null, amountCents: number): BudgetTxn =>
  ({ month, categoryId, amountCents })

const build = (o: Partial<Parameters<typeof buildBudget>[0]> = {}) => buildBudget({
  categories: [cat('a')], moves: [], txns: [], targets: [],
  fromMonth: '2026-01', toMonth: '2026-03', ...o,
})

const row = (b: Map<string, ReturnType<typeof buildBudget> extends Map<string, infer M> ? M : never>, month: string, id: string) =>
  b.get(month)!.rows.find((r) => r.categoryId === id)!

test('assigned, activity and available for a single plain month', () => {
  const b = build({ moves: [assign('2026-01', 'a', 50_000)], txns: [spend('2026-01', 'a', -20_000)] })
  const r = row(b, '2026-01', 'a')
  assert.equal(r.assignedCents, 50_000)
  assert.equal(r.activityCents, -20_000)
  assert.equal(r.availableCents, 30_000)
})

test('a positive balance rolls forward into the next month', () => {
  const b = build({ moves: [assign('2026-01', 'a', 50_000)] })
  assert.equal(row(b, '2026-01', 'a').availableCents, 50_000)
  assert.equal(row(b, '2026-02', 'a').availableCents, 50_000)
  assert.equal(row(b, '2026-02', 'a').assignedCents, 0)
})

test('overspending does NOT roll forward — the category restarts at zero', () => {
  const b = build({ moves: [assign('2026-01', 'a', 10_000)], txns: [spend('2026-01', 'a', -15_000)] })
  assert.equal(row(b, '2026-01', 'a').availableCents, -5_000)
  assert.equal(row(b, '2026-02', 'a').availableCents, 0,
    'February starts clean; January\'s overspend is Ready to Assign\'s problem')
})

test('last month\'s overspending is taken out of this month\'s Ready to Assign', () => {
  const b = build({
    moves: [assign('2026-01', 'a', 10_000)],
    txns: [spend('2026-01', null, 100_000), spend('2026-01', 'a', -15_000)],
  })
  // January: 100,000 in, 10,000 assigned -> 90,000 left to assign.
  assert.equal(b.get('2026-01')!.readyToAssignCents, 90_000)
  // February inherits that, less January''s 5,000 of overspending.
  assert.equal(b.get('2026-02')!.readyToAssignCents, 85_000)
})

test('income is anything that does not land in a spending category', () => {
  const b = build({
    categories: [cat('a'), cat('inc', { budgetRole: 'income', grp: 'Income' })],
    txns: [spend('2026-01', 'inc', 200_000), spend('2026-01', null, -1_500)],
  })
  assert.equal(b.get('2026-01')!.readyToAssignCents, 198_500,
    'an uncategorised outflow reduces Ready to Assign, exactly as YNAB does it')
  assert.equal(b.get('2026-01')!.rows.length, 1, 'income categories are never budget rows')
})

test('a refund nets activity down instead of needing a special case', () => {
  const b = build({
    moves: [assign('2026-01', 'a', 50_000)],
    txns: [spend('2026-01', 'a', -20_000), spend('2026-01', 'a', 5_000)],
  })
  assert.equal(row(b, '2026-01', 'a').activityCents, -15_000)
  assert.equal(row(b, '2026-01', 'a').availableCents, 35_000)
})

test('moving money between categories changes neither total nor Ready to Assign', () => {
  const b = build({
    categories: [cat('a'), cat('b')],
    txns: [spend('2026-01', null, 100_000)],
    moves: [
      assign('2026-01', 'a', 50_000),
      { month: '2026-01', fromCategoryId: 'a', toCategoryId: 'b', amountCents: 20_000 },
    ],
  })
  assert.equal(row(b, '2026-01', 'a').availableCents, 30_000)
  assert.equal(row(b, '2026-01', 'b').availableCents, 20_000)
  assert.equal(b.get('2026-01')!.readyToAssignCents, 50_000, 'only the 50,000 left Ready to Assign')
})

test('an undone move does not count — undo marks, it never deletes', () => {
  const b = buildBudget({
    categories: [cat('a')], txns: [], targets: [], fromMonth: '2026-01', toMonth: '2026-01',
    moves: [{ ...assign('2026-01', 'a', 50_000), undoneAt: '2026-01-05T00:00:00Z' } as BudgetMove],
  })
  assert.equal(row(b, '2026-01', 'a').assignedCents, 0)
})

test('a month with no assignment at all still reports its carried balance', () => {
  const b = build({ moves: [assign('2026-01', 'a', 50_000)] })
  const m = b.get('2026-03')!
  assert.equal(m.assignedCents, 0)
  assert.equal(m.leftOverCents, 50_000)
  assert.equal(m.availableCents, 50_000)
})

// --- targets ---

const monthly = (id: string, amountCents: number): CategoryTarget =>
  ({ categoryId: id, kind: 'monthly', amountCents, dueDate: null })

test('a monthly target that is met reads as funded', () => {
  const b = build({ targets: [monthly('a', 20_000)], moves: [assign('2026-01', 'a', 20_000)] })
  assert.deepEqual(row(b, '2026-01', 'a').status, { kind: 'funded', spentCents: 0, targetCents: 20_000 })
  assert.equal(row(b, '2026-01', 'a').neededCents, 0)
})

test('a monthly target funded and then spent to zero reads as fully spent', () => {
  const b = build({
    targets: [monthly('a', 20_000)],
    moves: [assign('2026-01', 'a', 20_000)],
    txns: [spend('2026-01', 'a', -20_000)],
  })
  assert.deepEqual(row(b, '2026-01', 'a').status, { kind: 'fully_spent' })
})

test('an unfunded monthly target reports exactly what it still needs', () => {
  const b = build({ targets: [monthly('a', 20_000)], moves: [assign('2026-01', 'a', 5_000)] })
  assert.deepEqual(row(b, '2026-01', 'a').status, { kind: 'underfunded', neededCents: 15_000 })
  assert.equal(b.get('2026-01')!.underfundedCents, 15_000)
})

test('overspending beats every other status — red wins', () => {
  const b = build({
    targets: [monthly('a', 20_000)],
    moves: [assign('2026-01', 'a', 20_000)],
    txns: [spend('2026-01', 'a', -25_000)],
  })
  assert.deepEqual(row(b, '2026-01', 'a').status,
    { kind: 'overspent', spentCents: 25_000, assignedCents: 20_000 })
})

test('carried money counts towards a monthly target — you do not refund what is already there', () => {
  const b = build({ targets: [monthly('a', 20_000)], moves: [assign('2026-01', 'a', 20_000)] })
  assert.deepEqual(row(b, '2026-02', 'a').status, { kind: 'funded', spentCents: 0, targetCents: 20_000 })
  assert.equal(row(b, '2026-02', 'a').neededCents, 0, 'February needs nothing — January\'s money carried')
})

test('a by-date target spreads what is missing across the months remaining', () => {
  // 30,000 wanted by the end of March; nothing saved. From January that is three
  // months, so 10,000 a month.
  const b = build({
    targets: [{ categoryId: 'a', kind: 'by_date', amountCents: 30_000, dueDate: '2026-03-31' }],
  })
  assert.equal(row(b, '2026-01', 'a').neededCents, 10_000)
  assert.deepEqual(row(b, '2026-01', 'a').status, { kind: 'needed_eventually', remainingCents: 30_000 })
})

test('a by-date target with this month\'s share already in reads as on track', () => {
  const b = build({
    targets: [{ categoryId: 'a', kind: 'by_date', amountCents: 30_000, dueDate: '2026-03-31' }],
    moves: [assign('2026-01', 'a', 10_000)],
  })
  assert.equal(row(b, '2026-01', 'a').neededCents, 0)
  assert.deepEqual(row(b, '2026-01', 'a').status, { kind: 'on_track' })
})

test('a by-date target past its due date asks for the whole shortfall at once', () => {
  const b = build({
    targets: [{ categoryId: 'a', kind: 'by_date', amountCents: 30_000, dueDate: '2025-12-31' }],
  })
  assert.equal(row(b, '2026-01', 'a').neededCents, 30_000)
})

test('a category with no target has no status and never counts as underfunded', () => {
  const b = build({ moves: [assign('2026-01', 'a', 5_000)] })
  assert.deepEqual(row(b, '2026-01', 'a').status, { kind: 'none' })
  assert.equal(b.get('2026-01')!.underfundedCents, 0)
})

test('a row carries its target\'s figure so the bar and the filters need not refetch', () => {
  const b = build({ targets: [monthly('a', 20_000)] })
  assert.equal(row(b, '2026-01', 'a').targetCents, 20_000)
  assert.equal(row(build(), '2026-01', 'a').targetCents, null)
})

test('hidden categories stay out of the budget entirely', () => {
  const b = build({ categories: [cat('a'), cat('gone', { hidden: true })] })
  assert.deepEqual(b.get('2026-01')!.rows.map((r) => r.categoryId), ['a'])
})

test('month totals are the sum of their rows', () => {
  const b = build({
    categories: [cat('a'), cat('b')],
    moves: [assign('2026-01', 'a', 50_000), assign('2026-01', 'b', 30_000)],
    txns: [spend('2026-01', 'a', -20_000)],
  })
  const m = b.get('2026-01')!
  assert.equal(m.assignedCents, 80_000)
  assert.equal(m.activityCents, -20_000)
  assert.equal(m.availableCents, 60_000)
})
