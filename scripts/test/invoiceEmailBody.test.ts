// The prefill (buildInvoiceEmailDefaults) and the final assembly
// (assembleInvoiceEmail) are pure, so the wording, the figures, the
// ABSENCE of bank details, and the appended link are all testable here
// with no network and no API key.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildInvoiceEmailDefaults, assembleInvoiceEmail } from '../../lib/invoiceEmailBody.ts'
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
  client: {
    name: 'Journey Church', address_line1: null, address_line2: null,
    city: null, state: null, postal_code: null,
  },
  lines: [{
    id: 'l1',
    description: 'Audio Training/Maintenance',
    qty_hundredths: 100,
    unit_price_cents: 50000,
    line_total_cents: 50000,
  }],
  settings: SETTINGS,
}

const URL = 'https://billing.theaudiosmith.com/i/11111111-2222-3333-4444-555555555555'

test('the default subject and body name the LEGAL entity, not the trading name', () => {
  const { subject, body } = buildInvoiceEmailDefaults({ invoice: INVOICE, status: 'sent' })
  assert.ok(subject.includes('386'), 'the invoice number is in the subject')
  assert.ok(subject.includes('Smith Audio, LLC'), 'the legal name is in the subject')
  assert.ok(!subject.includes('The Audio Smith'), 'and the trading name is not')
  assert.ok(body.includes('Smith Audio, LLC'), 'the legal name is in the body')
  assert.ok(!body.includes('The Audio Smith'), 'and the trading name is not')
})

test('the default body carries the amount and the due date but NOT the link', () => {
  const { body } = buildInvoiceEmailDefaults({ invoice: INVOICE, status: 'sent' })
  assert.ok(body.includes(formatUSD(50000)), 'carries $500.00')
  assert.ok(body.includes('9/6/2026'), 'carries the due date')
  assert.ok(!body.includes(URL), 'does not carry the link — that is appended at send')
  assert.ok(!body.includes('View it online'), 'and has no link line at all')
})

test('a paid invoice defaults to receipt wording, no demand and no due date', () => {
  const { subject, body } = buildInvoiceEmailDefaults({ invoice: INVOICE, status: 'paid' })
  assert.ok(subject.startsWith('Receipt for invoice'), 'the subject reads as a receipt')
  assert.ok(body.includes('Paid in full'), 'the body says Paid in full')
  assert.ok(body.includes(formatUSD(50000)), 'still carries the amount')
  assert.ok(!body.includes('Amount due'), 'does not demand payment')
  assert.ok(!body.includes('Due:'), 'has no due date line')
  assert.ok(!body.includes('Payment'), 'carries no Payment/remit-to block')
})

test('the default amount is the stored total, not a recomputed one', () => {
  const withDeposit: DocumentData = {
    ...INVOICE, subtotal_cents: 688394, deposit_cents: 585000, total_cents: 103394,
  }
  const { body } = buildInvoiceEmailDefaults({ invoice: withDeposit, status: 'sent' })
  assert.ok(body.includes(formatUSD(103394)), 'the amount is the stored total, $1,033.94')
  assert.ok(!body.includes(formatUSD(688394)), 'not the subtotal')
})

test('bank details can never reach the default body', () => {
  const leaky = {
    ...INVOICE,
    settings: { ...SETTINGS, ach_details: 'Routing 071000013 Account 1234567890' },
  } as unknown as DocumentData
  const { body } = buildInvoiceEmailDefaults({ invoice: leaky, status: 'sent' })
  // Positive control first: remit_to is the payment detail that DOES belong,
  // so the two absence checks below prove something only because this passes.
  assert.ok(body.includes(SETTINGS.remit_to as string), 'remit_to still prints')
  assert.ok(!body.includes('071000013'), 'no routing number')
  assert.ok(!body.includes('1234567890'), 'no account number')
})

// The JOB name in the subject and the opener. Dan was typing this in by hand
// on every send (2026-09-02): "Invoice #392" alone does not tell a client with
// several jobs in flight which one this is. Source is `work_for`, the
// invoice's own "For" field. The INVOICE fixture above deliberately has none,
// so every test that predates this still exercises the degraded path.

const FOR_JOB: DocumentData = { ...INVOICE, number: 392, work_for: 'PwC ALC EU&R' }

test('the subject names the job after the invoice and the business', () => {
  const { subject } = buildInvoiceEmailDefaults({ invoice: FOR_JOB, status: 'sent' })
  assert.equal(subject, 'Invoice #392 from Smith Audio, LLC - PwC ALC EU&R')
})

test('the body opens by thanking the client for that job by name', () => {
  const { body } = buildInvoiceEmailDefaults({ invoice: FOR_JOB, status: 'sent' })
  assert.ok(body.startsWith('Hello!\n\nThanks for having me on PwC ALC EU&R. ' +
    'Please find the invoice attached.'), body.slice(0, 120))
})

test('the whole default body reads in the order Dan wants it', () => {
  // A golden test, not a set of includes: the ORDER is the thing he asked
  // for, and an includes-only test would pass with the greeting at the end.
  const { body } = buildInvoiceEmailDefaults({ invoice: FOR_JOB, status: 'sent' })
  assert.equal(body, [
    'Hello!',
    '',
    'Thanks for having me on PwC ALC EU&R. Please find the invoice attached.',
    '',
    'Invoice #392 from Smith Audio, LLC',
    '',
    'Amount due: $500.00',
    'Due: 9/6/2026',
    '',
    'Payment',
    'Smith Audio, LLC\n2610 Melbourne Lane',
    '',
    'Thank you for your business!',
  ].join('\n'))
})

test('a hand-written invoice with no job degrades to the old wording', () => {
  // #387 in prod has work_for null. No dangling dash in the subject, and no
  // sentence about a job that does not exist — the greeting still stands.
  const { subject, body } = buildInvoiceEmailDefaults({ invoice: INVOICE, status: 'sent' })
  assert.equal(subject, 'Invoice #386 from Smith Audio, LLC')
  assert.ok(!subject.includes(' - '), 'no trailing dash with nothing after it')
  assert.ok(body.startsWith('Hello!\n\nPlease find the invoice attached.'), body.slice(0, 80))
  assert.ok(!body.includes('Thanks for having me on'), 'no thanks for an unnamed job')
})

test('a whitespace-only For field counts as no job, not an empty one', () => {
  const blank: DocumentData = { ...INVOICE, work_for: '   ' }
  const { subject, body } = buildInvoiceEmailDefaults({ invoice: blank, status: 'sent' })
  assert.equal(subject, 'Invoice #386 from Smith Audio, LLC')
  assert.ok(!body.includes('Thanks for having me on'))
})

test('a receipt says the RECEIPT is attached, never the invoice', () => {
  // Telling someone who has already paid to find the invoice attached reads
  // as a second demand for the same money.
  const { subject, body } = buildInvoiceEmailDefaults({ invoice: FOR_JOB, status: 'paid' })
  assert.equal(subject, 'Receipt for invoice #392 from Smith Audio, LLC - PwC ALC EU&R')
  assert.ok(body.includes('Please find the receipt attached.'))
  assert.ok(!body.includes('invoice attached'), 'never asks for money already paid')
})

test('assemble appends the link footer to the text and a real anchor to the html', () => {
  const { subject, text, html } = assembleInvoiceEmail({
    subject: 'Invoice #386 from Smith Audio, LLC',
    body: 'Amount due: $500.00',
    publicUrl: URL,
  })
  assert.equal(subject, 'Invoice #386 from Smith Audio, LLC', 'subject passes through')
  assert.ok(
    text.endsWith(`View it online: ${URL}\nA PDF copy is attached.`),
    'the text ends with the appended link and PDF note',
  )
  assert.ok(text.includes('Amount due: $500.00'), 'the body is above the footer')
  assert.ok(html.includes(`<a href="${URL}">`), 'the html link is a real anchor')
  assert.ok(html.includes('A PDF copy is attached.'), 'the html notes the attachment')
})

test('the html escapes whatever Dan typed into the body', () => {
  const { html } = assembleInvoiceEmail({
    subject: 'x', body: '<script>alert(1)</script>', publicUrl: URL,
  })
  assert.ok(!html.includes('<script>'), 'the raw tag never survives into the html')
  assert.ok(html.includes('&lt;script&gt;'), 'it is escaped instead')
})

test('an empty body still produces a footer-only email with no leading blank lines', () => {
  const { text, html } = assembleInvoiceEmail({ subject: 'x', body: '   ', publicUrl: URL })
  assert.equal(text, `View it online: ${URL}\nA PDF copy is attached.`, 'text is footer only')
  assert.ok(!text.startsWith('\n'), 'no leading blank line')
  assert.ok(!html.includes('<div style="margin:0 0 16px"></div>'), 'no empty body block')
})
