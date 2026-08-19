import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizePayee, rememberedCategories, memoryKey } from '../../lib/payeeMemory.ts'

const R = (payee: string, category_id: string | null, kind = 'expense', date = '2026-08-01') =>
  ({ payee, category_id, kind, date })

test('a categorized payee is remembered, case- and space-insensitively', () => {
  const m = rememberedCategories([R('Travel  Diner ', 'cat-meals')])
  assert.equal(m.get(memoryKey('expense', 'TRAVEL DINER')), 'cat-meals')
})

test('the newest categorization wins', () => {
  const m = rememberedCategories([
    R('Gear Outlet', 'cat-supplies', 'expense', '2026-05-01'),
    R('Gear Outlet', 'cat-equipment', 'expense', '2026-07-01'),
  ])
  assert.equal(m.get(memoryKey('expense', 'gear outlet')), 'cat-equipment')
})

test('uncategorized rows teach nothing', () => {
  const m = rememberedCategories([R('Mystery Vendor', null)])
  assert.equal(m.get(memoryKey('expense', 'mystery vendor')), undefined)
})

test('owner-pay and transfer rows never teach', () => {
  const m = rememberedCategories([
    R('Transfer to Personal', 'cat-anything', 'owner_pay'),
    R('Transfer to Personal', 'cat-other', 'transfer'),
  ])
  assert.equal(m.size, 0)
})

test('a blank payee teaches nothing', () => {
  assert.equal(rememberedCategories([R('   ', 'cat-x')]).size, 0)
})

// I1: memory is keyed on (kind, payee) — a payee categorized as an expense
// must never leak into that same payee's income rows, and vice versa. This
// is the actual bug this fix closes: "SQUARE INC" categorized as Bank Fees
// on an expense used to silently pre-fill the same category on SQUARE INC
// *income* rows too, since the old key was payee-only.
test('an expense categorization never teaches that payee\'s income rows', () => {
  const m = rememberedCategories([R('Square Inc', 'cat-bank-fees', 'expense')])
  assert.equal(m.get(memoryKey('expense', 'Square Inc')), 'cat-bank-fees')
  assert.equal(m.get(memoryKey('income', 'Square Inc')), undefined)
})

test('an income categorization never teaches that payee\'s expense rows', () => {
  const m = rememberedCategories([R('Square Inc', 'cat-show-income', 'income')])
  assert.equal(m.get(memoryKey('income', 'Square Inc')), 'cat-show-income')
  assert.equal(m.get(memoryKey('expense', 'Square Inc')), undefined)
})

test('income and expense memory for the same payee are kept independently', () => {
  const m = rememberedCategories([
    R('Square Inc', 'cat-show-income', 'income', '2026-06-01'),
    R('Square Inc', 'cat-bank-fees', 'expense', '2026-06-02'),
  ])
  assert.equal(m.get(memoryKey('income', 'Square Inc')), 'cat-show-income')
  assert.equal(m.get(memoryKey('expense', 'Square Inc')), 'cat-bank-fees')
  assert.equal(m.size, 2)
})

test('memoryKey normalizes only the payee half, and joins on kind', () => {
  assert.equal(memoryKey('expense', ' Square  Inc '), 'expense:square inc')
  assert.equal(memoryKey('income', ' Square  Inc '), 'income:square inc')
})
