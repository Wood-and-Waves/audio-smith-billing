// Punch vocabulary, shared by the calculator and the UI.
// No 'use client': this runs in server trees, client trees and node --test.

export const PUNCH_ORDER = [
  'start', 'meal_out', 'meal_in', 'meal2_out', 'meal2_in', 'end',
] as const

export type PunchType = (typeof PUNCH_ORDER)[number]

export const PUNCH_LABELS: Record<PunchType, string> = {
  start: 'In',
  meal_out: 'Meal out',
  meal_in: 'Meal in',
  meal2_out: 'Meal 2 out',
  meal2_in: 'Meal 2 in',
  end: 'Out',
}

/** Meal breaks as (out, in) pairs. Deduction and penalty rules walk this list. */
export const MEAL_PAIRS: readonly (readonly [PunchType, PunchType])[] = [
  ['meal_out', 'meal_in'],
  ['meal2_out', 'meal2_in'],
] as const
