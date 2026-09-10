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

export type ShowDayPlan = { date: string; day_type: 'show' | 'travel' }

/**
 * How a travel leg lands on the calendar.
 *
 * `same-day` is the one that is easy to miss and Dan hits regularly: Chosen Con
 * finished on the Sunday and he flew home the same night, so 2026-02-22 is a
 * show day AND a travel day. `show_days` is unique on (show, date, day_type),
 * so that date carries two rows — which is exactly why invoice #365 billed
 * eight days across a seven-day window.
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

  const dates: string[] = []
  for (let iso = startDate; iso <= endDate; iso = addDays(iso, 1)) dates.push(iso)

  const problems: string[] = []
  const bothOwnDays = travelIn === 'own-day' && travelOut === 'own-day'
  if (dates.length === 1 && bothOwnDays) {
    problems.push(`A one day window (${startDate}) cannot hold travel in and travel out.`)
  }

  // A date is a show day unless a travel leg claims it outright; `same-day`
  // adds its travel row beside the show row rather than replacing it.
  const claimed = new Set<string>()
  const travel: string[] = []
  const leg = (mode: TravelLeg, iso: string) => {
    if (mode === 'none') return
    travel.push(iso)
    if (mode === 'own-day') claimed.add(iso)
  }
  if (!(dates.length === 1 && bothOwnDays)) {
    leg(travelIn, dates[0])
    leg(travelOut, dates[dates.length - 1])
  }

  const days: ShowDayPlan[] = []
  for (const iso of dates) {
    if (!claimed.has(iso)) days.push({ date: iso, day_type: 'show' })
    if (travel.includes(iso)) days.push({ date: iso, day_type: 'travel' })
  }
  return { days, problems }
}

/**
 * Does the window hold the days the invoice billed?
 *
 * Only shortfalls are reported. A window LONGER than the billed days is normal
 * and not a problem — he is regularly on site a day he did not bill for.
 */
export function windowProblems(counts: DayCounts, days: readonly ShowDayPlan[]): string[] {
  const planned = (want: ShowDayPlan['day_type']) =>
    days.reduce((n, d) => (d.day_type === want ? n + 1 : n), 0)

  const problems: string[] = []
  const show = planned('show')
  const travel = planned('travel')
  if (counts.showDays > show) {
    problems.push(`Invoice billed ${counts.showDays} show days but the window holds ${show}.`)
  }
  if (counts.travelDays > travel) {
    problems.push(`Invoice billed ${counts.travelDays} travel days but the window holds ${travel}.`)
  }
  return problems
}
