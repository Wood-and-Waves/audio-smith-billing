import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { formatDateShort } from '@/lib/dates'
import AppShell from '@/components/AppShell'

export const dynamic = 'force-dynamic'

export default async function ShowsPage() {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('shows')
    .select('id, name, venue, status, created_at, clients(name), show_days(id, date)')
    .order('created_at', { ascending: false })

  if (error) {
    return (
      <AppShell current="shows">
        <p role="alert" className="text-danger border-l-2 border-danger pl-4 py-2">
          Couldn&rsquo;t load shows: {error.message}
        </p>
      </AppShell>
    )
  }

  type Row = {
    id: string; name: string; venue: string | null; status: string
    clients: { name: string } | null; show_days: { id: string; date: string }[]
  }
  const rows = (data ?? []) as unknown as Row[]
  const unbilled = rows.filter((r) => r.status === 'open')
  const billed = rows.filter((r) => r.status === 'billed')

  const Row = ({ r }: { r: Row }) => {
    const dates = r.show_days.map((d) => d.date).sort()
    return (
      <li>
        <Link href={`/shows/${r.id}`}
              className="block border-b border-line py-4 px-2 -mx-2 hover:bg-surface transition-colors">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <span className="font-semibold">{r.name}</span>
            <span className="text-sm text-muted tabular">
              {dates.length} {dates.length === 1 ? 'day' : 'days'}
              {dates.length > 0 && ` · ${formatDateShort(dates[0])}`}
            </span>
          </div>
          <p className="text-xs text-muted mt-1">
            {r.clients?.name}{r.venue ? ` · ${r.venue}` : ''}
          </p>
        </Link>
      </li>
    )
  }

  return (
    <AppShell current="shows">
      <div className="flex items-baseline gap-4 mb-4">
        <h2 className="eyebrow">Unbilled</h2>
        <Link href="/shows/new"
              className="text-xs font-semibold uppercase tracking-wider text-accent hover:opacity-80">
          + New show
        </Link>
      </div>
      {unbilled.length === 0 ? (
        <p className="text-muted border-l-2 border-line pl-4 py-1 mb-12">
          Nothing untracked and unbilled. Everything you&rsquo;ve worked is on an invoice.
        </p>
      ) : (
        <ul className="border-t border-line mb-12">{unbilled.map((r) => <Row key={r.id} r={r} />)}</ul>
      )}

      <h2 className="eyebrow mb-4">Billed</h2>
      <ul className="border-t border-line">{billed.map((r) => <Row key={r.id} r={r} />)}</ul>
    </AppShell>
  )
}
