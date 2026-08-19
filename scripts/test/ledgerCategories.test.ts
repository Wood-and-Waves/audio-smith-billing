// The seed chart is data, but data the whole Money section trusts: groups
// drive the editor's sections, deductible drives future CPA reporting, and
// is_equipment surfaces §179 candidates. Pin its shape.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_CATEGORIES } from '../../lib/ledgerCategories.ts'

test('every category has a non-blank name and group', () => {
  for (const cat of DEFAULT_CATEGORIES) {
    assert.ok(cat.name.trim().length > 0)
    assert.ok(cat.grp.trim().length > 0)
  }
})

test('names are unique', () => {
  const names = DEFAULT_CATEGORIES.map((c) => c.name)
  assert.equal(new Set(names).size, names.length)
})

test('income categories are never deductions', () => {
  for (const cat of DEFAULT_CATEGORIES.filter((c) => c.grp === 'Income')) {
    assert.equal(cat.deductible, false, cat.name)
  }
})

test('exactly Equipment & Gear carries the equipment flag', () => {
  const flagged = DEFAULT_CATEGORIES.filter((c) => c.is_equipment)
  assert.deepEqual(flagged.map((c) => c.name), ['Equipment & Gear'])
})

test('sort orders are unique so the editor renders deterministically', () => {
  const sorts = DEFAULT_CATEGORIES.map((c) => c.sort)
  assert.equal(new Set(sorts).size, sorts.length)
})
