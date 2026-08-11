import { createClient } from '@/lib/supabase/server'
import AppShell from '@/components/AppShell'
import NewShowForm from '@/components/NewShowForm'

export const dynamic = 'force-dynamic'

export default async function NewShowPage() {
  const supabase = await createClient()
  const { data } = await supabase
    .from('clients')
    .select('id, name, day_rate_cents')
    .eq('archived', false)
    .order('name')
  return (
    <AppShell current="shows">
      <NewShowForm
        clients={(data ?? []) as { id: string; name: string; day_rate_cents: number | null }[]}
      />
    </AppShell>
  )
}
