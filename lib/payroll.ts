// Port of CrewTracker's lib/payroll.ts — HOURS ONLY.
//
// CrewTracker's totalPay/mealPenaltyTotal/travelLegPay are deliberately NOT
// ported. They compute money in floats, which is fine for a payroll estimate
// and not for a document a client pays against. lib/showBuckets.ts turns these
// hours into invoice lines through lib/money.ts, in integer cents.
//
// No 'use client'. Keep it that way.

import { MEAL_PAIRS } from './punchTypes.ts'

export type PunchRecord = { punch_type: string; punched_at: string }

export type ShowRuleset = {
  overtime_after_hours: number
  double_time_enabled: boolean
  double_time_after_hours: number
  meal_penalty_enabled: boolean
  meal_penalty_grace_hours: number
  minimum_meal_break_enabled: boolean
  minimum_meal_break_minutes: number
  meal_break_deduction_cap: number
  short_turn_penalty_enabled: boolean
  short_turn_rest_hours: number
  continuous_time_enabled: boolean
}

export type ShowDayLike = {
  id: string
  date: string
  pay_as_half_day: boolean
  travel_in: boolean
  travel_out: boolean
  punches: PunchRecord[]
}

const DISTANT_PAST = new Date(-8640000000000000)

function punchTime(punches: PunchRecord[], type: string): Date | null {
  const p = punches.find((x) => x.punch_type === type)
  return p ? new Date(p.punched_at) : null
}

function mealBreakPairs(d: ShowDayLike): [Date, Date][] {
  const pairs: [Date, Date][] = []
  for (const [outType, inType] of MEAL_PAIRS) {
    const out = punchTime(d.punches, outType)
    const back = punchTime(d.punches, inType)
    if (out && back) pairs.push([out, back])
  }
  return pairs
}

const hasBothEnds = (d: ShowDayLike) =>
  !!punchTime(d.punches, 'start') && !!punchTime(d.punches, 'end')

/**
 * Seconds actually removed from a day for meals.
 *
 * Extracted from calculateNetHours so the backup page can print the SAME figure
 * it deducted. A second implementation would drift: this one honours the
 * minimum-break threshold, the per-break cap, and BOTH meal pairs, and a naive
 * "gap between meal_out and meal_in" gets all three wrong — showing 90 minutes
 * where 60 was deducted, or 30 where two breaks took 60.
 */
function mealDeductionSeconds(d: ShowDayLike, rules: ShowRuleset): number {
  if (rules.continuous_time_enabled) return 0
  const minBreak = rules.minimum_meal_break_enabled ? rules.minimum_meal_break_minutes * 60 : 0
  const cap = rules.meal_break_deduction_cap * 60
  let deduction = 0
  for (const [out, back] of mealBreakPairs(d)) {
    const duration = (back.getTime() - out.getTime()) / 1000
    // duration > 0 guards a reversed pair. chronologyError already refuses to
    // record one, so this only matters for data that predates that rule — but
    // without it a negative "break" would ADD paid time.
    if (duration > 0 && duration >= minBreak) deduction += Math.min(duration, cap)
  }
  return deduction
}

/** The same deduction, in whole minutes, for display on the backup page. */
export function mealDeductionMinutes(d: ShowDayLike, rules: ShowRuleset): number {
  return Math.round(mealDeductionSeconds(d, rules) / 60)
}

export function calculateNetHours(d: ShowDayLike, rules: ShowRuleset, roundingMinutes = 1): number {
  const start = punchTime(d.punches, 'start')
  const end = punchTime(d.punches, 'end')
  if (!start || !end) return 0

  const grossSeconds = (end.getTime() - start.getTime()) / 1000

  const netSeconds = Math.max(0, grossSeconds - mealDeductionSeconds(d, rules))

  const netMinutes = Math.round(netSeconds / 60)
  const interval = roundingMinutes > 0 ? roundingMinutes : 1
  if (interval === 1) return netMinutes / 60
  const remainder = netMinutes % interval
  return (remainder > 0 ? netMinutes - remainder + interval : netMinutes) / 60
}

/**
 * Short turnaround looks only within one show, per the spec. A Streamline run
 * ending at 11pm followed by a Journey Church visit at 8am is two shows and
 * won't trigger this.
 */
export function isShortTurnaround(d: ShowDayLike, allDays: ShowDayLike[], rules: ShowRuleset): boolean {
  if (!rules.short_turn_penalty_enabled) return false
  const start = punchTime(d.punches, 'start')
  if (!start) return false

  const previous = allDays.filter((o) => {
    if (o.id === d.id) return false
    const end = punchTime(o.punches, 'end') ?? DISTANT_PAST
    return end < start
  })
  if (previous.length === 0) return false

  const last = previous.reduce((a, b) => {
    const aEnd = punchTime(a.punches, 'end') ?? DISTANT_PAST
    const bEnd = punchTime(b.punches, 'end') ?? DISTANT_PAST
    return aEnd < bEnd ? b : a
  })
  const lastEnd = punchTime(last.punches, 'end')
  if (!lastEnd) return false

  return (start.getTime() - lastEnd.getTime()) / 1000 < rules.short_turn_rest_hours * 3600
}

/** Ceiling-rounded per day before summing — Dan validated this against a real client spreadsheet. */
export function paidNetHours(d: ShowDayLike, rules: ShowRuleset, roundingMinutes = 1): number {
  if (!hasBothEnds(d)) return 0
  return Math.ceil(calculateNetHours(d, rules, roundingMinutes))
}

export function paidStraightTimeHours(d: ShowDayLike, allDays: ShowDayLike[], rules: ShowRuleset, roundingMinutes = 1): number {
  if (!hasBothEnds(d)) return 0
  if (isShortTurnaround(d, allDays, rules)) return 0
  return Math.min(paidNetHours(d, rules, roundingMinutes), rules.overtime_after_hours)
}

export function paidOvertimeHours(d: ShowDayLike, allDays: ShowDayLike[], rules: ShowRuleset, roundingMinutes = 1): number {
  if (!hasBothEnds(d)) return 0
  if (isShortTurnaround(d, allDays, rules)) return 0
  const ot = paidNetHours(d, rules, roundingMinutes) - rules.overtime_after_hours
  if (ot <= 0) return 0
  if (rules.double_time_enabled) {
    return Math.min(ot, rules.double_time_after_hours - rules.overtime_after_hours)
  }
  return ot
}

export function paidDoubleTimeHours(d: ShowDayLike, allDays: ShowDayLike[], rules: ShowRuleset, roundingMinutes = 1): number {
  if (!hasBothEnds(d)) return 0
  const paidNet = paidNetHours(d, rules, roundingMinutes)
  if (isShortTurnaround(d, allDays, rules)) {
    // A short-turnaround day carries no day rate — computeShowLines only
    // emits one when straight time is nonzero, and straight time is zeroed
    // above — and bills its whole net day at double time, but never less
    // than the overtime threshold. Matches CrewTracker's totalPay guarantee:
    // actualDTHours = Math.max(paidNet, guaranteeHours).
    return Math.max(paidNet, rules.overtime_after_hours)
  }
  if (!rules.double_time_enabled) return 0
  return Math.max(0, paidNet - rules.double_time_after_hours)
}

/** One penalty per stretch longer than the grace period without a break. */
export function mealPenaltyCount(d: ShowDayLike, rules: ShowRuleset): number {
  if (!rules.meal_penalty_enabled) return 0
  const start = punchTime(d.punches, 'start')
  if (!start) return 0

  const graceSeconds = rules.meal_penalty_grace_hours * 3600
  const end = punchTime(d.punches, 'end')
  let penalties = 0
  let segmentStart: Date | null = start

  for (const [outType, inType] of MEAL_PAIRS) {
    if (!segmentStart) break
    const out = punchTime(d.punches, outType)
    const segmentEnd = out ?? end
    if (!segmentEnd) return penalties
    if ((segmentEnd.getTime() - segmentStart.getTime()) / 1000 > graceSeconds) penalties += 1
    if (!out) return penalties
    segmentStart = punchTime(d.punches, inType)
  }
  return penalties
}
