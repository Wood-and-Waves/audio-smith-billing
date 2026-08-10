import { createClient } from '@/lib/supabase/server'
import { formatUSD, travelRateFrom, overtimeRateFrom } from '@/lib/money'
import AppShell from '@/components/AppShell'

export const dynamic = 'force-dynamic'

type ClientRow = {
  id: string
  name: string
  billing_email: string | null
  day_rate_cents: number | null
  ot_after_hours: number
  legacy_names: string[]
  invoices: { total_cents: number; status: string }[]
}

export default async function ClientsPage() {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('clients')
    .select(
      'id, name, billing_email, day_rate_cents, ot_after_hours, legacy_names, invoices(total_cents, status)',
    )
    .eq('archived', false)
    .order('name')

  if (error) {
    return (
      <AppShell current="clients">
        <p role="alert" className="text-danger border-l-2 border-danger pl-4 py-2">
          Couldn&rsquo;t load clients: {error.message}
        </p>
      </AppShell>
    )
  }

  const clients = ((data ?? []) as unknown as ClientRow[])
    .map((c) => ({
      ...c,
      count: c.invoices.length,
      billed: c.invoices.reduce((t, i) => t + i.total_cents, 0),
    }))
    .sort((a, b) => b.billed - a.billed)

  const missingEmail = clients.filter((c) => !c.billing_email)

  return (
    <AppShell current="clients">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 mb-4">
        <h2 className="eyebrow">Clients</h2>
        <p className="tabular text-sm text-muted">{clients.length} active</p>
      </div>

      {missingEmail.length > 0 && (
        <p className="mb-6 text-sm text-muted border-l-2 border-accent pl-4 py-1">
          {missingEmail.length} {missingEmail.length === 1 ? 'client has' : 'clients have'} no
          billing email, so {missingEmail.length === 1 ? 'it' : 'they'} can&rsquo;t be invoiced by
          email yet: {missingEmail.map((c) => c.name).join(', ')}.
        </p>
      )}

      <ul className="border-t border-line">
        {clients.map((c) => {
          const day = c.day_rate_cents
          return (
            <li key={c.id}>
              {/* Not a link yet — the client editor doesn't exist, and a row
                  that 404s is worse than a row that doesn't move. */}
              <div className="block border-b border-line py-4 px-2 -mx-2">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <span className="font-semibold">{c.name}</span>
                  <span className="tabular text-sm">
                    <span className="text-muted">{c.count} invoice{c.count === 1 ? '' : 's'} · </span>
                    {formatUSD(c.billed)}
                  </span>
                </div>

                <div className="flex flex-wrap gap-x-5 gap-y-0.5 mt-1 text-xs text-muted">
                  <span className={c.billing_email ? '' : 'text-accent'}>
                    {c.billing_email ?? 'No billing email'}
                  </span>
                  {day ? (
                    <span className="tabular">
                      Day {formatUSD(day)} · Travel {formatUSD(travelRateFrom(day))} · OT{' '}
                      {formatUSD(overtimeRateFrom(day, c.ot_after_hours))} after {c.ot_after_hours}h
                    </span>
                  ) : (
                    <span>No rate card</span>
                  )}
                </div>

                {c.legacy_names.length > 0 && (
                  <p className="mt-1 text-xs text-muted/70">
                    Also billed as {c.legacy_names.join(', ')}
                  </p>
                )}
              </div>
            </li>
          )
        })}
      </ul>
    </AppShell>
  )
}
