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
// `today` is always a parameter, never read from a clock in here — see
// lib/dates.ts and lib/status.ts, which insist on the same thing for the
// same reason: a lib that reads its own clock can't be pinned by a test.
//
// No '@/' imports and no JSX — exercised by node --test.

import { addDays, addMonths } from './dates.ts'

// ---- inputs (DB-shaped, snake_case where they come from rows) ----

export type ForecastShowDay = {
  date: string // YYYY-MM-DD
  travel_in: boolean
  travel_out: boolean
  pay_as_half_day: boolean
}

export type ForecastShow = {
  id: string
  name: string
  client_id: string
  status: 'open' | 'billed'
  day_rate_cents: number
  travel_rate_cents: number
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

export type PayLag = { clientId: string; days: number; source: 'learned' | 'terms'; sampleSize: number }

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

export type Forecast = {
  months: ForecastMonth[]
  coveredThrough: string | null // YYYY-MM; null = not even this month
  beyondHorizon: boolean // never went negative within 24 months
  bookedThrough: string | null // last month carrying booked work
  inflows: ExpectedInflow[] // for the table's detail + overdue flags
  payLags: PayLag[]
}

export const HORIZON_MONTHS = 24

// Learning a lag from a settlement over a year old models the client as a
// worse payer than they are today — see the Journey case in the tests and
// the design doc's postscript on why this window exists.
const PAY_LAG_WINDOW_DAYS = 365

// ---------------------------------------------------------------------------
// Local date-diff helper. Same doctrine as lib/ledgerMatch.ts's daysApart:
// split on '-' and Date.UTC the parts, so this never drifts with the host
// machine's timezone. Unlike daysApart this is SIGNED (to - from), because a
// pay lag needs direction (paid after sent, not just "far apart"); it also
// tolerates a leading ISO timestamp (slices to the first 10 chars) so a
// `sent_at` like '2026-08-01T00:00:00Z' can be compared directly against a
// plain YYYY-MM-DD without every caller re-truncating it first.
const MS_PER_DAY = 24 * 60 * 60 * 1000

function toUtcMs(iso: string): number {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  return Date.UTC(y, m - 1, d)
}

function diffDays(fromIso: string, toIso: string): number {
  return Math.round((toUtcMs(toIso) - toUtcMs(fromIso)) / MS_PER_DAY)
}

/** Even count -> average the two middle values, rounded to a whole day. */
function median(sortedDays: number[]): number {
  const n = sortedDays.length
  const mid = Math.floor(n / 2)
  if (n % 2 === 1) return sortedDays[mid]
  return Math.round((sortedDays[mid - 1] + sortedDays[mid]) / 2)
}

/** Every scheduled day is a work day (migration 0005); travel flags add legs. */
export function projectedShowCents(show: ForecastShow): number {
  // Guard against nonsense input without throwing: a negative rate would
  // otherwise subtract from the projection instead of contributing nothing.
  const dayRate = show.day_rate_cents > 0 ? show.day_rate_cents : 0
  const travelRate = show.travel_rate_cents > 0 ? show.travel_rate_cents : 0
  const halfRate = Math.round(dayRate / 2)

  let fullDays = 0
  let halfDays = 0
  let legs = 0
  for (const d of show.days) {
    if (d.pay_as_half_day) halfDays += 1
    else fullDays += 1
    if (d.travel_in) legs += 1
    if (d.travel_out) legs += 1
  }

  return fullDays * dayRate + halfDays * halfRate + legs * travelRate
}

/** Median lag, learned ONLY from linked invoices sent within 365 days of `today`,
 *  minimum 2 samples; otherwise the client's terms_days. */
export function payLagFor(
  clientId: string, invoices: ForecastInvoice[], clients: ForecastClient[], today: string,
): PayLag {
  const samples: number[] = []
  for (const inv of invoices) {
    if (inv.client_id !== clientId) continue
    if (!inv.linked) continue
    if (inv.sent_at === null || inv.paid_at === null) continue
    if (diffDays(inv.sent_at, today) > PAY_LAG_WINDOW_DAYS) continue
    samples.push(diffDays(inv.sent_at, inv.paid_at))
  }

  if (samples.length >= 2) {
    samples.sort((a, b) => a - b)
    return { clientId, days: median(samples), source: 'learned', sampleSize: samples.length }
  }

  const client = clients.find((c) => c.id === clientId)
  return { clientId, days: client ? client.terms_days : 0, source: 'terms', sampleSize: samples.length }
}

/** Trailing 3 COMPLETE calendar months of spend, excluding owner_pay and transfer. */
export function computeOverheadCents(
  txns: { date: string; amount_cents: number; kind: string }[], today: string,
): number {
  const currentMonth = today.slice(0, 7)
  const completeMonths = new Set([
    addMonths(currentMonth, -1), addMonths(currentMonth, -2), addMonths(currentMonth, -3),
  ])

  let total = 0
  for (const t of txns) {
    if (t.kind !== 'expense') continue // excludes owner_pay and transfer along with income
    if (!completeMonths.has(t.date.slice(0, 7))) continue
    total += -t.amount_cents // expense amounts are stored negative; spend is positive
  }
  return Math.round(total / 3)
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
  shows: ForecastShow[]
  invoices: ForecastInvoice[]
  clients: ForecastClient[]
  assumptions: ForecastAssumptions
}): Forecast {
  const { today, startingBalanceCents, shows, invoices, clients, assumptions } = input
  const clientNames = new Map(clients.map((c) => [c.id, c.name]))

  // A client's lag only needs computing (and reporting) if it actually has
  // booked work counted below — a full client roster would otherwise pad the
  // assumptions list with clients that have no bearing on this forecast.
  const relevantClientIds = new Set<string>()
  for (const s of shows) if (s.status === 'open') relevantClientIds.add(s.client_id)
  for (const inv of invoices) if (inv.status === 'draft' || inv.status === 'sent') relevantClientIds.add(inv.client_id)

  const payLagByClient = new Map<string, PayLag>()
  for (const clientId of relevantClientIds) {
    payLagByClient.set(clientId, payLagFor(clientId, invoices, clients, today))
  }
  const lagDaysFor = (clientId: string): number => payLagByClient.get(clientId)?.days
    ?? payLagFor(clientId, invoices, clients, today).days

  const inflows: ExpectedInflow[] = []

  for (const inv of invoices) {
    if (inv.status === 'paid' || inv.status === 'void') continue

    // A 'sent' invoice with a null sent_at shouldn't happen, but dating it
    // like a draft (rather than crashing on a null slice) is the safe read.
    const baseDate = inv.status === 'sent' && inv.sent_at !== null
      ? inv.sent_at.slice(0, 10)
      : addDays(today, assumptions.billingLagDays)

    const expectedDate = addDays(baseDate, lagDaysFor(inv.client_id))
    const { month, overdue } = bucket(expectedDate, today)
    const clientName = clientNames.get(inv.client_id) ?? inv.client_id
    inflows.push({ month, amountCents: inv.total_cents, label: `#${inv.number} ${clientName}`, overdue })
  }

  for (const show of shows) {
    if (show.status === 'billed') continue // its invoice already covers it, counted above
    if (show.days.length === 0) continue // nothing to date the projection from

    let lastDay = show.days[0].date
    for (const d of show.days) if (d.date > lastDay) lastDay = d.date

    const baseDate = addDays(lastDay, assumptions.billingLagDays)
    const expectedDate = addDays(baseDate, lagDaysFor(show.client_id))
    const { month, overdue } = bucket(expectedDate, today)
    inflows.push({ month, amountCents: projectedShowCents(show), label: `${show.name} (projected)`, overdue })
  }

  inflows.sort((a, b) => {
    if (a.month !== b.month) return a.month < b.month ? -1 : 1
    if (a.label !== b.label) return a.label < b.label ? -1 : 1
    return 0
  })

  let bookedThrough: string | null = null
  for (const f of inflows) if (bookedThrough === null || f.month > bookedThrough) bookedThrough = f.month

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
    const overheadCents = assumptions.overheadCents
    const taxCents = Math.round(Math.max(0, incomeCents - overheadCents) * assumptions.taxRateBp / 10000)
    const drawCents = assumptions.takeHomeCents
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

  const payLags = [...payLagByClient.values()].sort((a, b) => (
    a.clientId < b.clientId ? -1 : a.clientId > b.clientId ? 1 : 0
  ))

  return { months, coveredThrough, beyondHorizon, bookedThrough, inflows, payLags }
}
