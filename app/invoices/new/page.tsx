import { createClient } from '@/lib/supabase/server'
import { defaultCardOf } from '@/lib/rateCards'
import AppShell from '@/components/AppShell'
import InvoiceEditor, { type EditorClient, type EditorItem } from '@/components/InvoiceEditor'

export const dynamic = 'force-dynamic'

export default async function NewInvoicePage() {
  const supabase = await createClient()
  const [{ data: clients }, { data: items }] = await Promise.all([
    supabase.from('clients')
      .select('id, name, terms_days, client_rate_cards(name, day_rate_cents, ot_after_hours)')
      .eq('archived', false).order('name'),
    supabase.from('items')
      .select('id, name, unit_label, default_price_cents, kind, derive_rule')
      .eq('archived', false).order('sort_order'),
  ])

  // The query joins client_rate_cards under its table name; InvoiceEditor
  // wants a single default card, not the client's superseded
  // day_rate_cents/ot_after_hours columns (see EditorClient).
  const editorClients: EditorClient[] = (
    (clients ?? []) as unknown as {
      id: string; name: string; terms_days: number
      client_rate_cards: { name: string | null; day_rate_cents: number; ot_after_hours: number }[]
    }[]
  ).map((c) => {
    const def = defaultCardOf(c.client_rate_cards)
    return {
      id: c.id,
      name: c.name,
      terms_days: c.terms_days,
      default_card: def ? { day_rate_cents: def.day_rate_cents, ot_after_hours: def.ot_after_hours } : null,
    }
  })

  return (
    <AppShell current="invoices">
      <InvoiceEditor
        clients={editorClients}
        items={(items ?? []) as EditorItem[]}
      />
    </AppShell>
  )
}
