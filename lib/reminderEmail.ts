// The two emails Dan gets: a weekly digest, and a one-off note the first
// morning an invoice goes late.
//
// SERVER ONLY — sendReminderEmail reads RESEND_API_KEY. Never import that from
// a client component. The two BUILDERS are pure and safe anywhere.
//
// These go to Dan, so every link points at the authenticated invoice screen.
// The public /i/<token> link is for clients and has no business here.
//
// The Resend client is constructed per call and the environment is read at call
// time, for the reason recorded in lib/invoiceEmail.ts: a module-scope client
// throws during next build wherever the key is absent.

import { formatUSD } from './money.ts'
import { formatDateLong } from './dates.ts'
import { escapeHtml } from './invoiceEmailBody.ts'
import type { Sweep, ReminderInvoice } from './reminders.ts'

const line = (inv: ReminderInvoice, appUrl: string) =>
  `#${inv.number} · ${inv.client_name} · ${formatUSD(inv.total_cents)} · due ${formatDateLong(inv.due_date)}\n` +
  `  ${appUrl}/invoices/${inv.id}`

const htmlLine = (inv: ReminderInvoice, appUrl: string) =>
  `<li style="margin:0 0 8px">` +
  `<a href="${escapeHtml(appUrl)}/invoices/${escapeHtml(inv.id)}"><strong>#${inv.number}</strong></a> · ` +
  `${escapeHtml(inv.client_name)} · <strong>${formatUSD(inv.total_cents)}</strong> · ` +
  `due ${formatDateLong(inv.due_date)}</li>`

export function buildDigestEmail(s: Sweep, appUrl: string) {
  const quiet = s.overdue.length === 0 && s.dueSoon.length === 0

  const subject = quiet
    ? 'Invoices: nothing outstanding'
    : `Invoices: ${s.overdue.length} overdue, ${s.dueSoon.length} due soon`

  const textParts: string[] = []
  const htmlParts: string[] = []

  if (quiet) {
    textParts.push('Nothing outstanding — 0 open invoices.')
    htmlParts.push('<p style="margin:0 0 16px">Nothing outstanding — 0 open invoices.</p>')
  } else {
    if (s.overdue.length) {
      textParts.push('OVERDUE', ...s.overdue.map((i) => line(i, appUrl)), '')
      htmlParts.push(
        '<p style="margin:0 0 4px;font-weight:bold">Overdue</p>',
        `<ul style="margin:0 0 16px;padding-left:18px">${s.overdue.map((i) => htmlLine(i, appUrl)).join('')}</ul>`,
      )
    }
    if (s.dueSoon.length) {
      textParts.push('DUE SOON', ...s.dueSoon.map((i) => line(i, appUrl)), '')
      htmlParts.push(
        '<p style="margin:0 0 4px;font-weight:bold">Due soon</p>',
        `<ul style="margin:0 0 16px;padding-left:18px">${s.dueSoon.map((i) => htmlLine(i, appUrl)).join('')}</ul>`,
      )
    }
    textParts.push(`Outstanding: ${formatUSD(s.totalOutstandingCents)}`)
    htmlParts.push(
      `<p style="margin:0">Outstanding: <strong>${formatUSD(s.totalOutstandingCents)}</strong></p>`,
    )
  }

  return {
    subject,
    text: textParts.join('\n'),
    html:
      '<div style="font-family:system-ui,-apple-system,sans-serif;font-size:14px;color:#121212;line-height:1.5">' +
      htmlParts.join('') +
      '</div>',
  }
}

export function buildOverdueAlertEmail(inv: ReminderInvoice, appUrl: string) {
  const subject = `Invoice #${inv.number} is now overdue`
  const text = [
    `#${inv.number} · ${inv.client_name} · ${formatUSD(inv.total_cents)}`,
    `Was due ${formatDateLong(inv.due_date)}.`,
    '',
    `${appUrl}/invoices/${inv.id}`,
  ].join('\n')
  const html =
    '<div style="font-family:system-ui,-apple-system,sans-serif;font-size:14px;color:#121212;line-height:1.5">' +
    `<p style="margin:0 0 8px"><strong>#${inv.number}</strong> · ${escapeHtml(inv.client_name)} · ` +
    `<strong>${formatUSD(inv.total_cents)}</strong></p>` +
    `<p style="margin:0 0 16px">Was due ${formatDateLong(inv.due_date)}.</p>` +
    `<p style="margin:0"><a href="${escapeHtml(appUrl)}/invoices/${escapeHtml(inv.id)}">Open the invoice</a></p>` +
    '</div>'
  return { subject, text, html }
}

export async function sendReminderEmail(
  input: { to: string; subject: string; text: string; html: string },
): Promise<{ error?: string }> {
  const key = process.env.RESEND_API_KEY
  if (!key) return { error: 'Email is not configured yet (RESEND_API_KEY is missing).' }

  const from = process.env.INVOICE_FROM_EMAIL
  if (!from) return { error: 'Email is not configured yet (INVOICE_FROM_EMAIL is missing).' }

  try {
    const { Resend } = await import('resend')
    const { error } = await new Resend(key).emails.send({
      from: `The Audio Smith <${from}>`,
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html,
    })
    if (error) return { error: error.message }
    return {}
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'The reminder could not be sent.' }
  }
}
