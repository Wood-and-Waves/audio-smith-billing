import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { formatUSD, overtimeRateFrom } from '@/lib/money'
import AppShell from '@/components/AppShell'

export const dynamic = 'force-dynamic'

type ClientRow = {
  id: string
  name: string
  billing_email: string | null
  legacy_names: string[]
  invoices: { total_cents: number; status: string }[]
  client_rate_cards: {
    name: string | null
    day_rate_cents: number
    ot_after_hours: number
    travel_rate_cents: number
  }[]
}

export default async function ClientsPage() {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('clients')
    .select(
      `id, name, billing_email, legacy_names, invoices(total_cents, status),
       client_rate_cards(name, day_rate_cents, ot_after_hours, travel_rate_cents)`,
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
      defaultCard: c.client_rate_cards.find((card) => card.name === null) ?? null,
      cardCount: c.client_rate_cards.length,
    }))
    .sort((a, b) => b.billed - a.billed)

  const missingEmail = clients.filter((c) => !c.billing_email)

  // Archiving is otherwise a one-way door: nothing else links to
  // /clients/[id] once a client is filtered out of the active list above, so
  // this collapsed section is the only way back in to un-archive one.
  const { data: archivedData } = await supabase
    .from('clients')
    .select('id, name')
    .eq('archived', true)
    .order('name')
  const archivedClients = (archivedData ?? []) as { id: string; name: string }[]

  return (
    <AppShell current="clients">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 mb-4">
        <div className="flex items-baseline gap-4">
          <h2 className="eyebrow">Clients</h2>
          <Link
            href="/clients/new"
            className="text-xs font-semibold uppercase tracking-wider text-accent hover:opacity-80"
          >
            + New client
          </Link>
        </div>
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
          const day = c.defaultCard?.day_rate_cents ?? null
          const otAfterHours = c.defaultCard?.ot_after_hours ?? 0
          return (
            <li key={c.id}>
              <Link
                href={`/clients/${c.id}`}
                className="block border-b border-line py-4 pl-3 -ml-3 pr-3 hover:bg-surface transition-colors"
              >
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
                      Day {formatUSD(day)} · Travel{' '}
                      {formatUSD(c.defaultCard!.travel_rate_cents)} · OT{' '}
                      {formatUSD(overtimeRateFrom(day, otAfterHours))} after {otAfterHours}h
                    </span>
                  ) : (
                    <span>No rate card</span>
                  )}
                  {c.cardCount > 1 && (
                    <span className="tabular">{c.cardCount} rate cards</span>
                  )}
                </div>

                {c.legacy_names.length > 0 && (
                  <p className="mt-1 text-xs text-muted/70">
                    Also billed as {c.legacy_names.join(', ')}
                  </p>
                )}
              </Link>
            </li>
          )
        })}
      </ul>

      {archivedClients.length > 0 && (
        <details className="mt-8 group">
          <summary className="eyebrow cursor-pointer select-none list-none flex items-center gap-2">
            <span className="transition-transform group-open:rotate-90">›</span>
            Archived ({archivedClients.length})
          </summary>
          <ul className="border-t border-line mt-4">
            {archivedClients.map((c) => (
              <li key={c.id}>
                <Link
                  href={`/clients/${c.id}`}
                  className="block border-b border-line py-3 pl-3 -ml-3 pr-3 text-sm text-muted
                             hover:bg-surface hover:text-ink transition-colors"
                >
                  {c.name}
                </Link>
              </li>
            ))}
          </ul>
        </details>
      )}
    </AppShell>
  )
}
