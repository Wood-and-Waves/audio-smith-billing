// Pins lib/ledgerSplits.ts's three decisions — split-leg validation, the
// single category-explosion helper every budget/P&L/parity reader calls,
// and the reconcile-refusal predicate. Same doctrine as budgetMoves.test.ts
// and incomeRoleGuard.test.ts: these are the pure brains behind writes and
// reads that would otherwise only be exercised by hand through a live
// Server Action or page.
//
// validateLegs's own tests mirror migration 0042's deferred trigger
// (scripts/sql/migrations/0042_splits_and_pending.sql,
// ledger_transaction_splits_check()) state for state — see lib/ledgerSplits.ts's
// header comment for why the two must never drift apart.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateLegs, explodeForCategories, pendingBlocksReconcile } from '../../lib/ledgerSplits.ts'
import type { TxnForExplode } from '../../lib/ledgerSplits.ts'

// ---------------------------------------------------------------------------
// validateLegs — mirrors the trigger: >=2 legs whenever any exist, integer
// non-zero amounts, every leg's sign matching the parent's, sum exact.

test('zero legs is valid — the trigger allows an unsplit transaction', () => {
  assert.equal(validateLegs(-10_000, []), null)
})

test('a single leg is refused — a split needs at least 2', () => {
  assert.equal(
    validateLegs(-10_000, [{ categoryId: 'cat-1', amountCents: -10_000 }]),
    'A split needs at least 2 legs.',
  )
})

test('two legs, correct sum, matching negative signs — valid', () => {
  assert.equal(
    validateLegs(-10_000, [
      { categoryId: 'owner-pay', amountCents: -6_000 },
      { categoryId: 'temp-transfer', amountCents: -4_000 },
    ]),
    null,
  )
})

test('the $400 case: cross-KIND legs, same sign, valid', () => {
  // The defining example from the design doc: an outflow split into an
  // owner_pay leg and an expense leg — different kinds, same sign. Kind
  // itself is not this function's concern (derived later via deriveKind);
  // this only checks category/amount shape.
  assert.equal(
    validateLegs(-10_000, [
      { categoryId: 'owner-pay-cat', amountCents: -6_000 },
      { categoryId: 'temp-transfer-cat', amountCents: -4_000, note: 'YNAB parity' },
    ]),
    null,
  )
})

test('legs on a positive parent (income split) are legal — signs positive', () => {
  assert.equal(
    validateLegs(100_000, [
      { categoryId: 'gig-a', amountCents: 60_000 },
      { categoryId: 'gig-b', amountCents: 40_000 },
    ]),
    null,
  )
})

test('three legs, matching signs, correct sum — valid beyond the minimum two', () => {
  assert.equal(
    validateLegs(-9_000, [
      { categoryId: 'a', amountCents: -3_000 },
      { categoryId: 'b', amountCents: -3_000 },
      { categoryId: 'c', amountCents: -3_000 },
    ]),
    null,
  )
})

test('sum off by one cent is refused', () => {
  const message = validateLegs(-10_000, [
    { categoryId: 'a', amountCents: -6_000 },
    { categoryId: 'b', amountCents: -3_999 },
  ])
  assert.ok(message, 'expected a refusal message')
  assert.match(message as string, /sum|add up|total/i)
})

test('a zero-amount leg is refused', () => {
  const message = validateLegs(-10_000, [
    { categoryId: 'a', amountCents: -10_000 },
    { categoryId: 'b', amountCents: 0 },
  ])
  assert.equal(message, 'Enter a nonzero amount for every split leg.')
})

test('a non-integer amount is refused', () => {
  const message = validateLegs(-10_000, [
    { categoryId: 'a', amountCents: -5_000.5 },
    { categoryId: 'b', amountCents: -4_999.5 },
  ])
  assert.equal(message, 'Enter a nonzero amount for every split leg.')
})

test('mixed signs summing correctly is still refused — sum alone is not enough', () => {
  // Sum is exactly right (-15,000 + 5,000 = -10,000), but the second leg's
  // sign does not match the parent's. The trigger catches this via its own
  // bad_sign check even when leg_sum already passed — this must too.
  const message = validateLegs(-10_000, [
    { categoryId: 'a', amountCents: -15_000 },
    { categoryId: 'b', amountCents: 5_000 },
  ])
  assert.ok(message, 'expected a refusal message')
  assert.match(message as string, /sign|direction/i)
})

test('a null categoryId leg (uncategorized) is fine shape-wise', () => {
  assert.equal(
    validateLegs(-10_000, [
      { categoryId: null, amountCents: -6_000 },
      { categoryId: 'b', amountCents: -4_000 },
    ]),
    null,
  )
})

// ---------------------------------------------------------------------------
// explodeForCategories — the ONE helper every category-reading consumer
// calls. Contract: pending yields nothing; a parent with legs yields one
// line per leg and suppresses its own line; everything else passes through
// byte-identical.

test('an entered, unsplit row passes through byte-identical', () => {
  const txns: TxnForExplode[] = [
    { month: '2026-03', categoryId: 'cat-1', amountCents: -5_000, enteredAt: '2026-03-05T00:00:00Z' },
  ]
  assert.deepEqual(explodeForCategories(txns), [
    { month: '2026-03', categoryId: 'cat-1', amountCents: -5_000 },
  ])
})

test('an entered row with an empty legs array passes through — not suppressed', () => {
  const txns: TxnForExplode[] = [
    {
      month: '2026-03', categoryId: 'cat-1', amountCents: -5_000,
      enteredAt: '2026-03-05T00:00:00Z', legs: [],
    },
  ]
  assert.deepEqual(explodeForCategories(txns), [
    { month: '2026-03', categoryId: 'cat-1', amountCents: -5_000 },
  ])
})

test('a null-category entered row (an income/RTA line) passes through untouched', () => {
  const txns: TxnForExplode[] = [
    { month: '2026-03', categoryId: null, amountCents: 200_000, enteredAt: '2026-03-01T00:00:00Z' },
  ]
  assert.deepEqual(explodeForCategories(txns), [
    { month: '2026-03', categoryId: null, amountCents: 200_000 },
  ])
})

test('a pending row is dropped entirely — not activity', () => {
  const txns: TxnForExplode[] = [
    { month: '2026-03', categoryId: 'cat-1', amountCents: -5_000, enteredAt: null },
  ]
  assert.deepEqual(explodeForCategories(txns), [])
})

test('a pending row is dropped entirely — not an income/RTA line either', () => {
  const txns: TxnForExplode[] = [
    { month: '2026-03', categoryId: null, amountCents: 200_000, enteredAt: null },
  ]
  assert.deepEqual(explodeForCategories(txns), [])
})

test('a split parent (entered) yields one line per leg, own line suppressed', () => {
  const txns: TxnForExplode[] = [
    {
      month: '2026-03', categoryId: null, amountCents: -10_000,
      enteredAt: '2026-03-05T00:00:00Z',
      legs: [
        { categoryId: 'owner-pay', amountCents: -6_000 },
        { categoryId: 'temp-transfer', amountCents: -4_000 },
      ],
    },
  ]
  assert.deepEqual(explodeForCategories(txns), [
    { month: '2026-03', categoryId: 'owner-pay', amountCents: -6_000 },
    { month: '2026-03', categoryId: 'temp-transfer', amountCents: -4_000 },
  ])
})

test('a split parent that is ALSO pending: legs suppressed too — pending wins', () => {
  const txns: TxnForExplode[] = [
    {
      month: '2026-03', categoryId: null, amountCents: -10_000,
      enteredAt: null,
      legs: [
        { categoryId: 'owner-pay', amountCents: -6_000 },
        { categoryId: 'temp-transfer', amountCents: -4_000 },
      ],
    },
  ]
  assert.deepEqual(explodeForCategories(txns), [])
})

test('a mixed batch: pending, unsplit, and split rows resolve independently', () => {
  const txns: TxnForExplode[] = [
    { month: '2026-03', categoryId: 'cat-1', amountCents: -1_000, enteredAt: '2026-03-01T00:00:00Z' },
    { month: '2026-03', categoryId: 'cat-2', amountCents: -2_000, enteredAt: null },
    {
      month: '2026-03', categoryId: null, amountCents: -3_000,
      enteredAt: '2026-03-02T00:00:00Z',
      legs: [
        { categoryId: 'cat-3', amountCents: -1_500 },
        { categoryId: 'cat-4', amountCents: -1_500 },
      ],
    },
  ]
  assert.deepEqual(explodeForCategories(txns), [
    { month: '2026-03', categoryId: 'cat-1', amountCents: -1_000 },
    { month: '2026-03', categoryId: 'cat-3', amountCents: -1_500 },
    { month: '2026-03', categoryId: 'cat-4', amountCents: -1_500 },
  ])
})

test('conservation law: output sums to the total of ENTERED rows only, pending excluded', () => {
  // The check a reviewer would otherwise have to hand-verify: exploding legs
  // must never create or destroy money, and pending must vanish completely
  // rather than partially. Each entered txn's own amountCents is the
  // invariant to check against (a split parent's legs sum to that same
  // figure, by the trigger's own invariant — this function trusts that,
  // same as replace_transaction_splits does).
  const txns: TxnForExplode[] = [
    { month: '2026-01', categoryId: 'cat-1', amountCents: -4_321, enteredAt: '2026-01-05T00:00:00Z' },
    { month: '2026-01', categoryId: null, amountCents: 150_000, enteredAt: '2026-01-01T00:00:00Z' },
    { month: '2026-01', categoryId: 'cat-2', amountCents: -9_999, enteredAt: null }, // pending
    {
      month: '2026-01', categoryId: null, amountCents: -10_000,
      enteredAt: '2026-01-10T00:00:00Z',
      legs: [
        { categoryId: 'owner-pay', amountCents: -6_000 },
        { categoryId: 'temp-transfer', amountCents: -4_000 },
      ],
    },
    {
      month: '2026-01', categoryId: null, amountCents: -500,
      enteredAt: null, // pending split parent — legs suppressed too
      legs: [
        { categoryId: 'a', amountCents: -300 },
        { categoryId: 'b', amountCents: -200 },
      ],
    },
    { month: '2026-01', categoryId: 'cat-5', amountCents: 77, enteredAt: '2026-01-15T00:00:00Z', legs: [] },
  ]

  const enteredTotal = txns
    .filter((t) => t.enteredAt !== null)
    .reduce((sum, t) => sum + t.amountCents, 0)

  const output = explodeForCategories(txns)
  const outputTotal = output.reduce((sum, line) => sum + line.amountCents, 0)

  assert.equal(outputTotal, enteredTotal)
  // And the pending rows really did contribute zero lines, not merely net
  // zero amounts — a stray null-amount line would pass the sum check above
  // while still being a real (wrong) leak.
  assert.equal(output.length, 5) // cat-1, RTA-150000, owner-pay, temp-transfer, cat-5
})

// ---------------------------------------------------------------------------
// pendingBlocksReconcile — true when any pending row's date is <= the
// statement date. Lexical compare on plain YYYY-MM-DD dates, house doctrine
// (see lib/showOrder.ts, lib/ledgerBalance.ts's compareLedgerOrder).

test('no pending rows never blocks', () => {
  assert.equal(pendingBlocksReconcile([], '2026-03-31'), false)
})

test('a pending row dated before the statement date blocks', () => {
  assert.equal(pendingBlocksReconcile([{ date: '2026-03-15' }], '2026-03-31'), true)
})

test('a pending row dated exactly the statement date blocks — the boundary', () => {
  assert.equal(pendingBlocksReconcile([{ date: '2026-03-31' }], '2026-03-31'), true)
})

test('a pending row dated after the statement date does not block', () => {
  assert.equal(pendingBlocksReconcile([{ date: '2026-04-01' }], '2026-03-31'), false)
})

test('one blocking row among several non-blocking ones still blocks', () => {
  assert.equal(
    pendingBlocksReconcile(
      [{ date: '2026-04-05' }, { date: '2026-03-31' }, { date: '2026-04-10' }],
      '2026-03-31',
    ),
    true,
  )
})
