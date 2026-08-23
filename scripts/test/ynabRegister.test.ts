// Pins the YNAB Register CSV -> ledger_transactions mapping: the CSV
// mechanics (quoting, amounts, dates) and Dan's business rules (owner vs.
// income vs. expense, aliases, skips) each get their own coverage.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseYnabRegister, mapYnabRow, ALIASES, type YnabRow } from '../../lib/ynabRegister.ts'

const HEADER = '"Account","Flag","Date","Payee","Category Group/Category","Category Group","Category","Memo","Outflow","Inflow","Cleared"'

/** One CSV data row from field values, quoting every field (always legal, never required). */
function csvRow(fields: string[]): string {
  return fields.map((f) => `"${f.replace(/"/g, '""')}"`).join(',')
}

// -- parseYnabRegister: CSV mechanics ---------------------------------------

test('parses a plain row: account/date/payee/category/memo/amounts/cleared', () => {
  const csv = [
    HEADER,
    csvRow(['Business Checking', '', '01/15/2026', 'Adobe', 'Bills: Software', 'Bills', 'Software', 'monthly sub', '54.99', '', 'Cleared']),
  ].join('\n')
  const rows = parseYnabRegister(csv)
  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0], {
    account: 'Business Checking',
    date: '2026-01-15',
    payee: 'Adobe',
    categoryGroup: 'Bills',
    category: 'Software',
    memo: 'monthly sub',
    outflowCents: 5499,
    inflowCents: 0,
    cleared: 'Cleared',
  })
})

test('tolerates the UTF-8 BOM YNAB writes before the header', () => {
  // The real export opens with \uFEFF; without stripping it the header
  // check fails with two visually identical strings.
  const rows = parseYnabRegister('\uFEFF' + HEADER + '\n'
    + '"Chase Checking","","01/15/2026","Coffee","","","","",$4.50,$0.00,"Cleared"\n')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].account, 'Chase Checking')
})

test('a quoted field can contain a comma', () => {
  const csv = [
    HEADER,
    csvRow(['Business Checking', '', '02/01/2026', 'Client, LLC', 'Income: Show Income', 'Income', 'Show Income', '', '', '500.00', 'Uncleared']),
  ].join('\n')
  const rows = parseYnabRegister(csv)
  assert.equal(rows[0].payee, 'Client, LLC')
})

test('a quoted field can contain an escaped quote', () => {
  const csv = [
    HEADER,
    csvRow(['Business Checking', '', '02/02/2026', 'Bob "The Mixer" Smith', 'Expenses: Gig Expenses', 'Expenses', 'Gig Expenses', '', '10.00', '', 'Cleared']),
  ].join('\n')
  const rows = parseYnabRegister(csv)
  assert.equal(rows[0].payee, 'Bob "The Mixer" Smith')
})

test('a quoted field can contain an embedded newline (multiline memo)', () => {
  const csv = [
    HEADER,
    csvRow(['Business Checking', '', '02/03/2026', 'Airline', 'Expenses: Flights', 'Expenses', 'Flights', 'Flight to LA\nfor the Smith show', '250.00', '', 'Cleared']),
  ].join('\n')
  const rows = parseYnabRegister(csv)
  assert.equal(rows[0].memo, 'Flight to LA\nfor the Smith show')
})

test('amounts with a $ and thousands separators parse to cents', () => {
  const csv = [
    HEADER,
    csvRow(['Business Checking', '', '03/01/2026', 'Big Client', 'Income: Show Income', 'Income', 'Show Income', '', '', '$1,234.56', 'Cleared']),
  ].join('\n')
  const rows = parseYnabRegister(csv)
  assert.equal(rows[0].inflowCents, 123456)
})

test('a bare number (no $, no comma) also parses to cents', () => {
  const csv = [HEADER, csvRow(['Business Checking', '', '03/02/2026', 'X', '', '', '', '', '1234.56', '', 'Cleared'])].join('\n')
  const rows = parseYnabRegister(csv)
  assert.equal(rows[0].outflowCents, 123456)
})

test('an empty amount field is zero cents', () => {
  const csv = [HEADER, csvRow(['Business Checking', '', '03/03/2026', 'X', '', '', '', '', '', '', 'Cleared'])].join('\n')
  const rows = parseYnabRegister(csv)
  assert.equal(rows[0].outflowCents, 0)
  assert.equal(rows[0].inflowCents, 0)
})

test('MM/DD/YYYY converts to YYYY-MM-DD, single-digit month/day included', () => {
  const csv = [HEADER, csvRow(['Business Checking', '', '3/4/2026', 'X', '', '', '', '', '5.00', '', 'Cleared'])].join('\n')
  const rows = parseYnabRegister(csv)
  assert.equal(rows[0].date, '2026-03-04')
})

test('a malformed header throws, naming the problem', () => {
  const csv = ['"Account","Date","Payee"', csvRow(['a', 'b', 'c'])].join('\n')
  assert.throws(() => parseYnabRegister(csv), /header/i)
})

test('an unparsable date throws, naming the row', () => {
  const csv = [HEADER, csvRow(['Business Checking', '', 'not-a-date', 'X', '', '', '', '', '5.00', '', 'Cleared'])].join('\n')
  assert.throws(() => parseYnabRegister(csv), /row 2/i)
})

test('an unparsable amount throws, naming the row', () => {
  const csv = [HEADER, csvRow(['Business Checking', '', '01/01/2026', 'X', '', '', '', '', 'garbage', '', 'Cleared'])].join('\n')
  assert.throws(() => parseYnabRegister(csv), /row 2/i)
})

test('an unrecognized Cleared value throws', () => {
  const csv = [HEADER, csvRow(['Business Checking', '', '01/01/2026', 'X', '', '', '', '', '5.00', '', 'Pending'])].join('\n')
  assert.throws(() => parseYnabRegister(csv), /cleared/i)
})

// -- mapYnabRow: skips -------------------------------------------------------

const row = (over: Partial<YnabRow> = {}): YnabRow => ({
  account: 'Business Checking',
  date: '2026-02-01',
  payee: 'Some Payee',
  categoryGroup: 'Expenses',
  category: 'Gig Expenses',
  memo: '',
  outflowCents: 1000,
  inflowCents: 0,
  cleared: 'Cleared',
  ...over,
})

const OPTS = { accountName: 'Business Checking', startDate: '2026-01-01' }

test('a row for a different YNAB account is skipped other-account', () => {
  const outcome = mapYnabRow(row({ account: 'Personal Checking' }), OPTS)
  assert.deepEqual(outcome, { kind: 'skip', reason: 'other-account' })
})

test('a row before the backfill start date is skipped before-start', () => {
  const outcome = mapYnabRow(row({ date: '2025-12-31' }), OPTS)
  assert.deepEqual(outcome, { kind: 'skip', reason: 'before-start' })
})

test('a row on the start date itself is NOT skipped before-start', () => {
  const outcome = mapYnabRow(row({ date: '2026-01-01' }), OPTS)
  assert.equal(outcome.kind, 'txn')
})

test('"Starting Balance" payee is skipped starting-balance', () => {
  const outcome = mapYnabRow(row({ payee: 'Starting Balance', outflowCents: 0, inflowCents: 500000 }), OPTS)
  assert.deepEqual(outcome, { kind: 'skip', reason: 'starting-balance' })
})

test('a zero-net row (inflow equals outflow) is skipped zero-amount', () => {
  const outcome = mapYnabRow(row({ outflowCents: 500, inflowCents: 500 }), OPTS)
  assert.deepEqual(outcome, { kind: 'skip', reason: 'zero-amount' })
})

test('a genuinely zero row (both amounts blank) is skipped zero-amount', () => {
  const outcome = mapYnabRow(row({ outflowCents: 0, inflowCents: 0 }), OPTS)
  assert.deepEqual(outcome, { kind: 'skip', reason: 'zero-amount' })
})

// -- mapYnabRow: owner group --------------------------------------------------

test('Owner Transactions outflow maps to owner_pay, negative, uncategorized', () => {
  const outcome = mapYnabRow(row({ categoryGroup: 'Owner Transactions', category: 'Owner Draw', outflowCents: 20000, inflowCents: 0 }), OPTS)
  assert.equal(outcome.kind, 'txn')
  if (outcome.kind !== 'txn') return
  assert.equal(outcome.txn.kind, 'owner_pay')
  assert.equal(outcome.txn.amountCents, -20000)
  assert.equal(outcome.txn.categoryName, null)
})

test('Owner Transactions inflow maps to transfer (an owner investment, not income), positive, uncategorized', () => {
  const outcome = mapYnabRow(row({ categoryGroup: 'Owner Transactions', category: 'Owner Investment', outflowCents: 0, inflowCents: 15000 }), OPTS)
  assert.equal(outcome.kind, 'txn')
  if (outcome.kind !== 'txn') return
  assert.equal(outcome.txn.kind, 'transfer')
  assert.equal(outcome.txn.amountCents, 15000)
  assert.equal(outcome.txn.categoryName, null)
})

// -- mapYnabRow: Transfer-payee rule ------------------------------------------

test('a "Transfer : X" payee outflow maps to owner_pay by the same rule as the owner group', () => {
  const outcome = mapYnabRow(row({ payee: 'Transfer : Savings', categoryGroup: '', category: '', outflowCents: 30000, inflowCents: 0 }), OPTS)
  assert.equal(outcome.kind, 'txn')
  if (outcome.kind !== 'txn') return
  assert.equal(outcome.txn.kind, 'owner_pay')
  assert.equal(outcome.txn.amountCents, -30000)
  assert.equal(outcome.txn.categoryName, null)
})

test('a "Transfer : X" payee inflow maps to transfer', () => {
  const outcome = mapYnabRow(row({ payee: 'Transfer : Savings', categoryGroup: '', category: '', outflowCents: 0, inflowCents: 30000 }), OPTS)
  assert.equal(outcome.kind, 'txn')
  if (outcome.kind !== 'txn') return
  assert.equal(outcome.txn.kind, 'transfer')
  assert.equal(outcome.txn.amountCents, 30000)
})

// -- mapYnabRow: income --------------------------------------------------------

test('a plain inflow maps to income, Show Income, with the payee preserved', () => {
  const outcome = mapYnabRow(row({ payee: 'Willow Creek Church', categoryGroup: 'Income', category: 'Inflow: Ready to Assign', outflowCents: 0, inflowCents: 250000 }), OPTS)
  assert.equal(outcome.kind, 'txn')
  if (outcome.kind !== 'txn') return
  assert.equal(outcome.txn.kind, 'income')
  assert.equal(outcome.txn.categoryName, 'Show Income')
  assert.equal(outcome.txn.amountCents, 250000)
  assert.equal(outcome.txn.payee, 'Willow Creek Church')
})

// -- mapYnabRow: expenses, aliases --------------------------------------------

test('Spotify and Clear are real categories now (0039 converged the lists) and pass through unchanged', () => {
  assert.deepEqual(ALIASES, {})

  const spotify = mapYnabRow(row({ payee: 'Spotify', category: 'Spotify', outflowCents: 999, inflowCents: 0 }), OPTS)
  assert.equal(spotify.kind, 'txn')
  if (spotify.kind !== 'txn') return
  assert.equal(spotify.txn.categoryName, 'Spotify')
  assert.equal(spotify.txn.kind, 'expense')
  assert.equal(spotify.txn.amountCents, -999)

  const clear = mapYnabRow(row({ category: 'Clear', outflowCents: 1999, inflowCents: 0 }), OPTS)
  assert.equal(clear.kind, 'txn')
  if (clear.kind !== 'txn') return
  assert.equal(clear.txn.categoryName, 'Clear')
})

test('an unknown category name passes through unchanged (caller resolves/tallies it)', () => {
  const outcome = mapYnabRow(row({ category: 'Some Category Dan Renamed' }), OPTS)
  assert.equal(outcome.kind, 'txn')
  if (outcome.kind !== 'txn') return
  assert.equal(outcome.txn.categoryName, 'Some Category Dan Renamed')
})

test('a blank category maps to a null categoryName', () => {
  const outcome = mapYnabRow(row({ category: '' }), OPTS)
  assert.equal(outcome.kind, 'txn')
  if (outcome.kind !== 'txn') return
  assert.equal(outcome.txn.categoryName, null)
})

// -- mapYnabRow: cleared -------------------------------------------------------

test('YNAB Uncleared maps to uncleared', () => {
  const outcome = mapYnabRow(row({ cleared: 'Uncleared' }), OPTS)
  assert.equal(outcome.kind, 'txn')
  if (outcome.kind !== 'txn') return
  assert.equal(outcome.txn.cleared, 'uncleared')
})

test('YNAB Cleared maps to cleared', () => {
  const outcome = mapYnabRow(row({ cleared: 'Cleared' }), OPTS)
  assert.equal(outcome.kind, 'txn')
  if (outcome.kind !== 'txn') return
  assert.equal(outcome.txn.cleared, 'cleared')
})

test('YNAB Reconciled ALSO maps to cleared, never reconciled — the first in-app reconcile earns that', () => {
  const outcome = mapYnabRow(row({ cleared: 'Reconciled' }), OPTS)
  assert.equal(outcome.kind, 'txn')
  if (outcome.kind !== 'txn') return
  assert.equal(outcome.txn.cleared, 'cleared')
})

// -- mapYnabRow: memo ------------------------------------------------------

test('memo is trimmed', () => {
  const outcome = mapYnabRow(row({ memo: '  padded memo  ' }), OPTS)
  assert.equal(outcome.kind, 'txn')
  if (outcome.kind !== 'txn') return
  assert.equal(outcome.txn.memo, 'padded memo')
})

test('a blank memo maps to null', () => {
  const outcome = mapYnabRow(row({ memo: '   ' }), OPTS)
  assert.equal(outcome.kind, 'txn')
  if (outcome.kind !== 'txn') return
  assert.equal(outcome.txn.memo, null)
})

// -- mapYnabRow: sign invariants ----------------------------------------------

test('every income outcome has amountCents > 0', () => {
  const outcome = mapYnabRow(row({ categoryGroup: 'Income', outflowCents: 0, inflowCents: 100 }), OPTS)
  assert.equal(outcome.kind, 'txn')
  if (outcome.kind !== 'txn') return
  assert.ok(outcome.txn.amountCents > 0)
})

test('every expense outcome has amountCents < 0', () => {
  const outcome = mapYnabRow(row({ outflowCents: 100, inflowCents: 0 }), OPTS)
  assert.equal(outcome.kind, 'txn')
  if (outcome.kind !== 'txn') return
  assert.equal(outcome.txn.kind, 'expense')
  assert.ok(outcome.txn.amountCents < 0)
})

test('every owner_pay outcome has amountCents < 0 and a null category', () => {
  const outcome = mapYnabRow(row({ categoryGroup: 'Owner Transactions', outflowCents: 100, inflowCents: 0 }), OPTS)
  assert.equal(outcome.kind, 'txn')
  if (outcome.kind !== 'txn') return
  assert.ok(outcome.txn.amountCents < 0)
  assert.equal(outcome.txn.categoryName, null)
})

test('every transfer outcome has a null category', () => {
  const outcome = mapYnabRow(row({ categoryGroup: 'Owner Transactions', outflowCents: 0, inflowCents: 100 }), OPTS)
  assert.equal(outcome.kind, 'txn')
  if (outcome.kind !== 'txn') return
  assert.equal(outcome.txn.categoryName, null)
})
