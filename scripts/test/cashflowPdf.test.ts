// The cash flow forecast document, pinned. It goes to Dan's accountant beside
// the P&L, so it follows the same conventions — and, unlike the screen, it must
// carry its ASSUMPTIONS, because every row depends on them and she may want to
// change one in the meeting.
//
// Plain objects stand in for the PDF primitives; no PDF is rendered here.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildCashflowPdf, cashflowFilename, type CashflowDocumentData } from '../../lib/cashflowPdf.ts'

const PARTS = {
  Document: 'Document', Page: 'Page', Text: 'Text', View: 'View', Image: 'Image',
} as any

function texts(node: any, out: string[] = []): string[] {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const n of node) texts(n, out); return out }
  if (node.props) texts(node.props.children, out)
  return out
}

/** Every node in the tree, so styles can be inspected as well as strings. */
function nodes(node: any, out: any[] = []): any[] {
  if (node === null || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const n of node) nodes(n, out); return out }
  out.push(node)
  if (node.props) nodes(node.props.children, out)
  return out
}

const DATA: CashflowDocumentData = {
  businessName: 'Smith Audio, LLC',
  generatedOn: '2026-09-10',
  openingBalanceCents: 1835027,
  months: [
    { month: '2026-09', incomeCents: 1411376, overheadCents: 80000, taxCents: 300000,
      drawCents: 500000, endingBalanceCents: 2366403, covered: true },
    { month: '2026-10', incomeCents: 0, overheadCents: 80000, taxCents: 0,
      drawCents: 750000, endingBalanceCents: 1536403, covered: true },
    { month: '2026-11', incomeCents: 0, overheadCents: 80000, taxCents: 0,
      drawCents: 750000, endingBalanceCents: -100000, covered: false },
  ],
  assumptions: [
    { label: 'Monthly take-home', value: '$7,500.00' },
    { label: 'Monthly overhead', value: '$800.00' },
    { label: 'Tax set-aside', value: '25%' },
  ],
}

test('the heading names the business, the report and the span of months', () => {
  const all = texts(buildCashflowPdf(PARTS, DATA))
  assert.ok(all.includes('Smith Audio, LLC'))
  assert.ok(all.includes('Cash Flow Forecast'))
  assert.ok(all.some(t => t.includes('September 2026') && t.includes('November 2026')))
})

test('it says when it was projected — a forecast is only true as of a date', () => {
  const all = texts(buildCashflowPdf(PARTS, DATA))
  assert.ok(all.some(t => t.includes('September 10, 2026')))
})

test('the assumptions are printed, not hidden', () => {
  const all = texts(buildCashflowPdf(PARTS, DATA))
  assert.ok(all.includes('Assumptions'))
  assert.ok(all.includes('Monthly take-home'))
  assert.ok(all.includes('$7,500.00'))
  assert.ok(all.includes('Tax set-aside'))
  assert.ok(all.includes('25%'))
})

test('starting cash is stated before the first month', () => {
  const all = texts(buildCashflowPdf(PARTS, DATA))
  assert.ok(all.includes('Starting cash'))
  assert.ok(all.includes('$18,350.27'))
  assert.ok(all.indexOf('Starting cash') < all.indexOf('September 2026'))
})

test('outflows print as negatives so the row reads as a sum', () => {
  const all = texts(buildCashflowPdf(PARTS, DATA))
  assert.ok(all.includes('-$800.00'), 'overhead should be negative')
  assert.ok(all.includes('-$3,000.00'), 'tax set-aside should be negative')
  assert.ok(all.includes('-$5,000.00'), 'draw should be negative')
  assert.ok(all.includes('$14,113.76'), 'income stays positive')
})

test('a month that falls short is marked, because it is the one thing not to miss', () => {
  const marked = nodes(buildCashflowPdf(PARTS, DATA))
    .filter(n => n?.props?.style?.color === '#b91c1c')
  assert.ok(marked.length > 0, 'the uncovered month should carry the short colour')
  const shortTexts = marked.flatMap(n => texts(n))
  assert.ok(shortTexts.includes('November 2026'))
  assert.ok(!shortTexts.includes('September 2026'), 'a covered month must not be marked')
})

test('no months is a document, not a crash', () => {
  const all = texts(buildCashflowPdf(PARTS, { ...DATA, months: [] }))
  assert.ok(all.includes('No months projected'))
})

test('the filename carries the span', () => {
  assert.equal(cashflowFilename('2026-09', '2028-08'),
    'smith-audio-cash-flow-2026-09-to-2028-08.pdf')
})

test('a zero outflow prints as zero, not as minus zero', () => {
  const all = texts(buildCashflowPdf(PARTS, {
    ...DATA,
    months: [{ month: '2026-10', incomeCents: 0, overheadCents: 80000, taxCents: 0,
      drawCents: 750000, endingBalanceCents: 100000, covered: true }],
  }))
  assert.ok(all.includes('$0.00'), 'a zero set-aside should read $0.00')
  assert.ok(!all.includes('-$0.00'), 'never minus zero')
})
