// The invoice email BODY — subject, text and html only.
//
// Deliberately free of server-only dependencies: no `resend`, no
// `process.env`, nothing that only runs on the server. That is what lets
// components/SendInvoicePanel.tsx ('use client') import
// buildInvoiceEmailDefaults directly to prefill Dan's editable fields —
// importing lib/invoiceEmail.ts instead would drag the resend SDK (and the
// SERVER ONLY module it lives in) into the browser bundle.
//
// Build and send are separate so the wording, the figures and the absence of
// bank details are unit-testable without a network or an API key.
//
// No JSX and no '@/' imports — this module is exercised by node --test.

import { formatUSD } from './money.ts'
import { formatDateLong } from './dates.ts'
import type { DocumentData } from '../components/InvoiceDocument.tsx'

export type InvoiceEmailInput = {
  /** Validated recipients. Resend accepts several; parsed by the caller. */
  to: string[]
  /** Dan's (possibly edited) subject. */
  subject: string
  /** Dan's (possibly edited) plain-text body, WITHOUT the link footer. */
  body: string
  /** Carries the settings (From legal name) and number (attachment filename). */
  invoice: DocumentData
  /** Absolute URL of the public copy. Must be absolute — this is an email. */
  publicUrl: string
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

// The FINAL assembly, shared by the invoice send and the client reminder. Takes
// the (possibly edited) subject and body plus the server-minted public URL, and
// appends the link footer — always, at the end, after whatever the sender wrote,
// so no edit can drop it. The "A PDF copy is attached." line is emitted only
// when pdfAttached is true (the invoice attaches one; a reminder does not). The
// html is built from the plain-text body: every line escaped, newlines to <br>,
// then the link as a real anchor. Pure string work; it never formats a date.
export function assembleEmail(input: {
  subject: string
  body: string
  publicUrl: string
  pdfAttached: boolean
}): { subject: string; text: string; html: string } {
  const { subject, body, publicUrl, pdfAttached } = input
  const trimmed = body.replace(/\s+$/, '')

  const footerLines = [`View it online: ${publicUrl}`]
  if (pdfAttached) footerLines.push('A PDF copy is attached.')
  const footerText = footerLines.join('\n')
  const text = trimmed ? `${trimmed}\n\n${footerText}` : footerText

  const safeBody = escapeHtml(trimmed).replace(/\n/g, '<br>')
  const html =
    `<div style="font-family:system-ui,-apple-system,sans-serif;font-size:14px;color:#121212;line-height:1.5">` +
    (trimmed ? `<div style="margin:0 0 16px">${safeBody}</div>` : '') +
    `<p style="margin:0 0 16px"><a href="${escapeHtml(publicUrl)}">View this invoice online</a></p>` +
    (pdfAttached ? `<p style="margin:0">A PDF copy is attached.</p>` : '') +
    `</div>`
  return { subject, text, html }
}

// The invoice send always attaches a PDF. Kept as a named wrapper so its
// callers (lib/invoiceEmail.ts) and tests read as before.
export function assembleInvoiceEmail(input: {
  subject: string
  body: string
  publicUrl: string
}): { subject: string; text: string; html: string } {
  return assembleEmail({ ...input, pdfAttached: true })
}
