// Pins the whole shape/date matrix so it's checked by node --test instead of
// only ever exercised by hand through a live Server Action. Error strings are
// asserted verbatim — app/money/actions.ts used to own this exact wording
// before the move, and drift here is drift a user would actually read.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateTxnShape, isSaneLedgerDate, deriveKind, VALID_KINDS } from '../../lib/ledgerRules.ts'

test('VALID_KINDS is the four ledger kinds', () => {
  assert.deepEqual(VALID_KINDS, ['income', 'expense', 'owner_pay', 'transfer'])
})

test('income: a positive amount with any category passes', () => {
  assert.equal(validateTxnShape({ amountCents: 5000, kind: 'income', categoryId: 'cat-1' }), null)
  assert.equal(validateTxnShape({ amountCents: 5000, kind: 'income', categoryId: null }), null)
})

test('expense: a negative amount with any category passes', () => {
  assert.equal(validateTxnShape({ amountCents: -5000, kind: 'expense', categoryId: 'cat-1' }), null)
  assert.equal(validateTxnShape({ amountCents: -5000, kind: 'expense', categoryId: null }), null)
})

test('owner_pay: a negative amount with any category passes — 0038 gave owner pay a real budget category', () => {
  assert.equal(validateTxnShape({ amountCents: -5000, kind: 'owner_pay', categoryId: 'cat-1' }), null)
  assert.equal(validateTxnShape({ amountCents: -5000, kind: 'owner_pay', categoryId: null }), null)
})

test('transfer: a nonzero amount with a null category passes', () => {
  assert.equal(validateTxnShape({ amountCents: -5000, kind: 'transfer', categoryId: null }), null)
  assert.equal(validateTxnShape({ amountCents: 5000, kind: 'transfer', categoryId: null }), null)
})

test('unknown kind is refused, naming the bad value', () => {
  assert.deepEqual(
    validateTxnShape({ amountCents: 5000, kind: 'bogus', categoryId: null }),
    { error: '"bogus" is not a transaction kind.' },
  )
})

test('zero amounts are refused for every kind, before the sign checks', () => {
  for (const kind of VALID_KINDS) {
    assert.deepEqual(
      validateTxnShape({ amountCents: 0, kind, categoryId: null }),
      { error: 'Enter a nonzero amount.' },
    )
  }
})

test('a non-integer amount is refused the same way as zero', () => {
  assert.deepEqual(
    validateTxnShape({ amountCents: 50.5, kind: 'income', categoryId: null }),
    { error: 'Enter a nonzero amount.' },
  )
})

test('income must be positive', () => {
  assert.deepEqual(
    validateTxnShape({ amountCents: -5000, kind: 'income', categoryId: null }),
    { error: 'Income must be a positive amount.' },
  )
})

test('expense must be negative', () => {
  assert.deepEqual(
    validateTxnShape({ amountCents: 5000, kind: 'expense', categoryId: null }),
    { error: 'Expenses must be a negative amount.' },
  )
})

test('owner_pay must be negative', () => {
  assert.deepEqual(
    validateTxnShape({ amountCents: 5000, kind: 'owner_pay', categoryId: null }),
    { error: 'Owner pay must be a negative amount.' },
  )
})

test('transfer with a category is refused — owner_pay no longer is, since 0038', () => {
  assert.deepEqual(
    validateTxnShape({ amountCents: -5000, kind: 'transfer', categoryId: 'cat-1' }),
    { error: 'Transfers do not use a category.' },
  )
})

test('isSaneLedgerDate accepts the full 1990..2100 range, inclusive', () => {
  assert.equal(isSaneLedgerDate('1990-01-01'), true)
  assert.equal(isSaneLedgerDate('2100-12-31'), true)
  assert.equal(isSaneLedgerDate('2026-08-16'), true)
})

test('isSaneLedgerDate rejects a year one outside either bound', () => {
  assert.equal(isSaneLedgerDate('1989-12-31'), false)
  assert.equal(isSaneLedgerDate('2101-01-01'), false)
})

// The bug this exists for: a typo'd year is still a real calendar date, so
// isPlainDate alone waves it through. '0206-05-01' is well-formed YYYY-MM-DD
// and a real day — just two centuries away from what anyone meant to type.
test('isSaneLedgerDate rejects a plausible-looking typo year', () => {
  assert.equal(isSaneLedgerDate('0206-05-01'), false)
})

// deriveKind — the kind dropdown's replacement (Wave B Task 5). Every test
// below is one cell of the task's own derivation table, same row order the
// helper's own doc comment reads top to bottom.

const spending = { budgetRole: 'spending' as const, grp: 'Bills' }
const income = { budgetRole: 'income' as const, grp: 'Income' }
const ownerGroup = { budgetRole: 'spending' as const, grp: 'Owner Transactions' }

test('Payment/Transfer derives transfer regardless of direction', () => {
  assert.deepEqual(deriveKind('payment-transfer', 'inflow'), { kind: 'transfer' })
  assert.deepEqual(deriveKind('payment-transfer', 'outflow'), { kind: 'transfer' })
})

test('an income-role category on an inflow derives income', () => {
  assert.deepEqual(deriveKind(income, 'inflow'), { kind: 'income' })
})

test('an income-role category on an outflow is refused', () => {
  assert.deepEqual(
    deriveKind(income, 'outflow'),
    { error: 'Income categories take inflows.' },
  )
})

test('the Owner Transactions group on an outflow derives owner_pay', () => {
  assert.deepEqual(deriveKind(ownerGroup, 'outflow'), { kind: 'owner_pay' })
})

test('the Owner Transactions group on an inflow is refused', () => {
  assert.deepEqual(
    deriveKind(ownerGroup, 'inflow'),
    { error: 'Money in from you is a transfer — use Payment/Transfer.' },
  )
})

test('any other spending category on an inflow derives income (a refund, category carried)', () => {
  assert.deepEqual(deriveKind(spending, 'inflow'), { kind: 'income' })
})

test('any other spending category on an outflow derives expense', () => {
  assert.deepEqual(deriveKind(spending, 'outflow'), { kind: 'expense' })
})

test('no category (Uncategorized) on an inflow derives income', () => {
  assert.deepEqual(deriveKind(null, 'inflow'), { kind: 'income' })
})

test('no category (Uncategorized) on an outflow derives expense', () => {
  assert.deepEqual(deriveKind(null, 'outflow'), { kind: 'expense' })
})

// The group match is by NAME (a deliberate, documented exception — see the
// helper's own comment) — a spending category that merely happens to share
// the same grp string, regardless of case or surrounding text, is what
// actually trips the owner_pay/refusal branches; this pins that it is an
// exact match, not a substring or case-insensitive one, so a group like
// "owner transactions" or "Owner Transactions HQ" does NOT accidentally
// qualify.
test('the Owner Transactions match is exact, not case-insensitive or a substring', () => {
  assert.deepEqual(
    deriveKind({ budgetRole: 'spending', grp: 'owner transactions' }, 'outflow'),
    { kind: 'expense' },
  )
  assert.deepEqual(
    deriveKind({ budgetRole: 'spending', grp: 'Owner Transactions HQ' }, 'outflow'),
    { kind: 'expense' },
  )
})
