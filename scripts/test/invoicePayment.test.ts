// Run: npm test -- scripts/test/invoicePayment.test.ts
//
// Dan's invoice #385 was paid $10 short because the client keyed the wrong
// amount. He is not chasing it. On cash basis the $10 was never income, so
// the BOOKS need no correction — what was missing was a way to record that
// the invoice is settled anyway, and why it does not tie out. These tests
// pin that arithmetic, including the one case that could invent money out
// of nothing: a single deposit covering several invoices.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { settlementFor } from '../../lib/invoicePayment.ts'

test('no link at all reads as unpaid, with the whole total outstanding', () => {
  assert.deepEqual(settlementFor(60000, null), {
    paidCents: 0, deltaCents: -60000, state: 'unpaid',
  })
})

test('a deposit matching to the penny is exact', () => {
  assert.deepEqual(settlementFor(60000, { amountCents: 60000, invoiceCount: 1 }), {
    paidCents: 60000, deltaCents: 0, state: 'exact',
  })
})

test("Dan's own case: a $10 short check settles as short, and reports what actually arrived", () => {
  assert.deepEqual(settlementFor(60000, { amountCents: 59000, invoiceCount: 1 }), {
    paidCents: 59000, deltaCents: -1000, state: 'short',
  })
})

test('an overpayment is the same mechanism with the opposite sign', () => {
  assert.deepEqual(settlementFor(60000, { amountCents: 61000, invoiceCount: 1 }), {
    paidCents: 61000, deltaCents: 1000, state: 'over',
  })
})

test('a COMBO link reads exact — attributing the whole deposit would invent a phantom overpayment', () => {
  // The matcher only ever proposes a 2-or-3-invoice combo when the totals
  // sum to the deposit exactly, so this invoice's share is its own total.
  // Reading amountCents here would report a $1,200 overpayment on a $600
  // invoice that was in fact paid precisely.
  assert.deepEqual(settlementFor(60000, { amountCents: 180000, invoiceCount: 3 }), {
    paidCents: 60000, deltaCents: 0, state: 'exact',
  })
  assert.deepEqual(settlementFor(60000, { amountCents: 120000, invoiceCount: 2 }), {
    paidCents: 60000, deltaCents: 0, state: 'exact',
  })
})

test('the sign of deltaCents is the ONLY thing separating short from over', () => {
  const short = settlementFor(50000, { amountCents: 49999, invoiceCount: 1 })
  const over = settlementFor(50000, { amountCents: 50001, invoiceCount: 1 })
  assert.equal(short.state, 'short')
  assert.equal(over.state, 'over')
  assert.equal(short.deltaCents, -1)
  assert.equal(over.deltaCents, 1)
})

test('a zero total needs no special case and gets none', () => {
  assert.deepEqual(settlementFor(0, null), { paidCents: 0, deltaCents: 0, state: 'unpaid' })
  assert.deepEqual(settlementFor(0, { amountCents: 0, invoiceCount: 1 }), {
    paidCents: 0, deltaCents: 0, state: 'exact',
  })
})
