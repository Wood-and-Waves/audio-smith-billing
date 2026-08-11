// Hours in, invoice lines out. This is the boundary where hours become money:
// everything above is floats, everything below is integer cents.
//
// Lines come out in the order Dan's invoices already use, and a bucket that is
// zero produces no line at all — matching InvoiceDocument's rule that
// zero-value rows are noise.

import {
  paidStraightTimeHours, paidOvertimeHours, paidDoubleTimeHours, mealPenaltyCount, pmHours,
  type ShowDayLike, type ShowRuleset,
} from './payroll.ts'

export type ShowRates = {
  day_rate_cents: number
  travel_rate_cents: number
  pm_rate_cents: number
  ot_rate_cents: number
  dt_rate_cents: number
  meal_penalty_cents: number
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
  rates: ShowRates,
  rules: ShowRuleset,
): BucketLine[] {
  let dayRateDays = 0
  let halfDays = 0
  let travelDays = 0
  let otHours = 0
  let dtHours = 0
  let pmTotal = 0
  let penalties = 0

  for (const d of days) {
    if (d.day_type === 'travel') { travelDays += 1; continue }
    if (d.day_type === 'pm') { pmTotal += pmHours(d, rules); continue }

    const st = paidStraightTimeHours(d, days, rules)
    const ot = paidOvertimeHours(d, days, rules)
    const dt = paidDoubleTimeHours(d, days, rules)

    // A show day with no punches bills nothing; the day rate is earned by working.
    // Gating on st alone (rather than st || ot || dt) is deliberate: paidStraightTimeHours
    // is zeroed on a short-turnaround day (see lib/payroll.ts), so that day contributes no
    // Day Rate line — it bills entirely as Double Time instead, never both.
    if (st > 0) {
      if (d.pay_as_half_day) halfDays += 1
      else dayRateDays += 1
    }
    otHours += ot
    dtHours += dt
    penalties += mealPenaltyCount(d, rules)
  }

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

  push('Day Rate', dayRateDays, rates.day_rate_cents)
  push('Day Rate (half)', halfDays, Math.round(rates.day_rate_cents / 2))
  push('Travel Rate', travelDays, rates.travel_rate_cents)
  push('Overtime', otHours, rates.ot_rate_cents)
  push('Double Time', dtHours, rates.dt_rate_cents)
  push('PM Hours', pmTotal, rates.pm_rate_cents)
  if (rates.meal_penalty_cents > 0) push('Meal Penalty', penalties, rates.meal_penalty_cents)

  return lines
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
