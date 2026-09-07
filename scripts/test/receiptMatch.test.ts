// Proposing the bank row a forwarded receipt belongs to.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  proposeReceiptMatches, RECEIPT_MATCH_DAYS, type ReceiptCandidateTxn,
} from '../../lib/receiptMatch.ts'

const txn = (o: Partial<ReceiptCandidateTxn> & { id: string }): ReceiptCandidateTxn => ({
  date: '2026-09-01', amount_cents: -1399, payee: 'NETLIFY', receipt_path: null, ...o,
})

test("Netlify's $13.99 finds its charge", () => {
  const m = proposeReceiptMatches(
    { amountCents: 1399, spentOn: '2026-06-08' },
    [txn({ id: 'a', date: '2026-06-09', amount_cents: -1399 })],
  )
  assert.equal(m.length, 1)
  assert.equal(m[0].txnId, 'a')
  assert.equal(m[0].daysApart, 1)
})

test('a DEPOSIT is never proposed — a receipt is proof money left', () => {
  const m = proposeReceiptMatches(
    { amountCents: 1399, spentOn: '2026-06-08' },
    [txn({ id: 'in', amount_cents: 1399, date: '2026-06-08' })],
  )
  assert.deepEqual(m, [])
})

test('the amount must match exactly — near misses are not offered', () => {
  const m = proposeReceiptMatches(
    { amountCents: 1399, spentOn: '2026-06-08' },
    [txn({ id: 'close', amount_cents: -1400, date: '2026-06-08' })],
  )
  assert.deepEqual(m, [])
})

test('the nearest date leads when several charges share an amount', () => {
  // Three Netlify months at the same price is exactly his real data.
  const m = proposeReceiptMatches({ amountCents: 1399, spentOn: '2026-06-08' }, [
    txn({ id: 'far', date: '2026-06-15' }),
    txn({ id: 'near', date: '2026-06-07' }),
    txn({ id: 'mid', date: '2026-06-11' }),
  ])
  assert.deepEqual(m.map((x) => x.txnId), ['near', 'mid', 'far'])
})

test('a charge beyond the window is not proposed', () => {
  const inside = proposeReceiptMatches({ amountCents: 1399, spentOn: '2026-06-01' },
    [txn({ id: 'edge', date: '2026-06-11' })])
  const outside = proposeReceiptMatches({ amountCents: 1399, spentOn: '2026-06-01' },
    [txn({ id: 'past', date: '2026-06-12' })])
  assert.equal(inside.length, 1, `${RECEIPT_MATCH_DAYS} days is inside`)
  assert.equal(outside.length, 0, 'one day further is not')
})

test('a row that already has a receipt is offered, but ranked last', () => {
  // Replacing a bad scan with the emailed original is a real thing to want,
  // so it must not be hidden — but it must never outrank an empty row.
  const m = proposeReceiptMatches({ amountCents: 1399, spentOn: '2026-06-08' }, [
    txn({ id: 'has', date: '2026-06-08', receipt_path: 'owner/ledger/x.jpg' }),
    txn({ id: 'empty', date: '2026-06-14' }),
  ])
  assert.deepEqual(m.map((x) => x.txnId), ['empty', 'has'])
  assert.equal(m[1].alreadyHasReceipt, true)
})

test('a blank receipt_path counts as no receipt', () => {
  const m = proposeReceiptMatches({ amountCents: 1399, spentOn: '2026-06-08' },
    [txn({ id: 'blank', receipt_path: '   ', date: '2026-06-08' })])
  assert.equal(m[0].alreadyHasReceipt, false)
})

test('equally close rows come back in a stable order', () => {
  const a = txn({ id: 'aaa', date: '2026-06-06' })
  const b = txn({ id: 'bbb', date: '2026-06-10' })
  const r1 = proposeReceiptMatches({ amountCents: 1399, spentOn: '2026-06-08' }, [a, b])
  const r2 = proposeReceiptMatches({ amountCents: 1399, spentOn: '2026-06-08' }, [b, a])
  assert.deepEqual(r1.map((x) => x.txnId), r2.map((x) => x.txnId))
})
