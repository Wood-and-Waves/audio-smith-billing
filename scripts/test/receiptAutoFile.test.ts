// Deciding whether a receipt files itself or waits for Dan.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideReceiptFiling } from '../../lib/receiptAutoFile.ts'
import { type ReceiptMatch } from '../../lib/receiptMatch.ts'

const match = (o: Partial<ReceiptMatch> & { txnId: string }): ReceiptMatch => ({
  date: '2026-05-18', payee: 'The Well', amountCents: 1998,
  daysApart: 0, alreadyHasReceipt: false, ...o,
})

test('one clean candidate files itself', () => {
  assert.deepEqual(decideReceiptFiling([match({ txnId: 't1' })]),
    { action: 'file', txnId: 't1' })
})

test('no candidate waits — a prepaid Starbucks receipt has no bank row at all', () => {
  assert.deepEqual(decideReceiptFiling([]), { action: 'queue', reason: 'no-charge' })
})

test('two candidates is a genuine tie and waits', () => {
  // Two Auntie Anne's charges four days apart, both $11.16. Real case.
  const d = decideReceiptFiling([match({ txnId: 'a' }), match({ txnId: 'b', daysApart: 4 })])
  assert.deepEqual(d, { action: 'queue', reason: 'ambiguous' })
})

test('a row that already carries a receipt is never overwritten', () => {
  const d = decideReceiptFiling([match({ txnId: 't1', alreadyHasReceipt: true })])
  assert.deepEqual(d, { action: 'queue', reason: 'taken' })
})

test('an exact-day match is not privileged over a tie — two candidates still wait', () => {
  // proposeReceiptMatches sorts nearest-first, so a 0-day candidate leads. That
  // must not be read as "the obvious one": both are the same amount, and only
  // Dan knows which meal was which.
  const d = decideReceiptFiling([
    match({ txnId: 'near', daysApart: 0 }),
    match({ txnId: 'far', daysApart: 6 }),
  ])
  assert.deepEqual(d, { action: 'queue', reason: 'ambiguous' })
})
