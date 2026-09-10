// Pairing identical receipts to identical charges.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pairExactSets, type PairableCharge } from '../../lib/receiptPairing.ts'

const charge = (id: string, date: string, amountCents: number, hasReceipt = false): PairableCharge =>
  ({ id, date, amountCents, hasReceipt })

test('two identical receipts and two identical charges pair off, oldest first', () => {
  // Two Meritage Resort charges at $24.38 and two receipts for them. Real case.
  const pairs = pairExactSets(
    [{ amountCents: 2438 }, { amountCents: 2438 }],
    [charge('b', '2026-05-21', 2438), charge('a', '2026-05-20', 2438)],
  )
  assert.equal(pairs.get(0), 'a')
  assert.equal(pairs.get(1), 'b')
})

test('one receipt and one charge pair', () => {
  const pairs = pairExactSets([{ amountCents: 1998 }], [charge('a', '2026-05-18', 1998)])
  assert.equal(pairs.get(0), 'a')
})

test('two receipts against three charges pair nothing — that is a real tie', () => {
  const pairs = pairExactSets(
    [{ amountCents: 476 }, { amountCents: 476 }],
    [charge('a', '2026-05-01', 476), charge('b', '2026-05-02', 476), charge('c', '2026-05-03', 476)],
  )
  assert.equal(pairs.size, 0)
})

test('three receipts against two charges pair nothing either', () => {
  const pairs = pairExactSets(
    [{ amountCents: 476 }, { amountCents: 476 }, { amountCents: 476 }],
    [charge('a', '2026-05-01', 476), charge('b', '2026-05-02', 476)],
  )
  assert.equal(pairs.size, 0)
})

test('a charge that already carries a receipt is not in the set', () => {
  // One free charge for two receipts: not a matched set.
  const pairs = pairExactSets(
    [{ amountCents: 6000 }, { amountCents: 6000 }],
    [charge('a', '2026-05-18', 6000), charge('b', '2026-05-21', 6000, true)],
  )
  assert.equal(pairs.size, 0)
})

test('amounts do not interfere with each other', () => {
  const pairs = pairExactSets(
    [{ amountCents: 6000 }, { amountCents: 898 }, { amountCents: 6000 }],
    [charge('x', '2026-05-19', 898), charge('a', '2026-05-18', 6000), charge('b', '2026-05-21', 6000)],
  )
  assert.deepEqual([...pairs.entries()].sort(), [[0, 'a'], [1, 'x'], [2, 'b']].sort())
})

test('a receipt with no charge at all pairs nothing', () => {
  // The prepaid Starbucks case: five receipts, zero charges.
  const pairs = pairExactSets([{ amountCents: 476 }], [])
  assert.equal(pairs.size, 0)
})

test('no charge is ever handed to two receipts', () => {
  const pairs = pairExactSets(
    [{ amountCents: 6000 }, { amountCents: 6000 }],
    [charge('a', '2026-05-18', 6000), charge('b', '2026-05-21', 6000)],
  )
  assert.equal(new Set(pairs.values()).size, 2)
})
