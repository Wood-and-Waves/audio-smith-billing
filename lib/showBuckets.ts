// Hours in, invoice lines out. This is the boundary where hours become money:
// everything above is floats, everything below is integer cents.
//
// Lines come out in the order Dan's invoices already use, and a bucket that is
// zero produces no line at all — matching InvoiceDocument's rule that
// zero-value rows are noise.

import {
  paidStraightTimeHours, paidOvertimeHours, paidDoubleTimeHours, mealPenaltyCount,
  type ShowDayLike, type ShowRuleset,
} from './payroll.ts'
import { overtimeRateFrom, doubleTimeRateFrom } from './money.ts'

export type PmEntryLike = { minutes: number }

export type ShowRates = {
  day_rate_cents: number
  travel_rate_cents: number
  pm_rate_cents: number
  ot_rate_cents: number
  dt_rate_cents: number
  meal_penalty_cents: number
  /**
   * The rate card this show was created from, frozen. NULL is the default card
   * and decorates nothing — naming the default would put "Day Rate — Standard"
   * on every invoice for every client, including the many with one rate.
   */
  rate_card_name: string | null
  /** When true, sub-threshold worked days bill by the hour, not a flat day rate. */
  bill_hourly: boolean
  /** Derived day_rate_cents / ot_after_hours; only read when bill_hourly. */
  hourly_rate_cents: number
}

export type BucketLine = {
  description: string
  qty_hundredths: number
  unit_price_cents: number
}

/** Hours (float) to the integer hundredths lib/money.ts expects. */
const toHundredths = (hours: number) => Math.round(hours * 100)

export function computeShowLines(
  days: ShowDayLike[],
  pmEntries: PmEntryLike[],
  rates: ShowRates,
  rules: ShowRuleset,
): BucketLine[] {
  let dayRateDays = 0
  let halfDays = 0
  let travelLegs = 0
  let otHours = 0
  let dtHours = 0
  let penalties = 0
  let hourlyHours = 0

  for (const d of days) {
    travelLegs += (d.travel_in ? 1 : 0) + (d.travel_out ? 1 : 0)

    const st = paidStraightTimeHours(d, days, rules)
    const ot = paidOvertimeHours(d, days, rules)
    const dt = paidDoubleTimeHours(d, days, rules)

    // A show day with no punches bills nothing; the day rate is earned by working.
    // Gating on st alone (rather than st || ot || dt) is deliberate: paidStraightTimeHours
    // is zeroed on a short-turnaround day (see lib/payroll.ts), so that day contributes no
    // Day Rate line — it bills entirely as Double Time instead, never both.
    //
    // bill_hourly diverts a sub-threshold day to hourly billing instead of a
    // flat day rate. st is already the per-day ceiling-rounded straight time,
    // so "st < overtime_after_hours" is exactly "under the day-rate threshold,"
    // and ot/dt are guaranteed zero for that day — the otHours += ot / dtHours
    // += dt lines below add nothing for it.
    if (st > 0) {
      if (rates.bill_hourly && st < rules.overtime_after_hours) hourlyHours += st
      else if (d.pay_as_half_day) halfDays += 1
      else dayRateDays += 1
    }
    otHours += ot
    dtHours += dt
    penalties += mealPenaltyCount(d, rules)
  }

  // Sessions sum first, THEN round up — once, for the whole show. Rounding each
  // session would bill four half-hours as four hours instead of two.
  const pmMinutes = pmEntries.reduce((t, e) => t + e.minutes, 0)
  const pmHours = pmMinutes > 0 ? Math.ceil(pmMinutes / 60) : 0

  const lines: BucketLine[] = []
  const push = (description: string, qty: number, unit_price_cents: number) => {
    const qty_hundredths = toHundredths(qty)
    // Guard on the rounded quantity, not the pre-rounded value, to ensure we never
    // emit a line with qty_hundredths: 0. A value like 1e-13 hours passes qty > 0
    // but rounds to zero hundredths; we must test the value that actually gets pushed.
    if (qty_hundredths > 0 && unit_price_cents >= 0) {
      lines.push({ description, qty_hundredths, unit_price_cents })
    }
  }

  // Every line whose price comes from the card carries the card's name. Not
  // just the day rate: a PM card at $900 also has a $135 overtime rate against
  // the standard $117, so a mixed invoice would otherwise show two "Overtime"
  // lines at different prices with nothing to distinguish them.
  const label = (base: string) =>
    rates.rate_card_name?.trim() ? `${base} — ${rates.rate_card_name.trim()}` : base

  push(label('Day Rate'), dayRateDays, rates.day_rate_cents)
  push(label('Day Rate (half)'), halfDays, Math.round(rates.day_rate_cents / 2))
  push(label('Hourly'), hourlyHours, rates.hourly_rate_cents)
  push(label('Travel Rate'), travelLegs, rates.travel_rate_cents)
  push(label('Overtime'), otHours, rates.ot_rate_cents)
  push(label('Double Time'), dtHours, rates.dt_rate_cents)
  push(label('PM Hours'), pmHours, rates.pm_rate_cents)
  if (rates.meal_penalty_cents > 0) push('Meal Penalty', penalties, rates.meal_penalty_cents)

  return lines
}

/**
 * The frozen rate-card columns a show carries (migration 0003) — the inputs
 * `rulesetAndRatesFor` needs to rebuild a ShowRuleset/ShowRates pair.
 * Structural rather than a Supabase row type, so this file has no dependency
 * on lib/supabase; it just needs something shaped like the columns
 * app/shows/actions.ts, app/shows/[id]/page.tsx and app/shows/page.tsx all
 * select off `shows`.
 */
export type FrozenShowColumns = {
  day_rate_cents: number
  travel_rate_cents: number
  pm_rate_cents: number
  ot_after_hours: number
  dt_after_hours: number | null
  minimum_meal_break_minutes: number
  meal_break_deduction_cap: number
  meal_penalty_grace_hours: number
  meal_penalty_cents: number
  short_turn_rest_hours: number
  continuous_time_enabled: boolean
  rate_card_name: string | null
  bill_hourly: boolean
}

/**
 * Builds the ShowRuleset/ShowRates pair `computeShowLines` needs, from a
 * show's frozen rate-card columns. This ~20-line construction used to be
 * copy-pasted in three places (billShows in app/shows/actions.ts,
 * app/shows/[id]/page.tsx, and app/shows/page.tsx) — a future rule field
 * would have had to be added in all three, and missing one would silently
 * change what a client is charged without the preview and the invoice
 * disagreeing loudly enough to notice.
 */
export function rulesetAndRatesFor(show: FrozenShowColumns): { rules: ShowRuleset; rates: ShowRates } {
  const hours = Number(show.ot_after_hours)
  const rules: ShowRuleset = {
    overtime_after_hours: hours,
    double_time_enabled: show.dt_after_hours != null,
    double_time_after_hours: Number(show.dt_after_hours ?? 12),
    meal_penalty_enabled: show.meal_penalty_cents > 0,
    meal_penalty_grace_hours: Number(show.meal_penalty_grace_hours),
    minimum_meal_break_enabled: show.minimum_meal_break_minutes > 0,
    minimum_meal_break_minutes: show.minimum_meal_break_minutes,
    meal_break_deduction_cap: show.meal_break_deduction_cap,
    short_turn_penalty_enabled: !show.bill_hourly,
    short_turn_rest_hours: Number(show.short_turn_rest_hours),
    continuous_time_enabled: show.continuous_time_enabled,
  }
  const rates: ShowRates = {
    day_rate_cents: show.day_rate_cents,
    travel_rate_cents: show.travel_rate_cents,
    pm_rate_cents: show.pm_rate_cents,
    ot_rate_cents: overtimeRateFrom(show.day_rate_cents, hours),
    dt_rate_cents: doubleTimeRateFrom(show.day_rate_cents, hours),
    meal_penalty_cents: show.meal_penalty_cents,
    rate_card_name: show.rate_card_name,
    bill_hourly: show.bill_hourly,
    hourly_rate_cents: Math.round(show.day_rate_cents / hours),
  }
  return { rules, rates }
}

/**
 * Combines lines from several shows onto one invoice. Two Streamline day-rate
 * lines at the same price become one line with double the quantity, which is
 * how Dan's invoices read today. Lines only merge when BOTH the description
 * and the unit price match — a $780 day rate and a $600 day rate stay apart.
 */
export function mergeLines(groups: BucketLine[][]): BucketLine[] {
  const merged: BucketLine[] = []
  for (const line of groups.flat()) {
    const hit = merged.find(
      (x) => x.description === line.description && x.unit_price_cents === line.unit_price_cents)
    if (hit) hit.qty_hundredths += line.qty_hundredths
    else merged.push({ ...line })
  }
  return merged
}
