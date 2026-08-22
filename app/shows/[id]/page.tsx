import Link from 'next/link'
import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { isUnfinishedDay } from '@/lib/chronology'
import { formatDateLong, formatDateShort } from '@/lib/dates'
import { instantToWall } from '@/lib/zonedTime'
import { formatUSD, formatQty, lineTotal } from '@/lib/money'
import { showProfit } from '@/lib/showProfit'
import { computeShowLines, rulesetAndRatesFor, type PmEntryLike } from '@/lib/showBuckets'
import {
  calculateNetHours, paidNetHours, paidStraightTimeHours, paidOvertimeHours,
  paidDoubleTimeHours, mealPenaltyCount, type ShowDayLike,
} from '@/lib/payroll'
import { expenseLines, expensesMissingReceipts, type ExpenseCategory } from '@/lib/expenses'
import AppShell from '@/components/AppShell'
import PunchClock from '@/components/PunchClock'
import ShowDayControls from '@/components/ShowDayControls'
import ShowSettings from '@/components/ShowSettings'
import HalfDayToggle from '@/components/HalfDayToggle'
import RemoveDayButton from '@/components/RemoveDayButton'
import TravelLegToggle from '@/components/TravelLegToggle'
import TravelWorksToggle from '@/components/TravelWorksToggle'
import PmLog from '@/components/PmLog'
import ExpenseLog from '@/components/ExpenseLog'
import DeleteShowButton from '@/components/DeleteShowButton'

export const dynamic = 'force-dynamic'

type Punch = { id: string; punch_type: string; punched_at: string }
type Day = {
  id: string; date: string; travel_in: boolean; travel_out: boolean
  pay_as_half_day: boolean; travel_works: boolean; punches: Punch[]
}
type PmEntry = { id: string; worked_on: string; minutes: number; note: string | null }
type Expense = {
  id: string; category: ExpenseCategory; where_spent: string
  amount_cents: number; spent_on: string; receipt_path: string | null
  receipt_original: string | null
  // Arrives via migration 0019 — set only once an original's Dropbox copy is
  // verified by size and content hash.
  receipt_archived_at: string | null
  billable: boolean
}
type ShowRow = {
  id: string; name: string; venue: string | null; location: string | null
  notes: string | null; timezone: string
  status: string; invoice_id: string | null
  day_rate_cents: number; travel_rate_cents: number; pm_rate_cents: number
  pm_role: boolean
  ot_after_hours: number; dt_after_hours: number | null
  minimum_meal_break_minutes: number; meal_break_deduction_cap: number
  meal_penalty_grace_hours: number; meal_penalty_cents: number
  short_turn_rest_hours: number; continuous_time_enabled: boolean
  bill_hourly: boolean
  rate_card_name: string | null
  clients: { name: string } | null
  invoices: { number: number; status: string; subtotal_cents: number } | null
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
             day_rate_cents, travel_rate_cents, pm_rate_cents, pm_role, ot_after_hours,
             dt_after_hours, minimum_meal_break_minutes, meal_break_deduction_cap,
             meal_penalty_grace_hours, meal_penalty_cents, short_turn_rest_hours,
             continuous_time_enabled, bill_hourly, rate_card_name,
             clients(name),
             invoices(number, status, subtotal_cents),
             show_days(id, date, travel_in, travel_out, pay_as_half_day, travel_works,
                       punches(id, punch_type, punched_at)),
             pm_entries(id, worked_on, minutes, note),
             expenses(id, category, where_spent, amount_cents, spent_on, receipt_path,
                      receipt_original, receipt_archived_at, billable)`)
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

  // The set-aside rate is Dan's own settings row — RLS scopes the read the
  // same way the shows query above is scoped.
  const { data: settingsRow } = await supabase
    .from('settings').select('tax_setaside_bp').maybeSingle()
  const setasideBp = settingsRow?.tax_setaside_bp ?? 0

  const days = [...s.show_days].sort((a, b) => a.date.localeCompare(b.date))
  const locked = s.status === 'billed'

  // Today in the SHOW's zone, not Chicago. todayInChicago() would be a
  // simpler string compare, but every show carries its own timezone and for
  // one hour a day the two disagree — on an Orlando show that means the wrong
  // row is highlighted exactly when Dan is on site late.
  const todayHere = instantToWall(new Date().toISOString(), s.timezone).date

  const { rules, rates } = rulesetAndRatesFor(s)
  // The per-day hours breakdown below and the OT/DT bucket functions all need
  // the whole set of days, because a short turnaround is a relationship between
  // one day's end and the next day's start.
  const typedDays = days as unknown as ShowDayLike[]
  // Hours as they read on the invoice: two decimals, trailing zeros trimmed
  // (8, 8.5, 10.25) — the same numbers billShows turns into qty_hundredths.
  const fmtHours = (n: number) => (Math.round(n * 100) / 100).toString()
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

  // Dan's side of the show. Revenue is the real invoice once billed (the
  // frozen truth), the live preview before that. Costs are EVERY expense he
  // paid: billable ones sit in revenue too and net to zero — which is what
  // makes a reimbursement show read as pure labor — while my-cost (per-diem)
  // ones only subtract. This card is the whole reason my-cost exists.
  const expensesPaidCents = (s.expenses ?? []).reduce((t, e) => t + e.amount_cents, 0)
  // The invoice subtotal is only THIS show's revenue when the invoice covers
  // exactly this show, isn't void, and the coverage count itself is known.
  // subtotal_cents, not total_cents: total_cents is net of any deposit
  // (subtotal + tax − deposit, see lib/money.ts), so a recorded deposit would
  // silently shrink the revenue and set-aside this card shows. subtotal also
  // makes the preview→billed transition continuous, since previewTotal IS
  // this show's subtotal by construction. billShows can merge several shows
  // onto one invoice (nothing in the UI does today, but the capability
  // exists and historical data could), and invoice_lines carries no per-show
  // split — so on a shared invoice the honest per-show figure is this show's
  // own lines, and the card says so rather than silently inflating profit
  // with other shows' money. A void invoice is the same story: it isn't
  // revenue, so the card falls back to this show's own lines there too.
  let invoiceShowCount: number | null = null
  if (locked && s.invoice_id) {
    const { count, error: countError } = await supabase
      .from('shows')
      .select('id', { count: 'exact', head: true })
      .eq('invoice_id', s.invoice_id)
    // null means unknown — a failed query or (defensively) a null count from
    // Supabase. Fail SAFE: an unknown count must never resolve to "sole
    // coverage" the way `count ?? 1` used to — that is the exact inflation
    // this guard exists to prevent. Unknown falls through to previewTotal
    // below, exactly like a confirmed >1.
    invoiceShowCount = countError || count === null ? null : count
  }
  const invoiceIsVoid = s.invoices?.status === 'void'
  const revenueCents = locked && s.invoices && !invoiceIsVoid && invoiceShowCount === 1
    ? s.invoices.subtotal_cents
    : previewTotal
  const profit = showProfit({ revenueCents, expensesPaidCents, setasideBp })

  // Shares isUnfinishedDay with billShows (app/shows/actions.ts) so this banner
  // and the billing gate can never disagree about what's billable. Flags a
  // dangling start/end or meal punch, AND a day with no punches that isn't
  // marked travel — the day forgotten before billing. A travel-only day (a leg,
  // no punches) is deliberate and stays clear.
  const unfinishedDates = days
    .filter((d) => isUnfinishedDay(d))
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
          pm_role: s.pm_role,
          ot_after_hours: s.ot_after_hours,
          dt_after_hours: s.dt_after_hours,
          minimum_meal_break_minutes: s.minimum_meal_break_minutes,
          meal_break_deduction_cap: s.meal_break_deduction_cap,
          meal_penalty_grace_hours: s.meal_penalty_grace_hours,
          meal_penalty_cents: s.meal_penalty_cents,
          short_turn_rest_hours: s.short_turn_rest_hours,
          continuous_time_enabled: s.continuous_time_enabled,
          bill_hourly: s.bill_hourly,
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
            {days.map((d) => {
              // The same functions billShows uses, per day, so the breakdown
              // shown here is exactly what this day would bill — the number Dan
              // needs to check the OT math on site, which had no home before.
              const dd = d as unknown as ShowDayLike
              const net = paidNetHours(dd, rules)
              const st = paidStraightTimeHours(dd, typedDays, rules)
              const ot = paidOvertimeHours(dd, typedDays, rules)
              const dt = paidDoubleTimeHours(dd, typedDays, rules)
              const mp = mealPenaltyCount(dd, rules)
              // A sub-threshold day in an hourly show bills hourly, not ST/OT/DT —
              // read it that way here too, so the breakdown always matches the
              // invoice. st is whole hours, so st * hourly_rate_cents is the
              // exact line total (same product the billing engine uses).
              const breakdown = (rates.bill_hourly && st > 0 && st < rules.overtime_after_hours)
                ? `${fmtHours(st)} hrs → ${formatUSD(st * rates.hourly_rate_cents)} hourly`
                : [
                    net > 0 && `${fmtHours(net)} net`,
                    st > 0 && `${fmtHours(st)} ST`,
                    ot > 0 && `${fmtHours(ot)} OT`,
                    dt > 0 && `${fmtHours(dt)} DT`,
                    mp > 0 && `meal penalty ×${mp}`,
                  ].filter(Boolean).join(' · ')

              // Today gets an amber edge and a chip. Before this the only thing
              // separating one day from the next was a hairline in #2a3441 on a
              // #121212 background, and each row is tall enough that one or two
              // fill a phone screen — so on site, mid-show, the days ran
              // together and it was easy to punch the wrong one.
              return (
              <li key={d.id}
                  className={`border-b border-line py-4 pl-3 -ml-3 pr-3 ${
                    d.date === todayHere ? 'border-l-2 border-l-accent bg-accent-wash' : ''
                  }`}>
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
                        // A travel day Dan also expects to work (travel_works,
                        // migration 0036) bills a day rate on top of the leg —
                        // say so, so the eyebrow agrees with the forecast.
                        d.travel_works && 'also working',
                        // A day carrying a travel leg but no punches (e.g. a
                        // pure fly-in day) is intentional, not an unfinished
                        // day someone forgot to punch — say so. But not when
                        // travel_works is set: the forecast prices that day as
                        // travel + day rate, so "travel only" would contradict it.
                        d.punches.length === 0 && (d.travel_in || d.travel_out) && !d.travel_works && 'travel only',
                      ].filter(Boolean).join(' · ')}
                    </span>
                    <RemoveDayButton showDayId={d.id} date={d.date} locked={locked} />
                  </span>
                </div>
                {/* The hours this day bills, split into buckets. Only shown when
                    there is something to show — a travel-only or not-yet-punched
                    day has no hours and stays quiet. An incomplete punch is
                    flagged by the banner above, not here. */}
                {breakdown && (
                  <p className="tabular text-xs text-muted mb-2">{breakdown}</p>
                )}
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
                    highlighted={d.date === todayHere}
                  />
                  <span className="flex flex-wrap items-center gap-3">
                    <TravelLegToggle showDayId={d.id} leg="in" checked={d.travel_in} locked={locked} />
                    <TravelLegToggle showDayId={d.id} leg="out" checked={d.travel_out} locked={locked} />
                    {
                      // Only offered once a leg is actually flagged — a day
                      // with no travel has nothing for "also working" to
                      // qualify, and setTravelLeg itself clears travel_works
                      // the moment the last leg is cleared, so this stays
                      // consistent with what can actually be stored.
                      (d.travel_in || d.travel_out) && (
                        <TravelWorksToggle showDayId={d.id} checked={d.travel_works} locked={locked} />
                      )
                    }
                  </span>
                  {
                    // The toggle only appears under 5 net hours — a half
                    // day is meant for a short call, not a full one — but
                    // a day that already has the flag stays visible so it
                    // can always be cleared, even if it later grew past 5
                    // hours (e.g. after adding punches). Hourly billing is
                    // already finer-grained than a half day, so it never
                    // shows in an hourly show.
                    !rates.bill_hourly && (calculateNetHours(d as unknown as ShowDayLike, rules) < 5 || d.pay_as_half_day) && (
                      <HalfDayToggle
                        showDayId={d.id}
                        checked={d.pay_as_half_day}
                        locked={locked}
                      />
                    )
                  }
                </div>
              </li>
              )
            })}
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

      {(lines.length > 0 || expensesPaidCents > 0) && (
        <section className="mb-10">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 mb-4">
            <h2 className="eyebrow">Profit</h2>
            <p className="text-xs text-muted">estimate — your money, never on the invoice</p>
          </div>
          <ul className="border-t border-line text-sm">
            <li className="flex items-baseline justify-between gap-x-4 border-b border-line py-2">
              <span>
                Revenue
                {locked && s.invoices && invoiceIsVoid && (
                  <span className="text-muted">
                    {' '}· invoice #{s.invoices.number} is void — showing this show&rsquo;s lines
                  </span>
                )}
                {locked && s.invoices && !invoiceIsVoid && invoiceShowCount === 1 && (
                  <span className="text-muted"> · invoice #{s.invoices.number} · {s.invoices.status}</span>
                )}
                {locked && s.invoices && invoiceShowCount !== null && invoiceShowCount > 1 && (
                  <span className="text-muted">
                    {' '}· this show&rsquo;s lines — invoice #{s.invoices.number} covers {invoiceShowCount} shows
                  </span>
                )}
                {!locked && <span className="text-muted"> · preview</span>}
              </span>
              <span className="tabular font-semibold">{formatUSD(revenueCents)}</span>
            </li>
            {expensesPaidCents > 0 && (
              <li className="flex items-baseline justify-between gap-x-4 border-b border-line py-2">
                <span>Expenses you paid</span>
                <span className="tabular whitespace-nowrap">−{formatUSD(expensesPaidCents)}</span>
              </li>
            )}
            <li className="flex items-baseline justify-between gap-x-4 border-b border-line py-2">
              <span className="font-semibold">Profit</span>
              <span className="tabular font-semibold">{formatUSD(profit.profitCents)}</span>
            </li>
            {setasideBp > 0 && profit.setasideCents > 0 && (
              <>
                <li className="flex items-baseline justify-between gap-x-4 border-b border-line py-2">
                  {/* toFixed(2) then trim: 3000→30, 2750→27.5, 3333→33.33 — never "27.50". */}
                  <span>Set aside for taxes ({(setasideBp / 100).toFixed(2).replace(/\.?0+$/, '')}%) <Link href="/money/budget" className="text-xs text-muted hover:text-ink transition-colors">→ Taxes envelope</Link></span>
                  <span className="tabular whitespace-nowrap">−{formatUSD(profit.setasideCents)}</span>
                </li>
                <li className="flex items-baseline justify-between gap-x-4 border-b border-line py-2">
                  <span className="font-semibold">Take-home</span>
                  <span className="tabular font-semibold text-good">{formatUSD(profit.takeHomeCents)}</span>
                </li>
              </>
            )}
          </ul>
          {setasideBp === 0 && (
            <p className="text-xs text-muted mt-2">
              Set a tax set-aside rate in <Link href="/settings" className="underline hover:text-ink">Settings</Link> to
              estimate take-home.
            </p>
          )}
        </section>
      )}

      <section className="mb-10">
        <h2 className="eyebrow mb-4">{locked ? 'Billed' : 'Actions'}</h2>
        <ShowDayControls
          showId={s.id}
          status={s.status}
          invoiceId={s.invoice_id}
          hasLines={lines.length > 0}
          unfinishedDates={unfinishedDates}
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
