// Calendar quarters and the Reports screen's date range, pure.
//
// Calendar quarters because that is what US estimated federal tax uses, and
// this exists so Dan can hand his accountant a quarter's figures (2026-09-09:
// "It is for estimated quarterly taxes. I need to give information to my
// accountant.").
//
// NO PAYMENT DUE DATES live here, deliberately. They shift for weekends and
// holidays, and a wrong one printed beside a number Dan is about to send would
// be worse than no date at all.
//
// No '@/' imports and no JSX — exercised by node --test, same as lib/dates.ts.

import { isPlainDate } from './dates.ts'

export type DateRange = { from: string; to: string }

// Written out rather than computed from month lengths: no quarter ends in
// February, so a leap year can never move a boundary, and the literal table is
// the thing a reader can check against a tax form at a glance.
const Q_FROM = ['01-01', '04-01', '07-01', '10-01'] as const
const Q_TO = ['03-31', '06-30', '09-30', '12-31'] as const

/** Inclusive on both ends. */
export function quarterRange(year: number, q: 1 | 2 | 3 | 4): DateRange {
  return { from: `${year}-${Q_FROM[q - 1]}`, to: `${year}-${Q_TO[q - 1]}` }
}

/** Inclusive on both ends. */
export function yearRange(year: number): DateRange {
  return { from: `${year}-01-01`, to: `${year}-12-31` }
}

/**
 * The range the Reports page should show, from its URL parameters.
 *
 * Every unusable input falls back to the current calendar year rather than
 * erroring: this screen has no destructive action, and an unreadable URL
 * should not cost Dan the page. A REVERSED range is refused for a sharper
 * reason — it would report zero of everything, which reads as "you earned
 * nothing this quarter" instead of as a broken link.
 */
export function resolveRange(
  from: string | undefined, to: string | undefined, today: string,
): DateRange {
  const fallback = yearRange(Number(today.slice(0, 4)))
  if (!from || !to) return fallback
  if (!isPlainDate(from) || !isPlainDate(to)) return fallback
  if (to < from) return fallback
  return { from, to }
}
