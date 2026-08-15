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

const BASE: InvoiceEmailInput = {
  to: 'accounts@journey.example',
  invoice: INVOICE,
  status: 'sent',
  publicUrl: 'https://billing.theaudiosmith.com/i/11111111-2222-3333-4444-555555555555',
  note: null,
  replyTo: 'dan@theaudiosmith.com',
}

test('the subject and body name the LEGAL entity, not the trading name', () => {
  // A client's accounts-payable clerk has "Smith Audio, LLC" on file and has
  // very likely never heard of "The Audio Smith". The PDF keeps the trading
  // name in its wordmark — that is branding on a document — but the email has
  // to identify the supplier they are actually paying.
  const { subject, text, html } = buildInvoiceEmail(BASE)
  assert.ok(subject.includes('386'), 'the invoice number is in the subject')
  assert.ok(subject.includes('Smith Audio, LLC'), 'the legal name is in the subject')
  assert.ok(!subject.includes('The Audio Smith'), 'and the trading name is not')
  for (const body of [text, html]) {
    assert.ok(body.includes('Smith Audio, LLC'), 'the legal name is in the body')
    assert.ok(!body.includes('The Audio Smith'), 'and the trading name is not')
  }
})

test('both bodies carry the amount, the due date and the link', () => {
  const { text, html } = buildInvoiceEmail(BASE)
  for (const [name, body] of [['text', text], ['html', html]] as const) {
    assert.ok(body.includes(formatUSD(50000)), `${name} carries $500.00`)
    assert.ok(body.includes('9/6/2026'), `${name} carries the due date`)
    assert.ok(body.includes(BASE.publicUrl), `${name} carries the link`)
  }
})

test('a paid invoice reads as a receipt, never a demand for money already received', () => {
  // The design deliberately allows resending a paid invoice, and the panel
  // offers the button on every non-void invoice. A paid invoice must not
  // say "Amount due" with a due date in the past — this is the case that
  // burned invoice #384 (paid, $2,731.01, due 2026-07-14): resending it as
  // written before this fix would have emailed the client a demand for
  // money already paid, with a due date a month in the past.
  const paid: InvoiceEmailInput = { ...BASE, status: 'paid' }
  const { subject, text, html } = buildInvoiceEmail(paid)

  assert.ok(subject.startsWith('Receipt for invoice'), 'the subject reads as a receipt')
  assert.ok(subject.includes('386'), 'the invoice number is still in the subject')

  for (const [name, body] of [['text', text], ['html', html]] as const) {
    assert.ok(body.includes('Paid in full'), `${name} says Paid in full`)
    assert.ok(body.includes(formatUSD(50000)), `${name} still carries the amount`)
    assert.ok(!body.includes('Amount due'), `${name} does not demand payment`)
    assert.ok(!body.includes('Due:'), `${name} has no due date line`)
    assert.ok(!body.includes('9/6/2026'), `${name} does not print the due date at all`)
    assert.ok(!body.includes('Payment'), `${name} carries no Payment/remit-to block`)
    assert.ok(!body.includes(SETTINGS.remit_to!), `${name} does not print remit-to text`)
  }
})

test('a sent or draft invoice keeps the original demand wording', () => {
  // Unchanged behavior, pinned explicitly now that the body branches on
  // status: neither "sent" (the normal case, and a resend of it) nor
  // "draft" should ever read as a receipt.
  for (const status of ['sent', 'draft'] as const) {
    const { subject, text, html } = buildInvoiceEmail({ ...BASE, status })
    assert.ok(!subject.startsWith('Receipt'), `${status}: subject is not a receipt subject`)
    for (const [name, body] of [['text', text], ['html', html]] as const) {
      assert.ok(body.includes('Amount due'), `${status} ${name} still demands payment`)
      assert.ok(body.includes('9/6/2026'), `${status} ${name} still carries the due date`)
      assert.ok(body.includes('Payment'), `${status} ${name} still carries the Payment block`)
    }
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
    // The positive control comes FIRST, and it is not decoration. Without it
    // this test passes just as happily against a builder that returns an empty
    // string — two assertions about what is absent prove nothing unless
    // something is known to be present. remit_to is the right control because
    // it is the payment detail that DOES belong in an invoice email, so it
    // fails the moment the builder stops emitting payment information at all.
    assert.ok(body.includes(SETTINGS.remit_to as string), 'remit_to still prints')
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
  //
  // This test passes today only because that RangeError fires before
  // `new Resend(key).emails.send(...)` is ever reached. That is incidental,
  // not structural — if formatDateLong (or anything upstream of it) ever
  // became lenient about bad dates, this same test would silently start
  // making a real POST to api.resend.com using a fake key, on every `npm
  // test`. Two independent guards against that, so a refactor upstream
  // can't turn this into a live network call:
  //   1. global.fetch is replaced with a function that throws — Resend's SDK
  //      sends over fetch, so this makes an actual network attempt fail
  //      loudly and immediately rather than silently succeed or hang.
  //   2. the assertion below checks the error is the exact RangeError text
  //      from Intl.DateTimeFormat, not merely "an error of some kind" — a
  //      fetch failure or a Resend auth error would read differently, so the
  //      assertion would fail (not pass for the wrong reason) if the code
  //      ever got that far.
  const prevKey = process.env.RESEND_API_KEY
  const prevFrom = process.env.INVOICE_FROM_EMAIL
  const prevFetch = globalThis.fetch
  process.env.RESEND_API_KEY = 'dummy-test-key'
  process.env.INVOICE_FROM_EMAIL = 'test@example.invalid'
  globalThis.fetch = (() => {
    throw new Error('network call attempted in invoiceEmail.test.ts — this test must never reach the network')
  }) as typeof fetch
  try {
    const broken = {
      ...BASE,
      invoice: { ...INVOICE, due_date: 'not-a-date' },
      pdf: Buffer.from(''),
    }
    const result = await sendInvoiceEmail(broken)
    assert.ok(result.error, 'it returned an error instead of throwing')
    assert.equal(
      result.error,
      'Invalid time value',
      'the error is the RangeError from formatting the date, not a network or SDK result',
    )
  } finally {
    if (prevKey === undefined) delete process.env.RESEND_API_KEY
    else process.env.RESEND_API_KEY = prevKey
    if (prevFrom === undefined) delete process.env.INVOICE_FROM_EMAIL
    else process.env.INVOICE_FROM_EMAIL = prevFrom
    globalThis.fetch = prevFetch
  }
})
