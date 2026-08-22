// Which show is Dan standing in right now?
//
// The snap-a-receipt button has to answer that without asking, because the
// whole point is removing taps on a show floor. The answer is almost always
// "the one whose dates contain today" — a receipt gets photographed while the
// gig is happening.
//
// It is a DEFAULT, never a commitment: the caller names the chosen show on
// the confirm screen with a control to change it. A wrong guess that reaches
// the database is a receipt filed against the wrong client's invoice, so the
// rule here is deliberately narrow — it declines to guess far more readily
// than it guesses wrong.
//
// `today` is a parameter, resolved in Chicago by the caller. That matches the
// shows LIST page rather than the detail page: picking among many shows is a
// list-grade decision, and the detail page's show-own-zone treatment answers
// a different question ("which row of THIS show is today").
//
// No '@/' imports and no JSX — exercised by node --test.

/** Nearby-ness window for ordering picker candidates, in days either side. */
export const NEARBY_DAYS = 7

export type PickableShow = {
  id: string
  name: string
  status: 'open' | 'billed'
  /** Every scheduled day, plain YYYY-MM-DD. Empty is legal (a show with no
   *  days yet) and simply never matches today. */
  dates: string[]
}

const MS_PER_DAY = 86_400_000

/** Absolute whole days between two plain dates, UTC-pinned (lib/dates.ts's
 *  doctrine: a plain date read through a local zone shifts west of UTC). */
function daysApart(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number)
  const [by, bm, bd] = b.split('-').map(Number)
  return Math.abs(Date.UTC(ay, am - 1, ad) - Date.UTC(by, bm - 1, bd)) / MS_PER_DAY
}

/** Smallest distance in days from `today` to any of the show's dates, or
 *  null when it has none. */
function proximity(show: PickableShow, today: string): number | null {
  let best: number | null = null
  for (const d of show.dates) {
    const gap = daysApart(d, today)
    if (best === null || gap < best) best = gap
  }
  return best
}

/**
 * The show to default to, or null when the app should ask instead.
 *
 * Null on purpose in three cases: no show contains today, more than one does
 * (nothing in the data breaks that tie, and guessing would misfile), or the
 * only match is billed — a billed show's expenses are frozen and `addExpense`
 * refuses them, so walking Dan into it would waste the shot he just took.
 */
export function showForToday(shows: PickableShow[], today: string): PickableShow | null {
  const containing = shows.filter(
    (s) => s.status !== 'billed' && s.dates.includes(today),
  )
  return containing.length === 1 ? containing[0] : null
}

/**
 * Shows to offer when there is no automatic answer, best first: anything
 * within a week of today (a load-in that starts tomorrow, a receipt filed the
 * morning after), then everything else by how recently it ran. Billed shows
 * are omitted entirely rather than shown-and-refused.
 */
export function pickerCandidates(shows: PickableShow[], today: string): PickableShow[] {
  const open = shows.filter((s) => s.status !== 'billed')
  const scored = open.map((s) => ({ show: s, gap: proximity(s, today) }))

  return scored
    .sort((a, b) => {
      // A show with no dates sorts last but is still offered — it can hold an
      // expense, and excluding it would hide a real destination.
      const aGap = a.gap ?? Infinity
      const bGap = b.gap ?? Infinity
      const aNear = aGap <= NEARBY_DAYS
      const bNear = bGap <= NEARBY_DAYS
      if (aNear !== bNear) return aNear ? -1 : 1
      if (aGap !== bGap) return aGap - bGap
      // Deterministic tail: same distance, order by name so the list never
      // reshuffles between renders.
      return a.show.name.localeCompare(b.show.name)
    })
    .map((s) => s.show)
}
