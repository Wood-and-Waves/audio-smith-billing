// The P&L document, pinned. Dan's accountant "likes the style of quickbooks
// printouts", so the structure below is the thing under test: a centred
// heading block, income then expenses with subtotals, Net Income, and the two
// memo lines BELOW the statement rather than inside it.
//
// Like invoicePdf.test.ts, this injects plain objects as the PDF primitives
// and inspects the tree, so no PDF is ever rendered here.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildProfitLossPdf, plFilename, type PlDocumentData } from '../../lib/profitLossPdf.ts'

// Each primitive records its own name so the tree can be searched by text.
const PARTS = {
  Document: 'Document', Page: 'Page', Text: 'Text', View: 'View', Image: 'Image',
} as any

/** Every string anywhere in the built tree, in document order. */
function texts(node: any, out: string[] = []): string[] {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const n of node) texts(n, out); return out }
  if (node.props) texts(node.props.children, out)
  return out
}

const DATA: PlDocumentData = {
  businessName: 'Smith Audio, LLC',
  from: '2026-07-01',
  to: '2026-09-30',
  income: [{ name: 'Show Income', amountCents: 2640776 }],
  totalIncomeCents: 2640776,
  expenseGroups: [
    { group: 'Bills', rows: [{ name: 'Insurance', amountCents: 42700 }], subtotalCents: 42700 },
  ],
  totalExpensesCents: 42700,
  netCents: 2598076,
  ownerPayCents: 750000,
  deductibleCents: 42700,
}

test('the heading block names the business, the report and the period', () => {
  const all = texts(buildProfitLossPdf(PARTS, DATA))
  assert.ok(all.includes('Smith Audio, LLC'))
  assert.ok(all.includes('Profit and Loss'))
  assert.ok(all.some((t) => t.includes('July 1') && t.includes('September 30, 2026')))
})

test('income and expenses each carry a total, and Net Income appears', () => {
  const all = texts(buildProfitLossPdf(PARTS, DATA))
  assert.ok(all.includes('Total Income'))
  assert.ok(all.includes('Total Expenses'))
  assert.ok(all.includes('Net Income'))
  assert.ok(all.includes('$25,980.76'))
})

// QuickBooks-style P&Ls subtotal each expense group beneath its own rows,
// distinct from the one grand Total Expenses at the end. PlDocumentData
// already carries subtotalCents per group; this proves it actually renders.
test('each expense group prints its own subtotal, after its rows and before Total Expenses', () => {
  const all = texts(buildProfitLossPdf(PARTS, DATA))
  const insurance = all.indexOf('Insurance')
  const groupSubtotal = all.indexOf('Total Bills')
  const grandTotal = all.indexOf('Total Expenses')
  assert.ok(insurance > -1 && groupSubtotal > -1 && grandTotal > -1, 'all three lines must render')
  assert.ok(groupSubtotal > insurance, 'the group subtotal must come after its own rows')
  assert.ok(groupSubtotal < grandTotal, 'the group subtotal must come before the grand total')
})

test('with two expense groups, each gets its own subtotal, distinct from the grand total', () => {
  const twoGroups: PlDocumentData = {
    ...DATA,
    expenseGroups: [
      { group: 'Bills', rows: [{ name: 'Insurance', amountCents: 42700 }], subtotalCents: 42700 },
      {
        group: 'Travel',
        rows: [{ name: 'Airfare', amountCents: 30000 }, { name: 'Hotel', amountCents: 20000 }],
        subtotalCents: 50000,
      },
    ],
    totalExpensesCents: 92700,
  }
  const all = texts(buildProfitLossPdf(PARTS, twoGroups))
  const insurance = all.indexOf('Insurance')
  const billsSubtotal = all.indexOf('Total Bills')
  const airfare = all.indexOf('Airfare')
  const hotel = all.indexOf('Hotel')
  const travelSubtotal = all.indexOf('Total Travel')
  const grandTotal = all.indexOf('Total Expenses')

  for (const i of [insurance, billsSubtotal, airfare, hotel, travelSubtotal, grandTotal]) {
    assert.ok(i > -1, 'every expected line must render')
  }
  assert.ok(billsSubtotal > insurance, 'Total Bills must follow its own rows')
  assert.ok(billsSubtotal < airfare, "Total Bills must precede the next group's rows")
  assert.ok(travelSubtotal > hotel, 'Total Travel must follow its own rows')
  assert.ok(travelSubtotal < grandTotal, 'both group subtotals must precede the grand total')
  assert.ok(all.includes('$427.00'), "Bills' own subtotal amount must render")
  assert.ok(all.includes('$500.00'), "Travel's own subtotal amount must render")
})

// Owner draws are equity, not an expense. They must not be inside Expenses or
// they would understate profit; they sit below the statement as a memo.
test('owner pay appears as a memo, after Net Income', () => {
  const all = texts(buildProfitLossPdf(PARTS, DATA))
  const net = all.indexOf('Net Income')
  const owner = all.findIndex((t) => t.startsWith('Owner pay'))
  assert.ok(net > -1 && owner > net, 'owner pay must come after Net Income')
})

test('no tax figure and no payment due date appear anywhere', () => {
  const all = texts(buildProfitLossPdf(PARTS, DATA)).join(' ').toLowerCase()
  assert.equal(all.includes('tax due'), false)
  assert.equal(all.includes('due date'), false)
  assert.equal(all.includes('estimated tax'), false)
})

test('an empty period still renders a statement with zero totals', () => {
  const empty: PlDocumentData = {
    ...DATA, income: [], totalIncomeCents: 0, expenseGroups: [],
    totalExpensesCents: 0, netCents: 0, ownerPayCents: 0, deductibleCents: 0,
  }
  const all = texts(buildProfitLossPdf(PARTS, empty))
  assert.ok(all.includes('Net Income'))
  assert.ok(all.includes('$0.00'))
})

test('the filename names the range', () => {
  assert.equal(plFilename('2026-07-01', '2026-09-30'),
    'smith-audio-profit-and-loss-2026-07-01-to-2026-09-30.pdf')
})
