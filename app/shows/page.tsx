import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { isIncompleteDay } from '@/lib/chronology'
import { formatDateShort } from '@/lib/dates'
import { lineTotal, overtimeRateFrom, doubleTimeRateFrom } from '@/lib/money'
import { computeShowLines, type ShowRates } from '@/lib/showBuckets'
import type { ShowDayLike, ShowRuleset } from '@/lib/payroll'
import AppShell from '@/components/AppShell'
import UnbilledShows, { type UnbilledShow } from '@/components/UnbilledShows'

export const dynamic = 'force-dynamic'

type Punch = { punch_type: string; punched_at: string }
type Day = { id: string; date: string; day_type: 'show' | 'travel' | 'pm'; pay_as_half_day: boolean; punches: Punch[] }
type Row = {
  id: string; name: string; venue: string | null; status: string; client_id: string
  day_rate_cents: number; travel_rate_cents: number; pm_rate_cents: number
  ot_after_hours: number; dt_after_hours: number | null
  minimum_meal_break_minutes: number; meal_break_deduction_cap: number
  meal_penalty_grace_hours: number; meal_penalty_cents: number
  short_turn_rest_hours: number; continuous_time_enabled: boolean
  clients: { name: string } | null; show_days: Day[]
}

export default async function ShowsPage() {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('shows')
    .select(`id, name, venue, status, created_at, client_id,
             day_rate_cents, travel_rate_cents, pm_rate_cents, ot_after_hours,
             dt_after_hours, minimum_meal_break_minutes, meal_break_deduction_cap,
             meal_penalty_grace_hours, meal_penalty_cents, short_turn_rest_hours,
             continuous_time_enabled,
             clients(name), show_days(id, date, day_type, pay_as_half_day, punches(punch_type, punched_at))`)
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

  const rows = (data ?? []) as unknown as Row[]
  const unbilled = rows.filter((r) => r.status === 'open')
  const billed = rows.filter((r) => r.status === 'billed')

  // Money lives here, on the server, in integer cents — never in the client
  // component. Each unbilled show gets its own computeShowLines pass, same
  // rules/rates shape billShows and app/shows/[id]/page.tsx build, so the
  // total shown here can never disagree with what billing would compute.
  const unbilledShows: UnbilledShow[] = unbilled.map((s) => {
    const days = [...s.show_days].sort((a, b) => a.date.localeCompare(b.date))
    const hours = Number(s.ot_after_hours)
    const rules: ShowRuleset = {
      overtime_after_hours: hours,
      double_time_enabled: s.dt_after_hours != null,
      double_time_after_hours: Number(s.dt_after_hours ?? 12),
      meal_penalty_enabled: s.meal_penalty_cents > 0,
      meal_penalty_grace_hours: Number(s.meal_penalty_grace_hours),
      minimum_meal_break_enabled: s.minimum_meal_break_minutes > 0,
      minimum_meal_break_minutes: s.minimum_meal_break_minutes,
      meal_break_deduction_cap: s.meal_break_deduction_cap,
      short_turn_penalty_enabled: true,
      short_turn_rest_hours: Number(s.short_turn_rest_hours),
      continuous_time_enabled: s.continuous_time_enabled,
    }
    const rates: ShowRates = {
      day_rate_cents: s.day_rate_cents,
      travel_rate_cents: s.travel_rate_cents,
      pm_rate_cents: s.pm_rate_cents,
      ot_rate_cents: overtimeRateFrom(s.day_rate_cents, hours),
      dt_rate_cents: doubleTimeRateFrom(s.day_rate_cents, hours),
      meal_penalty_cents: s.meal_penalty_cents,
    }
    const lines = computeShowLines(days as unknown as ShowDayLike[], rates, rules)
    const totalCents = lines.reduce((t, l) => t + lineTotal(l.qty_hundredths, l.unit_price_cents), 0)

    // Shares isIncompleteDay with billShows and the show detail page so this
    // list can never mark a show billable that billShows would reject.
    const incompleteDates = days
      .filter((d) => d.day_type !== 'travel')
      .filter((d) => isIncompleteDay(d.punches))
      .map((d) => formatDateShort(d.date))

    return {
      id: s.id,
      name: s.name,
      venue: s.venue,
      clientId: s.client_id,
      clientName: s.clients?.name ?? 'Unknown client',
      dates: days.map((d) => d.date),
      totalCents,
      incompleteDates,
    }
  })

  const BilledRow = ({ r }: { r: Row }) => {
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
      {unbilledShows.length === 0 ? (
        <p className="text-muted border-l-2 border-line pl-4 py-1 mb-12">
          Nothing untracked and unbilled. Everything you&rsquo;ve worked is on an invoice.
        </p>
      ) : (
        <div className="mb-12">
          <UnbilledShows shows={unbilledShows} />
        </div>
      )}

      <h2 className="eyebrow mb-4">Billed</h2>
      <ul className="border-t border-line">{billed.map((r) => <BilledRow key={r.id} r={r} />)}</ul>
    </AppShell>
  )
}
