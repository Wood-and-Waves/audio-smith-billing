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

/**
 * True when a day is not ready to bill. Stronger than isIncompleteDay: it also
 * catches a day that was added but never clocked.
 *
 * A day blocks billing when it has a dangling punch (isIncompleteDay), OR it is
 * empty AND not marked travel. The second half is the point — a bare day with
 * no punches used to bill nothing and pass silently, so a day Dan forgot to
 * clock would quietly under-bill the show. A completed work day (start + end)
 * and a travel-only day (a fly day with a leg but no punches) are both fine.
 *
 * Shared by the billing gate (billShows), the shows list, and the show page so
 * all three agree on exactly what "unfinished" means.
 */
export function isUnfinishedDay(day: {
  punches: { punch_type: string }[]
  travel_in: boolean
  travel_out: boolean
}): boolean {
  if (isIncompleteDay(day.punches)) return true
  const types = new Set(day.punches.map((p) => p.punch_type))
  // A real work day is start-and-end; isIncompleteDay above already ruled out a
  // dangling meal, so a complete pair here is genuinely finished.
  if (types.has('start') && types.has('end')) return false
  // No worked pair: fine only if this is a deliberate travel day.
  return !(day.travel_in || day.travel_out)
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

  // Note <= and >=, not < and >. Two punches at the same moment are rejected:
  // an out equal to its in is a zero-length day, and a meal that starts and
  // ends at once is not a break. This was unreachable while punching stamped
  // the current millisecond, but the picker prefills a later punch from the
  // previous one — so saving without changing the time is now one careless tap,
  // and it would bill silently wrong hours.
  for (let i = 0; i < index; i++) {
    const earlier = byType.get(PUNCH_ORDER[i])
    if (earlier !== undefined && when <= earlier) {
      return `${PUNCH_LABELS[type]} must be after ${PUNCH_LABELS[PUNCH_ORDER[i]]}.`
    }
  }
  for (let i = index + 1; i < PUNCH_ORDER.length; i++) {
    const later = byType.get(PUNCH_ORDER[i])
    if (later !== undefined && when >= later) {
      return `${PUNCH_LABELS[type]} must be before ${PUNCH_LABELS[PUNCH_ORDER[i]]}.`
    }
  }
  return null
}
