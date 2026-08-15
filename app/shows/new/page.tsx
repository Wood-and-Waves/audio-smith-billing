import { createClient } from '@/lib/supabase/server'
import AppShell from '@/components/AppShell'
import NewShowForm, { type Client } from '@/components/NewShowForm'

export const dynamic = 'force-dynamic'

export default async function NewShowPage() {
  const supabase = await createClient()
  const { data } = await supabase
    .from('clients')
    .select('id, name, client_rate_cards(id, name, day_rate_cents, ot_after_hours, travel_full_day)')
    .eq('archived', false)
    .order('name')
    // Otherwise the rate-card picker lists a client's cards in whatever
    // order Postgres happens to return them, which reads as random.
    .order('name', { referencedTable: 'client_rate_cards' })

  // The query joins client_rate_cards under its table name; NewShowForm
  // wants it as `cards`, the same rename ClientEditor's page does.
  const clients = ((data ?? []) as unknown as (Client & {
    client_rate_cards: Client['cards']
  })[]).map(({ client_rate_cards, ...rest }) => ({ ...rest, cards: client_rate_cards }))

  return (
    <AppShell current="shows">
      <NewShowForm clients={clients} />
    </AppShell>
  )
}
