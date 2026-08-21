// The link matcher's income half. Like receiptDuplicates.ts, a guess here
// is only ever a PROPOSAL — this file pins exactly which deposits get
// proposed against which invoices, at what confidence, and which cases stay
// silent because guessing wrong is worse than not guessing.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { proposeMatches } from '../../lib/ledgerMatch.ts'
import type { BankRow, CandidateInvoice, Dismissal } from '../../lib/ledgerMatch.ts'

const row = (over: Partial<BankRow> = {}): BankRow => ({
  id: 't1', date: '2026-08-10', amount_cents: 240000, payee: 'CLINIQUE ACH', kind: 'income', linked: false, ...over,
})

const invoice = (over: Partial<CandidateInvoice> = {}): CandidateInvoice => ({
  id: 'i1', number: 1001, client_id: 'c1', client_name: 'Clinique', total_cents: 240000,
  sent_at: '2026-08-01T00:00:00Z', status: 'sent', linked: false, ...over,
})

const dismissal = (over: Partial<Dismissal> = {}): Dismissal => ({
  transaction_id: 't1', invoice_id: 'i1', expense_id: null, ...over,
})

test('an exact-amount deposit on or after the send date proposes the invoice', () => {
  const result = proposeMatches({ rows: [row()], invoices: [invoice()], expenses: [], dismissed: [] })
  assert.deepEqual(result.income, [{ transactionId: 't1', invoiceIds: ['i1'], confidence: 'high' }])
  assert.deepEqual(result.expense, [])
})

test('a deposit dated before sent_at proposes nothing — money cannot land before the ask', () => {
  const result = proposeMatches({
    rows: [row({ date: '2026-07-25' })],
    invoices: [invoice({ sent_at: '2026-08-01T00:00:00Z' })],
    expenses: [], dismissed: [],
  })
  assert.deepEqual(result.income, [])
})

test('an invoice already marked paid by hand is still proposed — the deposit still needs its date', () => {
  const result = proposeMatches({
    rows: [row()],
    invoices: [invoice({ status: 'paid' })],
    expenses: [], dismissed: [],
  })
  assert.deepEqual(result.income, [{ transactionId: 't1', invoiceIds: ['i1'], confidence: 'high' }])
})

test('a linked invoice is never proposed again', () => {
  const result = proposeMatches({
    rows: [row()], invoices: [invoice({ linked: true })], expenses: [], dismissed: [],
  })
  assert.deepEqual(result.income, [])
})

test('a linked bank row is never proposed again', () => {
  const result = proposeMatches({
    rows: [row({ linked: true })], invoices: [invoice()], expenses: [], dismissed: [],
  })
  assert.deepEqual(result.income, [])
})

test('two same-client invoices summing to one deposit propose together — the Streamline case', () => {
  const result = proposeMatches({
    rows: [row({ amount_cents: 240000 })],
    invoices: [
      invoice({ id: 'i1', client_id: 'c1', total_cents: 100000, sent_at: '2026-08-01T00:00:00Z' }),
      invoice({ id: 'i2', client_id: 'c1', total_cents: 140000, sent_at: '2026-08-02T00:00:00Z' }),
    ],
    expenses: [], dismissed: [],
  })
  assert.deepEqual(result.income, [{ transactionId: 't1', invoiceIds: ['i1', 'i2'], confidence: 'low' }])
})

test('sum proposals never mix clients', () => {
  const result = proposeMatches({
    rows: [row({ amount_cents: 240000 })],
    invoices: [
      invoice({ id: 'i1', client_id: 'c1', total_cents: 100000, sent_at: '2026-08-01T00:00:00Z' }),
      invoice({ id: 'i2', client_id: 'c2', total_cents: 140000, sent_at: '2026-08-02T00:00:00Z' }),
    ],
    expenses: [], dismissed: [],
  })
  assert.deepEqual(result.income, [])
})

test('a sum is not proposed when an exact single exists for the row', () => {
  const result = proposeMatches({
    rows: [row({ amount_cents: 240000 })],
    invoices: [
      invoice({ id: 'iA', client_id: 'cA', total_cents: 240000, sent_at: '2026-08-01T00:00:00Z' }),
      invoice({ id: 'iB', client_id: 'cB', total_cents: 100000, sent_at: '2026-08-01T00:00:00Z' }),
      invoice({ id: 'iC', client_id: 'cB', total_cents: 140000, sent_at: '2026-08-02T00:00:00Z' }),
    ],
    expenses: [], dismissed: [],
  })
  assert.equal(result.income.length, 1)
  assert.deepEqual(result.income[0].invoiceIds, ['iA'])
})

test('two identical-value invoices both propose at low confidence — the matcher never guesses between equals', () => {
  const result = proposeMatches({
    rows: [row({ amount_cents: 240000 })],
    invoices: [
      invoice({ id: 'i1', client_id: 'c1', total_cents: 240000, sent_at: '2026-08-01T00:00:00Z' }),
      invoice({ id: 'i2', client_id: 'c2', total_cents: 240000, sent_at: '2026-08-01T00:00:00Z' }),
    ],
    expenses: [], dismissed: [],
  })
  assert.deepEqual(result.income, [
    { transactionId: 't1', invoiceIds: ['i1'], confidence: 'low' },
    { transactionId: 't1', invoiceIds: ['i2'], confidence: 'low' },
  ])
})

test('payee similarity raises confidence but never creates a match', () => {
  // similar payee + wrong amount -> nothing
  const wrongAmount = proposeMatches({
    rows: [row({ id: 't1', payee: 'CLINIQUE ACH', amount_cents: 999999 })],
    invoices: [invoice({ id: 'i1', client_name: 'Clinique', total_cents: 240000 })],
    expenses: [], dismissed: [],
  })
  assert.deepEqual(wrongAmount.income, [])

  // similar payee + right amount -> high
  const similarRight = proposeMatches({
    rows: [row({ id: 't2', payee: 'CLINIQUE ACH', amount_cents: 240000 })],
    invoices: [invoice({ id: 'i2', client_name: 'Clinique', total_cents: 240000 })],
    expenses: [], dismissed: [],
  })
  assert.deepEqual(similarRight.income, [{ transactionId: 't2', invoiceIds: ['i2'], confidence: 'high' }])

  // dissimilar payee + right amount -> low
  const dissimilarRight = proposeMatches({
    rows: [row({ id: 't3', payee: 'RANDOM XYZ CORP', amount_cents: 240000 })],
    invoices: [invoice({ id: 'i3', client_name: 'Clinique', total_cents: 240000 })],
    expenses: [], dismissed: [],
  })
  assert.deepEqual(dissimilarRight.income, [{ transactionId: 't3', invoiceIds: ['i3'], confidence: 'low' }])
})

test('a dismissed pair suppresses its proposal', () => {
  const result = proposeMatches({
    rows: [row()], invoices: [invoice()], expenses: [],
    dismissed: [dismissal({ transaction_id: 't1', invoice_id: 'i1' })],
  })
  assert.deepEqual(result.income, [])
})

test('transfers and owner-pay-shaped rows never match', () => {
  const result = proposeMatches({
    rows: [row({ id: 't1', kind: 'transfer' }), row({ id: 't2', kind: 'owner_pay' })],
    invoices: [invoice()],
    expenses: [], dismissed: [],
  })
  assert.deepEqual(result.income, [])
})

test('an invoice with no sent_at is never a candidate', () => {
  const result = proposeMatches({
    rows: [row()], invoices: [invoice({ sent_at: null })], expenses: [], dismissed: [],
  })
  assert.deepEqual(result.income, [])
})

test('more than three sum combinations proposes none — too illegible to guess', () => {
  const result = proposeMatches({
    rows: [row({ amount_cents: 200000 })],
    invoices: [
      invoice({ id: 'i1', client_id: 'c1', total_cents: 100000, sent_at: '2026-08-01T00:00:00Z' }),
      invoice({ id: 'i2', client_id: 'c1', total_cents: 100000, sent_at: '2026-08-01T00:00:00Z' }),
      invoice({ id: 'i3', client_id: 'c1', total_cents: 100000, sent_at: '2026-08-01T00:00:00Z' }),
      invoice({ id: 'i4', client_id: 'c1', total_cents: 100000, sent_at: '2026-08-01T00:00:00Z' }),
    ],
    expenses: [], dismissed: [],
  })
  assert.deepEqual(result.income, [])
})

test('an invoice claimed by two different deposits keeps both proposals low', () => {
  const result = proposeMatches({
    rows: [
      row({ id: 't1', date: '2026-08-05', amount_cents: 240000 }),
      row({ id: 't2', date: '2026-08-06', amount_cents: 240000 }),
    ],
    invoices: [invoice({ id: 'i1', total_cents: 240000, sent_at: '2026-08-01T00:00:00Z' })],
    expenses: [], dismissed: [],
  })
  assert.deepEqual(result.income, [
    { transactionId: 't1', invoiceIds: ['i1'], confidence: 'low' },
    { transactionId: 't2', invoiceIds: ['i1'], confidence: 'low' },
  ])
})

test('sum invoiceIds order ascending by sent_at then id when dates tie', () => {
  const result = proposeMatches({
    rows: [row({ amount_cents: 240000 })],
    invoices: [
      // Listed i2-then-i1 on purpose, same sent_at date: proves the tie-break
      // is by id, not by input order.
      invoice({ id: 'i2', client_id: 'c1', total_cents: 100000, sent_at: '2026-08-01T00:00:00Z' }),
      invoice({ id: 'i1', client_id: 'c1', total_cents: 140000, sent_at: '2026-08-01T00:00:00Z' }),
    ],
    expenses: [], dismissed: [],
  })
  assert.deepEqual(result.income, [{ transactionId: 't1', invoiceIds: ['i1', 'i2'], confidence: 'low' }])
})

test('a two-letter shared token does not count toward payee similarity', () => {
  const result = proposeMatches({
    rows: [row({ payee: 'AB CORP' })],
    invoices: [invoice({ client_name: 'AB Widgets' })],
    expenses: [], dismissed: [],
  })
  assert.deepEqual(result.income, [{ transactionId: 't1', invoiceIds: ['i1'], confidence: 'low' }])
})

test('proposals are sorted by transaction date ascending then transaction id', () => {
  const result = proposeMatches({
    rows: [
      row({ id: 'tX', date: '2026-08-10', amount_cents: 100000 }),
      row({ id: 'tM', date: '2026-08-05', amount_cents: 200000 }),
      row({ id: 'tW', date: '2026-08-10', amount_cents: 140000 }),
    ],
    invoices: [
      invoice({ id: 'iX', client_id: 'cX', total_cents: 100000, sent_at: '2026-08-01T00:00:00Z' }),
      invoice({ id: 'iM', client_id: 'cM', total_cents: 200000, sent_at: '2026-08-01T00:00:00Z' }),
      invoice({ id: 'iW', client_id: 'cW', total_cents: 140000, sent_at: '2026-08-01T00:00:00Z' }),
    ],
    expenses: [], dismissed: [],
  })
  assert.deepEqual(result.income.map((p) => p.transactionId), ['tM', 'tW', 'tX'])
})
