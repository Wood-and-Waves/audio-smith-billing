import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import AppShell from '@/components/AppShell'
import InvoiceEditor, { type EditorClient, type EditorItem } from '@/components/InvoiceEditor'

export const dynamic = 'force-dynamic'

export default async function EditInvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()

  const [{ data: invoice }, { data: clients }, { data: items }] = await Promise.all([
    supabase.from('invoices')
      .select(`id, number, client_id, issue_date, terms_days, deposit_cents, tax_bp, notes,
               invoice_lines(position, description, qty_hundredths, unit_price_cents)`)
      .eq('id', id).maybeSingle(),
    supabase.from('clients')
      .select('id, name, terms_days, day_rate_cents, ot_after_hours')
      .eq('archived', false).order('name'),
    supabase.from('items')
      .select('id, name, unit_label, default_price_cents, kind, derive_rule')
      .eq('archived', false).order('sort_order'),
  ])

  if (!invoice) notFound()

  const inv = invoice as unknown as {
    id: string; number: number; client_id: string; issue_date: string
    terms_days: number; deposit_cents: number; tax_bp: number; notes: string | null
    invoice_lines: { position: number; description: string; qty_hundredths: number; unit_price_cents: number }[]
  }

  return (
    <AppShell current="invoices">
      <InvoiceEditor
        invoiceId={inv.id}
        invoiceNumber={inv.number}
        clients={(clients ?? []) as EditorClient[]}
        items={(items ?? []) as EditorItem[]}
        initial={{
          client_id: inv.client_id,
          issue_date: inv.issue_date,
          terms_days: inv.terms_days,
          deposit_cents: inv.deposit_cents,
          tax_bp: inv.tax_bp,
          notes: inv.notes ?? '',
          lines: [...inv.invoice_lines].sort((a, b) => a.position - b.position),
        }}
      />
    </AppShell>
  )
}
