// Pins lib/ledgerSplits.ts's two decisions — split-leg validation and the
// single category-explosion helper every budget/P&L/parity reader calls.
// Same doctrine as budgetMoves.test.ts and incomeRoleGuard.test.ts: these
// are the pure brains behind writes and reads that would otherwise only be
// exercised by hand through a live Server Action or page.
//
// There was a third decision here until 2026-08-25 — a pending row yielded
// no category line, and reconcile refused while any pending row sat at or
// before the statement date. Dan reversed both: an imported row counts in
// the budget the moment it lands, and entered_at only marks "I have looked
// at this". The tests below that name an "unreviewed" row are the inverted
// survivors of that reversal, kept rather than deleted so the decision
// stays pinned from both sides.
//
// validateLegs's own tests mirror migration 0042's deferred trigger
// (scripts/sql/migrations/0042_splits_and_pending.sql,
// ledger_transaction_splits_check()) state for state — see lib/ledgerSplits.ts's
// header comment for why the two must never drift apart.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  validateLegs, explodeForCategories, explodeForReports,
} from '../../lib/ledgerSplits.ts'
import type { TxnForExplode, ReportTxnForExplode } from '../../lib/ledgerSplits.ts'

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
// calls. Contract: a parent with legs yields one line per leg and
// suppresses its own line; every other row passes through byte-identical,
// whether or not it has been reviewed.

test('an unsplit row passes through byte-identical', () => {
  const txns: TxnForExplode[] = [
    { month: '2026-03', categoryId: 'cat-1', amountCents: -5_000 },
  ]
  assert.deepEqual(explodeForCategories(txns), [
    { month: '2026-03', categoryId: 'cat-1', amountCents: -5_000 },
  ])
})

test('a row with an empty legs array passes through — not suppressed', () => {
  const txns: TxnForExplode[] = [
    {
      month: '2026-03', categoryId: 'cat-1', amountCents: -5_000, legs: [],
    },
  ]
  assert.deepEqual(explodeForCategories(txns), [
    { month: '2026-03', categoryId: 'cat-1', amountCents: -5_000 },
  ])
})

test('a null-category row (an income/RTA line) passes through untouched', () => {
  const txns: TxnForExplode[] = [
    { month: '2026-03', categoryId: null, amountCents: 200_000 },
  ]
  assert.deepEqual(explodeForCategories(txns), [
    { month: '2026-03', categoryId: null, amountCents: 200_000 },
  ])
})

test('a freshly imported, unreviewed charge yields its activity line', () => {
  // Was: "a pending row is dropped entirely — not activity", inverted on
  // 2026-08-25. Note there is no longer any field here to say "unreviewed"
  // with: entered_at left TxnForExplode entirely, so this function CANNOT
  // gate on it even by accident. That absence is the fix. The amount is the
  // real $592 charge that went missing from Dan's budget under the old rule.
  const txns: TxnForExplode[] = [
    { month: '2026-08', categoryId: 'cat-1', amountCents: -59_200 },
  ]
  assert.deepEqual(explodeForCategories(txns), [
    { month: '2026-08', categoryId: 'cat-1', amountCents: -59_200 },
  ])
})

test('an unreviewed null-category deposit still yields its income/RTA line', () => {
  // Was: "a pending row is dropped entirely — not an income/RTA line
  // either". The other half of the old exclusion, and the costlier half:
  // money that lands unreviewed is still money to assign, so withholding it
  // understated Ready to Assign as well as activity.
  const txns: TxnForExplode[] = [
    { month: '2026-08', categoryId: null, amountCents: 200_000 },
  ]
  assert.deepEqual(explodeForCategories(txns), [
    { month: '2026-08', categoryId: null, amountCents: 200_000 },
  ])
})

test('an unreviewed row now counts like any other — entered_at is a review marker, not an accounting gate', () => {
  // Dan, 2026-08-25: imported rows must hit the budget immediately. Before
  // this they yielded nothing, which is what kept a real $592 charge out of
  // his budget until he clicked Enter.
  const lines = explodeForCategories([
    { month: '2026-08', categoryId: 'cat-a', amountCents: -1788 },
    { month: '2026-08', categoryId: null, amountCents: -2263 },
  ])
  assert.deepEqual(lines, [
    { month: '2026-08', categoryId: 'cat-a', amountCents: -1788 },
    { month: '2026-08', categoryId: null, amountCents: -2263 },
  ])
})

test('a split parent yields one line per leg, own line suppressed', () => {
  const txns: TxnForExplode[] = [
    {
      month: '2026-03', categoryId: null, amountCents: -10_000,
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

test('an unreviewed split parent yields its legs — being unreviewed suppresses nothing', () => {
  // Was: "a split parent that is ALSO pending: legs suppressed too —
  // pending wins". There is no longer anything for pending to win over; a
  // split parent explodes the same whether or not Dan has looked at it.
  const txns: TxnForExplode[] = [
    {
      month: '2026-08', categoryId: null, amountCents: -3_000,
      legs: [
        { categoryId: 'gear', amountCents: -1_800 },
        { categoryId: 'travel', amountCents: -1_200 },
      ],
    },
  ]
  assert.deepEqual(explodeForCategories(txns), [
    { month: '2026-08', categoryId: 'gear', amountCents: -1_800 },
    { month: '2026-08', categoryId: 'travel', amountCents: -1_200 },
  ])
})

test('a mixed batch: unreviewed, unsplit, and split rows all yield their lines', () => {
  // Was: "a mixed batch: pending, unsplit, and split rows resolve
  // independently" — the unreviewed cat-2 row used to vanish from this
  // output; now it sits in the middle of it, in input order.
  const txns: TxnForExplode[] = [
    { month: '2026-03', categoryId: 'cat-1', amountCents: -1_000 },
    { month: '2026-03', categoryId: 'cat-2', amountCents: -2_000 },
    {
      month: '2026-03', categoryId: null, amountCents: -3_000,
      legs: [
        { categoryId: 'cat-3', amountCents: -1_500 },
        { categoryId: 'cat-4', amountCents: -1_500 },
      ],
    },
  ]
  assert.deepEqual(explodeForCategories(txns), [
    { month: '2026-03', categoryId: 'cat-1', amountCents: -1_000 },
    { month: '2026-03', categoryId: 'cat-2', amountCents: -2_000 },
    { month: '2026-03', categoryId: 'cat-3', amountCents: -1_500 },
    { month: '2026-03', categoryId: 'cat-4', amountCents: -1_500 },
  ])
})

test('conservation law: output sums to the total of EVERY row, none excluded', () => {
  // The check a reviewer would otherwise have to hand-verify: exploding legs
  // must never create or destroy money. Each txn's own amountCents is the
  // invariant to check against (a split parent's legs sum to that same
  // figure, by the trigger's own invariant — this function trusts that,
  // same as replace_transaction_splits does). Was "ENTERED rows only,
  // pending excluded": conservation is now total, with no exception —
  // that carve-out was the gate this wave removed.
  const txns: TxnForExplode[] = [
    { month: '2026-01', categoryId: 'cat-1', amountCents: -4_321 },
    { month: '2026-01', categoryId: null, amountCents: 150_000 },
    { month: '2026-01', categoryId: 'cat-2', amountCents: -9_999 }, // unreviewed
    {
      month: '2026-01', categoryId: null, amountCents: -10_000,
      legs: [
        { categoryId: 'owner-pay', amountCents: -6_000 },
        { categoryId: 'temp-transfer', amountCents: -4_000 },
      ],
    },
    {
      month: '2026-01', categoryId: null, amountCents: -500,
      legs: [
        { categoryId: 'a', amountCents: -300 },
        { categoryId: 'b', amountCents: -200 },
      ],
    },
    { month: '2026-01', categoryId: 'cat-5', amountCents: 77, legs: [] },
  ]

  const total = txns.reduce((sum, t) => sum + t.amountCents, 0)

  const output = explodeForCategories(txns)
  const outputTotal = output.reduce((sum, line) => sum + line.amountCents, 0)

  assert.equal(outputTotal, total)
  // And every row really did contribute its lines, not merely net to the
  // right sum — a dropped row plus a stray compensating line would pass the
  // sum check above while still being a real (wrong) leak.
  // cat-1, RTA-150000, cat-2, owner-pay, temp-transfer, a, b, cat-5
  assert.equal(output.length, 8)
})

// ---------------------------------------------------------------------------
// explodeForReports — the kind-aware sibling explodeForCategories' own
// CategoryLine can't serve: the reports/P&L reader (lib/ledgerReports.ts's
// plSummary) branches on KIND (income/expense/owner_pay), and a leg's own
// kind can differ from its parent's (the $400 case: an owner_pay parent
// exploding into an owner_pay leg AND an expense leg). Same split contract
// as explodeForCategories — this is the read-shape variant, not a
// different rule.

test('an unsplit row passes through byte-identical, kind included', () => {
  const txns: ReportTxnForExplode[] = [
    { date: '2026-03-05', categoryId: 'cat-1', amountCents: -5_000, kind: 'expense' },
  ]
  assert.deepEqual(explodeForReports(txns), [
    { date: '2026-03-05', categoryId: 'cat-1', amountCents: -5_000, kind: 'expense' },
  ])
})

test('an unreviewed row yields its line, kind included — nothing is dropped', () => {
  // Was: "a pending row is dropped entirely, regardless of kind". The P&L,
  // spend-by-category, the monthly reports, the CPA export and the
  // forecast's overhead average all read through this one function, so this
  // single inversion is what puts unreviewed spending into every report at
  // once. Same $592 charge as the categories-side test above.
  const txns: ReportTxnForExplode[] = [
    { date: '2026-08-09', categoryId: 'cat-1', amountCents: -59_200, kind: 'expense' },
  ]
  assert.deepEqual(explodeForReports(txns), [
    { date: '2026-08-09', categoryId: 'cat-1', amountCents: -59_200, kind: 'expense' },
  ])
})

test('the $400 case: a split parent yields its legs, each with its OWN kind — not the parent\'s', () => {
  // The defining acceptance test (design doc + plan Task 5): the 3/5
  // Online Realtime Transfer, split into a $6,000 owner_pay leg and a
  // $4,000 expense leg (Temporary Transfer). The parent's own kind
  // (whatever it was pre-split) must never leak into either line — P&L
  // has to see the Temporary Transfer leg as an EXPENSE and the rest as
  // owner pay, which is only possible if the explosion reads kind off
  // each leg, not off the parent it suppresses.
  const txns: ReportTxnForExplode[] = [
    {
      date: '2026-03-05', categoryId: null, amountCents: -10_000, kind: 'owner_pay',
      legs: [
        { categoryId: 'owner-pay-cat', amountCents: -6_000, kind: 'owner_pay' },
        { categoryId: 'temp-transfer-cat', amountCents: -4_000, kind: 'expense' },
      ],
    },
  ]
  assert.deepEqual(explodeForReports(txns), [
    { date: '2026-03-05', categoryId: 'owner-pay-cat', amountCents: -6_000, kind: 'owner_pay' },
    { date: '2026-03-05', categoryId: 'temp-transfer-cat', amountCents: -4_000, kind: 'expense' },
  ])
})

test('an unreviewed split parent yields its legs, each with its own kind', () => {
  // Was: "a split parent that is ALSO pending: legs suppressed too —
  // pending wins". Being unreviewed suppresses nothing now, so the $400
  // case reads the same whether or not the parent has been looked at.
  const txns: ReportTxnForExplode[] = [
    {
      date: '2026-08-09', categoryId: null, amountCents: -3_000, kind: 'owner_pay',
      legs: [
        { categoryId: 'owner-pay-cat', amountCents: -1_800, kind: 'owner_pay' },
        { categoryId: 'temp-transfer-cat', amountCents: -1_200, kind: 'expense' },
      ],
    },
  ]
  assert.deepEqual(explodeForReports(txns), [
    { date: '2026-08-09', categoryId: 'owner-pay-cat', amountCents: -1_800, kind: 'owner_pay' },
    { date: '2026-08-09', categoryId: 'temp-transfer-cat', amountCents: -1_200, kind: 'expense' },
  ])
})

test('a row with an empty legs array passes through with the parent\'s own kind', () => {
  const txns: ReportTxnForExplode[] = [
    {
      date: '2026-03-05', categoryId: null, amountCents: 200_000, kind: 'income', legs: [],
    },
  ]
  assert.deepEqual(explodeForReports(txns), [
    { date: '2026-03-05', categoryId: null, amountCents: 200_000, kind: 'income' },
  ])
})

test('conservation law holds for explodeForReports too: every row counted, none vanishes', () => {
  // Was "entered-only total, pending vanishes" — same inversion as
  // explodeForCategories' own conservation test above.
  const txns: ReportTxnForExplode[] = [
    { date: '2026-01-05', categoryId: 'cat-1', amountCents: -4_321, kind: 'expense' },
    { date: '2026-01-09', categoryId: 'cat-2', amountCents: -9_999, kind: 'expense' }, // unreviewed
    {
      date: '2026-01-10', categoryId: null, amountCents: -10_000, kind: 'owner_pay',
      legs: [
        { categoryId: 'owner-pay', amountCents: -6_000, kind: 'owner_pay' },
        { categoryId: 'temp-transfer', amountCents: -4_000, kind: 'expense' },
      ],
    },
  ]
  const total = txns.reduce((sum, t) => sum + t.amountCents, 0)
  const output = explodeForReports(txns)
  const outputTotal = output.reduce((sum, line) => sum + line.amountCents, 0)
  assert.equal(outputTotal, total)
  assert.equal(output.length, 4) // cat-1, cat-2, owner-pay leg, temp-transfer leg
})
