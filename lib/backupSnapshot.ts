// The frozen backup that travels with an invoice.
//
// invoice_lines has always been a snapshot; this gives the PDF's backup pages
// the same property. A sent invoice is a fixed document — re-downloading it in
// a year produces the same pages, whatever has happened to the shows since.
//
// Pure: no database, no clock, no rendering. No '@/' imports and no JSX.

import {
  paidStraightTimeHours, paidOvertimeHours, paidDoubleTimeHours, mealDeductionMinutes,
  mealPenaltyCount, type ShowDayLike, type ShowRuleset,
} from './payroll.ts'
import { instantToWall, friendlyTime } from './zonedTime.ts'
import { timezoneShortLabel } from './timezones.ts'
import type { ExpenseLike } from './expenses.ts'

export type SnapshotDay = {
  day: string
  in: string | null
  out: string | null
  meal_minutes: number
  net_hours: number
  st_hours: number
  ot_hours: number
  dt_hours: number
  travel_in: boolean
  travel_out: boolean
  half_day: boolean
  meal_penalties: number
}

export type SnapshotShow = { name: string; zone_label: string; days: SnapshotDay[] }

export type SnapshotExpense = {
  category: string
  where_spent: string
  amount_cents: number
  spent_on: string
  receipt_path: string | null
}

export type BackupSnapshot = {
  show_hours: boolean
  shows: SnapshotShow[]
  total_net: number
  total_st: number
  total_ot: number
  total_dt: number
  expenses: SnapshotExpense[]
}

export type SnapshotInput = {
  name: string
  timezone: string
  days: ShowDayLike[]
  rules: ShowRuleset
  expenses: ExpenseLike[]
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** `2026-08-30` -> `Sun 8/30`. Built from the plain date in UTC, so it cannot
 *  shift by a day on a machine west of Greenwich. */
export function dayLabel(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  const at = new Date(Date.UTC(y, m - 1, d))
  return `${WEEKDAYS[at.getUTCDay()]} ${m}/${d}`
}

/**
 * Freezes a set of billed shows into the document that backs their invoice.
 *
 * Hours come from the SAME functions billing uses, at the same rounding. A page
 * derived from the same punches but rounded differently would disagree with the
 * invoice by minutes — worse than showing nothing, because it invites a query
 * about a discrepancy that is purely cosmetic.
 */
export function buildBackupSnapshot(
  input: { shows: SnapshotInput[]; showHours: boolean },
): BackupSnapshot {
  const shows: SnapshotShow[] = input.shows.map((s) => ({
    name: s.name,
    zone_label: timezoneShortLabel(s.timezone),
    days: [...s.days]
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((d) => {
        const start = d.punches.find((p) => p.punch_type === 'start')
        const end = d.punches.find((p) => p.punch_type === 'end')
        const complete = Boolean(start && end)

        // Every column is a BILLED figure, from the same functions that price
        // the invoice.
        const st = complete ? paidStraightTimeHours(d, s.days, s.rules) : 0
        const ot = complete ? paidOvertimeHours(d, s.days, s.rules) : 0
        const dt = complete ? paidDoubleTimeHours(d, s.days, s.rules) : 0

        return {
          day: dayLabel(d.date),
          // Formatted HERE, in the show's zone, and stored as text. Keeping the
          // instant and formatting at render would let a later edit to the
          // show's timezone retro-shift times a client already received.
          in: complete ? friendlyTime(instantToWall(start!.punched_at, s.timezone).time) : null,
          out: complete ? friendlyTime(instantToWall(end!.punched_at, s.timezone).time) : null,
          // What was actually deducted, not the gap between the punches — the
          // deduction honours a minimum, a per-break cap, and both meal pairs.
          meal_minutes: complete ? mealDeductionMinutes(d, s.rules) : 0,
          // The SUM, not paidNetHours. A short-turnaround day carries a
          // minimum-call guarantee: four hours worked can bill ten, so
          // paidNetHours would print NET 4.0 beside DT 10.0 and the row would
          // be off by six hours. NET is what the day bills, which is its parts.
          net_hours: st + ot + dt,
          st_hours: st,
          ot_hours: ot,
          dt_hours: dt,
          travel_in: d.travel_in,
          travel_out: d.travel_out,
          half_day: d.pay_as_half_day,
          meal_penalties: complete ? mealPenaltyCount(d, s.rules) : 0,
        }
      }),
  }))

  const allDays = shows.flatMap((s) => s.days)
  const sum = (pick: (d: SnapshotDay) => number) => allDays.reduce((t, d) => t + pick(d), 0)

  return {
    // The DECISION is frozen with the data, so a sent invoice is fixed. The
    // rows are captured either way, so turning the option on for an already
    // billed invoice has something to render.
    show_hours: input.showHours,
    shows,
    total_net: sum((d) => d.net_hours),
    total_st: sum((d) => d.st_hours),
    total_ot: sum((d) => d.ot_hours),
    total_dt: sum((d) => d.dt_hours),
    // The snapshot is the CLIENT-facing itemization: a my-cost expense here
    // would print on the invoice PDF and the public link, so it is filtered
    // out before it is ever mapped.
    expenses: input.shows.flatMap((s) => s.expenses
      .filter((e) => e.billable)
      .map((e) => ({
        category: e.category,
        where_spent: e.where_spent,
        amount_cents: e.amount_cents,
        spent_on: e.spent_on,
        receipt_path: e.receipt_path,
      }))),
  }
}
