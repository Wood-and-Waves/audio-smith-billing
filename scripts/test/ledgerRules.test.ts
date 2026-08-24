// Pins the whole shape/date matrix so it's checked by node --test instead of
// only ever exercised by hand through a live Server Action. Error strings are
// asserted verbatim — app/money/actions.ts used to own this exact wording
// before the move, and drift here is drift a user would actually read.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateTxnShape, isSaneLedgerDate, VALID_KINDS } from '../../lib/ledgerRules.ts'

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
