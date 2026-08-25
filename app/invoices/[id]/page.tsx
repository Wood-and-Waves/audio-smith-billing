import Link from 'next/link'
import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { formatUSD } from '@/lib/money'
import { formatDateShort } from '@/lib/dates'
import { displayStatus, daysUntilDue, STATUS_META, todayInChicago } from '@/lib/status'
import AppShell from '@/components/AppShell'
import InvoiceDocument, { type DocumentData } from '@/components/InvoiceDocument'
import DownloadInvoiceButton from '@/components/DownloadInvoiceButton'
import SendInvoicePanel from '@/components/SendInvoicePanel'
import SendReminderButton from '@/components/SendReminderButton'
import MarkPaidButton from '@/components/MarkPaidButton'
import DeleteDraftInvoiceButton from '@/components/DeleteDraftInvoiceButton'
import InvoiceHoursToggle from '@/components/InvoiceHoursToggle'
import LinkPaymentPanel, { type PaymentCandidate } from '@/components/LinkPaymentPanel'
import { signedReceiptUrls } from '@/app/expenses/actions'
import type { ExpenseCategory } from '@/lib/expenses'
import type { BackupSnapshot } from '@/lib/backupSnapshot'
import { settlementFor, type Settlement } from '@/lib/invoicePayment'

export const dynamic = 'force-dynamic'

export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const today = todayInChicago()

  const [{ data: invoice, error }, { data: settings }, { data: linkedShows }, { data: depositTxns }] = await Promise.all([
    supabase
      .from('invoices')
      .select(
        `id, number, issue_date, due_date, terms_days, status, sent_at, paid_at, bill_to_snapshot,
         subtotal_cents, tax_bp, tax_cents, deposit_cents, total_cents, notes, imported,
         work_for, backup_snapshot,
         clients(name, address_line1, address_line2, city, state, postal_code, billing_email),
         invoice_lines(id, position, description, qty_hundredths, unit_price_cents, line_total_cents),
         reminder_log(kind, sent_at, sent_on)`,
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
    // Whether ANY show was ever billed onto this invoice — shows.invoice_id
    // is the only edge back from a show to its invoice, so this is its own
    // query. Used only to tell "no shows behind this invoice" apart from "a
    // show billed this invoice before the backup snapshot existed" below.
    supabase.from('shows').select('id').eq('invoice_id', id),
    // .order + .limit(1): an invoice can in principle carry more than one
    // link row (a rare hand-correction case), and without an explicit order
    // Postgres makes no promise about which one comes back first — the same
    // "unknown must never resolve to a guess" reasoning as everywhere else in
    // this app, applied here by pinning the deterministic choice (oldest
    // link first) instead of leaving it to whatever the planner happens to
    // return.
    supabase
      .from('ledger_transaction_invoices')
      .select('transaction_id, ledger_transactions(id, date, amount_cents)')
      .eq('invoice_id', id)
      .order('created_at', { ascending: true })
      .limit(1),
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
    sent_at: string | null
    paid_at: string | null
    bill_to_snapshot: string | null
    subtotal_cents: number
    tax_bp: number
    tax_cents: number
    deposit_cents: number
    total_cents: number
    notes: string | null
    imported: boolean
    work_for: string | null
    backup_snapshot: BackupSnapshot | null
    clients:
      | (NonNullable<DocumentData['client']> & { billing_email: string | null })
      | null
    invoice_lines: DocumentData['lines'] & { position: number }[]
    reminder_log?: { kind: string; sent_at: string; sent_on: string | null }[]
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
  const hasLinkedShows = (linkedShows ?? []).length > 0

  // Extract the paying deposit from the first ledger transaction (or null).
  // The query itself already narrowed this to one deterministic row (oldest
  // link first) via .order + .limit(1) above.
  const depositRow = (depositTxns ?? [])[0] as unknown as
    | {
        transaction_id: string
        ledger_transactions: { id: string; date: string; amount_cents: number } | null
      }
    | undefined
  const deposit = depositRow?.ledger_transactions ?? null

  // How many invoices this ONE deposit covers. A combo (the matcher's two-
  // or three-invoice match) is exact by construction, and settlementFor
  // needs the count to tell a combo from a lone link. null means "could not
  // find out" — on this page an unknown must never resolve to a guess, so
  // the settlement line below simply does not render in that case rather
  // than risk printing a shortfall that isn't real.
  let linkInvoiceCount: number | null = null
  if (depositRow) {
    const { data: siblingLinks, error: siblingError } = await supabase
      .from('ledger_transaction_invoices')
      .select('invoice_id')
      .eq('transaction_id', depositRow.transaction_id)
    if (!siblingError) linkInvoiceCount = (siblingLinks ?? []).length
  }

  const settlement: Settlement | null =
    deposit && linkInvoiceCount !== null
      ? settlementFor(inv.total_cents, {
          amountCents: deposit.amount_cents,
          invoiceCount: linkInvoiceCount,
        })
      : null

  // Candidates for "Link a payment": recent deposits not already spoken for.
  // PostgREST has no clean NOT IN subquery, so this reads the newest deposits
  // plus both link tables' transaction ids and filters in memory — the same
  // fetch-then-filter idiom the rest of /money uses. Fail CLOSED: if any of
  // the three reads errors, the taken-set would be incomplete and the panel
  // would offer a deposit that is already linked, so offer nothing instead.
  const canLinkPayment = !deposit && (inv.status === 'sent' || inv.status === 'paid')
  let paymentCandidates: PaymentCandidate[] = []
  if (canLinkPayment) {
    const [recentRes, invLinkRes, expLinkRes] = await Promise.all([
      supabase
        .from('ledger_transactions')
        .select('id, date, payee, amount_cents')
        .eq('kind', 'income')
        .gt('amount_cents', 0)
        .order('date', { ascending: false })
        .limit(40),
      supabase.from('ledger_transaction_invoices').select('transaction_id'),
      supabase.from('ledger_transaction_expenses').select('transaction_id'),
    ])
    if (!recentRes.error && !invLinkRes.error && !expLinkRes.error) {
      const taken = new Set<string>([
        ...((invLinkRes.data ?? []) as { transaction_id: string }[]).map((r) => r.transaction_id),
        ...((expLinkRes.data ?? []) as { transaction_id: string }[]).map((r) => r.transaction_id),
      ])
      paymentCandidates = ((recentRes.data ?? []) as {
        id: string; date: string; payee: string; amount_cents: number
      }[])
        .filter((t) => !taken.has(t.id))
        .map((t) => ({ id: t.id, date: t.date, payee: t.payee, amountCents: t.amount_cents }))
    }
  }

  // Fetched here, not by the PDF renderer: letting it pull a dozen remote URLs
  // would serialise a dozen round trips inside a function with a timeout — the
  // send would work on a two-receipt invoice and fail on a twelve-receipt one.
  //
  // Original PDFs (never photos — DownloadInvoiceButton's buildInvoicePdfBlob
  // only ever appends a PDF onto the download) are signed in the SAME call as
  // the enhanced images below, so this page costs one Storage round trip, not
  // two.
  const originalPdfPaths = snapshotExpenses
    .map((e) => e.receipt_original)
    .filter((p): p is string => typeof p === 'string' && p.endsWith('.pdf'))
  const paths = [
    ...(snapshotExpenses.map((e) => e.receipt_path).filter(Boolean) as string[]),
    ...originalPdfPaths,
  ]
  const { urls } = await signedReceiptUrls(paths)
  const withImages = await Promise.all(snapshotExpenses.map(async (e) => {
    const url = e.receipt_path ? urls[e.receipt_path] : null
    // Undefined for a photo original, or for a PDF original whose sign
    // failed/was skipped (storage outage, or an original that predates this
    // field) — either way DownloadInvoiceButton simply has nothing to append.
    const receiptOriginalPdfUrl =
      e.receipt_original && e.receipt_original.endsWith('.pdf')
        ? (urls[e.receipt_original] ?? null)
        : null
    if (!url) {
      return {
        ...e, category: e.category as ExpenseCategory, receiptDataUri: null, receiptOriginalPdfUrl,
      }
    }
    try {
      const res = await fetch(url)
      if (!res.ok) {
        return {
          ...e, category: e.category as ExpenseCategory, receiptDataUri: null, receiptOriginalPdfUrl,
        }
      }
      const buf = Buffer.from(await res.arrayBuffer())
      return {
        ...e,
        category: e.category as ExpenseCategory,
        receiptDataUri: `data:image/jpeg;base64,${buf.toString('base64')}`,
        receiptOriginalPdfUrl,
      }
    } catch {
      // A missing image must not lose the invoice. The itemisation still
      // lists the expense; only the picture is absent.
      return {
        ...e, category: e.category as ExpenseCategory, receiptDataUri: null, receiptOriginalPdfUrl,
      }
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
    work_for: inv.work_for,
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
          city: inv.clients.city,
          state: inv.clients.state,
          postal_code: inv.clients.postal_code,
        }
      : null,
    lines,
    settings: settings ?? null,
    backup: snapshot ? { ...snapshot, expenses: withImages } : undefined,
  }

  // Most recent client reminder, as a plain date for display.
  //
  // sent_on is the Chicago day the message actually went, written at insert.
  // This used to be sent_at.slice(0, 10) — the UTC date of a timestamptz — so a
  // reminder sent after 7pm Central displayed as sent TOMORROW. lib/dates.ts
  // warns that exact slicing "bit CrewTracker twice"; migration 0021 added the
  // column so it does not have to be guessed from an instant.
  //
  // Rows written before 0021 have no sent_on, and there are none — the table was
  // empty when the migration ran — but the fallback keeps a null out of the
  // display rather than rendering "Invalid Date" if one ever appears.
  const lastReminder = (inv.reminder_log ?? [])
    .filter((r) => r.kind === 'client_reminder')
    .sort((a, b) => a.sent_at.localeCompare(b.sent_at))
    .pop() ?? null
  const lastReminderDate = lastReminder?.sent_on ?? null

  return (
    <AppShell current="invoices">
      {/* Phones stack: the back link, then the actions flowing left in
          neat rows — four right-aligned links of unequal width wrapped into
          a ragged pile beside a two-line back link. Desktop keeps one row. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-8">
        <Link
          href="/invoices"
          className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wider
                     text-muted hover:text-ink transition-colors"
        >
          ← All invoices
        </Link>
        <div className="flex flex-wrap items-center justify-start sm:justify-end gap-x-5 gap-y-2">
          <MarkPaidButton invoiceId={inv.id} status={inv.status} wasSent={inv.sent_at != null} />
          {/* `sent` covers overdue too — overdue is derived from a sent
              invoice being past due, never a separate stored status. */}
          {inv.status === 'sent' ? (
            <SendReminderButton
              invoiceId={inv.id}
              to={(inv.clients as { billing_email?: string | null } | null)?.billing_email?.trim() || null}
              lastSentDate={lastReminderDate}
              number={docData.number}
              totalCents={docData.total_cents}
              dueDate={docData.due_date}
              legalName={docData.settings?.legal_name ?? 'Smith Audio, LLC'}
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

      {canLinkPayment && (
        <LinkPaymentPanel
          invoiceId={inv.id}
          invoiceNumber={inv.number}
          totalCents={inv.total_cents}
          candidates={paymentCandidates}
        />
      )}

      {/* The email panel lives on its OWN full-width row, not in the action
          group above. Opened, it expands into a full-width card, and a card is
          the wrong thing to put inside that shrink-to-fit, non-wrapping button
          row: on a phone the card's w-full resolved against a circular width
          and rendered as a squeezed mess. Here it has the width it asks for. */}
      <div className="mb-8 flex justify-start sm:justify-end">
        <SendInvoicePanel
          invoiceId={inv.id}
          data={docData}
          // .trim()'d the same way app/invoices/actions.ts trims it at send
          // time, so a whitespace-only billing_email renders the "no billing
          // email" state here too, rather than a blank "To" and a "Send to    "
          // button that would then be refused server-side anyway.
          to={inv.clients?.billing_email?.trim() || null}
          status={inv.status}
        />
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
                : s === 'paid' && inv.paid_at
                  ? `Paid ${formatDateShort(inv.paid_at)}`
                  : STATUS_META[s].label}
          </p>
          {deposit && (
            <p className="text-xs text-muted mt-1">
              Bank deposit · {formatDateShort(deposit.date)}
              {/* Only a real mismatch earns extra words. An exact settlement
                  reads exactly as it did before this feature, and 'unpaid'
                  renders nothing at all — it is reachable on an invoice
                  hand-marked paid that carries no link, where printing
                  "unpaid" beside a Paid badge would flatly contradict it. */}
              {settlement && (settlement.state === 'short' || settlement.state === 'over') && (
                <>
                  {' · '}Paid {formatUSD(settlement.paidCents)}
                  {' · '}{formatUSD(Math.abs(settlement.deltaCents))}{' '}
                  {settlement.state === 'short' ? 'short' : 'over'}
                </>
              )}
            </p>
          )}
        </div>
      </header>

      {inv.notes && inv.imported && (
        <p className="mb-8 text-sm text-muted border-l-2 border-accent pl-4 py-1">{inv.notes}</p>
      )}

      {snapshot ? (
        <div className="flex justify-end mb-4">
          <InvoiceHoursToggle invoiceId={inv.id} checked={snapshot.show_hours} />
        </div>
      ) : hasLinkedShows ? (
        // No toggle to offer: there is nothing frozen to switch on. This
        // invoice's show(s) were billed before the hours backup existed (or
        // this invoice predates migration 0012 entirely), so it carries no
        // breakdown and no expense itemisation — re-billing the show(s)
        // would produce one.
        <div className="flex justify-end mb-4">
          <p className="text-xs text-muted">
            Billed before hours backup existed, so it carries no breakdown. Re-billing the show would produce one.
          </p>
        </div>
      ) : null}

      <InvoiceDocument data={docData} />

      {/* Any never-sent draft gets a way out — with shows still billed, the
          button unbills them too. The action re-checks server-side. */}
      {inv.status === 'draft' && !inv.sent_at && (
        <div className="mt-10">
          <DeleteDraftInvoiceButton
            invoiceId={inv.id}
            number={inv.number}
            linkedCount={(linkedShows ?? []).length}
          />
        </div>
      )}
    </AppShell>
  )
}
