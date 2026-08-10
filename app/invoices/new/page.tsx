import { createClient } from '@/lib/supabase/server'
import AppShell from '@/components/AppShell'
import InvoiceEditor, { type EditorClient, type EditorItem } from '@/components/InvoiceEditor'

export const dynamic = 'force-dynamic'

export default async function NewInvoicePage() {
  const supabase = await createClient()
  const [{ data: clients }, { data: items }] = await Promise.all([
    supabase.from('clients')
      .select('id, name, terms_days, day_rate_cents, ot_after_hours')
      .eq('archived', false).order('name'),
    supabase.from('items')
      .select('id, name, unit_label, default_price_cents, kind, derive_rule')
      .eq('archived', false).order('sort_order'),
  ])

  return (
    <AppShell current="invoices">
      <InvoiceEditor
        clients={(clients ?? []) as EditorClient[]}
        items={(items ?? []) as EditorItem[]}
      />
    </AppShell>
  )
}
