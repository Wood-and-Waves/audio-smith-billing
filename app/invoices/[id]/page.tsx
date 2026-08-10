import Link from 'next/link'
import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { formatUSD } from '@/lib/money'
import { displayStatus, daysUntilDue, STATUS_META, todayInChicago } from '@/lib/status'
import AppShell from '@/components/AppShell'
import InvoiceDocument, { type DocumentData } from '@/components/InvoiceDocument'

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
         clients(name, address_line1, address_line2),
         invoice_lines(id, position, description, qty_hundredths, unit_price_cents, line_total_cents)`,
      )
      .eq('id', id)
      .maybeSingle(),
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
    clients: DocumentData['client']
    invoice_lines: DocumentData['lines'] & { position: number }[]
  }

  const s = displayStatus(inv, today)
  const days = daysUntilDue(inv.due_date, today)
  const lines = [...(inv.invoice_lines ?? [])].sort(
    (a, b) => (a as { position: number }).position - (b as { position: number }).position,
  )

  return (
    <AppShell current="invoices">
      <Link
        href="/invoices"
        className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wider
                   text-muted hover:text-ink transition-colors mb-8"
      >
        ← All invoices
      </Link>

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

      <InvoiceDocument
        data={{
          number: inv.number,
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
          client: inv.clients,
          lines,
          settings: settings ?? null,
        }}
      />
    </AppShell>
  )
}
