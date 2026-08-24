// Pins categoryOwnedByCaller's (app/money/budget/actions.ts) decision
// matrix: the first write path onto Dan's live books, and the same bug
// class already regressed once inside this budget wave. Exactly the three
// cases the review asked for — a matching owner, someone else's category,
// and a read that errors outright.
//
// Grown for budget-phase-two's assign/move actions: budget_role/hidden
// refusals, and proof the original three cases still hold when those two
// fields are simply absent (setCategoryTarget/clearCategoryTarget's own
// shape, unchanged by the growth).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideCategoryOwnership } from '../../lib/categoryOwnership.ts'

test('the category is the caller\'s own — passes', () => {
  assert.equal(
    decideCategoryOwnership({ owner_id: 'owner-1' }, null, 'owner-1'),
    null,
  )
})

test('the category belongs to somebody else — rejects with the action\'s own message', () => {
  assert.deepEqual(
    decideCategoryOwnership({ owner_id: 'someone-else' }, null, 'owner-1'),
    { ok: false, error: 'That category does not belong to you.' },
  )
})

test('the read itself errors — rejects on error.message and never falls through to success', () => {
  // data would pass on its own (owner_id matches) — proving the error check
  // wins even when the row underneath it looks fine, not just when data is
  // absent too.
  assert.deepEqual(
    decideCategoryOwnership({ owner_id: 'owner-1' }, { message: 'connection reset' }, 'owner-1'),
    { ok: false, error: 'connection reset' },
  )
})

// ---------------------------------------------------------------------------
// budget_role / hidden — grown for budget-phase-two's assign/move paths.
// setCategoryTarget/clearCategoryTarget never select these two columns, so
// their calls always hand in `undefined` for both — the three cases above
// (no budget_role/hidden field at all) already prove those two checks are
// no-ops when the fields are absent, so this growth leaves that pre-existing
// behavior unchanged, byte for byte.

test('an owned income-role category is refused, even though ownership itself passes', () => {
  assert.deepEqual(
    decideCategoryOwnership({ owner_id: 'owner-1', budget_role: 'income' }, null, 'owner-1'),
    { ok: false, error: 'Income categories are not part of the budget.' },
  )
})

test('an owned hidden category is refused, even though ownership itself passes', () => {
  assert.deepEqual(
    decideCategoryOwnership({ owner_id: 'owner-1', budget_role: 'spending', hidden: true }, null, 'owner-1'),
    { ok: false, error: 'Hidden categories cannot be assigned money.' },
  )
})

test('an owned spending, visible category with budget_role/hidden present passes', () => {
  assert.equal(
    decideCategoryOwnership({ owner_id: 'owner-1', budget_role: 'spending', hidden: false }, null, 'owner-1'),
    null,
  )
})

test('a category belonging to someone else is refused with the ownership message, not the income one — even when it is also income', () => {
  // Proves ownership is decided BEFORE role: a caller probing someone
  // else's category must learn only "not yours," never "not yours, and
  // also it's an income category" — that would leak information about a
  // category it has no business seeing.
  assert.deepEqual(
    decideCategoryOwnership(
      { owner_id: 'someone-else', budget_role: 'income', hidden: true },
      null,
      'owner-1',
    ),
    { ok: false, error: 'That category does not belong to you.' },
  )
})

test('a failed read is refused on error.message even when budget_role/hidden would otherwise pass', () => {
  assert.deepEqual(
    decideCategoryOwnership(
      { owner_id: 'owner-1', budget_role: 'spending', hidden: false },
      { message: 'timeout' },
      'owner-1',
    ),
    { ok: false, error: 'timeout' },
  )
})
