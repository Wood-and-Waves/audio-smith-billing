import Link from 'next/link'
import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { formatUSD } from '@/lib/money'
import { displayStatus, daysUntilDue, STATUS_META, todayInChicago } from '@/lib/status'
import AppShell from '@/components/AppShell'
import InvoiceDocument, { type DocumentData } from '@/components/InvoiceDocument'
import DownloadInvoiceButton from '@/components/DownloadInvoiceButton'
import SendInvoicePanel from '@/components/SendInvoicePanel'
import SendReminderButton from '@/components/SendReminderButton'
import InvoiceHoursToggle from '@/components/InvoiceHoursToggle'
import { signedReceiptUrls } from '@/app/expenses/actions'
import type { ExpenseCategory } from '@/lib/expenses'
import type { BackupSnapshot } from '@/lib/backupSnapshot'

export const dynamic = 'force-dynamic'

export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const today = todayInChicago()

  const [{ data: invoice, error }, { data: settings }] = await Promise.all([
    supabase
      .from('invoices')
      .select(
        `id, number, issue_date, due_date, terms_days, status, bill_to_snapshot,
         subtotal_cents, tax_bp, tax_cents, deposit_cents, total_cents, notes, imported,
         backup_snapshot,
         clients(name, address_line1, address_line2, billing_email),
         invoice_lines(id, position, description, qty_hundredths, unit_price_cents, line_total_cents),
         reminder_log(kind, sent_at)`,
      )
      .eq('id', id)
      .maybeSingle(),
    // docData below (including this whole settings object) is passed to a
    // client component and so gets serialized into the page payload sent to
    // the browser. This explicit column list is the only thing keeping
    // ach_details — bank transfer details — out of that payload. Never widen
    // this to select('*'): that would ship bank details to the browser on
    // every invoice view.
    supabase
      .from('settings')
      .select('business_name, legal_name, address_line1, address_line2, phone, email, remit_to')
      .eq('id', 1)
      .maybeSingle(),
  ])

  if (error) {
    return (
      <AppShell current="invoices">
        <p role="alert" className="text-danger border-l-2 border-danger pl-4 py-2">
          Couldn&rsquo;t load this invoice: {error.message}
        </p>
      </AppShell>
    )
  }
  if (!invoice) notFound()

  const inv = invoice as unknown as {
    id: string
    number: number
    issue_date: string
    due_date: string
    terms_days: number
    status: 'draft' | 'sent' | 'paid' | 'void'
    bill_to_snapshot: string | null
    subtotal_cents: number
    tax_bp: number
    tax_cents: number
    deposit_cents: number
    total_cents: number
    notes: string | null
    imported: boolean
    backup_snapshot: BackupSnapshot | null
    clients:
      | (NonNullable<DocumentData['client']> & { billing_email: string | null })
      | null
    invoice_lines: DocumentData['lines'] & { position: number }[]
    reminder_log?: { kind: string; sent_at: string }[]
  }

  const s = displayStatus(inv, today)
  const days = daysUntilDue(inv.due_date, today)
  const lines = [...(inv.invoice_lines ?? [])].sort(
    (a, b) => (a as { position: number }).position - (b as { position: number }).position,
  )

  // Null on every invoice billed before migration 0012 (and any hand-written
  // one) — those render no backup pages, which is what they already did.
  const snapshot = inv.backup_snapshot
  const snapshotExpenses = snapshot?.expenses ?? []

  // Fetched here, not by the PDF renderer: letting it pull a dozen remote URLs
  // would serialise a dozen round trips inside a function with a timeout — the
  // send would work on a two-receipt invoice and fail on a twelve-receipt one.
  const paths = snapshotExpenses.map((e) => e.receipt_path).filter(Boolean) as string[]
  const { urls } = await signedReceiptUrls(paths)
  const withImages = await Promise.all(snapshotExpenses.map(async (e) => {
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

  const docData: DocumentData = {
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
    // The import note belongs above the document, not printed on it.
    notes: inv.imported ? null : inv.notes,
    // Reconstructed field by field, NOT `client: inv.clients`. The query fetches
    // billing_email for the send panel, and assigning the row wholesale would
    // carry it into docData — which is serialized to the browser and handed to
    // the PDF builder. A type annotation describes a shape; it does not remove
    // properties at runtime.
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

  // Most recent client reminder, as a plain date for display. reminder_log
  // stores an instant; formatDateShort takes a calendar date.
  const lastReminder = (inv.reminder_log ?? [])
    .filter((r) => r.kind === 'client_reminder')
    .map((r) => r.sent_at)
    .sort()
    .pop() ?? null
  const lastReminderDate = lastReminder ? lastReminder.slice(0, 10) : null

  return (
    <AppShell current="invoices">
      <div className="flex items-center justify-between mb-8">
        <Link
          href="/invoices"
          className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wider
                     text-muted hover:text-ink transition-colors"
        >
          ← All invoices
        </Link>
        <div className="flex items-center gap-5">
          <SendInvoicePanel
            invoiceId={inv.id}
            data={docData}
            // .trim()'d the same way app/invoices/actions.ts trims it at send
            // time, so a whitespace-only billing_email renders the "no
            // billing email" state here too, rather than a blank "To" and a
            // "Send to    " button that would then be refused server-side
            // anyway.
            to={inv.clients?.billing_email?.trim() || null}
            status={inv.status}
            publicUrlBase={process.env.APP_URL ?? ''}
          />
          {/* `sent` covers overdue too — overdue is derived from a sent
              invoice being past due, never a separate stored status. */}
          {inv.status === 'sent' ? (
            <SendReminderButton
              invoiceId={inv.id}
              to={(inv.clients as { billing_email?: string | null } | null)?.billing_email?.trim() || null}
              lastSentDate={lastReminderDate}
            />
          ) : null}
          <DownloadInvoiceButton data={docData} />
          <Link
            href={`/invoices/${inv.id}/edit`}
            className="text-xs font-semibold uppercase tracking-wider text-accent hover:opacity-80"
          >
            Edit
          </Link>
        </div>
      </div>

      <header className="flex flex-wrap items-start justify-between gap-4 mb-8">
        <div className="min-w-0">
          <h1 className="display text-3xl font-bold">
            <span className="text-muted">#</span>
            {inv.number}
          </h1>
          <p className="text-muted mt-1 truncate">{inv.clients?.name ?? 'Unknown client'}</p>
        </div>

        <div className="text-right">
          <p className="tabular text-2xl font-bold">{formatUSD(inv.total_cents)}</p>
          <p className={`text-sm mt-1 ${STATUS_META[s].text}`}>
            {s === 'overdue'
              ? `${Math.abs(days)} ${Math.abs(days) === 1 ? 'day' : 'days'} overdue`
              : s === 'sent'
                ? `Due in ${days} ${days === 1 ? 'day' : 'days'}`
                : STATUS_META[s].label}
          </p>
        </div>
      </header>

      {inv.notes && inv.imported && (
        <p className="mb-8 text-sm text-muted border-l-2 border-accent pl-4 py-1">{inv.notes}</p>
      )}

      {snapshot && (
        <div className="flex justify-end mb-4">
          <InvoiceHoursToggle invoiceId={inv.id} checked={snapshot.show_hours} />
        </div>
      )}

      <InvoiceDocument data={docData} />
    </AppShell>
  )
}
