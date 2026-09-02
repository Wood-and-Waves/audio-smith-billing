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

/**
 * Plain chronological, earliest first — the order the UNBILLED list uses.
 *
 * `byDateClosestFirst` above buckets past/current/planning before it looks at
 * a date, so a show that finished yesterday sorts below one six months out.
 * That is right for "what is next" and wrong for billing, which is the only
 * thing the unbilled list is for: a finished show is precisely the one with
 * work left on it (Dan, 2026-09-02 — *"When a show is over on the shows page
 * it drops to the bottom. This makes it annoying to bill."*).
 *
 * Nothing here marks which show is current, and nothing needs to: the row
 * renderer computes `inProgress` from the dates themselves and paints it in
 * the accent colour, independent of position. That highlight is why a plain
 * date order stays readable — Dan's own reasoning for choosing it.
 *
 * A show with NO days still sorts to the very top, same as the other order:
 * it is being set up right now, which is the only reason it exists in that
 * state. That falls out of `firstDay` returning `''`, which sorts before any
 * real date lexically — pinned by a test rather than left to luck.
 *
 * Ties on the first day fall back to the last, so a one-day show sorts above
 * a week-long one starting the same morning.
 */
export function byDateEarliestFirst<T extends DatedShow>(shows: T[]): T[] {
  return [...shows].sort((a, b) =>
    firstDay(a).localeCompare(firstDay(b)) || lastDay(a).localeCompare(lastDay(b)))
}
