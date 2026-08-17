// sendInvoiceEmail promises to return { error } rather than throw, so a failed
// send never loses the record of what was being sent. The pure body building
// is tested in invoiceEmailBody.test.ts; this pins the network-failure
// contract of the server sender itself.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sendInvoiceEmail } from '../../lib/invoiceEmail.ts'
import type { InvoiceEmailInput } from '../../lib/invoiceEmailBody.ts'
import type { DocumentData } from '../../components/InvoiceDocument.tsx'

const INVOICE = {
  number: 386,
  due_date: '2026-09-06',
  total_cents: 50000,
  settings: { legal_name: 'Smith Audio, LLC' },
} as unknown as DocumentData

const BASE: InvoiceEmailInput & { pdf: Buffer } = {
  to: ['accounts@journey.example'],
  subject: 'Invoice #386 from Smith Audio, LLC',
  body: 'Amount due: $500.00',
  invoice: INVOICE,
  publicUrl: 'https://billing.theaudiosmith.com/i/11111111-2222-3333-4444-555555555555',
  replyTo: 'dan@theaudiosmith.com',
  pdf: Buffer.from(''),
}

test('a network failure makes the send return an error, never throw', async () => {
  // The send goes over fetch (Resend's SDK). We force fetch to throw, so this
  // exercises the try/catch's promise of { error } — with two guards that a
  // real POST is never made: a fetch that throws, and a fake key.
  const prevKey = process.env.RESEND_API_KEY
  const prevFrom = process.env.INVOICE_FROM_EMAIL
  const prevFetch = globalThis.fetch
  process.env.RESEND_API_KEY = 'dummy-test-key'
  process.env.INVOICE_FROM_EMAIL = 'test@example.invalid'
  globalThis.fetch = (() => {
    throw new Error('network call attempted in invoiceEmail.test.ts — this test must never reach the network')
  }) as typeof fetch
  try {
    const result = await sendInvoiceEmail(BASE)
    assert.ok(result.error, 'it returned an error instead of throwing')
  } finally {
    if (prevKey === undefined) delete process.env.RESEND_API_KEY
    else process.env.RESEND_API_KEY = prevKey
    if (prevFrom === undefined) delete process.env.INVOICE_FROM_EMAIL
    else process.env.INVOICE_FROM_EMAIL = prevFrom
    globalThis.fetch = prevFetch
  }
})

test('a missing RESEND_API_KEY is reported, not thrown', async () => {
  const prevKey = process.env.RESEND_API_KEY
  delete process.env.RESEND_API_KEY
  try {
    const result = await sendInvoiceEmail(BASE)
    assert.ok(result.error?.includes('RESEND_API_KEY'), 'the missing key is named')
  } finally {
    if (prevKey !== undefined) process.env.RESEND_API_KEY = prevKey
  }
})
