// What may be archived, and what may be deleted.
//
// The deletion rules are the dangerous half: getting one wrong destroys the
// only untouched copy of a financial record. Every rule gets a test that fails
// in the destructive direction if the rule is dropped.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  needsArchiving, mayDelete, deletable, deletionBlocker, settlementDate,
  toReclaimCandidates, GRACE_DAYS,
  type RetentionRow, type ReclaimQueryRow,
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

// --------------------------------------------------------------------------
// The refusal reasons, which the dry run prints
// --------------------------------------------------------------------------

test('a deletable row has no blocker', () => {
  assert.equal(deletionBlocker(row(), TODAY), null)
})

test('every refusal says which rule refused it', () => {
  // The dry run is how a human confirms the guard before it is trusted, and a
  // list of refusals with no reasons confirms nothing.
  const cases: [Partial<RetentionRow>, RegExp][] = [
    [{ receiptOriginal: null }, /no original/],
    [{ receiptArchivedAt: null }, /not archived/],
    [{ invoiceStatus: 'void' }, /void, not paid/],
    [{ invoiceStatus: null }, /absent, not paid/],
    [{ paidOn: null, invoiceUpdatedAt: null }, /no payment date/],
    [{ paidOn: '2026-08-01' }, /settled 14 of 30 days ago/],
  ]
  for (const [over, expected] of cases) {
    assert.match(deletionBlocker(row(over), TODAY) ?? '', expected)
  }
})

test('mayDelete and deletionBlocker cannot disagree', () => {
  // mayDelete is a reading of deletionBlocker, so the dry run's explanation and
  // the guard that deletes are one piece of logic rather than two.
  const rows = [
    row(), row({ receiptArchivedAt: null }), row({ invoiceStatus: 'sent' }),
    row({ paidOn: '2026-08-14' }), row({ receiptOriginal: null }),
    row({ paidOn: null, invoiceUpdatedAt: null }),
  ]
  for (const r of rows) {
    assert.equal(mayDelete(r, TODAY), deletionBlocker(r, TODAY) === null, r.expenseId)
  }
})

test('the settlement date prefers a real payment, then falls back to updated_at', () => {
  assert.equal(settlementDate(row()), '2026-07-01')
  assert.equal(settlementDate(row({ paidOn: null, invoiceUpdatedAt: '2026-05-04T18:30:00Z' })), '2026-05-04')
  assert.equal(settlementDate(row({ paidOn: null, invoiceUpdatedAt: null })), null)
})

test('deletable hands back the caller own rows, extra fields intact', () => {
  // The deletion stage carries a show name and invoice number alongside each
  // row so it can report what it did. Losing them here would mean re-joining
  // the filtered result to the candidates by id, in the one code path where a
  // wrong lookup means deleting the wrong file.
  const rows = [{ ...row({ expenseId: 'keep' }), showName: 'PwC Tax Start' }]
  assert.equal(deletable(rows, TODAY)[0].showName, 'PwC Tax Start')
})

// --------------------------------------------------------------------------
// Reading the deletion stage's query result
// --------------------------------------------------------------------------

const queryRow = (over: Partial<ReclaimQueryRow> = {}): ReclaimQueryRow => ({
  id: 'e1',
  receipt_original: 'user/show/1-original.jpg',
  receipt_archived_at: '2026-06-01T00:00:00Z',
  shows: {
    name: 'PwC Tax Start',
    invoices: {
      number: 118,
      status: 'paid',
      updated_at: '2026-07-01T00:00:00Z',
      payments: [{ paid_on: '2026-07-01' }],
    },
  },
  ...over,
})

test('a query row becomes a candidate carrying what the report needs', () => {
  assert.deepEqual(toReclaimCandidates([queryRow()]), [{
    expenseId: 'e1',
    receiptOriginal: 'user/show/1-original.jpg',
    receiptArchivedAt: '2026-06-01T00:00:00Z',
    invoiceStatus: 'paid',
    paidOn: '2026-07-01',
    invoiceUpdatedAt: '2026-07-01T00:00:00Z',
    showName: 'PwC Tax Start',
    invoiceNumber: 118,
  }])
})

test('the settlement date is the LAST partial payment, not the first', () => {
  // Partial payments are why payments is a table. An invoice paid in two
  // instalments is not settled until the second lands, and taking the earliest
  // would start the 30-day clock early on an invoice still being paid.
  const rows = toReclaimCandidates([queryRow({
    shows: {
      name: 'Two payments',
      invoices: {
        number: 9, status: 'paid', updated_at: '2026-05-01T00:00:00Z',
        payments: [{ paid_on: '2026-05-02' }, { paid_on: '2026-08-01' }, { paid_on: '2026-06-10' }],
      },
    },
  })])
  assert.equal(rows[0].paidOn, '2026-08-01')
  assert.equal(mayDelete(rows[0], TODAY), false)   // 14 days, not 105
})

test('an unrecognised invoice status reads as null, so it can never be paid', () => {
  const rows = toReclaimCandidates([queryRow({
    shows: { name: 'S', invoices: { number: 1, status: 'PAID', updated_at: null, payments: [] } },
  })])
  assert.equal(rows[0].invoiceStatus, null)
  assert.equal(mayDelete(rows[0], TODAY), false)
})

test('a show with no invoice at all yields nothing deletable', () => {
  // Today this is every show with expenses on it, so it is the case the first
  // real run will actually hit.
  const rows = toReclaimCandidates([queryRow({
    shows: { name: 'Unbilled show', invoices: null },
  })])
  assert.deepEqual(
    [rows[0].invoiceStatus, rows[0].paidOn, rows[0].invoiceUpdatedAt, rows[0].invoiceNumber],
    [null, null, null, null],
  )
  assert.equal(mayDelete(rows[0], TODAY), false)
})

test('an embed arriving as an array reads the same as one arriving as an object', () => {
  // PostgREST returns a to-one embed as an object and a to-many as an array,
  // and nothing type-checks which it decided. Guessing wrong fails safe but
  // fails SILENTLY, and a stage that quietly never deletes anything looks
  // exactly like one that works.
  const asArrays = toReclaimCandidates([queryRow({
    shows: [{
      name: 'PwC Tax Start',
      invoices: [{
        number: 118, status: 'paid', updated_at: '2026-07-01T00:00:00Z',
        payments: [{ paid_on: '2026-07-01' }],
      }],
    }],
  })])
  assert.deepEqual(asArrays, toReclaimCandidates([queryRow()]))
  assert.equal(mayDelete(asArrays[0], TODAY), true)
})

test('a missing show, or a payment with no date, does not throw', () => {
  const rows = toReclaimCandidates([
    queryRow({ id: 'no-show', shows: null }),
    queryRow({
      id: 'blank-payment',
      shows: { name: null, invoices: { number: null, status: 'paid', updated_at: null, payments: [{ paid_on: null }] } },
    }),
  ])
  assert.equal(rows[0].showName, 'Unknown show')
  assert.equal(rows[0].invoiceStatus, null)
  assert.equal(rows[1].paidOn, null)
  assert.equal(rows[1].invoiceNumber, null)
  for (const r of rows) assert.equal(mayDelete(r, TODAY), false)
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
