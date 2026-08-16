import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { isUnfinishedDay } from '@/lib/chronology'
import { formatDateShort, todayInChicago } from '@/lib/dates'
import { byDateClosestFirst } from '@/lib/showOrder'
import { lineTotal } from '@/lib/money'
import { computeShowLines, rulesetAndRatesFor, type PmEntryLike } from '@/lib/showBuckets'
import type { ShowDayLike } from '@/lib/payroll'
import { expenseLines, expensesMissingReceipts, type ExpenseCategory } from '@/lib/expenses'
import AppShell from '@/components/AppShell'
import UnbilledShows, { type UnbilledShow } from '@/components/UnbilledShows'

export const dynamic = 'force-dynamic'

type Punch = { punch_type: string; punched_at: string }
type Day = { id: string; date: string; travel_in: boolean; travel_out: boolean; pay_as_half_day: boolean; punches: Punch[] }
type PmEntry = { minutes: number }
type Expense = {
  id: string; category: ExpenseCategory; where_spent: string
  amount_cents: number; spent_on: string; receipt_path: string | null
}
type Row = {
  id: string; name: string; venue: string | null; location: string | null
  status: string; client_id: string
  day_rate_cents: number; travel_rate_cents: number; pm_rate_cents: number
  ot_after_hours: number; dt_after_hours: number | null
  minimum_meal_break_minutes: number; meal_break_deduction_cap: number
  meal_penalty_grace_hours: number; meal_penalty_cents: number
  short_turn_rest_hours: number; continuous_time_enabled: boolean
  bill_hourly: boolean
  rate_card_name: string | null
  clients: { name: string } | null; show_days: Day[]; pm_entries: PmEntry[]
  expenses: Expense[]
}

export default async function ShowsPage() {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('shows')
    .select(`id, name, venue, location, status, created_at, client_id,
             day_rate_cents, travel_rate_cents, pm_rate_cents, ot_after_hours,
             dt_after_hours, minimum_meal_break_minutes, meal_break_deduction_cap,
             meal_penalty_grace_hours, meal_penalty_cents, short_turn_rest_hours,
             continuous_time_enabled, bill_hourly, rate_card_name,
             clients(name),
             show_days(id, date, travel_in, travel_out, pay_as_half_day, punches(punch_type, punched_at)),
             pm_entries(minutes),
             expenses(id, category, where_spent, amount_cents, spent_on, receipt_path)`)
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
  // Closest first, not created_at — the order Dan happened to type shows in
  // tells him nothing a month later, and what he scans this page for is what
  // is next. A show still running outranks one that has not started; finished
  // ones follow, most recent first, because a trip just back from is the one
  // still being billed.
  //
  // Sorted here rather than in the query: the key is the earliest show_days
  // date, which is not a column on shows. Chicago is fine for the bucket — a
  // list ordering does not need each show's own zone the way a highlighted
  // "today" row does.
  const today = todayInChicago()
  const byDate = <T extends { show_days: { date: string }[] }>(list: T[]) =>
    byDateClosestFirst(
      list.map((r) => ({ ...r, dates: r.show_days.map((d) => d.date) })), today)

  const unbilled = byDate(rows.filter((r) => r.status === 'open'))
  const billed = byDate(rows.filter((r) => r.status === 'billed'))

  // Money lives here, on the server, in integer cents — never in the client
  // component. Each unbilled show gets its own computeShowLines pass, built
  // from the same rulesetAndRatesFor(show) that billShows and
  // app/shows/[id]/page.tsx call, and then expenseLines(s.expenses) appended
  // in the same order billShows uses (app/shows/actions.ts), so the per-show
  // lines below can never disagree with what billing would compute for that
  // show — a show billing labour AND expenses previews both, and a show
  // billing only expenses (no punches at all) still produces lines here
  // instead of showing as empty.
  //
  // We hand the raw BucketLine[] down to UnbilledShows (not just a total):
  // when several shows are selected together, the multi-show total must run
  // those lines through the SAME mergeLines-then-lineTotal order billShows
  // uses, or a preview built from per-show rounded totals can disagree with
  // the invoice by a cent (round(a) + round(b) is not always round(a + b)).
  const unbilledShows: UnbilledShow[] = unbilled.map((s) => {
    const days = [...s.show_days].sort((a, b) => a.date.localeCompare(b.date))
    const { rules, rates } = rulesetAndRatesFor(s)
    const lines = [
      ...computeShowLines(
        days as unknown as ShowDayLike[], (s.pm_entries ?? []) as PmEntryLike[], rates, rules),
      ...expenseLines(s.expenses ?? []),
    ]
    const totalCents = lines.reduce((t, l) => t + lineTotal(l.qty_hundredths, l.unit_price_cents), 0)

    // Shares isUnfinishedDay with billShows and the show detail page so this
    // list can never mark a show billable that billShows would reject. Blocks a
    // dangling punch AND a day with no punches that isn't marked travel — the
    // day Dan forgot to clock — while leaving a real travel day alone.
    const unfinishedDates = days
      .filter((d) => isUnfinishedDay(d))
      .map((d) => formatDateShort(d.date))

    // Shares expensesMissingReceipts with billShows and the show detail page
    // so this list, the detail page's gate, and the server refusal can never
    // disagree about which expenses block billing.
    const expensesNeedingReceipts = expensesMissingReceipts(s.expenses ?? [])
      .map((e) => e.where_spent)

    // In progress = today falls within the show's own days. This is the show
    // being worked right now, highlighted like the current day on the show
    // page — a show entirely in the past or future is not. Chicago is close
    // enough for a list badge; the detail page uses the show's exact zone.
    const inProgress = days.length > 0
      && days[0].date <= today && today <= days[days.length - 1].date

    return {
      id: s.id,
      name: s.name,
      venue: s.venue,
      location: s.location,
      clientName: s.clients?.name ?? 'Unknown client',
      dates: days.map((d) => d.date),
      totalCents,
      unfinishedDates,
      expensesNeedingReceipts,
      inProgress,
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
          {/* Location, not venue: the city is what Dan scans for here (he used
              to type it into the show name to find it), and venue is the long
              building name that already runs on for a full line on its own —
              see the show page. Dropping venue from this line, rather than
              appending a third segment, is what keeps it readable at 375px. */}
          <p className="text-xs text-muted mt-1">
            {r.clients?.name}{r.location ? ` · ${r.location}` : ''}
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
