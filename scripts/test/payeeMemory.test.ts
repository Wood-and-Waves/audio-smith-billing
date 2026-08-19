import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizePayee, rememberedCategories } from '../../lib/payeeMemory.ts'

const R = (payee: string, category_id: string | null, kind = 'expense', date = '2026-08-01') =>
  ({ payee, category_id, kind, date })

test('a categorized payee is remembered, case- and space-insensitively', () => {
  const m = rememberedCategories([R('Travel  Diner ', 'cat-meals')])
  assert.equal(m.get(normalizePayee('TRAVEL DINER')), 'cat-meals')
})

test('the newest categorization wins', () => {
  const m = rememberedCategories([
    R('Gear Outlet', 'cat-supplies', 'expense', '2026-05-01'),
    R('Gear Outlet', 'cat-equipment', 'expense', '2026-07-01'),
  ])
  assert.equal(m.get('gear outlet'), 'cat-equipment')
})

test('uncategorized rows teach nothing', () => {
  const m = rememberedCategories([R('Mystery Vendor', null)])
  assert.equal(m.get('mystery vendor'), undefined)
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
