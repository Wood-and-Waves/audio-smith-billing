import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { isIncompleteDay } from '@/lib/chronology'
import { formatDateLong, formatDateShort } from '@/lib/dates'
import { formatUSD, formatQty, lineTotal, overtimeRateFrom, doubleTimeRateFrom } from '@/lib/money'
import { computeShowLines, type ShowRates } from '@/lib/showBuckets'
import { calculateNetHours, type ShowDayLike, type ShowRuleset } from '@/lib/payroll'
import AppShell from '@/components/AppShell'
import PunchClock from '@/components/PunchClock'
import ShowDayControls from '@/components/ShowDayControls'
import ShowSettings from '@/components/ShowSettings'
import HalfDayToggle from '@/components/HalfDayToggle'
import RemoveDayButton from '@/components/RemoveDayButton'

export const dynamic = 'force-dynamic'

const DAY_TYPE_LABEL: Record<string, string> = { show: 'Show', travel: 'Travel', pm: 'PM' }

type Punch = { id: string; punch_type: string; punched_at: string }
type Day = {
  id: string; date: string; day_type: 'show' | 'travel' | 'pm'
  pay_as_half_day: boolean; punches: Punch[]
}
type ShowRow = {
  id: string; name: string; venue: string | null; notes: string | null; timezone: string
  status: string; invoice_id: string | null
  day_rate_cents: number; travel_rate_cents: number; pm_rate_cents: number
  ot_after_hours: number; dt_after_hours: number | null
  minimum_meal_break_minutes: number; meal_break_deduction_cap: number
  meal_penalty_grace_hours: number; meal_penalty_cents: number
  short_turn_rest_hours: number; continuous_time_enabled: boolean
  clients: { name: string } | null
  show_days: Day[]
}

export default async function ShowPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('shows')
    .select(`id, name, venue, notes, timezone, status, invoice_id,
             day_rate_cents, travel_rate_cents, pm_rate_cents, ot_after_hours,
             dt_after_hours, minimum_meal_break_minutes, meal_break_deduction_cap,
             meal_penalty_grace_hours, meal_penalty_cents, short_turn_rest_hours,
             continuous_time_enabled,
             clients(name),
             show_days(id, date, day_type, pay_as_half_day, punches(id, punch_type, punched_at))`)
    .eq('id', id)
    .maybeSingle()

  if (error) {
    return (
      <AppShell current="shows">
        <p role="alert" className="text-danger border-l-2 border-danger pl-4 py-2">
          Couldn&rsquo;t load this show: {error.message}
        </p>
      </AppShell>
    )
  }
  if (!data) notFound()

  const s = data as unknown as ShowRow
  const days = [...s.show_days].sort((a, b) => a.date.localeCompare(b.date))
  const locked = s.status === 'billed'

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
  // Pure function — safe to call straight from a server component to render
  // a live preview of what this show would bill if billed right now.
  const lines = computeShowLines(days as unknown as ShowDayLike[], rates, rules)
  const previewTotal = lines.reduce((t, l) => t + lineTotal(l.qty_hundredths, l.unit_price_cents), 0)

  // Shares isIncompleteDay with billShows (app/shows/actions.ts) so this
  // banner and the billing gate can never disagree about what's billable.
  // A day with a start punch and no end punch (or vice versa), or an
  // unpaired meal punch, would otherwise silently bill wrong hours. Travel
  // days legitimately have no punches at all and are not "incomplete".
  const incompleteDates = days
    .filter((d) => d.day_type !== 'travel')
    .filter((d) => isIncompleteDay(d.punches))
    .map((d) => formatDateShort(d.date))

  return (
    <AppShell current="shows">
      <div className="mb-8">
        <h1 className="display text-3xl font-bold">{s.name}</h1>
        <p className="text-sm text-muted mt-1">
          {s.clients?.name}{s.venue ? ` · ${s.venue}` : ''}
        </p>
      </div>

      <ShowSettings
        initial={{
          id: s.id,
          name: s.name,
          venue: s.venue,
          notes: s.notes,
          day_rate_cents: s.day_rate_cents,
          travel_rate_cents: s.travel_rate_cents,
          pm_rate_cents: s.pm_rate_cents,
          ot_after_hours: s.ot_after_hours,
          dt_after_hours: s.dt_after_hours,
          minimum_meal_break_minutes: s.minimum_meal_break_minutes,
          meal_break_deduction_cap: s.meal_break_deduction_cap,
          meal_penalty_grace_hours: s.meal_penalty_grace_hours,
          meal_penalty_cents: s.meal_penalty_cents,
          short_turn_rest_hours: s.short_turn_rest_hours,
          continuous_time_enabled: s.continuous_time_enabled,
        }}
        locked={locked}
      />

      <section className="mb-10">
        <h2 className="eyebrow mb-4">Days</h2>
        {days.length === 0 ? (
          <p className="text-muted border-l-2 border-line pl-4 py-1">
            No days added yet.
          </p>
        ) : (
          <ul className="border-t border-line">
            {days.map((d) => (
              <li key={d.id} className="border-b border-line py-4">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 mb-2">
                  <span className="font-semibold">{formatDateLong(d.date)}</span>
                  <span className="flex items-baseline gap-3">
                    <span className="eyebrow">
                      {DAY_TYPE_LABEL[d.day_type]}{d.pay_as_half_day ? ' · half day' : ''}
                    </span>
                    <RemoveDayButton showDayId={d.id} date={d.date} locked={locked} />
                  </span>
                </div>
                {d.day_type === 'travel' ? (
                  <p className="text-xs text-muted">Travel day — billed by rate, no punches needed.</p>
                ) : (
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                    <PunchClock
                      showId={s.id}
                      showDayId={d.id}
                      timezone={s.timezone}
                      punches={d.punches}
                      locked={locked}
                    />
                    {d.day_type === 'show' && (
                      // The toggle only appears under 5 net hours — a half
                      // day is meant for a short call, not a full one — but
                      // a day that already has the flag stays visible so it
                      // can always be cleared, even if it later grew past 5
                      // hours (e.g. after adding punches).
                      (calculateNetHours(d as unknown as ShowDayLike, rules) < 5 || d.pay_as_half_day) && (
                        <HalfDayToggle
                          showDayId={d.id}
                          checked={d.pay_as_half_day}
                          locked={locked}
                        />
                      )
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mb-10">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 mb-4">
          <h2 className="eyebrow">Preview</h2>
          {lines.length > 0 && (
            <p className="tabular text-sm text-muted">
              <span className="text-ink font-semibold">{formatUSD(previewTotal)}</span>
            </p>
          )}
        </div>
        {lines.length === 0 ? (
          <p className="text-muted border-l-2 border-line pl-4 py-1">
            Nothing billable yet — complete a punch to see a line here.
          </p>
        ) : (
          <ul className="border-t border-line">
            {lines.map((l) => (
              <li key={l.description}
                  className="flex flex-wrap items-baseline justify-between gap-x-4 border-b border-line py-2">
                <span className="text-sm">
                  {l.description} <span className="tabular text-muted">× {formatQty(l.qty_hundredths)}</span>
                </span>
                <span className="tabular text-sm font-semibold">
                  {formatUSD(lineTotal(l.qty_hundredths, l.unit_price_cents))}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="eyebrow mb-4">{locked ? 'Billed' : 'Actions'}</h2>
        <ShowDayControls
          showId={s.id}
          status={s.status}
          invoiceId={s.invoice_id}
          hasLines={lines.length > 0}
          incompleteDates={incompleteDates}
        />
      </section>
    </AppShell>
  )
}
