// Rebuilding a 2026 show from the invoice that billed it.
//
// Dan's Jan-June 2026 invoices came in from the Google Sheet with no shows
// behind them, so there is nothing for an expense or a receipt to attach to.
// The invoice turns out to carry almost everything a show needs: its lines
// hold both the counts and the frozen rates.
//
//     #383   5 x 780.00 Day Rate   2 x 390.00 Travel Day   12 x 78.00 PM Hours
//
// That is a five-day show with two travel days at his 2026 Streamline card.
// DATES are the one thing an invoice never says, so they come from Dan or from
// the travel charges that bracket the trip in the ledger.
//
// This module PROPOSES and REPORTS. It never truncates a window to make the
// arithmetic work: a window too short for the days the invoice billed is a
// problem to show Dan, not a discrepancy to absorb quietly.
//
// Pure: no database, no clock beyond the plain dates it is handed.

import { addDays, isPlainDate } from './dates.ts'

/** An `invoice_lines` row, narrowed to what a show can be rebuilt from. */
export type BackfillLine = {
  description: string
  /** 4.5 -> 450, as stored. */
  qty_hundredths: number
  unit_price_cents: number
}

/** The frozen rate card, in the shape the `shows` columns want. */
export type ShowRates = {
  dayRateCents: number
  travelRateCents: number
  pmRateCents: number
}

export type DayCounts = { showDays: number; travelDays: number }

/**
 * One `show_days` row, in the shape the table has had since migration 0005:
 * every row is a work day and travel is a FLAG on the day, not a row of its own.
 */
export type ShowDayPlan = {
  date: string
  travel_in: boolean
  travel_out: boolean
  /** 0036: a travel day he also worked. Requires a travel flag (0037's trigger). */
  travel_works: boolean
}

/**
 * How a travel leg lands on the calendar.
 *
 * `same-day` is the one that is easy to miss and Dan hits regularly: Chosen Con
 * finished on the Sunday and he flew home that night, so 2026-02-22 carries the
 * travel-out leg AND counts as a worked day. That is why invoice #365 billed
 * eight days — 6 day rates + 2 travel legs — across a seven-date window.
 *
 * `computeShowLines` counts legs and worked days independently (a travel flag
 * never suppresses a day rate), so this maps straight onto the billing model.
 */
export type TravelLeg = 'none' | 'own-day' | 'same-day'

type Bucket = 'day' | 'travel' | 'pm' | 'other'

// Wording drifted year to year — "Day Rate", "Standard Day Rate", "Travel Day",
// "Travel Rate", "Travel Day Rate" are all real descriptions from his invoices.
// Travel is tested FIRST because "Travel Day Rate" would otherwise read as a
// show day, which would both overcount the show and lose the travel rate.
// Overtime is deliberately its own dead end: it is billed by the hour off the
// day rate and is neither a day to schedule nor a rate the show freezes.
function bucketOf(description: string): Bucket {
  const d = description.toLowerCase()
  if (d.includes('travel')) return 'travel'
  if (/\bpm\b/.test(d)) return 'pm'
  if (d.includes('overtime')) return 'other'
  if (/\bday\b/.test(d)) return 'day'
  return 'other'
}

/**
 * The rate card as the invoice froze it.
 *
 * Where an invoice carries more than one line in a bucket — a full day beside a
 * discounted one — the HIGHEST unit price wins, because that is the card's rate
 * and the lower line is the exception to it. A bucket with no line is zero, not
 * an error: plenty of his shows have no PM hours at all.
 */
export function ratesFromInvoiceLines(lines: readonly BackfillLine[]): ShowRates {
  const top = (want: Bucket) => lines.reduce(
    (best, l) => (bucketOf(l.description) === want ? Math.max(best, l.unit_price_cents) : best),
    0,
  )
  return { dayRateCents: top('day'), travelRateCents: top('travel'), pmRateCents: top('pm') }
}

/** How many days of each kind the invoice billed. */
export function dayCountsFromInvoiceLines(lines: readonly BackfillLine[]): DayCounts {
  const sum = (want: Bucket) => lines.reduce(
    (n, l) => (bucketOf(l.description) === want ? n + l.qty_hundredths : n),
    0,
  )
  return { showDays: Math.round(sum('day') / 100), travelDays: Math.round(sum('travel') / 100) }
}

/**
 * One `show_days` row per date in the window.
 *
 * `travelIn`/`travelOut` place the travel legs, which is how he actually works:
 * fly in, work, fly home. A one-day window cannot hold an `own-day` leg at each
 * end, and that is reported rather than resolved — only Dan knows which way the
 * window is wrong.
 */
export function planShowDays(
  startDate: string,
  endDate: string,
  travelIn: TravelLeg,
  travelOut: TravelLeg,
): { days: ShowDayPlan[]; problems: string[] } {
  for (const [label, iso] of [['start', startDate], ['end', endDate]] as const) {
    if (!isPlainDate(iso)) return { days: [], problems: [`Not a ${label} date: "${iso}".`] }
  }
  if (endDate < startDate) {
    return { days: [], problems: [`End ${endDate} is before start ${startDate}.`] }
  }

  const days: ShowDayPlan[] = []
  for (let iso = startDate; iso <= endDate; iso = addDays(iso, 1)) {
    days.push({ date: iso, travel_in: false, travel_out: false, travel_works: false })
  }

  const problems: string[] = []
  const first = days[0]
  const last = days[days.length - 1]
  if (travelIn !== 'none') {
    first.travel_in = true
    if (travelIn === 'same-day') first.travel_works = true
  }
  if (travelOut !== 'none') {
    last.travel_out = true
    if (travelOut === 'same-day') last.travel_works = true
  }

  // A single date carrying both legs is legal — he drives out and back the same
  // day — but only if he actually worked it. Two pure travel legs on one date
  // would mean a day with no work at all, which is not a show.
  if (days.length === 1 && travelIn === 'own-day' && travelOut === 'own-day') {
    problems.push(
      `A one day window (${startDate}) cannot hold two travel legs and no worked day.`,
    )
  }
  return { days, problems }
}

/**
 * Does the window hold the days the invoice billed?
 *
 * Counted the way `computeShowLines` counts: a travel LEG is a flag, so one
 * date can carry two, and a day rate is earned by working, which a travel flag
 * never suppresses. A backfilled show has no punches, so a travel day counts as
 * worked only when `travel_works` says he worked it.
 *
 * Only shortfalls are reported. A window LONGER than the billed days is normal
 * and not a problem — he is regularly on site a day he did not bill for.
 */
export function windowProblems(counts: DayCounts, days: readonly ShowDayPlan[]): string[] {
  const problems: string[] = []
  const show = days.reduce(
    (n, d) => (!d.travel_in && !d.travel_out) || d.travel_works ? n + 1 : n, 0,
  )
  const travel = days.reduce((n, d) => n + (d.travel_in ? 1 : 0) + (d.travel_out ? 1 : 0), 0)
  if (counts.showDays > show) {
    problems.push(`Invoice billed ${counts.showDays} show days but the window holds ${show}.`)
  }
  if (counts.travelDays > travel) {
    problems.push(`Invoice billed ${counts.travelDays} travel legs but the window holds ${travel}.`)
  }
  return problems
}
