// The link matcher's income half. Like receiptDuplicates.ts, a guess here
// is only ever a PROPOSAL — this file pins exactly which deposits get
// proposed against which invoices, at what confidence, and which cases stay
// silent because guessing wrong is worse than not guessing.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { proposeMatches } from '../../lib/ledgerMatch.ts'
import type { BankRow, CandidateInvoice, CandidateExpense, Dismissal } from '../../lib/ledgerMatch.ts'

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

// expense-side helpers: a charge row (negative amount, kind 'expense') and a
// candidate expense (positive amount, checked against `spent_on`).
const expenseRow = (over: Partial<BankRow> = {}): BankRow => ({
  id: 'x1', date: '2026-08-10', amount_cents: -5000, payee: 'ACME SUPPLY', kind: 'expense', linked: false, ...over,
})

const expenseFixture = (over: Partial<CandidateExpense> = {}): CandidateExpense => ({
  id: 'e1', show_id: 's1', amount_cents: 5000, spent_on: '2026-08-10', where_spent: 'Acme Supply', linked: false, ...over,
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

test('a deposit dated exactly on the send date proposes the invoice — the boundary is inclusive', () => {
  // Single: row.date equals sent_at's date prefix exactly (not one day after).
  const single = proposeMatches({
    rows: [row({ date: '2026-08-01' })],
    invoices: [invoice({ sent_at: '2026-08-01T00:00:00Z' })],
    expenses: [], dismissed: [],
  })
  assert.deepEqual(single.income, [{ transactionId: 't1', invoiceIds: ['i1'], confidence: 'high' }])

  // Sum eligibility: an invoice whose sent_at date equals the row's date is
  // still eligible to combine — the same inclusive boundary, not an
  // off-by-one that would silently exclude same-day invoices from a sum.
  const sum = proposeMatches({
    rows: [row({ amount_cents: 240000, date: '2026-08-02' })],
    invoices: [
      invoice({ id: 'i1', client_id: 'c1', total_cents: 100000, sent_at: '2026-08-01T00:00:00Z' }),
      invoice({ id: 'i2', client_id: 'c1', total_cents: 140000, sent_at: '2026-08-02T00:00:00Z' }),
    ],
    expenses: [], dismissed: [],
  })
  assert.deepEqual(sum.income, [{ transactionId: 't1', invoiceIds: ['i1', 'i2'], confidence: 'low' }])
})

test('exactly three sum combinations still propose — the cap is over three', () => {
  // Six invoices, deliberately valued so exactly three distinct pairs sum to
  // the target and no other pair or triple does. Complements the existing
  // over-cap test (six 100000 invoices -> six combos -> none propose): this
  // pins the boundary from the other side.
  const result = proposeMatches({
    rows: [row({ amount_cents: 300000 })],
    invoices: [
      invoice({ id: 'iA', client_id: 'c1', total_cents: 100000, sent_at: '2026-08-01T00:00:00Z' }),
      invoice({ id: 'iB', client_id: 'c1', total_cents: 200000, sent_at: '2026-08-01T00:00:00Z' }),
      invoice({ id: 'iC', client_id: 'c1', total_cents: 120000, sent_at: '2026-08-01T00:00:00Z' }),
      invoice({ id: 'iD', client_id: 'c1', total_cents: 180000, sent_at: '2026-08-01T00:00:00Z' }),
      invoice({ id: 'iE', client_id: 'c1', total_cents: 150000, sent_at: '2026-08-01T00:00:00Z' }),
      invoice({ id: 'iF', client_id: 'c1', total_cents: 150000, sent_at: '2026-08-01T00:00:00Z' }),
    ],
    expenses: [], dismissed: [],
  })
  assert.deepEqual(result.income.map((p) => p.invoiceIds), [
    ['iA', 'iB'],
    ['iC', 'iD'],
    ['iE', 'iF'],
  ])
  assert.ok(result.income.every((p) => p.confidence === 'low'))
})

test('a dismissed exact single does not fall back to sum matching', () => {
  // Pinning Task 2's actual behavior: proposalsFor decides single-vs-sum for
  // a row BEFORE dismissal suppression runs. Once iA is chosen as the row's
  // only exact single, the row never falls back to considering iB+iC as a
  // sum, even though iB+iC sums to the same amount and dismissing iA is the
  // only thing standing between the row and a proposal. This is deliberate:
  // a dismissed guess must not resurrect as a different guess.
  const result = proposeMatches({
    rows: [row({ amount_cents: 240000 })],
    invoices: [
      invoice({ id: 'iA', client_id: 'cA', total_cents: 240000, sent_at: '2026-08-01T00:00:00Z' }),
      invoice({ id: 'iB', client_id: 'cB', total_cents: 100000, sent_at: '2026-08-01T00:00:00Z' }),
      invoice({ id: 'iC', client_id: 'cB', total_cents: 140000, sent_at: '2026-08-02T00:00:00Z' }),
    ],
    dismissed: [dismissal({ transaction_id: 't1', invoice_id: 'iA' })],
    expenses: [],
  })
  assert.deepEqual(result.income, [])
})

// ---------------------------------------------------------------------------
// Expense half: the mirror image of income. Income sums combine multiple
// invoices onto one deposit; expense sums combine multiple charges onto one
// expense (the Uber Eats order-plus-tip case) — the opposite cardinality,
// same 2-or-3, same over-three cap, same suppress-the-whole-group rule.

test('a charge matching an expense within ten days proposes it', () => {
  const result = proposeMatches({
    rows: [expenseRow({ date: '2026-08-15', amount_cents: -5000 })],
    invoices: [],
    expenses: [expenseFixture({ spent_on: '2026-08-10', amount_cents: 5000 })],
    dismissed: [],
  })
  assert.deepEqual(result.expense, [{ transactionIds: ['x1'], expenseId: 'e1', confidence: 'high' }])
})

test('eleven days out proposes nothing — the boundary pair (10 days matches / 11 does not)', () => {
  const tenDays = proposeMatches({
    rows: [expenseRow({ id: 'x1', date: '2026-08-20', amount_cents: -5000 })],
    invoices: [],
    expenses: [expenseFixture({ id: 'e1', spent_on: '2026-08-10', amount_cents: 5000 })],
    dismissed: [],
  })
  assert.equal(tenDays.expense.length, 1)
  assert.deepEqual(tenDays.expense[0].transactionIds, ['x1'])

  const elevenDays = proposeMatches({
    rows: [expenseRow({ id: 'x2', date: '2026-08-21', amount_cents: -5000 })],
    invoices: [],
    expenses: [expenseFixture({ id: 'e2', spent_on: '2026-08-10', amount_cents: 5000 })],
    dismissed: [],
  })
  assert.deepEqual(elevenDays.expense, [])
})

test('the Uber Eats case — order plus tip sum to one expense', () => {
  const result = proposeMatches({
    rows: [
      expenseRow({ id: 'x1', date: '2026-08-10', amount_cents: -3325, payee: 'UBER EATS' }),
      expenseRow({ id: 'x2', date: '2026-08-10', amount_cents: -700, payee: 'UBER EATS TIP' }),
    ],
    invoices: [],
    expenses: [expenseFixture({ id: 'e1', spent_on: '2026-08-10', amount_cents: 4025, where_spent: 'Uber Eats' })],
    dismissed: [],
  })
  assert.deepEqual(result.expense, [{ transactionIds: ['x1', 'x2'], expenseId: 'e1', confidence: 'low' }])
})

test('rows with different leading tokens never group', () => {
  const result = proposeMatches({
    rows: [
      expenseRow({ id: 'x1', date: '2026-08-10', amount_cents: -3000, payee: 'UBER EATS' }),
      expenseRow({ id: 'x2', date: '2026-08-10', amount_cents: -2000, payee: 'LYFT RIDE' }),
    ],
    invoices: [],
    expenses: [expenseFixture({ id: 'e1', spent_on: '2026-08-10', amount_cents: 5000 })],
    dismissed: [],
  })
  assert.deepEqual(result.expense, [])
})

test('rows four days apart never group — pairwise span is the rule', () => {
  const result = proposeMatches({
    rows: [
      expenseRow({ id: 'x1', date: '2026-08-10', amount_cents: -3000, payee: 'UBER EATS' }),
      expenseRow({ id: 'x2', date: '2026-08-14', amount_cents: -2000, payee: 'UBER EATS TIP' }),
    ],
    invoices: [],
    expenses: [expenseFixture({ id: 'e1', spent_on: '2026-08-10', amount_cents: 5000 })],
    dismissed: [],
  })
  assert.deepEqual(result.expense, [])
})

test('a group is not proposed when a single row matches exactly', () => {
  const result = proposeMatches({
    rows: [
      expenseRow({ id: 'x1', date: '2026-08-10', amount_cents: -5000, payee: 'UBER EATS' }),
      expenseRow({ id: 'x2', date: '2026-08-10', amount_cents: -3000, payee: 'UBER EATS PLUS' }),
      expenseRow({ id: 'x3', date: '2026-08-10', amount_cents: -2000, payee: 'UBER EATS TIP' }),
    ],
    invoices: [],
    expenses: [expenseFixture({ id: 'e1', spent_on: '2026-08-10', amount_cents: 5000 })],
    dismissed: [],
  })
  assert.deepEqual(result.expense, [{ transactionIds: ['x1'], expenseId: 'e1', confidence: 'low' }])
})

test('two identical-value expenses both propose at low confidence', () => {
  const result = proposeMatches({
    rows: [expenseRow({ id: 'x1', date: '2026-08-10', amount_cents: -5000, payee: 'UBER EATS' })],
    invoices: [],
    expenses: [
      expenseFixture({ id: 'e1', spent_on: '2026-08-10', amount_cents: 5000, where_spent: 'Uber Eats' }),
      expenseFixture({ id: 'e2', spent_on: '2026-08-12', amount_cents: 5000, where_spent: 'Uber Eats' }),
    ],
    dismissed: [],
  })
  assert.deepEqual(result.expense, [
    { transactionIds: ['x1'], expenseId: 'e1', confidence: 'low' },
    { transactionIds: ['x1'], expenseId: 'e2', confidence: 'low' },
  ])
})

test('a dismissed pair suppresses the whole group', () => {
  const result = proposeMatches({
    rows: [
      expenseRow({ id: 'x1', date: '2026-08-10', amount_cents: -3325, payee: 'UBER EATS' }),
      expenseRow({ id: 'x2', date: '2026-08-10', amount_cents: -700, payee: 'UBER EATS TIP' }),
    ],
    invoices: [],
    expenses: [expenseFixture({ id: 'e1', spent_on: '2026-08-10', amount_cents: 4025 })],
    dismissed: [{ transaction_id: 'x1', invoice_id: null, expense_id: 'e1' }],
  })
  assert.deepEqual(result.expense, [])
})

test('a dismissed single suppresses only that proposal, not unrelated ones', () => {
  const result = proposeMatches({
    rows: [
      expenseRow({ id: 'x1', date: '2026-08-10', amount_cents: -5000 }),
      expenseRow({ id: 'x2', date: '2026-08-11', amount_cents: -3000 }),
    ],
    invoices: [],
    expenses: [
      expenseFixture({ id: 'e1', spent_on: '2026-08-10', amount_cents: 5000 }),
      expenseFixture({ id: 'e2', spent_on: '2026-08-11', amount_cents: 3000 }),
    ],
    dismissed: [{ transaction_id: 'x1', invoice_id: null, expense_id: 'e1' }],
  })
  assert.deepEqual(result.expense, [{ transactionIds: ['x2'], expenseId: 'e2', confidence: 'high' }])
})

test('a linked expense is never proposed again', () => {
  const result = proposeMatches({
    rows: [expenseRow({ amount_cents: -5000 })],
    invoices: [],
    expenses: [expenseFixture({ linked: true })],
    dismissed: [],
  })
  assert.deepEqual(result.expense, [])
})

test('a linked bank row is never proposed against an expense', () => {
  const result = proposeMatches({
    rows: [expenseRow({ amount_cents: -5000, linked: true })],
    invoices: [],
    expenses: [expenseFixture()],
    dismissed: [],
  })
  assert.deepEqual(result.expense, [])
})

test('rows shaped as income, transfer, or owner_pay never match an expense', () => {
  const result = proposeMatches({
    rows: [
      expenseRow({ id: 'x1', kind: 'income', amount_cents: -5000 }),
      expenseRow({ id: 'x2', kind: 'transfer', amount_cents: -5000 }),
      expenseRow({ id: 'x3', kind: 'owner_pay', amount_cents: -5000 }),
      expenseRow({ id: 'x4', kind: 'expense', amount_cents: 5000 }), // positive: not a charge
    ],
    invoices: [],
    expenses: [expenseFixture()],
    dismissed: [],
  })
  assert.deepEqual(result.expense, [])
})

test('a three-row sum still proposes when every pair is within three days and within range of spent_on', () => {
  const result = proposeMatches({
    rows: [
      expenseRow({ id: 'x1', date: '2026-08-09', amount_cents: -2000, payee: 'UBER EATS' }),
      expenseRow({ id: 'x2', date: '2026-08-10', amount_cents: -1500, payee: 'UBER EATS TIP' }),
      expenseRow({ id: 'x3', date: '2026-08-11', amount_cents: -1500, payee: 'UBER EATS FEE' }),
    ],
    invoices: [],
    expenses: [expenseFixture({ id: 'e1', spent_on: '2026-08-10', amount_cents: 5000 })],
    dismissed: [],
  })
  assert.deepEqual(result.expense, [{ transactionIds: ['x1', 'x2', 'x3'], expenseId: 'e1', confidence: 'low' }])
})

test('expense proposals are sorted by first transaction date ascending then transaction id', () => {
  const result = proposeMatches({
    rows: [
      expenseRow({ id: 'xX', date: '2026-08-10', amount_cents: -1000 }),
      expenseRow({ id: 'xM', date: '2026-08-05', amount_cents: -2000 }),
      expenseRow({ id: 'xW', date: '2026-08-10', amount_cents: -1400 }),
    ],
    invoices: [],
    expenses: [
      expenseFixture({ id: 'eX', spent_on: '2026-08-10', amount_cents: 1000 }),
      expenseFixture({ id: 'eM', spent_on: '2026-08-05', amount_cents: 2000 }),
      expenseFixture({ id: 'eW', spent_on: '2026-08-10', amount_cents: 1400 }),
    ],
    dismissed: [],
  })
  assert.deepEqual(result.expense.map((p) => p.transactionIds[0]), ['xM', 'xW', 'xX'])
})
