// What may be archived, and what may be deleted.
//
// The deletion rules are the dangerous half: getting one wrong destroys the
// only untouched copy of a financial record. Every rule gets a test that fails
// in the destructive direction if the rule is dropped.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  needsArchiving, mayDelete, deletable, GRACE_DAYS, type RetentionRow,
} from '../../lib/receiptRetention.ts'

const TODAY = '2026-08-15'

const row = (over: Partial<RetentionRow> = {}): RetentionRow => ({
  expenseId: 'e1',
  receiptOriginal: 'user/show/1-original.jpg',
  receiptArchivedAt: '2026-06-01T00:00:00Z',
  invoiceStatus: 'paid',
  paidOn: '2026-07-01',          // 45 days before TODAY
  invoiceUpdatedAt: '2026-07-01T00:00:00Z',
  ...over,
})

test('the grace period is 30 days', () => {
  assert.equal(GRACE_DAYS, 30)
})

test('paid, aged and archived may be deleted', () => {
  assert.equal(mayDelete(row(), TODAY), true)
})

test('an unarchived original is NEVER deletable, whatever else is true', () => {
  // The rule the whole design rests on. If this one goes, a failed upload
  // destroys the only untouched copy.
  assert.equal(mayDelete(row({ receiptArchivedAt: null }), TODAY), false)
})

test('a payment inside the grace period is not deletable', () => {
  assert.equal(mayDelete(row({ paidOn: '2026-08-01' }), TODAY), false)   // 14 days
  assert.equal(mayDelete(row({ paidOn: '2026-07-16' }), TODAY), true)    // exactly 30
  assert.equal(mayDelete(row({ paidOn: '2026-07-17' }), TODAY), false)   // 29
})

test('draft, sent and void invoices are never deletable', () => {
  // void especially: voiding frees the show to be rebilled, so those expenses
  // are live again.
  for (const status of ['draft', 'sent', 'void'] as const) {
    assert.equal(mayDelete(row({ invoiceStatus: status }), TODAY), false, status)
  }
})

test('an expense on a show that was never billed is not deletable', () => {
  assert.equal(mayDelete(row({ invoiceStatus: null, paidOn: null }), TODAY), false)
})

test('an invoice marked paid with no payment row falls back to when it changed', () => {
  // Dan can flip the status without recording a payment. Without the fallback
  // those originals would be archived forever and never reclaimed.
  assert.equal(
    mayDelete(row({ paidOn: null, invoiceUpdatedAt: '2026-07-01T12:00:00Z' }), TODAY),
    true,
  )
  assert.equal(
    mayDelete(row({ paidOn: null, invoiceUpdatedAt: '2026-08-10T12:00:00Z' }), TODAY),
    false,
  )
})

test('a row with no original left has nothing to delete', () => {
  assert.equal(mayDelete(row({ receiptOriginal: null }), TODAY), false)
})

test('deletable filters a mixed list and keeps order', () => {
  const rows = [
    row({ expenseId: 'yes-1' }),
    row({ expenseId: 'no-unarchived', receiptArchivedAt: null }),
    row({ expenseId: 'no-recent', paidOn: '2026-08-14' }),
    row({ expenseId: 'yes-2' }),
  ]
  assert.deepEqual(deletable(rows, TODAY).map((r) => r.expenseId), ['yes-1', 'yes-2'])
})

test('archiving wants every unarchived original, regardless of payment', () => {
  // Deliberately not gated on payment: archiving early spreads the work, so by
  // the time an invoice is 30 days paid its originals went across weeks ago.
  const rows = [
    row({ expenseId: 'unbilled', invoiceStatus: null, paidOn: null, receiptArchivedAt: null }),
    row({ expenseId: 'already', receiptArchivedAt: '2026-06-01T00:00:00Z' }),
    row({ expenseId: 'gone', receiptOriginal: null, receiptArchivedAt: null }),
    row({ expenseId: 'draft', invoiceStatus: 'draft', receiptArchivedAt: null }),
  ]
  assert.deepEqual(needsArchiving(rows).map((r) => r.expenseId), ['unbilled', 'draft'])
})
