import 'server-only'
// buildDigestEmail and buildOverdueAlertEmail: the two emails Dan gets — a
// weekly digest, and a one-off note the first morning an invoice goes late.
// Both link to the authenticated invoice screen, never the client-facing
// /i/<token> link, and neither is ever passed settings — see the "no ACH
// block" test below.
//
// sendReminderEmail itself is a generic sender, not owner-only: it is also
// used by sendClientReminder (app/invoices/actions.ts) to nudge a client
// about one invoice. Its from-name and reply-to are parameters for exactly
// that reason — the digest and the alert stick to their defaults, the client
// nudge overrides both from Settings.
//
// SERVER ONLY — sendReminderEmail reads RESEND_API_KEY. Never import that from
// a client component. The two BUILDERS are pure and safe anywhere.
//
// The Resend client is constructed per call and the environment is read at call
// time, for the reason recorded in lib/invoiceEmail.ts: a module-scope client
// throws during next build wherever the key is absent.

import { formatUSD } from './money.ts'
import { formatDateLong } from './dates.ts'
import { escapeHtml } from './invoiceEmailBody.ts'
import type { Sweep, ReminderInvoice } from './reminders.ts'

/** Strip a trailing slash so callers can hand this either shape of APP_URL. */
const trimSlash = (url: string) => url.replace(/\/+$/, '')

const line = (inv: ReminderInvoice, appUrl: string) =>
  `#${inv.number} · ${inv.client_name} · ${formatUSD(inv.total_cents)} · due ${formatDateLong(inv.due_date)}\n` +
  `  ${appUrl}/invoices/${inv.id}`

const htmlLine = (inv: ReminderInvoice, appUrl: string) =>
  `<li style="margin:0 0 8px">` +
  `<a href="${escapeHtml(appUrl)}/invoices/${escapeHtml(inv.id)}"><strong>#${inv.number}</strong></a> · ` +
  `${escapeHtml(inv.client_name)} · <strong>${formatUSD(inv.total_cents)}</strong> · ` +
  `due ${formatDateLong(inv.due_date)}</li>`

export function buildDigestEmail(s: Sweep, appUrl: string) {
  const url = trimSlash(appUrl)

  // Quiet means nothing is outstanding at all — every bucket empty, not just
  // the ones worth chasing. s.later is real money, just not due yet, and
  // omitting it from this check is exactly what made the subject line lie:
  // it let a digest with $9,993.14 open call itself quiet.
  const quiet = s.overdue.length === 0 && s.dueSoon.length === 0 && s.later.length === 0
  const nothingChaseableYet = !quiet && s.overdue.length === 0 && s.dueSoon.length === 0

  const subject = quiet
    ? 'Invoices: nothing outstanding'
    : nothingChaseableYet
      ? `Invoices: ${formatUSD(s.totalOutstandingCents)} outstanding, nothing due yet`
      : `Invoices: ${s.overdue.length} overdue, ${s.dueSoon.length} due soon`

  const textParts: string[] = []
  const htmlParts: string[] = []

  if (quiet) {
    textParts.push('Nothing outstanding — 0 open invoices.')
    htmlParts.push('<p style="margin:0 0 16px">Nothing outstanding — 0 open invoices.</p>')
  } else {
    if (s.overdue.length) {
      textParts.push('OVERDUE', ...s.overdue.map((i) => line(i, url)), '')
      htmlParts.push(
        '<p style="margin:0 0 4px;font-weight:bold">Overdue</p>',
        `<ul style="margin:0 0 16px;padding-left:18px">${s.overdue.map((i) => htmlLine(i, url)).join('')}</ul>`,
      )
    }
    if (s.dueSoon.length) {
      textParts.push('DUE SOON', ...s.dueSoon.map((i) => line(i, url)), '')
      htmlParts.push(
        '<p style="margin:0 0 4px;font-weight:bold">Due soon</p>',
        `<ul style="margin:0 0 16px;padding-left:18px">${s.dueSoon.map((i) => htmlLine(i, url)).join('')}</ul>`,
      )
    }
    if (s.later.length) {
      textParts.push('ALSO OUTSTANDING', ...s.later.map((i) => line(i, url)), '')
      htmlParts.push(
        '<p style="margin:0 0 4px;font-weight:bold">Also outstanding</p>',
        `<ul style="margin:0 0 16px;padding-left:18px">${s.later.map((i) => htmlLine(i, url)).join('')}</ul>`,
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
  const url = trimSlash(appUrl)
  const subject = `Invoice #${inv.number} is now overdue`
  const text = [
    `#${inv.number} · ${inv.client_name} · ${formatUSD(inv.total_cents)}`,
    `Was due ${formatDateLong(inv.due_date)}.`,
    '',
    `${url}/invoices/${inv.id}`,
  ].join('\n')
  const html =
    '<div style="font-family:system-ui,-apple-system,sans-serif;font-size:14px;color:#121212;line-height:1.5">' +
    `<p style="margin:0 0 8px"><strong>#${inv.number}</strong> · ${escapeHtml(inv.client_name)} · ` +
    `<strong>${formatUSD(inv.total_cents)}</strong></p>` +
    `<p style="margin:0 0 16px">Was due ${formatDateLong(inv.due_date)}.</p>` +
    `<p style="margin:0"><a href="${escapeHtml(url)}/invoices/${escapeHtml(inv.id)}">Open the invoice</a></p>` +
    '</div>'
  return { subject, text, html }
}

export async function sendReminderEmail(
  input: {
    to: string | string[]; subject: string; text: string; html: string
    /** Defaults to the invoice's own reply-to path: nobody replies to Dan's digest. */
    replyTo?: string
    fromName?: string
    /** Client-facing callers pass OWNER_BCC so Dan gets his own copy; the
     *  cron digest and overdue alerts leave it unset — they already go TO
     *  him, and a BCC would double every one. */
    bcc?: string
  },
): Promise<{ error?: string }> {
  const key = process.env.RESEND_API_KEY
  if (!key) return { error: 'Email is not configured yet (RESEND_API_KEY is missing).' }

  const from = process.env.INVOICE_FROM_EMAIL
  if (!from) return { error: 'Email is not configured yet (INVOICE_FROM_EMAIL is missing).' }

  try {
    const { Resend } = await import('resend')
    const { error } = await new Resend(key).emails.send({
      // Falls back to the LEGAL name. Client-facing mail routed through here is
      // read by an accounts-payable clerk who has that name on file, not the
      // trading name.
      from: `${input.fromName ?? 'Smith Audio, LLC'} <${from}>`,
      to: input.to,
      ...(input.bcc ? { bcc: input.bcc } : {}),
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
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
