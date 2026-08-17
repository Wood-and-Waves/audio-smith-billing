// buildReminderDefaults and the shared assembleEmail are pure — the reminder
// wording, the figures, the absence of a PDF line, and the appended link are
// all testable here with no network and no key.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assembleEmail, assembleInvoiceEmail } from '../../lib/invoiceEmailBody.ts'
import { buildReminderDefaults } from '../../lib/reminderEmailBody.ts'
import { formatUSD } from '../../lib/money.ts'

const URL = 'https://billing.theaudiosmith.com/i/11111111-2222-3333-4444-555555555555'

test('reminder defaults: subject names the invoice and legal entity', () => {
  const { subject } = buildReminderDefaults({
    number: 386, total_cents: 50000, due_date: '2026-09-06', legalName: 'Smith Audio, LLC',
  })
  assert.equal(subject, 'Reminder: invoice #386 from Smith Audio, LLC')
})

test('reminder defaults: body carries the amount and due date, but no link', () => {
  const { body } = buildReminderDefaults({
    number: 386, total_cents: 50000, due_date: '2026-09-06', legalName: 'Smith Audio, LLC',
  })
  assert.ok(body.includes('A friendly reminder about invoice #386.'), 'the nudge line')
  assert.ok(body.includes(formatUSD(50000)), 'carries $500.00')
  assert.ok(body.includes('9/6/2026'), 'carries the due date')
  assert.ok(!body.includes('View it online'), 'no link line — appended at send')
  assert.ok(!body.includes(URL), 'no url')
})

test('assembleEmail without a PDF appends only the link, no attachment line', () => {
  const { text, html } = assembleEmail({
    subject: 'Reminder: invoice #386 from Smith Audio, LLC',
    body: 'A friendly reminder about invoice #386.',
    publicUrl: URL,
    pdfAttached: false,
  })
  assert.ok(text.endsWith(`View it online: ${URL}`), 'text ends with the link, nothing after')
  assert.ok(!text.includes('A PDF copy is attached.'), 'no PDF line in text')
  assert.ok(html.includes(`<a href="${URL}">`), 'html links the url')
  assert.ok(!html.includes('A PDF copy is attached.'), 'no PDF line in html')
})

test('assembleEmail with a PDF still emits the attachment line', () => {
  const { text, html } = assembleEmail({
    subject: 'x', body: 'Amount due: $500.00', publicUrl: URL, pdfAttached: true,
  })
  assert.ok(text.endsWith(`View it online: ${URL}\nA PDF copy is attached.`), 'text keeps the PDF line')
  assert.ok(html.includes('A PDF copy is attached.'), 'html keeps the PDF line')
})

test('assembleInvoiceEmail is assembleEmail with pdfAttached true — identical output', () => {
  const input = { subject: 's', body: 'b', publicUrl: URL }
  assert.deepEqual(
    assembleInvoiceEmail(input),
    assembleEmail({ ...input, pdfAttached: true }),
    'the wrapper must match the pdfAttached:true path exactly',
  )
})

test('assembleEmail escapes the body it is given', () => {
  const { html } = assembleEmail({
    subject: 'x', body: '<script>alert(1)</script>', publicUrl: URL, pdfAttached: false,
  })
  assert.ok(!html.includes('<script>'), 'raw tag never survives')
  assert.ok(html.includes('&lt;script&gt;'), 'escaped instead')
})
