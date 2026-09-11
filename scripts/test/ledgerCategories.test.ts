// The seed chart is data, but data the whole Money section trusts: groups
// drive the editor's sections, deductible drives future CPA reporting, and
// is_equipment surfaces §179 candidates. Pin its shape.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_CATEGORIES, OWNER_PAY_CATEGORY_NAME, seedCategoryRows } from '../../lib/ledgerCategories.ts'

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

// Computers alone, since 2026-09-10. The flag exists to surface purchases
// needing a depreciation or 179 decision, and Audio Tools does not qualify:
// 37 of 39 charges under $500 that year, the largest $577, against a de
// minimis threshold usually ten times that. Flagging it only started a
// conversation with his accountant that did not need to happen.
test('only Computers carries the equipment flag', () => {
  const flagged = DEFAULT_CATEGORIES.filter((c) => c.is_equipment)
  assert.deepEqual(flagged.map((c) => c.name), ['Computers'])
})

// The budget orders its groups by the lowest sort among their members, and the
// P&L follows the same numbering, so the bands ARE the order both screens use.
test('the groups are banded, and read down a P&L in the right order', () => {
  const lowest = new Map<string, number>()
  for (const cat of DEFAULT_CATEGORIES) {
    lowest.set(cat.grp, Math.min(lowest.get(cat.grp) ?? Infinity, cat.sort))
  }
  const order = [...lowest.entries()].sort((a, b) => a[1] - b[1]).map(([g]) => g)
  // Payroll joined at band 45 with migration 0053 — between the fees paid to
  // other people and the tax the business owes, which is where an accountant
  // reads officer compensation.
  assert.deepEqual(order, [
    'Income', 'Bills', 'Travel and Meals', 'Equipment and Supplies',
    'Professional Services', 'Payroll', 'Taxes and Licenses', 'Owner Transactions',
  ])
})

test('no group is split across two bands', () => {
  const seen = new Map<string, number[]>()
  DEFAULT_CATEGORIES.forEach((cat, i) => {
    if (!seen.has(cat.grp)) seen.set(cat.grp, [])
    seen.get(cat.grp)!.push(i)
  })
  for (const [grp, indexes] of seen) {
    const contiguous = indexes[indexes.length - 1] - indexes[0] + 1 === indexes.length
    assert.ok(contiguous, `${grp} is not contiguous in the seed`)
  }
})

test('sort orders are unique so the editor renders deterministically', () => {
  const sorts = DEFAULT_CATEGORIES.map((c) => c.sort)
  assert.equal(new Set(sorts).size, sorts.length)
})

test('income categories are inflows, never budget rows', () => {
  for (const cat of DEFAULT_CATEGORIES) {
    assert.equal(cat.budget_role === 'income', cat.grp === 'Income',
      `${cat.name} should be income-role exactly when it is in the Income group`)
  }
})

test('owner pay is a real category and is never deductible', () => {
  // Owner Transactions now holds several categories (Temporary Transfer, Loan
  // to Wood and Waves, Charitable Giving, owner pay, Money Due Wood and
  // Waves), so find owner pay by its own name rather than by group alone.
  const owner = DEFAULT_CATEGORIES.find((c) => c.name === OWNER_PAY_CATEGORY_NAME)
  assert.ok(owner, 'owner pay must have a category — the budget cannot add up without one')
  assert.equal(owner.grp, 'Owner Transactions', 'owner pay belongs in the Owner Transactions group')
  assert.equal(owner.deductible, false, 'paying yourself is not a deduction')
  assert.equal(owner.name, OWNER_PAY_CATEGORY_NAME,
    'must match migration 0039\'s insert and 0040\'s backfill verbatim, or a name lookup silently matches nothing')
})

test('every money-movement category in Owner Transactions defaults non-deductible', () => {
  // Temporary Transfer, Loan to Wood and Waves, Charitable Giving, and Money
  // Due Wood and Waves all default non-deductible per the chart's standing
  // doctrine: overstating deductions is the one direction this tool must
  // never fail. The CPA flips what belongs to him.
  for (const cat of DEFAULT_CATEGORIES.filter((c) => c.grp === 'Owner Transactions')) {
    assert.equal(cat.deductible, false, `${cat.name} should default non-deductible`)
  }
})

// seedCategoryRows is the exact row shape ensureDefaultCategories inserts —
// pinned here so a future edit that drops a column from that mapping (e.g.
// budget_role) fails this test instead of only surfacing as Ready to Assign
// quietly disagreeing with YNAB once a new income category gets seeded.
test('seedCategoryRows carries every seed field through to the insert payload, budget_role included', () => {
  const rows = seedCategoryRows('owner-1')
  assert.equal(rows.length, DEFAULT_CATEGORIES.length)
  for (const row of rows) {
    assert.equal(row.owner_id, 'owner-1')
    assert.ok('budget_role' in row, `${row.name} insert payload is missing budget_role`)
  }
  const incomeNames = rows.filter((r) => r.budget_role === 'income').map((r) => r.name).sort()
  assert.deepEqual(incomeNames, ['Other Income', 'Show Income'],
    'exactly the Income-group categories should reach the DB as budget_role \'income\'')
})
