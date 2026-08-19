import { test } from 'node:test'
import assert from 'node:assert/strict'
import { envelopeBalances, netAllocated, availableToAllocate } from '../../lib/envelopes.ts'

const M = (from: string | null, to: string | null, amount_cents: number) =>
  ({ from_envelope_id: from, to_envelope_id: to, amount_cents })

const MOVES = [
  M(null, 'tax', 180000),    // fund Taxes from Available
  M(null, 'gear', 50000),    // fund Gear
  M('gear', 'tax', 10000),   // rob Gear to top up Taxes
  M('tax', null, 40000),     // release back to Available (IRS payment made)
]

test('an envelope balance is the sum of the moves that touched it', () => {
  const b = envelopeBalances(MOVES)
  assert.equal(b.get('tax'), 180000 + 10000 - 40000)
  assert.equal(b.get('gear'), 50000 - 10000)
})

test('envelope-to-envelope moves never change what is allocated', () => {
  assert.equal(netAllocated(MOVES), 180000 + 50000 - 40000)
  assert.equal(netAllocated([M('a', 'b', 99999)]), 0)
})

test('available is the working balance minus the net allocation', () => {
  assert.equal(availableToAllocate(1582033, MOVES), 1582033 - 190000)
})

test('over-allocation goes negative rather than clamping — the red is the point', () => {
  assert.equal(availableToAllocate(100000, [M(null, 'tax', 150000)]), -50000)
})

test('no moves: everything is available and no envelope has a balance', () => {
  assert.equal(availableToAllocate(123456, []), 123456)
  assert.equal(envelopeBalances([]).size, 0)
})
