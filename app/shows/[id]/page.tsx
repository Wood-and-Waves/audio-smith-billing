import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { isIncompleteDay } from '@/lib/chronology'
import { formatDateLong, formatDateShort } from '@/lib/dates'
import { instantToWall } from '@/lib/zonedTime'
import { formatUSD, formatQty, lineTotal } from '@/lib/money'
import { computeShowLines, rulesetAndRatesFor, type PmEntryLike } from '@/lib/showBuckets'
import { calculateNetHours, type ShowDayLike } from '@/lib/payroll'
import { expenseLines, expensesMissingReceipts, type ExpenseCategory } from '@/lib/expenses'
import AppShell from '@/components/AppShell'
import PunchClock from '@/components/PunchClock'
import ShowDayControls from '@/components/ShowDayControls'
import ShowSettings from '@/components/ShowSettings'
import HalfDayToggle from '@/components/HalfDayToggle'
import RemoveDayButton from '@/components/RemoveDayButton'
import TravelLegToggle from '@/components/TravelLegToggle'
import PmLog from '@/components/PmLog'
import ExpenseLog from '@/components/ExpenseLog'
import DeleteShowButton from '@/components/DeleteShowButton'

export const dynamic = 'force-dynamic'

type Punch = { id: string; punch_type: string; punched_at: string }
type Day = {
  id: string; date: string; travel_in: boolean; travel_out: boolean
  pay_as_half_day: boolean; punches: Punch[]
}
type PmEntry = { id: string; worked_on: string; minutes: number; note: string | null }
type Expense = {
  id: string; category: ExpenseCategory; where_spent: string
  amount_cents: number; spent_on: string; receipt_path: string | null
}
type ShowRow = {
  id: string; name: string; venue: string | null; location: string | null
  notes: string | null; timezone: string
  status: string; invoice_id: string | null
  day_rate_cents: number; travel_rate_cents: number; pm_rate_cents: number
  ot_after_hours: number; dt_after_hours: number | null
  minimum_meal_break_minutes: number; meal_break_deduction_cap: number
  meal_penalty_grace_hours: number; meal_penalty_cents: number
  short_turn_rest_hours: number; continuous_time_enabled: boolean
  rate_card_name: string | null
  clients: { name: string } | null
  show_days: Day[]
  pm_entries: PmEntry[]
  expenses: Expense[]
}

export default async function ShowPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('shows')
    .select(`id, name, venue, location, notes, timezone, status, invoice_id,
             day_rate_cents, travel_rate_cents, pm_rate_cents, ot_after_hours,
             dt_after_hours, minimum_meal_break_minutes, meal_break_deduction_cap,
             meal_penalty_grace_hours, meal_penalty_cents, short_turn_rest_hours,
             continuous_time_enabled, rate_card_name,
             clients(name),
             show_days(id, date, travel_in, travel_out, pay_as_half_day,
                       punches(id, punch_type, punched_at)),
             pm_entries(id, worked_on, minutes, note),
             expenses(id, category, where_spent, amount_cents, spent_on, receipt_path)`)
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

  // Today in the SHOW's zone, not Chicago. todayInChicago() would be a
  // simpler string compare, but every show carries its own timezone and for
  // one hour a day the two disagree — on an Orlando show that means the wrong
  // row is highlighted exactly when Dan is on site late.
  const todayHere = instantToWall(new Date().toISOString(), s.timezone).date

  const { rules, rates } = rulesetAndRatesFor(s)
  // Pure functions — safe to call straight from a server component to render
  // a live preview of what this show would bill if billed right now. Must
  // load the same pm_entries billShows does (app/shows/actions.ts) and append
  // expenseLines(s.expenses) in the same order billShows does, or this
  // preview can disagree with the invoice it produces — a show whose only
  // billable thing is an unreceipted-but-now-photographed expense (no
  // punches at all) would otherwise preview as empty and stay unbillable in
  // the UI even though billShows would happily bill it.
  const lines = [
    ...computeShowLines(
      days as unknown as ShowDayLike[], s.pm_entries as unknown as PmEntryLike[], rates, rules),
    ...expenseLines(s.expenses ?? []),
  ]
  const previewTotal = lines.reduce((t, l) => t + lineTotal(l.qty_hundredths, l.unit_price_cents), 0)

  // Shares isIncompleteDay with billShows (app/shows/actions.ts) so this
  // banner and the billing gate can never disagree about what's billable.
  // A day with a start punch and no end punch (or vice versa), or an
  // unpaired meal punch, would otherwise silently bill wrong hours. A day
  // with no punches at all (e.g. a travel-only leg) is not "incomplete" —
  // isIncompleteDay only flags an unpaired start/end or meal punch.
  const incompleteDates = days
    .filter((d) => isIncompleteDay(d.punches))
    .map((d) => formatDateShort(d.date))

  // Shares expensesMissingReceipts with billShows (app/shows/actions.ts) so
  // this banner and the billing gate can never disagree about which expenses
  // block billing. "Every expense has to have a receipt to bill" — the design
  // asks for this to be predicted before the click, the same way an
  // incomplete punch already is above.
  const expensesNeedingReceipts = expensesMissingReceipts(s.expenses ?? [])
    .map((e) => e.where_spent)

  // Counts DeleteShowButton needs to name what a delete destroys, and the
  // date ShowDayControls needs to default the next range's From to the day
  // after this show's last existing day.
  const punchCount = days.reduce((t, d) => t + d.punches.length, 0)
  const lastDayDate = days.length > 0 ? days[days.length - 1].date : null

  return (
    <AppShell current="shows">
      <div className="mb-8">
        <h1 className="display text-3xl font-bold">{s.name}</h1>
        <p className="text-sm text-muted mt-1">
          {s.clients?.name}{s.location ? ` · ${s.location}` : ''}{s.venue ? ` · ${s.venue}` : ''}
        </p>
      </div>

      <ShowSettings
        initial={{
          id: s.id,
          name: s.name,
          venue: s.venue,
          location: s.location,
          notes: s.notes,
          timezone: s.timezone,
          rate_card_name: s.rate_card_name,
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
              // Today gets an amber edge and a chip. Before this the only thing
              // separating one day from the next was a hairline in #2a3441 on a
              // #121212 background, and each row is tall enough that one or two
              // fill a phone screen — so on site, mid-show, the days ran
              // together and it was easy to punch the wrong one.
              <li key={d.id}
                  className={d.date === todayHere
                    ? 'border-b border-line py-4 pl-3 -ml-3 border-l-2 border-l-accent bg-accent-wash'
                    : 'border-b border-line py-4'}>
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 mb-2">
                  <span className="font-semibold">
                    {formatDateLong(d.date)}
                    {d.date === todayHere && (
                      <span className="ml-2 align-middle text-[11px] font-bold uppercase tracking-wider
                                       text-accent-ink bg-accent-surface rounded-field px-1.5 py-0.5">
                        Today
                      </span>
                    )}
                  </span>
                  <span className="flex items-baseline gap-3">
                    <span className="eyebrow">
                      {[
                        d.travel_in && 'travel in',
                        d.travel_out && 'travel out',
                        d.pay_as_half_day && 'half day',
                        // A day carrying a travel leg but no punches (e.g. a
                        // pure fly-in day) is intentional, not an unfinished
                        // day someone forgot to punch — say so.
                        d.punches.length === 0 && (d.travel_in || d.travel_out) && 'travel only',
                      ].filter(Boolean).join(' · ')}
                    </span>
                    <RemoveDayButton showDayId={d.id} date={d.date} locked={locked} />
                  </span>
                </div>
                {/* Every show_days row is a work day now (migration 0005 dropped
                    day_type); travel is an orthogonal flag, so punches, the
                    travel-leg checkboxes and the half-day toggle all apply
                    together — a day flown in and worked still needs all three. */}
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  <PunchClock
                    showId={s.id}
                    showDayId={d.id}
                    date={d.date}
                    timezone={s.timezone}
                    punches={d.punches}
                    locked={locked}
                  />
                  <span className="flex flex-wrap items-center gap-3">
                    <TravelLegToggle showDayId={d.id} leg="in" checked={d.travel_in} locked={locked} />
                    <TravelLegToggle showDayId={d.id} leg="out" checked={d.travel_out} locked={locked} />
                  </span>
                  {
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
                  }
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <PmLog showId={s.id} entries={s.pm_entries} locked={locked} />

      <ExpenseLog showId={s.id} expenses={s.expenses} locked={locked} />

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

      <section className="mb-10">
        <h2 className="eyebrow mb-4">{locked ? 'Billed' : 'Actions'}</h2>
        <ShowDayControls
          showId={s.id}
          status={s.status}
          invoiceId={s.invoice_id}
          hasLines={lines.length > 0}
          incompleteDates={incompleteDates}
          expensesNeedingReceipts={expensesNeedingReceipts}
          lastDayDate={lastDayDate}
        />
      </section>

      <section className="pt-6 border-t border-line">
        <DeleteShowButton
          showId={s.id}
          locked={locked}
          dayCount={days.length}
          punchCount={punchCount}
          pmEntryCount={s.pm_entries.length}
          expenseCount={(s.expenses ?? []).length}
        />
      </section>
    </AppShell>
  )
}
