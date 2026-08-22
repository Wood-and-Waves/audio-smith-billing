// The cash-flow forecast: "covered through <month>," and the arithmetic that
// backs it up. Two things make this file trustworthy.
//
// First, it counts only booked work. Nothing here is invented about future
// bookings — a `sent` invoice, a `draft` invoice, and an unbilled open show
// are the only sources of money in. That means the model is free to be
// pessimistic (a thin calendar six months out reads as a thin runway) but it
// can never flatter Dan by assuming a booking that hasn't happened. Money out
// is real too: overhead is the trailing 3-month average of actual ledger
// spend, and the tax set-aside applies to projected profit at the rate Dan
// has configured in Settings — nothing here is tax advice, and the figure is
// only ever as good as the rate he's told it to use.
//
// Second, it writes nothing. Every value in a `Forecast` is derived fresh
// from its inputs on every call — no row is inserted, no envelope is funded,
// no invoice is touched. Calling this twice with the same inputs always
// produces the same answer, and calling it does not change what a third call
// would return.
//
// Pay lag is simply the client's `terms_days` (30 when the client can't be
// found) — no per-client learning happens here. A prior version tried to
// learn each client's real-world lag from settled invoices, but the lags it
// found were mostly an artifact of Dan's own mail habits, not client
// behavior — teaching the forecast the wrong thing. `terms_days` is what Dan
// actually told the client to expect, which is the only number this model
// has any business asserting.
//
// A show's cash also includes what the model ASSUMES about travel and PM
// time when the show data doesn't say so explicitly: an out-of-state show
// that runs more than one day, with no travel legs flagged on any of its
// days, is assumed to need two (see `stateOf` and the travel-leg rule in
// `projectedShowCents`) — a one-day out-of-town gig is flown in and out the
// same day, not billed as travel days, so a one-day show never gets the
// assumption. A show
// with `pm_role` set gets a flat `PM_FORECAST_HOURS` of PM time billed once,
// never per day. Both are reported per-show in `showProjections`, which
// lists exactly the shows that fed `inflows` — the two are computed from the
// same pass over `shows` so they can never drift apart.
//
// `today` is always a parameter, never read from a clock in here — see
// lib/dates.ts and lib/status.ts, which insist on the same thing for the
// same reason: a lib that reads its own clock can't be pinned by a test.
//
// No '@/' imports and no JSX — exercised by node --test.

import { addDays, addMonths } from './dates.ts'
import { instantToWall } from './zonedTime.ts'

// ---- inputs (DB-shaped, snake_case where they come from rows) ----

export type ForecastShowDay = {
  date: string // YYYY-MM-DD
  travel_in: boolean
  travel_out: boolean
  pay_as_half_day: boolean
}

/** Flat PM time billed once per show (not per day) when `pm_role` is set. */
export const PM_FORECAST_HOURS = 4

export type ForecastShow = {
  id: string
  name: string
  client_id: string
  status: 'open' | 'billed'
  day_rate_cents: number
  travel_rate_cents: number
  pm_rate_cents: number // hourly PM rate; billed PM_FORECAST_HOURS times when pm_role
  pm_role: boolean
  location: string | null // free text, e.g. "City, ST" — see stateOf
  days: ForecastShowDay[]
}

export type ForecastInvoice = {
  id: string
  number: number
  client_id: string
  status: 'draft' | 'sent' | 'paid' | 'void'
  total_cents: number
  sent_at: string | null // ISO; null on drafts
  paid_at: string | null // YYYY-MM-DD
  linked: boolean // has a ledger_transaction_invoices row
}

export type ForecastClient = { id: string; name: string; terms_days: number }

export type ForecastAssumptions = {
  takeHomeCents: number
  overheadCents: number // resolved: override ?? computed
  taxRateBp: number
  billingLagDays: number
}

// ---- outputs ----

export type ExpectedInflow = {
  month: string // YYYY-MM
  amountCents: number
  label: string // "#391 Clinique" | "Willow Creek (projected)"
  overdue: boolean // expected date already passed
}

export type ForecastMonth = {
  month: string // YYYY-MM
  incomeCents: number
  overheadCents: number
  taxCents: number
  drawCents: number
  endingBalanceCents: number
  covered: boolean // endingBalance >= 0
}

// A show the projection couldn't price or date, so it was left out of
// inflows rather than silently contributing nothing. See the show loop in
// buildForecast below for how each reason is detected.
export type NotProjectedShow = {
  showId: string
  name: string
  reason: 'no days' | 'no rate'
}

/** Per-show cash breakdown backing the forecast screen's show-by-show table.
 *  Lists every open, dated show buildForecast walked — including a $0 one,
 *  so nothing goes missing between here and notProjected — ordered by
 *  firstDay then name. `totalCents`/`landsMonth` always match the inflow
 *  that show produced (zero for a show with no inflow at all), because both
 *  come out of the same per-show computation in buildForecast. */
export type ShowProjection = {
  showId: string
  name: string
  firstDay: string
  lastDay: string
  dayCents: number // full + half days
  travelCents: number
  pmCents: number
  totalCents: number
  // Counts backing the money above, for the forecast screen's breakdown
  // line — same loop in computeShowBreakdown as dayCents/travelCents/pmCents,
  // never a second computation, so a count can never drift from its dollars.
  dayCount: number // scheduled days; a half day counts as 0.5
  travelLegs: number // flagged legs, or 2 when travelAssumed
  pmHours: number // 0 or PM_FORECAST_HOURS
  travelAssumed: boolean // true when the legs came from the out-of-state rule, not flagged days
  landsMonth: string // YYYY-MM the cash is expected
}

export type Forecast = {
  months: ForecastMonth[]
  coveredThrough: string | null // YYYY-MM; null = not even this month
  beyondHorizon: boolean // never went negative within 24 months
  bookedThrough: string | null // last month carrying booked WORK (not cash landing)
  inflows: ExpectedInflow[] // for the table's detail + overdue flags
  notProjected: NotProjectedShow[]
  showProjections: ShowProjection[] // ordered by firstDay then name
}

export const HORIZON_MONTHS = 24

// terms_days is missing only when a show/invoice's client_id doesn't match
// any row in the roster passed in — shouldn't happen, but this is the same
// "don't crash on bad data" doctrine as projectedShowCents' rate clamping.
const FALLBACK_TERMS_DAYS = 30

// `sent_at` is stamped `new Date().toISOString()` (sendInvoice) — a UTC
// instant, not a plain date. Slicing its first 10 characters reads the UTC
// calendar day, which for an evening-Chicago send is already tomorrow (or,
// near a month boundary, already next month) — the exact bug this file used
// to have. Every place that needs "what day did Dan send this, on his own
// clock" goes through here instead of a raw slice.
function sentAtChicagoDate(iso: string): string {
  return instantToWall(iso, 'America/Chicago').date
}

// Same doctrine as lib/dates.ts's monthGrid: day 0 of next month = last day
// of this one, entirely in UTC calendar-math space.
function daysInMonth(ym: string): number {
  const [y, m] = ym.split('-').map(Number)
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

/** Two-letter state parsed from a free-text location ("Orlando, FL" -> "FL").
 *  Takes the text after the LAST comma (so extra commas earlier in the
 *  string don't confuse it), trims and uppercases it, and accepts it only
 *  when that's exactly two A-Z letters. Null for null/empty/whitespace-only
 *  text, text with no comma at all, or a trailing token that isn't a clean
 *  two-letter code (a full state name, a trailing period, etc). */
export function stateOf(location: string | null): string | null {
  if (location === null) return null
  const parts = location.split(',')
  if (parts.length < 2) return null
  const candidate = parts[parts.length - 1].trim().toUpperCase()
  return /^[A-Z]{2}$/.test(candidate) ? candidate : null
}

type ShowBreakdown = {
  firstDay: string | null // null only when the show has no days
  lastDay: string | null
  dayCents: number
  travelCents: number
  pmCents: number
  totalCents: number
  dayCount: number // fullDays + halfDays * 0.5
  travelLegs: number // same value that priced travelCents
  pmHours: number // same value that priced pmCents
  travelAssumed: boolean
}

/** Every scheduled day is a work day (migration 0005). Travel legs come from
 *  flagged days when any are flagged; otherwise an out-of-state show (per
 *  `stateOf` vs `homeState`) that has MORE THAN ONE scheduled day is assumed
 *  to need exactly 2 legs — a single-day out-of-town gig is flown in and out
 *  the same day, not billed as travel days, so a one-day show never picks up
 *  the assumption. Flagged legs always win over the assumption in every
 *  case, including on a one-day show (the double-count guard) — if Dan
 *  flags travel on a single-day show, that flag is honored regardless. PM is
 *  `pm_role`'s flat `PM_FORECAST_HOURS * pm_rate_cents`, once per show
 *  regardless of day count. */
function computeShowBreakdown(show: ForecastShow, homeState: string): ShowBreakdown {
  // Guard against nonsense input without throwing: a negative rate would
  // otherwise subtract from the projection instead of contributing nothing.
  const dayRate = show.day_rate_cents > 0 ? show.day_rate_cents : 0
  const travelRate = show.travel_rate_cents > 0 ? show.travel_rate_cents : 0
  const pmRate = show.pm_rate_cents > 0 ? show.pm_rate_cents : 0
  const halfRate = Math.round(dayRate / 2)

  let fullDays = 0
  let halfDays = 0
  let flaggedLegs = 0
  let firstDay: string | null = null
  let lastDay: string | null = null

  for (const d of show.days) {
    if (d.pay_as_half_day) halfDays += 1
    else fullDays += 1
    if (d.travel_in) flaggedLegs += 1
    if (d.travel_out) flaggedLegs += 1
    if (firstDay === null || d.date < firstDay) firstDay = d.date
    if (lastDay === null || d.date > lastDay) lastDay = d.date
  }

  const dayCents = fullDays * dayRate + halfDays * halfRate

  let legs = 0
  let travelAssumed = false
  if (flaggedLegs > 0) {
    legs = flaggedLegs
  } else if (show.days.length > 1) {
    const showState = stateOf(show.location)
    if (showState !== null && showState !== homeState) {
      legs = 2
      travelAssumed = true
    }
  }
  const travelCents = legs * travelRate

  const pmHours = show.pm_role ? PM_FORECAST_HOURS : 0
  const pmCents = pmHours * pmRate

  return {
    firstDay, lastDay, dayCents, travelCents, pmCents, totalCents: dayCents + travelCents + pmCents,
    dayCount: fullDays + halfDays * 0.5, travelLegs: legs, pmHours, travelAssumed,
  }
}

export function projectedShowCents(show: ForecastShow, homeState: string): number {
  return computeShowBreakdown(show, homeState).totalCents
}

/** Trailing 3 COMPLETE calendar months of spend, excluding owner_pay and transfer. */
export function computeOverheadCents(
  txns: { date: string; amount_cents: number; kind: string }[], today: string,
): number {
  const currentMonth = today.slice(0, 7)
  const completeMonths = new Set([
    addMonths(currentMonth, -1), addMonths(currentMonth, -2), addMonths(currentMonth, -3),
  ])

  // The denominator is the number of those three months that have ANY
  // ledger history at all — not just expense rows. A month absent from the
  // ledger entirely (no import yet, a gap, a business that's too young to
  // have 3 months of data) must not silently count as a $0-spend month and
  // drag the average down; it should just not be averaged in. A month that
  // DOES have transactions but happens to have no expense-kind rows in it
  // (a genuinely frugal month, or one with only income/transfer activity)
  // is real data and must still count as a true zero in the average — that
  // distinction is why this is tracked separately from the sum below.
  const monthsWithHistory = new Set<string>()
  for (const t of txns) {
    const m = t.date.slice(0, 7)
    if (completeMonths.has(m)) monthsWithHistory.add(m)
  }
  if (monthsWithHistory.size === 0) return 0

  let total = 0
  for (const t of txns) {
    if (t.kind !== 'expense') continue // excludes owner_pay and transfer along with income
    if (!completeMonths.has(t.date.slice(0, 7))) continue
    total += -t.amount_cents // expense amounts are stored negative; spend is positive
  }
  return Math.round(total / monthsWithHistory.size)
}

type Bucketed = { month: string; overdue: boolean }

/** An expected date already in the past lands in today's month, flagged. */
function bucket(expectedDate: string, today: string): Bucketed {
  if (expectedDate < today) return { month: today.slice(0, 7), overdue: true }
  return { month: expectedDate.slice(0, 7), overdue: false }
}

export function buildForecast(input: {
  today: string // YYYY-MM-DD
  startingBalanceCents: number // available-to-allocate
  homeState: string // Dan's home state — drives the out-of-state travel assumption
  shows: ForecastShow[]
  invoices: ForecastInvoice[]
  clients: ForecastClient[]
  assumptions: ForecastAssumptions
}): Forecast {
  const { today, startingBalanceCents, homeState, shows, invoices, clients, assumptions } = input
  const clientNames = new Map(clients.map((c) => [c.id, c.name]))
  const clientsById = new Map(clients.map((c) => [c.id, c]))
  const termsDaysFor = (clientId: string): number => clientsById.get(clientId)?.terms_days ?? FALLBACK_TERMS_DAYS

  const inflows: ExpectedInflow[] = []

  for (const inv of invoices) {
    if (inv.status === 'paid' || inv.status === 'void') continue

    // A 'sent' invoice with a null sent_at shouldn't happen, but dating it
    // like a draft (rather than crashing on a null read) is the safe read.
    const baseDate = inv.status === 'sent' && inv.sent_at !== null
      ? sentAtChicagoDate(inv.sent_at)
      : addDays(today, assumptions.billingLagDays)

    const expectedDate = addDays(baseDate, termsDaysFor(inv.client_id))
    const { month, overdue } = bucket(expectedDate, today)
    const clientName = clientNames.get(inv.client_id) ?? inv.client_id
    inflows.push({ month, amountCents: inv.total_cents, label: `#${inv.number} ${clientName}`, overdue })
  }

  const notProjected: NotProjectedShow[] = []
  const showProjections: ShowProjection[] = []

  for (const show of shows) {
    if (show.status === 'billed') continue // its invoice already covers it, counted above

    if (show.days.length === 0) {
      // Nothing to date the projection from — previously dropped with no
      // trace; now surfaced so it doesn't vanish silently (design doc's
      // promise that these are listed).
      notProjected.push({ showId: show.id, name: show.name, reason: 'no days' })
      continue
    }

    const breakdown = computeShowBreakdown(show, homeState)
    // Guaranteed non-null: show.days.length > 0 was just checked above.
    const firstDay = breakdown.firstDay as string
    const lastDay = breakdown.lastDay as string

    const baseDate = addDays(lastDay, assumptions.billingLagDays)
    const expectedDate = addDays(baseDate, termsDaysFor(show.client_id))
    const { month, overdue } = bucket(expectedDate, today)

    if (breakdown.totalCents === 0) {
      // No rate card, no rates, or both clamped from negative — a real $0
      // projection the page never surfaced. List it instead of adding a
      // silent no-op inflow row.
      notProjected.push({ showId: show.id, name: show.name, reason: 'no rate' })
    } else {
      inflows.push({ month, amountCents: breakdown.totalCents, label: `${show.name} (projected)`, overdue })
    }

    // Every open, dated show gets a row here — even the $0 one above — so
    // the per-show table never hides a show inflows or notProjected didn't
    // separately surface. totalCents/landsMonth are the exact figures just
    // computed above, not a second pass, so this can never drift from inflows.
    showProjections.push({
      showId: show.id,
      name: show.name,
      firstDay,
      lastDay,
      dayCents: breakdown.dayCents,
      travelCents: breakdown.travelCents,
      pmCents: breakdown.pmCents,
      totalCents: breakdown.totalCents,
      dayCount: breakdown.dayCount,
      travelLegs: breakdown.travelLegs,
      pmHours: breakdown.pmHours,
      travelAssumed: breakdown.travelAssumed,
      landsMonth: month,
    })
  }

  showProjections.sort((a, b) => {
    if (a.firstDay !== b.firstDay) return a.firstDay < b.firstDay ? -1 : 1
    if (a.name !== b.name) return a.name < b.name ? -1 : 1
    return 0
  })

  inflows.sort((a, b) => {
    if (a.month !== b.month) return a.month < b.month ? -1 : 1
    if (a.label !== b.label) return a.label < b.label ? -1 : 1
    return 0
  })

  // bookedThrough names the month WORK ends, not the month cash lands. Cash
  // is pushed 1-2 months out by billing lag + pay lag, which would flatten
  // this into the most flattering number on the page — the exact line meant
  // to tell Dan his calendar is thin. So this is computed independently of
  // `inflows` (which is dated to the money) from the underlying work dates:
  // the last scheduled day of every counted open show, and the send/draft
  // date of every unpaid invoice.
  let bookedThrough: string | null = null
  const considerForBookedThrough = (month: string) => {
    if (bookedThrough === null || month > bookedThrough) bookedThrough = month
  }
  for (const show of shows) {
    if (show.status !== 'open') continue
    if (show.days.length === 0) continue // nothing to count — same case notProjected lists above
    let lastDay = show.days[0].date
    for (const d of show.days) if (d.date > lastDay) lastDay = d.date
    considerForBookedThrough(lastDay.slice(0, 7))
  }
  for (const inv of invoices) {
    if (inv.status !== 'draft' && inv.status !== 'sent') continue
    const month = inv.status === 'sent' && inv.sent_at !== null
      ? sentAtChicagoDate(inv.sent_at).slice(0, 7)
      : today.slice(0, 7) // drafts (and a malformed null-sent_at 'sent' row) date to today
    considerForBookedThrough(month)
  }

  const incomeByMonth = new Map<string, number>()
  for (const f of inflows) incomeByMonth.set(f.month, (incomeByMonth.get(f.month) ?? 0) + f.amountCents)

  const months: ForecastMonth[] = []
  const startMonth = today.slice(0, 7)
  let balance = startingBalanceCents
  let coveredThrough: string | null = null
  let beyondHorizon = false

  for (let i = 0; i < HORIZON_MONTHS; i++) {
    const month = addMonths(startMonth, i)
    const incomeCents = incomeByMonth.get(month) ?? 0

    // Month 0 is a partial month. Its income is already only "what's left
    // to land" — every inflow is dated to an expected FUTURE landing date,
    // so nothing before today ever accrues into it. Overhead and the draw
    // must be pro-rated the same way, or month 0 charges a full month's
    // costs against a starting balance that, per the design doc, already
    // paid its share of both up through yesterday — overstating what this
    // month still owes. `today` itself counts as remaining (a forecast run
    // on the 1st owes the whole month; run on the last day, it owes ~1 day
    // of it). Tax is computed from incomeCents/overheadCents below either
    // way, so it needs no separate pro-ration — it already follows suit.
    let overheadCents = assumptions.overheadCents
    let drawCents = assumptions.takeHomeCents
    if (i === 0) {
      const totalDays = daysInMonth(month)
      const dayOfMonth = Number(today.slice(8, 10))
      const remainingFraction = (totalDays - dayOfMonth + 1) / totalDays
      overheadCents = Math.round(assumptions.overheadCents * remainingFraction)
      drawCents = Math.round(assumptions.takeHomeCents * remainingFraction)
    }

    const taxCents = Math.round(Math.max(0, incomeCents - overheadCents) * assumptions.taxRateBp / 10000)
    balance += incomeCents - overheadCents - taxCents - drawCents
    const covered = balance >= 0

    months.push({ month, incomeCents, overheadCents, taxCents, drawCents, endingBalanceCents: balance, covered })

    if (!covered) {
      coveredThrough = i === 0 ? null : addMonths(startMonth, i - 1)
      break
    }
    if (i === HORIZON_MONTHS - 1) {
      coveredThrough = month
      beyondHorizon = true
    }
  }

  return { months, coveredThrough, beyondHorizon, bookedThrough, inflows, notProjected, showProjections }
}
