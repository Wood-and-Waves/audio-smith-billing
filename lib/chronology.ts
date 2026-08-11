// Punch ordering validation, adapted from CrewTracker's lib/punches.ts.
// Rejecting an impossible punch at entry is far cheaper than discovering a
// 33.5-hour day at billing time.
//
// No 'use client'. lib/-internal imports are relative with a .ts extension
// so this also runs under plain `node --test`.

import { PUNCH_ORDER, PUNCH_LABELS, MEAL_PAIRS, type PunchType } from './punchTypes.ts'

type Existing = { punch_type: string; punched_at: string }

/**
 * True when a day has an unpaired start/end, or an unpaired meal out/in for
 * any meal in MEAL_PAIRS. An unpaired meal punch (e.g. meal_out with no
 * meal_in) would otherwise silently bill the break as worked time — see
 * lib/payroll.ts's mealBreakPairs, which only deducts a break when both ends
 * are present.
 *
 * Shared by the billing gate (app/shows/actions.ts, inside billShows) and the
 * show page's incomplete-day banner (app/shows/[id]/page.tsx) so a show the
 * page marks billable can never turn around and have billShows refuse it.
 */
export function isIncompleteDay(punches: { punch_type: string }[]): boolean {
  const types = new Set(punches.map((p) => p.punch_type))
  if (types.has('start') !== types.has('end')) return true
  for (const [outType, inType] of MEAL_PAIRS) {
    if (types.has(outType) !== types.has(inType)) return true
  }
  return false
}

export function chronologyError(
  type: PunchType,
  at: string,
  existing: Existing[],
): string | null {
  if (existing.some((p) => p.punch_type === type)) {
    return `${PUNCH_LABELS[type]} is already recorded for this day.`
  }

  const when = new Date(at).getTime()
  const index = PUNCH_ORDER.indexOf(type)
  const byType = new Map(existing.map((p) => [p.punch_type, new Date(p.punched_at).getTime()]))

  for (let i = 0; i < index; i++) {
    const earlier = byType.get(PUNCH_ORDER[i])
    if (earlier !== undefined && when < earlier) {
      return `${PUNCH_LABELS[type]} must be after ${PUNCH_LABELS[PUNCH_ORDER[i]]}.`
    }
  }
  for (let i = index + 1; i < PUNCH_ORDER.length; i++) {
    const later = byType.get(PUNCH_ORDER[i])
    if (later !== undefined && when > later) {
      return `${PUNCH_LABELS[type]} must be before ${PUNCH_LABELS[PUNCH_ORDER[i]]}.`
    }
  }
  return null
}
