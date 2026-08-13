// The invoice email.
//
// SERVER ONLY — sendInvoiceEmail reads RESEND_API_KEY. Never import this from a
// client component.
//
// Build and send are separate so the wording, the figures and the absence of
// bank details are unit-testable without a network or an API key. The send
// returns { error } rather than throwing, so a failed email never destroys the
// record of what was being sent.
//
// The Resend client is constructed PER CALL, never at module scope: a top-level
// `new Resend(...)` throws during `next build` wherever the key is absent, which
// broke every CrewTracker preview deployment until 2026-07-27. Environment
// variables are read at call time for the same reason.
//
// No JSX and no '@/' imports — this module is exercised by node --test.

import { formatUSD } from './money.ts'
import { formatDateLong } from './dates.ts'
import type { DocumentData } from '../components/InvoiceDocument.tsx'

export type InvoiceEmailInput = {
  to: string
  invoice: DocumentData
  /** Absolute URL of the public copy. Must be absolute — this is an email. */
  publicUrl: string
  /** Dan's per-send message. May be null, empty, or whitespace. */
  note: string | null
  replyTo: string
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function buildInvoiceEmail(input: InvoiceEmailInput) {
  const { invoice, publicUrl } = input
  const business = invoice.settings?.business_name ?? 'The Audio Smith'
  const amount = formatUSD(invoice.total_cents)
  const due = formatDateLong(invoice.due_date)
  const note = input.note?.trim() || null

  const subject = `Invoice #${invoice.number} from ${business}`

  // Deliberately NOT settings.ach_details. Bank numbers on a forwarded email
  // are the same exposure as bank numbers on a forwarded PDF; a client who
  // wants to pay by transfer asks, and gets them in a reply.
  const remit = invoice.settings?.remit_to?.trim() || null

  const textParts = [
    `Invoice #${invoice.number} from ${business}`,
    '',
    `Amount due: ${amount}`,
    `Due: ${due}`,
  ]
  if (note) textParts.push('', note)
  textParts.push('', `View it online: ${publicUrl}`, 'A PDF copy is attached.')
  if (remit) textParts.push('', 'Payment', remit)
  textParts.push('', 'Thank you for your business!')
  const text = textParts.join('\n')

  const htmlParts = [
    `<p style="margin:0 0 16px"><strong>Invoice #${invoice.number}</strong> from ${escapeHtml(business)}</p>`,
    `<p style="margin:0 0 4px">Amount due: <strong>${amount}</strong></p>`,
    `<p style="margin:0 0 16px">Due: ${due}</p>`,
  ]
  if (note) {
    htmlParts.push(
      `<p style="margin:0 0 16px;white-space:pre-line">${escapeHtml(note)}</p>`,
    )
  }
  htmlParts.push(
    `<p style="margin:0 0 16px"><a href="${escapeHtml(publicUrl)}">View this invoice online</a></p>`,
    '<p style="margin:0 0 16px">A PDF copy is attached.</p>',
  )
  if (remit) {
    htmlParts.push(
      '<p style="margin:0 0 4px;font-size:12px;color:#525252">Payment</p>',
      `<p style="margin:0 0 16px;font-size:12px;color:#525252;white-space:pre-line">${escapeHtml(remit)}</p>`,
    )
  }
  htmlParts.push(
    '<p style="margin:0;font-size:12px;color:#737373">Thank you for your business!</p>',
  )
  const html =
    `<div style="font-family:system-ui,-apple-system,sans-serif;font-size:14px;color:#121212;line-height:1.5">` +
    htmlParts.join('') +
    '</div>'

  return { subject, text, html }
}

export async function sendInvoiceEmail(
  input: InvoiceEmailInput & { pdf: Buffer },
): Promise<{ error?: string }> {
  const key = process.env.RESEND_API_KEY
  if (!key) return { error: 'Email is not configured yet (RESEND_API_KEY is missing).' }

  const from = process.env.INVOICE_FROM_EMAIL
  if (!from) return { error: 'Email is not configured yet (INVOICE_FROM_EMAIL is missing).' }

  const business = input.invoice.settings?.business_name ?? 'The Audio Smith'
  const { subject, text, html } = buildInvoiceEmail(input)

  try {
    const { Resend } = await import('resend')
    const { error } = await new Resend(key).emails.send({
      from: `${business} <${from}>`,
      to: input.to,
      replyTo: input.replyTo,
      subject,
      text,
      html,
      attachments: [{
        filename: `Invoice-${input.invoice.number}.pdf`,
        content: input.pdf,
      }],
    })
    if (error) return { error: error.message }
    return {}
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'The email could not be sent.' }
  }
}
