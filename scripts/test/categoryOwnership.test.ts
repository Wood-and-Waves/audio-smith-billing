// Pins categoryOwnedByCaller's (app/money/budget/actions.ts) decision
// matrix: the first write path onto Dan's live books, and the same bug
// class already regressed once inside this budget wave. Exactly the three
// cases the review asked for — a matching owner, someone else's category,
// and a read that errors outright.

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
