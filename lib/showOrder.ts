// The order shows are listed in.
//
// The list was ordered by created_at, which is the order Dan happened to type
// them in — useful on the day and useless a month later. What he actually
// scans for is "what is next".
//
// So: closest first. Anything still to come, or happening right now, sorted by
// when it starts. Everything finished after that, most recent first, because a
// trip you just got back from is the one you are still billing.
//
// Pure — `today` is passed in, never read from a clock, so the tests cannot
// drift when the suite runs on a different day.

export type DatedShow = {
  /** Every day on the show, in any order. Empty for a show with none yet. */
  dates: string[]
}

/** Where a show sits relative to today. Exported for the tests to name. */
export type ShowWhen = 'planning' | 'current' | 'past'

/**
 * A show is `current` while its LAST day is still ahead — not while its first
 * one is. A trip that started yesterday and runs another week is the most
 * relevant thing on the screen, and bucketing on the first day would file it
 * under history.
 */
export function whenIs(show: DatedShow, today: string): ShowWhen {
  if (show.dates.length === 0) return 'planning'
  const last = show.dates.reduce((a, b) => (a > b ? a : b))
  return last >= today ? 'current' : 'past'
}

const firstDay = (s: DatedShow) =>
  s.dates.length === 0 ? '' : s.dates.reduce((a, b) => (a < b ? a : b))

const lastDay = (s: DatedShow) =>
  s.dates.length === 0 ? '' : s.dates.reduce((a, b) => (a > b ? a : b))

/**
 * Closest first.
 *
 * A show with no days yet sorts to the very top: it is being set up right now,
 * which is the only reason it exists in that state.
 *
 * Dates are plain `YYYY-MM-DD`, so they compare lexically — no parsing, and no
 * chance of a timezone shifting one a day either way.
 */
export function byDateClosestFirst<T extends DatedShow>(shows: T[], today: string): T[] {
  const rank = { planning: 0, current: 1, past: 2 } as const

  return [...shows].sort((a, b) => {
    const wa = whenIs(a, today)
    const wb = whenIs(b, today)
    if (wa !== wb) return rank[wa] - rank[wb]

    // Upcoming and in-progress: soonest start first.
    if (wa === 'current') return firstDay(a).localeCompare(firstDay(b))

    // Finished: most recently finished first.
    if (wa === 'past') return lastDay(b).localeCompare(lastDay(a))

    return 0
  })
}
