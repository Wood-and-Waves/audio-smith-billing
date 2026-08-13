// buildInvoiceEmail is pure, so the wording, the figures and — most
// importantly — the ABSENCE of bank details are all testable here without a
// network, an API key, or any risk of a message actually leaving.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildInvoiceEmail, type InvoiceEmailInput } from '../../lib/invoiceEmailBody.ts'
import { sendInvoiceEmail } from '../../lib/invoiceEmail.ts'
import { formatUSD } from '../../lib/money.ts'
import type { DocumentData } from '../../components/InvoiceDocument.tsx'

const SETTINGS: DocumentData['settings'] = {
  business_name: 'The Audio Smith',
  legal_name: 'Smith Audio, LLC',
  address_line1: '2610 Melbourne Lane',
  address_line2: 'Lake in the Hills, IL 60156',
  phone: '269.217.8400',
  email: 'dan@theaudiosmith.com',
  remit_to: 'Smith Audio, LLC\n2610 Melbourne Lane',
}

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

const BASE: InvoiceEmailInput = {
  to: 'accounts@journey.example',
  invoice: INVOICE,
  publicUrl: 'https://billing.theaudiosmith.com/i/11111111-2222-3333-4444-555555555555',
  note: null,
  replyTo: 'dan@theaudiosmith.com',
}

test('the subject names the invoice and the business', () => {
  const { subject } = buildInvoiceEmail(BASE)
  assert.ok(subject.includes('386'), 'the invoice number is in the subject')
  assert.ok(subject.includes('The Audio Smith'), 'the business is in the subject')
})

test('both bodies carry the amount, the due date and the link', () => {
  const { text, html } = buildInvoiceEmail(BASE)
  for (const [name, body] of [['text', text], ['html', html]] as const) {
    assert.ok(body.includes(formatUSD(50000)), `${name} carries $500.00`)
    assert.ok(body.includes('9/6/2026'), `${name} carries the due date`)
    assert.ok(body.includes(BASE.publicUrl), `${name} carries the link`)
  }
})

test('the amount is formatUSD of the stored total, not a recomputed one', () => {
  // A total that disagrees with its own lines, the way a deposit invoice does.
  const withDeposit: InvoiceEmailInput = {
    ...BASE,
    invoice: { ...INVOICE, subtotal_cents: 688394, deposit_cents: 585000, total_cents: 103394 },
  }
  const { text } = buildInvoiceEmail(withDeposit)
  assert.ok(text.includes(formatUSD(103394)), 'the amount due is the stored total, $1,033.94')
  assert.ok(!text.includes(formatUSD(688394)), 'not the subtotal')
})

test("Dan's note appears when given", () => {
  const { text, html } = buildInvoiceEmail({ ...BASE, note: 'Invoice for the last two visits.' })
  assert.ok(text.includes('Invoice for the last two visits.'))
  assert.ok(html.includes('Invoice for the last two visits.'))
})

test('an empty note leaves no empty paragraph or dangling label behind', () => {
  const withEmpty = buildInvoiceEmail({ ...BASE, note: '   ' })
  const withNull = buildInvoiceEmail({ ...BASE, note: null })
  assert.equal(withEmpty.text, withNull.text, 'whitespace-only reads the same as none')
  assert.equal(withEmpty.html, withNull.html)
  assert.ok(!withNull.html.includes('<p></p>'), 'no empty paragraph')
  assert.ok(!/\n\n\n/.test(withNull.text), 'no triple blank line')
})

test('bank details can never reach either body', () => {
  // ach_details is not part of DocumentData. This attaches it the way a
  // careless widening of the type would, and proves the builder still does not
  // print it. The type is the real guard; this catches its removal.
  const leaky: InvoiceEmailInput = {
    ...BASE,
    invoice: {
      ...INVOICE,
      settings: { ...SETTINGS, ach_details: 'Routing 071000013 Account 1234567890' },
    } as unknown as DocumentData,
  }
  const { text, html } = buildInvoiceEmail(leaky)
  for (const body of [text, html]) {
    assert.ok(!body.includes('071000013'), 'no routing number')
    assert.ok(!body.includes('1234567890'), 'no account number')
  }
})

test('the html body escapes anything a client name could carry', () => {
  const nasty: InvoiceEmailInput = {
    ...BASE,
    note: '<script>alert(1)</script>',
  }
  const { html } = buildInvoiceEmail(nasty)
  assert.ok(!html.includes('<script>'), 'the raw tag never survives into the html')
  assert.ok(html.includes('&lt;script&gt;'), 'it is escaped instead')
})

test('a malformed date makes the send return an error, never throw', async () => {
  // sendInvoiceEmail promises to return { error } rather than throw, so that a
  // failed send never loses the record of what was being sent. formatDateLong
  // throws a RangeError on an unparseable date, so building the body has to
  // happen inside the try — this pins that.
  const prevKey = process.env.RESEND_API_KEY
  const prevFrom = process.env.INVOICE_FROM_EMAIL
  process.env.RESEND_API_KEY = 'dummy-test-key'
  process.env.INVOICE_FROM_EMAIL = 'dan@theaudiosmith.com'
  try {
    const broken = {
      ...BASE,
      invoice: { ...INVOICE, due_date: 'not-a-date' },
      pdf: Buffer.from(''),
    }
    const result = await sendInvoiceEmail(broken)
    assert.ok(result.error, 'it returned an error instead of throwing')
  } finally {
    if (prevKey === undefined) delete process.env.RESEND_API_KEY
    else process.env.RESEND_API_KEY = prevKey
    if (prevFrom === undefined) delete process.env.INVOICE_FROM_EMAIL
    else process.env.INVOICE_FROM_EMAIL = prevFrom
  }
})
