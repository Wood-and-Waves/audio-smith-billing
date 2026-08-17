// The invoice email BODY — subject, text and html only.
//
// Deliberately free of server-only dependencies: no `resend`, no
// `process.env`, nothing that only runs on the server. That is what lets
// components/SendInvoicePanel.tsx ('use client') import buildInvoiceEmail
// directly to render a live preview — importing lib/invoiceEmail.ts instead
// would drag the resend SDK (and the SERVER ONLY module it lives in) into
// the browser bundle.
//
// Build and send are separate so the wording, the figures and the absence of
// bank details are unit-testable without a network or an API key.
//
// No JSX and no '@/' imports — this module is exercised by node --test.

import { formatUSD } from './money.ts'
import { formatDateLong } from './dates.ts'
import type { DocumentData } from '../components/InvoiceDocument.tsx'

export type InvoiceEmailInput = {
  to: string
  invoice: DocumentData
  /**
   * DocumentData carries no status — it's what the page and the PDF render,
   * and neither needs to know. The email body does: the design deliberately
   * allows resending a paid invoice, and a paid invoice must read as a
   * receipt, not as a demand for money already received. Every caller reads
   * this off the real row, never assumes it.
   */
  status: 'draft' | 'sent' | 'paid' | 'void'
  /** Absolute URL of the public copy. Must be absolute — this is an email. */
  publicUrl: string
  /** Dan's per-send message. May be null, empty, or whitespace. */
  note: string | null
  replyTo: string
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function buildInvoiceEmail(input: InvoiceEmailInput) {
  const { invoice, publicUrl, status } = input
  // The LEGAL name, not the trading name. This email is read by a client's
  // accounts-payable clerk, who has "Smith Audio, LLC" on file and has very
  // likely never heard of "The Audio Smith". The PDF keeps the trading name in
  // its wordmark — that is branding on a document; this is identification in an
  // inbox.
  const business = invoice.settings?.legal_name ?? 'Smith Audio, LLC'
  const amount = formatUSD(invoice.total_cents)
  const note = input.note?.trim() || null
  const isReceipt = status === 'paid'

  const subject = isReceipt
    ? `Receipt for invoice #${invoice.number} from ${business}`
    : `Invoice #${invoice.number} from ${business}`

  // Deliberately NOT settings.ach_details. Bank numbers on a forwarded email
  // are the same exposure as bank numbers on a forwarded PDF; a client who
  // wants to pay by transfer asks, and gets them in a reply.
  //
  // Also deliberately withheld when this is a receipt: a document telling a
  // client their invoice is paid in full has no business printing where to
  // send payment.
  const remit = !isReceipt && (invoice.settings?.remit_to?.trim() || null)

  const textParts = [`Invoice #${invoice.number} from ${business}`, '']
  if (isReceipt) {
    textParts.push(`Paid in full: ${amount}`)
  } else {
    const due = formatDateLong(invoice.due_date)
    textParts.push(`Amount due: ${amount}`, `Due: ${due}`)
  }
  if (note) textParts.push('', note)
  textParts.push('', `View it online: ${publicUrl}`, 'A PDF copy is attached.')
  if (remit) textParts.push('', 'Payment', remit)
  textParts.push('', 'Thank you for your business!')
  const text = textParts.join('\n')

  const htmlParts = [
    `<p style="margin:0 0 16px"><strong>Invoice #${invoice.number}</strong> from ${escapeHtml(business)}</p>`,
  ]
  if (isReceipt) {
    htmlParts.push(
      `<p style="margin:0 0 16px">Paid in full: <strong>${amount}</strong></p>`,
    )
  } else {
    const due = formatDateLong(invoice.due_date)
    htmlParts.push(
      `<p style="margin:0 0 4px">Amount due: <strong>${amount}</strong></p>`,
      `<p style="margin:0 0 16px">Due: ${due}</p>`,
    )
  }
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

// The PREFILL. Subject and a plain-text body Dan edits before sending. The
// body deliberately omits the public link: its token does not exist until
// the server mints it at send, so the link is appended by assembleInvoiceEmail
// (below), never typed. Everything else mirrors what the email used to say —
// amount, due date (or "Paid in full" for a receipt), the remit-to block, the
// thank-you — so an unedited send reads exactly as before, minus the link
// which now lands at the very bottom.
//
// remit_to only, NEVER ach_details — bank numbers on a forwarded email are
// the same exposure as on a forwarded PDF. Withheld entirely on a receipt: a
// document saying "paid in full" has no business printing where to send money.
export function buildInvoiceEmailDefaults(input: {
  invoice: DocumentData
  status: 'draft' | 'sent' | 'paid' | 'void'
}): { subject: string; body: string } {
  const { invoice, status } = input
  const business = invoice.settings?.legal_name ?? 'Smith Audio, LLC'
  const amount = formatUSD(invoice.total_cents)
  const isReceipt = status === 'paid'

  const subject = isReceipt
    ? `Receipt for invoice #${invoice.number} from ${business}`
    : `Invoice #${invoice.number} from ${business}`

  const remit = !isReceipt && (invoice.settings?.remit_to?.trim() || null)

  const parts = [`Invoice #${invoice.number} from ${business}`, '']
  if (isReceipt) {
    parts.push(`Paid in full: ${amount}`)
  } else {
    parts.push(`Amount due: ${amount}`, `Due: ${formatDateLong(invoice.due_date)}`)
  }
  if (remit) parts.push('', 'Payment', remit)
  parts.push('', 'Thank you for your business!')
  return { subject, body: parts.join('\n') }
}

// The FINAL assembly. Takes Dan's (possibly edited) subject and body and the
// server-minted public URL, and produces what actually gets sent. The link
// and the "PDF copy is attached" line are appended here — always, at the end,
// after whatever Dan wrote — so no edit can drop them. The html is built from
// the plain-text body: every line escaped, newlines to <br>, then the link as
// a real anchor. Pure string work; it cannot throw on a bad date because it
// never formats one (buildInvoiceEmailDefaults already did that at prefill).
export function assembleInvoiceEmail(input: {
  subject: string
  body: string
  publicUrl: string
}): { subject: string; text: string; html: string } {
  const { subject, body, publicUrl } = input
  const trimmed = body.replace(/\s+$/, '')

  const footerText = `View it online: ${publicUrl}\nA PDF copy is attached.`
  const text = trimmed ? `${trimmed}\n\n${footerText}` : footerText

  const safeBody = escapeHtml(trimmed).replace(/\n/g, '<br>')
  const html =
    `<div style="font-family:system-ui,-apple-system,sans-serif;font-size:14px;color:#121212;line-height:1.5">` +
    (trimmed ? `<div style="margin:0 0 16px">${safeBody}</div>` : '') +
    `<p style="margin:0 0 16px"><a href="${escapeHtml(publicUrl)}">View this invoice online</a></p>` +
    `<p style="margin:0">A PDF copy is attached.</p>` +
    `</div>`
  return { subject, text, html }
}
