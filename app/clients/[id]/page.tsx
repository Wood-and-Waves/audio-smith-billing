import Link from 'next/link'
import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { todayInChicago } from '@/lib/dates'
import AppShell from '@/components/AppShell'
import ClientEditor, { type EditorClient } from '@/components/ClientEditor'
import InvoiceRow, { type InvoiceRowData } from '@/components/InvoiceRow'

export const dynamic = 'force-dynamic'

export default async function ClientPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()

  const [{ data: client, error }, { data: invoices }] = await Promise.all([
    supabase
      .from('clients')
      .select(
        `id, name, billing_email, contact_name, phone, address_line1, address_line2,
         terms_days, day_rate_cents, ot_after_hours, notes, archived, show_hours_on_invoice`,
      )
      .eq('id', id)
      .maybeSingle(),
    supabase
      .from('invoices')
      .select('id, number, issue_date, due_date, status, total_cents, clients(name)')
      .eq('client_id', id)
      .order('number', { ascending: false }),
  ])

  if (error) {
    return (
      <AppShell current="clients">
        <p role="alert" className="text-danger border-l-2 border-danger pl-4 py-2">
          Couldn&rsquo;t load this client: {error.message}
        </p>
      </AppShell>
    )
  }
  if (!client) notFound()

  const rows = (invoices ?? []) as unknown as InvoiceRowData[]
  const today = todayInChicago()

  return (
    <AppShell current="clients">
      <Link
        href="/clients"
        className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wider
                   text-muted hover:text-ink transition-colors mb-8"
      >
        ← All clients
      </Link>

      <ClientEditor initial={client as unknown as EditorClient} />

      <div className="max-w-xl mt-14">
        <h2 className="eyebrow mb-4">Invoice history</h2>
        {rows.length === 0 ? (
          <p className="text-muted py-6 border-t border-line">No invoices for this client yet.</p>
        ) : (
          <ul className="border-t border-line">
            {rows.map((r) => (
              <InvoiceRow key={r.id} invoice={r} today={today} />
            ))}
          </ul>
        )}
      </div>
    </AppShell>
  )
}
