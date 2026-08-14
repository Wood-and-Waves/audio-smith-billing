'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { computeTotals, formatUSD } from '@/lib/money'
import { addDays, formatDateLong } from '@/lib/dates'
import { buildInvoicePdf } from '@/lib/invoicePdf'
import { sendInvoiceEmail } from '@/lib/invoiceEmail'
import { sendReminderEmail } from '@/lib/reminderEmail'
import { signedReceiptUrls } from '@/app/expenses/actions'
import type { DocumentData } from '@/components/InvoiceDocument'
import type { ExpenseCategory } from '@/lib/expenses'
import type { BackupSnapshot } from '@/lib/backupSnapshot'

export type LineInput = {
  description: string
  qty_hundredths: number
  unit_price_cents: number
}

export type InvoiceInput = {
  id?: string
  client_id: string
  issue_date: string
  terms_days: number
  deposit_cents: number
  notes: string
  lines: LineInput[]
  // Only billShows (app/shows/actions.ts) ever passes this — a show-derived
  // invoice freezes its hours/expense backup here, at the same moment the
  // invoice itself is created. InvoiceEditor's hand-written invoices have no
  // shows behind them, pass nothing, and store null — a null snapshot
  // renders no backup pages, which is what every invoice billed before
  // migration 0012 already does.
  backupSnapshot?: BackupSnapshot | null
}

export type SaveResult = { error: string } | { ok: true; id: string }

/**
 * The one place an invoice is written. Totals are recomputed here from the
 * line items rather than trusted from the browser — a total that disagrees
 * with its own lines is the worst bug this app could ship.
 */
export async function saveInvoice(input: InvoiceInput): Promise<SaveResult> {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  if (!input.client_id) return { error: 'Choose a client before saving.' }
  const lines = input.lines.filter((l) => l.description.trim() || l.unit_price_cents !== 0)
  if (lines.length === 0) return { error: 'Add at least one line item.' }

  // Tax is hardcoded to zero, not read from the caller: neither renderer
  // (InvoiceDocument.tsx nor invoicePdf.ts) draws a tax row, so any non-zero
  // value here would produce a document whose printed total does not add up
  // to what the client is being asked to pay. See InvoiceInput above — it
  // has no tax_bp field, so no caller can even attempt to pass one.
  const totals = computeTotals(
    lines.map((l) => ({ qtyHundredths: l.qty_hundredths, unitPriceCents: l.unit_price_cents })),
    { taxBasisPoints: 0, depositCents: input.deposit_cents },
  )

  const { data: client } = await supabase
    .from('clients')
    .select('name, address_line1, address_line2')
    .eq('id', input.client_id)
    .maybeSingle()

  // Frozen at save time, so editing a client later can't rewrite an invoice
  // that has already gone out.
  const billTo = [client?.name, client?.address_line1, client?.address_line2]
    .filter(Boolean)
    .join('\n')

  const row = {
    owner_id: user.id,
    client_id: input.client_id,
    issue_date: input.issue_date,
    due_date: addDays(input.issue_date, input.terms_days),
    terms_days: input.terms_days,
    bill_to_snapshot: billTo,
    subtotal_cents: totals.subtotalCents,
    tax_bp: 0,
    tax_cents: totals.taxCents,
    deposit_cents: totals.depositCents,
    total_cents: totals.totalCents,
    notes: input.notes.trim() || null,
  }

  let invoiceId = input.id

  if (invoiceId) {
    // Read the due date this row had BEFORE the update, so it can be compared
    // against the new one below.
    const { data: before } = await supabase
      .from('invoices').select('due_date').eq('id', invoiceId).maybeSingle()

    const { error } = await supabase.from('invoices').update(row).eq('id', invoiceId)
    if (error) return { error: error.message }
    const { error: delError } = await supabase
      .from('invoice_lines')
      .delete()
      .eq('invoice_id', invoiceId)
    if (delError) return { error: delError.message }

    // A new due date is a new deadline, so a new lapse deserves a new alert.
    // Without this, pushing #385 from 8/18 to 9/30 after it has already
    // alerted leaves the old reminder_log row in place, "already alerted"
    // stays true, and the invoice can go overdue again on the new date
    // without ever re-notifying anyone.
    if (before && before.due_date !== row.due_date) {
      const { error: clearError } = await supabase
        .from('reminder_log')
        .delete()
        .eq('invoice_id', invoiceId)
        .eq('kind', 'overdue_alert')
      if (clearError) return { error: clearError.message }
    }
  } else {
    const { data: number, error: numError } = await supabase.rpc('allocate_invoice_number')
    if (numError) return { error: `Couldn't allocate an invoice number: ${numError.message}` }

    const { data: created, error } = await supabase
      .from('invoices')
      // backup_snapshot is set only here, at creation, and left out of `row`
      // (shared with the update branch above) on purpose: an edit made
      // through InvoiceEditor never passes one, and if it were in `row` that
      // edit would silently null out a backup a show already froze in.
      .insert({ ...row, number, status: 'draft', backup_snapshot: input.backupSnapshot ?? null })
      .select('id')
      .single()
    if (error) return { error: error.message }
    invoiceId = created.id
  }

  const { error: lineError } = await supabase.from('invoice_lines').insert(
    lines.map((l, position) => ({
      owner_id: user.id,
      invoice_id: invoiceId,
      position,
      description: l.description.trim(),
      qty_hundredths: l.qty_hundredths,
      unit_price_cents: l.unit_price_cents,
      line_total_cents: Math.round((l.qty_hundredths * l.unit_price_cents) / 100),
    })),
  )
  if (lineError) return { error: lineError.message }

  revalidatePath('/invoices')
  revalidatePath(`/invoices/${invoiceId}`)
  return { ok: true, id: invoiceId! }
}

/** draft -> sent, or sent -> paid. Kept separate from editing on purpose. */
export async function setInvoiceStatus(
  id: string,
  status: 'draft' | 'sent' | 'paid' | 'void',
): Promise<{ error: string } | { ok: true }> {
  const supabase = await createClient()
  const patch: Record<string, unknown> = { status }
  if (status === 'sent') patch.sent_at = new Date().toISOString()

  const { error } = await supabase.from('invoices').update(patch).eq('id', id)
  if (error) return { error: error.message }

  revalidatePath('/invoices')
  revalidatePath(`/invoices/${id}`)
  return { ok: true }
}

/**
 * Emails an invoice: PDF attached, plus a link to the public copy.
 *
 * ORDERING IS DELIBERATE. The status and sent_at are written only AFTER the
 * send succeeds. If that write then fails, Dan has an invoice a client received
 * that the app still calls a draft — visible, and correctable by hand. The
 * reverse order would mark an invoice sent that never left, which nobody would
 * ever notice.
 *
 * draft, sent and paid are all sendable: a draft is the normal case, sending a
 * sent invoice again is a resend, and a paid one is occasionally wanted as a
 * receipt. Only void is refused — a voided invoice must never reach a client.
 */
export async function sendInvoice(
  invoiceId: string, note: string,
): Promise<{ error: string } | { ok: true }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  const appUrl = process.env.APP_URL
  if (!appUrl) return { error: 'Email is not configured yet (APP_URL is missing).' }

  const [{ data: invoice, error: invoiceError }, { data: settings, error: settingsError }] =
    await Promise.all([
      supabase
        .from('invoices')
        .select(
          `id, number, issue_date, due_date, terms_days, status, bill_to_snapshot,
         subtotal_cents, tax_bp, tax_cents, deposit_cents, total_cents, notes, imported,
         public_token, backup_snapshot,
         clients(name, address_line1, address_line2, billing_email),
         invoice_lines(id, position, description, qty_hundredths, unit_price_cents, line_total_cents)`,
        )
        .eq('id', invoiceId)
        .maybeSingle(),
      supabase
        .from('settings')
        // Explicit columns. ach_details must never join this list — it would then
        // travel into the email builder and, from there, to a client.
        .select('business_name, legal_name, address_line1, address_line2, phone, email, remit_to')
        .eq('id', 1)
        .maybeSingle(),
    ])

  if (invoiceError) return { error: invoiceError.message }
  if (!invoice) return { error: 'That invoice no longer exists.' }

  // A degraded document reaching a client is worse than a refusal Dan can
  // retry. If settings failed to load (transient DB error) or came back
  // empty, the PDF would render with no business address, no phone, no
  // email and no Payment footer, and the email would silently fall back to
  // a hardcoded reply-to — a letterhead-less invoice mailed without Dan ever
  // knowing it went out that way. Refuse instead: nothing is sent, nothing
  // is marked sent, and Dan can just try again.
  if (settingsError) {
    return {
      error: 'Business details could not be loaded, so the invoice was not sent: ' +
        `${settingsError.message}`,
    }
  }
  if (!settings) {
    return {
      error: 'Business details could not be loaded, so the invoice was not sent. ' +
        'The settings row is missing.',
    }
  }

  const inv = invoice as unknown as {
    id: string; number: number; issue_date: string; due_date: string; terms_days: number
    status: 'draft' | 'sent' | 'paid' | 'void'; bill_to_snapshot: string | null
    subtotal_cents: number; tax_bp: number; tax_cents: number; deposit_cents: number
    total_cents: number; notes: string | null; imported: boolean
    public_token: string | null
    backup_snapshot: BackupSnapshot | null
    clients: { name: string; address_line1: string | null; address_line2: string | null; billing_email: string | null } | null
    invoice_lines: { id: string; position: number; description: string; qty_hundredths: number; unit_price_cents: number; line_total_cents: number }[]
  }

  if (inv.status === 'void') {
    return { error: `Invoice #${inv.number} is void. Voided invoices are not sent.` }
  }

  const to = inv.clients?.billing_email?.trim()
  if (!to) {
    return {
      error: `${inv.clients?.name ?? 'This client'} has no billing email on file, ` +
        'so there is nowhere to send it. Add one on the client screen.',
    }
  }

  // Mint the link on first send. Historical invoices stay tokenless until they
  // are actually sent from here.
  let token = inv.public_token
  if (!token) {
    token = crypto.randomUUID()
    const { error: tokErr } = await supabase
      .from('invoices').update({ public_token: token }).eq('id', invoiceId)
    if (tokErr) return { error: tokErr.message }
  }

  const lines = [...(inv.invoice_lines ?? [])].sort((a, b) => a.position - b.position)

  // Null on every invoice billed before migration 0012 (and any hand-written
  // one) — those render no backup pages, which is what they already did.
  const snapshot = inv.backup_snapshot
  const expenseRows = snapshot?.expenses ?? []

  // Fetched here, not by the PDF renderer: letting it pull a dozen remote URLs
  // would serialise a dozen round trips inside a function with a timeout — the
  // send would work on a two-receipt invoice and fail on a twelve-receipt one.
  const paths = expenseRows.map((e) => e.receipt_path).filter(Boolean) as string[]
  const urls = await signedReceiptUrls(paths)

  // A receipt is what makes an expense billable (see the billing guard in
  // lib/expenses.ts / billShows) — mailing a client an itemisation backed by
  // zero receipt pages is worse than refusing to send. This guards ONLY a
  // genuine bucket-level failure: signedReceiptUrls resolved not a single
  // URL for a non-empty set of paths, which only happens when Storage itself
  // errored or is unreachable (see its own doc comment — it swallows a
  // top-level error into `{}`), i.e. a Storage outage. It must be checked
  // here, off `urls` directly, and not off how many images end up attached —
  // an invoice with exactly one expense would otherwise make "one dead file"
  // and "total outage" the same predicate (every() is vacuously true over
  // one failure) and refuse to send forever, with no way to recover once the
  // show is billed and locked. A per-file failure below (a signed URL that
  // resolved but whose `fetch` call failed, or came back non-OK) is NOT this
  // condition and must fall through to the existing degrade-to-null
  // behaviour and still send.
  const allUrlsFailed = paths.length > 0 && Object.keys(urls).length === 0
  if (allUrlsFailed) {
    return {
      error: "This invoice's receipt images could not be attached (Storage may be down), " +
        'so it was not sent. Try again.',
    }
  }

  const withImages = await Promise.all(expenseRows.map(async (e) => {
    const url = e.receipt_path ? urls[e.receipt_path] : null
    if (!url) return { ...e, category: e.category as ExpenseCategory, receiptDataUri: null }
    try {
      const res = await fetch(url)
      if (!res.ok) return { ...e, category: e.category as ExpenseCategory, receiptDataUri: null }
      const buf = Buffer.from(await res.arrayBuffer())
      return {
        ...e,
        category: e.category as ExpenseCategory,
        receiptDataUri: `data:image/jpeg;base64,${buf.toString('base64')}`,
      }
    } catch {
      // A missing image must not lose the invoice. The itemisation still
      // lists the expense; only the picture is absent.
      return { ...e, category: e.category as ExpenseCategory, receiptDataUri: null }
    }
  }))

  const data: DocumentData = {
    number: inv.number,
    status: inv.status,
    issue_date: inv.issue_date,
    due_date: inv.due_date,
    terms_days: inv.terms_days,
    bill_to_snapshot: inv.bill_to_snapshot,
    subtotal_cents: inv.subtotal_cents,
    tax_bp: inv.tax_bp,
    tax_cents: inv.tax_cents,
    deposit_cents: inv.deposit_cents,
    total_cents: inv.total_cents,
    notes: inv.imported ? null : inv.notes,
    client: inv.clients
      ? {
          name: inv.clients.name,
          address_line1: inv.clients.address_line1,
          address_line2: inv.clients.address_line2,
        }
      : null,
    lines,
    settings: settings ?? null,
    backup: snapshot ? { ...snapshot, expenses: withImages } : undefined,
  }

  // Rendered from the SAME builder as the download button, so the attachment
  // cannot differ from what was approved on screen.
  //
  // Absolute paths from process.cwd(), NOT relative ones. The browser fetches
  // these over HTTP; here they are read off the serverless filesystem, and a
  // relative path depends on a working directory nobody controls. next.config
  // must also trace them into this route's bundle — Vercel serves public/ from
  // the CDN and does not otherwise put it in the function.
  // lib/invoiceEmail.ts goes to real trouble to never throw and always
  // return { error }. A dynamic import, Font.register or renderToBuffer that
  // throws here — a missing font in the deployed bundle, an unreadable row,
  // OOM — would reject this action outright; React 19 hands a rejected
  // transition to the error boundary, which replaces the whole page and
  // loses the panel's error/sent state. This try/catch keeps that contract
  // intact all the way from the PDF render to the caller.
  let pdf: Buffer
  try {
    const { join } = await import('node:path')
    const { Document, Page, Text, View, Image, Font, renderToBuffer } =
      await import('@react-pdf/renderer')
    Font.register({
      family: 'Oswald',
      src: join(process.cwd(), 'public', 'fonts', 'Oswald-Bold.ttf'),
      fontWeight: 700,
    })
    pdf = await renderToBuffer(
      buildInvoicePdf(
        { Document, Page, Text, View, Image },
        data,
        { logoSrc: join(process.cwd(), 'public', 'logo.png') },
      ),
    )
  } catch (e) {
    return {
      error: 'The invoice PDF could not be rendered: ' +
        (e instanceof Error ? e.message : 'unknown error.'),
    }
  }

  const result = await sendInvoiceEmail({
    to,
    invoice: data,
    status: inv.status,
    publicUrl: `${appUrl.replace(/\/+$/, '')}/i/${token}`,
    note,
    // From Settings, not hardcoded — it is already editable there, and a
    // second copy in code is one that goes stale silently. The fallback only
    // covers a settings row with no email at all.
    replyTo: settings?.email ?? 'dan@theaudiosmith.com',
    pdf,
  })
  if (result.error) return { error: result.error }

  // Only now. See the note above about ordering.
  const { error: markErr } = await supabase
    .from('invoices')
    .update({
      sent_at: new Date().toISOString(),
      ...(inv.status === 'draft' ? { status: 'sent' } : {}),
    })
    .eq('id', invoiceId)
  if (markErr) {
    return {
      error: `Invoice #${inv.number} was emailed to ${to}, but recording that failed: ` +
        `${markErr.message}. The client has it; the status here is stale.`,
    }
  }

  revalidatePath(`/invoices/${invoiceId}`)
  revalidatePath('/invoices')
  return { ok: true }
}

/**
 * Nudges one client about one unpaid invoice.
 *
 * Deliberately manual. An automatic chase eventually reaches somebody who has
 * already paid an invoice that has not been marked paid yet, and that email
 * cannot be recalled.
 *
 * A second send is NOT blocked — chasing twice is legitimate. The button shows
 * when the last one went instead.
 */
export async function sendClientReminder(
  invoiceId: string,
): Promise<{ error: string } | { ok: true }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  const appUrl = process.env.APP_URL
  if (!appUrl) return { error: 'Email is not configured yet (APP_URL is missing).' }

  const [{ data: invoice, error }, { data: settings, error: settingsError }] = await Promise.all([
    supabase
      .from('invoices')
      .select(`id, number, due_date, total_cents, status, public_token,
               clients(name, billing_email)`)
      .eq('id', invoiceId)
      .maybeSingle(),
    supabase
      .from('settings')
      // Explicit columns, same list sendInvoice uses — ach_details must never
      // join this, or it would reach a client through this path too.
      .select('legal_name, email')
      .eq('id', 1)
      .maybeSingle(),
  ])
  if (error) return { error: error.message }
  if (!invoice) return { error: 'That invoice no longer exists.' }
  if (settingsError) return { error: settingsError.message }

  const inv = invoice as unknown as {
    id: string; number: number; due_date: string; total_cents: number
    status: 'draft' | 'sent' | 'paid' | 'void'; public_token: string | null
    clients: { name: string; billing_email: string | null } | null
  }

  if (inv.status !== 'sent') {
    return { error: `Invoice #${inv.number} is ${inv.status}. Only a sent invoice is chased.` }
  }
  const to = inv.clients?.billing_email?.trim()
  if (!to) {
    return {
      error: `${inv.clients?.name ?? 'This client'} has no billing email on file. ` +
        'Add one on the client screen.',
    }
  }

  // Mint the link on first send, exactly like sendInvoice does. public_token
  // is otherwise only ever set there, so a reminder for an invoice nobody has
  // re-sent since the token feature shipped would go out with no link at all.
  let token = inv.public_token
  if (!token) {
    token = crypto.randomUUID()
    const { error: tokErr } = await supabase
      .from('invoices').update({ public_token: token }).eq('id', invoiceId)
    if (tokErr) return { error: tokErr.message }
  }

  const link = `${appUrl.replace(/\/+$/, '')}/i/${token}`
  // The legal name, not the trading name — this reaches a client's accounts
  // payable, who have "Smith Audio, LLC" on file. Was hardcoded; now it follows
  // Settings like everything else.
  const legalName = settings?.legal_name ?? 'Smith Audio, LLC'
  const subject = `Reminder: invoice #${inv.number} from ${legalName}`
  const text = [
    `A friendly reminder about invoice #${inv.number}.`,
    '',
    `Amount due: ${formatUSD(inv.total_cents)}`,
    `Due: ${formatDateLong(inv.due_date)}`,
    '',
    `View it online: ${link}`,
    '',
    'Thank you!',
  ].join('\n')
  const html =
    '<div style="font-family:system-ui,-apple-system,sans-serif;font-size:14px;color:#121212;line-height:1.5">' +
    `<p style="margin:0 0 16px">A friendly reminder about invoice <strong>#${inv.number}</strong>.</p>` +
    `<p style="margin:0 0 4px">Amount due: <strong>${formatUSD(inv.total_cents)}</strong></p>` +
    `<p style="margin:0 0 16px">Due: ${formatDateLong(inv.due_date)}</p>` +
    `<p style="margin:0 0 16px"><a href="${link}">View this invoice online</a></p>` +
    '<p style="margin:0">Thank you!</p>' +
    '</div>'

  const result = await sendReminderEmail({
    to,
    subject,
    text,
    html,
    // From Settings, same reasoning as sendInvoice: a reply from the client
    // must reach Dan, not INVOICE_FROM_EMAIL, which receives nothing.
    replyTo: settings?.email ?? 'dan@theaudiosmith.com',
    fromName: legalName,
  })
  if (result.error) return { error: result.error }

  // Only after the send succeeded.
  const { error: logErr } = await supabase.from('reminder_log').insert({
    owner_id: user.id,
    invoice_id: inv.id,
    kind: 'client_reminder',
    sent_to: to,
  })
  if (logErr) {
    return {
      error: `The reminder went to ${to}, but recording it failed: ${logErr.message}.`,
    }
  }

  revalidatePath(`/invoices/${invoiceId}`)
  return { ok: true }
}

/**
 * Flips only the `show_hours` flag inside an already-frozen snapshot.
 *
 * The rest of the snapshot is untouched: this changes whether the backup
 * PRINTS, never what it says. An explicit act rather than silent drift, which
 * is the whole reason the flag was frozen in the first place.
 */
export async function setInvoiceHours(
  invoiceId: string, show: boolean,
): Promise<{ error: string } | { ok: true }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  const { data: inv } = await supabase
    .from('invoices').select('backup_snapshot').eq('id', invoiceId).maybeSingle()
  if (!inv) return { error: 'That invoice no longer exists.' }

  const snapshot = inv.backup_snapshot as BackupSnapshot | null
  if (!snapshot) {
    return { error: 'This invoice has no hours recorded — it was not billed from a show.' }
  }

  const { error } = await supabase.from('invoices')
    .update({ backup_snapshot: { ...snapshot, show_hours: show } })
    .eq('id', invoiceId)
  if (error) return { error: error.message }

  revalidatePath(`/invoices/${invoiceId}`)
  return { ok: true }
}
