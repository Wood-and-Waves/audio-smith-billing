import 'server-only'
// Sending the invoice email.
//
// SERVER ONLY — sendInvoiceEmail reads RESEND_API_KEY. Never import this from a
// client component. The pure body (subject/text/html) lives in
// lib/invoiceEmailBody.ts specifically so a client component CAN import that
// half for a preview without pulling this one — and the resend SDK inside
// it — into the browser bundle.
//
// The send returns { error } rather than throwing, so a failed email never
// destroys the record of what was being sent.
//
// The Resend client is constructed PER CALL, never at module scope: a top-level
// `new Resend(...)` throws during `next build` wherever the key is absent, which
// broke every CrewTracker preview deployment until 2026-07-27. Environment
// variables are read at call time for the same reason.
//
// No JSX and no '@/' imports — this module is exercised by node --test.

import { assembleInvoiceEmail, type InvoiceEmailInput } from './invoiceEmailBody.ts'
import { invoiceFilename } from './invoicePdf.ts'

// Re-exported so existing callers (e.g. the test suite) that imported this
// type from here keep working.
export type { InvoiceEmailInput }

/** Dan's own copy of every client-facing email (2026-08-20, his ask). Also
 *  imported by the reminder send in app/invoices/actions.ts — one address,
 *  one place to change it. */
export const OWNER_BCC = 'dan@theaudiosmith.com'

export async function sendInvoiceEmail(
  input: InvoiceEmailInput & { pdf: Buffer },
): Promise<{ error?: string }> {
  const key = process.env.RESEND_API_KEY
  if (!key) return { error: 'Email is not configured yet (RESEND_API_KEY is missing).' }

  const from = process.env.INVOICE_FROM_EMAIL
  if (!from) return { error: 'Email is not configured yet (INVOICE_FROM_EMAIL is missing).' }

  // The business lookup and assembleInvoiceEmail live inside this try, not
  // just the network call: buildInvoiceEmailDefaults (called by the caller,
  // at prefill) formats the due date, and formatDateLong throws a RangeError
  // on an unparseable date. This function's whole contract is to return
  // { error } and never throw, so anything that can throw on a bad row has
  // to be in here too.
  try {
    // The legal name, matching the subject and body — this is the sender name
    // an accounts-payable clerk sees in their inbox list, and it has to be the
    // one they have on file.
    const business = input.invoice.settings?.legal_name ?? 'Smith Audio, LLC'
    const { subject, text, html } = assembleInvoiceEmail({
      subject: input.subject,
      body: input.body,
      publicUrl: input.publicUrl,
    })

    const { Resend } = await import('resend')
    const { error } = await new Resend(key).emails.send({
      from: `${business} <${from}>`,
      to: input.to,
      // Every client-facing email lands in Dan's inbox too — his own copy of
      // exactly what the client received, without relying on Resend's logs.
      // The cron digest and overdue alerts don't carry this: they already go
      // TO him.
      bcc: OWNER_BCC,
      replyTo: input.replyTo,
      subject,
      text,
      html,
      attachments: [{
        filename: invoiceFilename(input.invoice),
        content: input.pdf,
      }],
    })
    if (error) return { error: error.message }
    return {}
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'The email could not be sent.' }
  }
}
