// The calendar's bar geometry (design: docs/superpowers/specs/
// 2026-08-25-calendar-show-bars-design.md). Pure — no I/O, no clock, no JSX
// — so every decision the month grid makes about a bar is provable by
// node --test instead of by eye.
//
// Dan's rule, from his own review of the mockup: a run's TRUE start and
// TRUE finish are rounded; an edge where the run continues into another
// week is square. `continuesLeft`/`continuesRight` below are the ONLY
// inputs to that rule — components must never re-derive them from dates,
// or the two copies will drift and a bar will quietly lie about whether a
// booking carries on.

import { addDays } from './dates.ts'

/** One show day, as little of it as the geometry needs. */
export type RunDay = { showId: string; showName: string; date: string }

/** An unbroken stretch of one show's days, inclusive at both ends. */
export type ShowRun = { showId: string; showName: string; start: string; end: string }

/** One run's intersection with one week of the grid. */
export type BarSegment = {
  startCol: number
  span: number
  /** The run began BEFORE this week — draw a square left edge. */
  continuesLeft: boolean
  /** The run runs on PAST this week — draw a square right edge. */
  continuesRight: boolean
}

export type PlacedBar = BarSegment & { lane: number; showId: string; showName: string }

/** Lanes drawn per week before further segments fall to the "+N" counter.
 *  Dan's real books peak at 2 concurrent shows, so this is defensive. */
export const MAX_LANES = 3

/**
 * Days -> unbroken runs, one per contiguous stretch per show.
 *
 * A show whose days have a GAP yields several runs and therefore several
 * bars: a single bar spanning the gap would claim a day he is not working.
 * Duplicate dates for one show are absorbed rather than treated as a gap.
 *
 * The returned order is total and deterministic (start date, then show
 * name, then show id), which is what makes `layOutWeek`'s greedy lane
 * assignment stable across renders instead of drifting with fetch order.
 */
export function contiguousRuns(days: RunDay[]): ShowRun[] {
  const byShow = new Map<string, RunDay[]>()
  for (const d of days) {
    const list = byShow.get(d.showId)
    if (list) list.push(d)
    else byShow.set(d.showId, [d])
  }

  const runs: ShowRun[] = []
  for (const [showId, list] of byShow) {
    const sorted = [...list].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    const showName = sorted[0].showName
    let start = sorted[0].date
    let prev = sorted[0].date
    for (let i = 1; i < sorted.length; i++) {
      const date = sorted[i].date
      if (date === prev) continue
      if (date === addDays(prev, 1)) { prev = date; continue }
      runs.push({ showId, showName, start, end: prev })
      start = date
      prev = date
    }
    runs.push({ showId, showName, start, end: prev })
  }

  return runs.sort((a, b) =>
    a.start < b.start ? -1 : a.start > b.start ? 1 :
    a.showName < b.showName ? -1 : a.showName > b.showName ? 1 :
    a.showId < b.showId ? -1 : a.showId > b.showId ? 1 : 0,
  )
}

/**
 * One run clipped to one week, or null when they do not touch.
 *
 * The continue flags compare against the week's own ends, so a run reaching
 * outside the RENDERED grid is still reported as continuing — which is why
 * the calendar page must fetch whole shows rather than only the days inside
 * the grid window (see its own comment).
 */
export function segmentForWeek(run: ShowRun, week: string[]): BarSegment | null {
  const weekStart = week[0]
  const weekEnd = week[week.length - 1]
  if (run.end < weekStart || run.start > weekEnd) return null

  const firstVisible = run.start < weekStart ? weekStart : run.start
  const lastVisible = run.end > weekEnd ? weekEnd : run.end
  const startCol = week.indexOf(firstVisible)
  const endCol = week.indexOf(lastVisible)
  // A week from monthGrid is seven consecutive days, so both lookups hit;
  // the guard keeps a hand-built week from producing a negative span.
  if (startCol < 0 || endCol < 0) return null

  return {
    startCol,
    span: endCol - startCol + 1,
    continuesLeft: run.start < weekStart,
    continuesRight: run.end > weekEnd,
  }
}

/**
 * Every bar for one week, each on the lowest lane free across its whole
 * span — the standard greedy calendar layout. Runs arrive in
 * `contiguousRuns`' own total order, so the result is identical on every
 * render.
 *
 * A segment that would need a lane beyond `maxLanes` is deliberately NOT
 * drawn; it increments `overflowByCol` for each column it covers so the
 * cell can say "+N". Hiding it silently would let the calendar under-report
 * his own bookings.
 */
export function layOutWeek(
  runs: ShowRun[],
  week: string[],
  maxLanes: number = MAX_LANES,
): { bars: PlacedBar[]; overflowByCol: number[] } {
  const bars: PlacedBar[] = []
  const overflowByCol = new Array(week.length).fill(0) as number[]
  const lanes: boolean[][] = []

  for (const run of runs) {
    const seg = segmentForWeek(run, week)
    if (!seg) continue

    let lane = 0
    while (lane < maxLanes) {
      if (!lanes[lane]) lanes[lane] = new Array(week.length).fill(false)
      let free = true
      for (let c = seg.startCol; c < seg.startCol + seg.span; c++) {
        if (lanes[lane][c]) { free = false; break }
      }
      if (free) break
      lane++
    }

    if (lane >= maxLanes) {
      for (let c = seg.startCol; c < seg.startCol + seg.span; c++) overflowByCol[c]++
      continue
    }

    for (let c = seg.startCol; c < seg.startCol + seg.span; c++) lanes[lane][c] = true
    bars.push({ ...seg, lane, showId: run.showId, showName: run.showName })
  }

  return { bars, overflowByCol }
}
