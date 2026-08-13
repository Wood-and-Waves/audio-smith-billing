// The builder takes its PDF primitives as an argument, so these tests pass
// plain strings as the primitives and walk the resulting React element tree.
// No PDF engine runs, nothing is rendered, and the assertions are about the
// exact strings a client would read on paper.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildInvoicePdf, invoiceFilename, type PdfParts } from '../../lib/invoicePdf.ts'
import { formatUSD } from '../../lib/money.ts'
import type { DocumentData } from '../../components/InvoiceDocument.tsx'

const PARTS: PdfParts = {
  Document: 'DOC', Page: 'PAGE', Text: 'TEXT', View: 'VIEW', Image: 'IMG',
}
const ASSETS = { logoSrc: '/logo.png' }

const SETTINGS: DocumentData['settings'] = {
  business_name: 'The Audio Smith',
  legal_name: 'Smith Audio, LLC',
  address_line1: '2610 Melbourne Lane',
  address_line2: 'Lake in the Hills, IL 60156',
  phone: '269.217.8400',
  email: 'dan@theaudiosmith.com',
  remit_to: 'Smith Audio, LLC\n2610 Melbourne Lane',
}

// Invoice #386 as it was actually issued.
const INVOICE: DocumentData = {
  number: 386,
  issue_date: '2026-08-07',
  due_date: '2026-09-06',
  terms_days: 30,
  bill_to_snapshot: 'Journey Church',
  subtotal_cents: 50000,
  tax_bp: 0,
  tax_cents: 0,
  deposit_cents: 0,
  total_cents: 50000,
  notes: null,
  client: { name: 'Journey Church', address_line1: null, address_line2: null },
  lines: [{
    id: 'l1',
    description: 'Audio Training/Maintenance',
    qty_hundredths: 100,
    unit_price_cents: 50000,
    line_total_cents: 50000,
  }],
  settings: SETTINGS,
}

// Every string the document would print, in order. Text can arrive two ways:
// as `children` (the common case) or, for @react-pdf/renderer's page-number
// trick, as a `render` callback the renderer invokes at layout time. Calling
// only the former would leave that text invisible to every assertion here —
// including the negative ones (no tax, no routing number, no account
// number) — so both are walked.
function textOf(node: unknown, out: string[] = []): string[] {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const n of node) textOf(n, out)
    return out
  }
  const props = (node as { props?: { children?: unknown; render?: unknown } }).props
  if (props && 'children' in props) textOf(props.children, out)
  if (props && typeof props.render === 'function') {
    textOf((props.render as (arg: { pageNumber: number; totalPages: number }) => unknown)(
      { pageNumber: 1, totalPages: 2 },
    ), out)
  }
  return out
}

const joined = (data: DocumentData) =>
  textOf(buildInvoicePdf(PARTS, data, ASSETS)).join('')

test('every money string is formatUSD of the stored cents, never recomputed', () => {
  const all = textOf(buildInvoicePdf(PARTS, INVOICE, ASSETS))
  assert.ok(all.includes(formatUSD(50000)), 'subtotal / total / line figures print as $500.00')
  // Nothing may print a figure that is not one of the stored values.
  const money = all.filter((s) => /^\$[\d,]+\.\d{2}$/.test(s))
  assert.ok(money.length > 0, 'the document prints money')
  for (const m of money) {
    assert.equal(m, formatUSD(50000), `unexpected money string ${m}`)
  }
})

test('stored cents print even when they disagree with qty x price', () => {
  // Dan's history holds both $106.36 and $106.37 as the overtime rate for the
  // same computed figure — the same maths rounded two ways, years apart. An
  // invoice that was sent at the rounded-up total must re-export at that
  // total, so this fixture stores a line total one cent away from what
  // qty x unit_price would give and asserts the stored value is what prints.
  const drifted: DocumentData = {
    ...INVOICE,
    subtotal_cents: 116997,   // recomputing 11 x 10636 would give 116996
    total_cents: 116997,
    lines: [{
      id: 'l1',
      description: 'Overtime',
      qty_hundredths: 1100,
      unit_price_cents: 10636,
      line_total_cents: 116997,
    }],
  }
  const all = textOf(buildInvoicePdf(PARTS, drifted, ASSETS))
  assert.ok(all.includes(formatUSD(116997)), 'the stored $1,169.97 prints')
  assert.ok(!all.includes(formatUSD(116996)), 'the recomputed $1,169.96 never appears')
})

test('dates print as the dates they are, not a day early', () => {
  const all = joined(INVOICE)
  assert.ok(all.includes('8/7/2026'), 'issue date prints 8/7/2026')
  assert.ok(all.includes('9/6/2026'), 'due date prints 9/6/2026')
})

test('no tax row is ever emitted, even when tax is set', () => {
  const taxed: DocumentData = { ...INVOICE, tax_bp: 875, tax_cents: 4375 }
  const all = joined(taxed)
  assert.ok(!/tax/i.test(all), 'the word "tax" never appears')
  assert.ok(!all.includes('8.75'), 'the tax rate never appears')
  assert.ok(!all.includes(formatUSD(4375)), 'the tax amount never appears')
})

test('a zero deposit prints no deposit row', () => {
  assert.ok(!/deposit/i.test(joined(INVOICE)))
})

test('a real deposit prints, negated, and the three figures reconcile', () => {
  // Invoice #340, Streamline Pictures, as actually issued.
  const withDeposit: DocumentData = {
    ...INVOICE,
    number: 340,
    subtotal_cents: 688394,
    deposit_cents: 585000,
    total_cents: 103394,
    lines: [{
      id: 'l1', description: 'Day Rate', qty_hundredths: 600,
      unit_price_cents: 78000, line_total_cents: 468000,
    }],
  }
  const all = joined(withDeposit)
  assert.ok(/deposit/i.test(all), 'the deposit row is present')
  assert.ok(all.includes(formatUSD(688394)), 'subtotal $6,883.94 prints')
  // ASCII hyphen, deliberately. Helvetica silently drops U+2212, which would
  // make the credit read as a charge. See the comment in the builder.
  assert.ok(all.includes(`-${formatUSD(585000)}`), 'deposit prints negated as -$5,850.00')
  assert.ok(!all.includes(`−${formatUSD(585000)}`), 'and NOT with a U+2212 minus')
  assert.ok(all.includes(formatUSD(103394)), 'total $1,033.94 prints')
  assert.equal(688394 - 585000, 103394, 'the printed figures reconcile')

  // The three figures above are only proof the *strings* appear somewhere in
  // the tree — a builder that printed total_cents in the Subtotal row and
  // subtotal_cents in TOTAL DUE would pass every assertion above while
  // sending invoice #340 out reading "Subtotal $1,033.94 ... TOTAL DUE
  // $6,883.94". The tree walk collects strings in document order, so pin
  // each label to the figure that immediately follows it.
  const strings = textOf(buildInvoicePdf(PARTS, withDeposit, ASSETS))
  const labelThenValue = (label: string, value: string) => {
    const i = strings.indexOf(label)
    assert.notEqual(i, -1, `"${label}" appears in the document`)
    assert.equal(strings[i + 1], value, `"${label}" is immediately followed by ${value}`)
  }
  labelThenValue('Subtotal', formatUSD(688394))
  labelThenValue('Deposit received', `-${formatUSD(585000)}`)
  labelThenValue('TOTAL DUE', formatUSD(103394))
})

test('lines print in order, one row each', () => {
  const many: DocumentData = {
    ...INVOICE,
    lines: [
      { id: 'a', description: 'Day Rate', qty_hundredths: 600, unit_price_cents: 78000, line_total_cents: 468000 },
      { id: 'b', description: 'Travel Rate', qty_hundredths: 200, unit_price_cents: 39000, line_total_cents: 78000 },
      { id: 'c', description: 'PM Hours', qty_hundredths: 400, unit_price_cents: 7091, line_total_cents: 28364 },
    ],
  }
  const all = textOf(buildInvoicePdf(PARTS, many, ASSETS))
  const at = (s: string) => all.indexOf(s)
  assert.ok(at('Day Rate') < at('Travel Rate'), 'Day Rate before Travel Rate')
  assert.ok(at('Travel Rate') < at('PM Hours'), 'Travel Rate before PM Hours')
  assert.ok(all.includes('6'), 'quantity 6 prints via formatQty')
})

test('bank details can never reach the document', () => {
  // ach_details is not part of DocumentData. This attaches it the way a
  // careless future widening of the type would, and proves the builder still
  // does not print it. The type is the real guard; this catches its removal.
  const leaky = {
    ...INVOICE,
    settings: { ...SETTINGS, ach_details: 'Routing 071000013 Account 1234567890' },
  } as unknown as DocumentData
  const all = joined(leaky)
  assert.ok(!all.includes('071000013'), 'no routing number')
  assert.ok(!all.includes('1234567890'), 'no account number')
  // The INVITATION to ask about ACH is not the ACH details, and it must print —
  // InvoiceDocument shows it, and the PDF mirrors that component exactly.
  assert.ok(all.includes('Paying by ACH?'), 'the invitation to ask still prints')
})

test('the closing line always prints', () => {
  assert.ok(joined(INVOICE).includes('Thank you for your business!'))
})

test('the filename names the invoice and the client', () => {
  assert.equal(invoiceFilename(INVOICE), 'Invoice-386-Journey-Church.pdf')
  assert.equal(
    invoiceFilename({ ...INVOICE, client: null, bill_to_snapshot: null }),
    'Invoice-386.pdf',
  )
})
