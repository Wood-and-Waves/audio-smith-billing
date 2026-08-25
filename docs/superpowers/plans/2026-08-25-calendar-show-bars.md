# Calendar Show Bars Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render each show as one spanning bar across the month grid instead of one chip per day, and emit one calendar-feed event per show run instead of one per day.

**Architecture:** A new pure lib (`lib/showRuns.ts`) turns show days into contiguous runs, intersects each run with each week of the grid, and assigns stacking lanes. The month grid becomes per-week rows with a pointer-events-none bar overlay above the existing day-cell buttons, so a bar can be a link without nesting interactives. `lib/ics.ts` reuses the same run grouping for the feed; migration 0047 adds the `show_id` the feed's RPC does not currently return.

**Tech Stack:** Next.js 16 (App Router, RSC), Supabase/Postgres, Tailwind, `node --test`.

## Global Constraints

- Design doc: `docs/superpowers/specs/2026-08-25-calendar-show-bars-design.md`. Dan's four decisions are binding: one uniform bar (no travel shading); bar click → show page, cell click → day dialog; bars on phone too; the feed becomes one event per run.
- **The corner rule** (his own correction): a run's true start and true finish are ROUNDED; an edge where the run continues into another week is SQUARE. `continuesLeft`/`continuesRight` from `lib/showRuns.ts` are the only inputs — the component never re-derives them from dates.
- Migration ADDITIVE ONLY: `scripts/sql/migrations/0047_calendar_feed_show_id.sql`. **SHIP ORDER: prod migration FIRST, then merge.**
- Pure libs (`lib/*.ts`): relative `.ts` imports, no `@/`, no JSX, no clock reads.
- The feed is SCHEDULE FACTS ONLY — no rate, cents, total, or invoice field may enter `lib/ics.ts`, the feed RPC, or `app/cal/[token]/route.ts`.
- **DTEND is EXCLUSIVE** for an all-day VEVENT (RFC 5545 3.6.1): a run ending 9/3 carries DTEND 9/4. Its own test is mandatory.
- Bars use the app's existing single accent (`bg-accent-surface text-accent-ink`), NOT the per-show colors in the approved mockup — the mockup's palette was the mockup tool's, and inventing a per-show colour assignment is new design surface nobody asked for. Flag this to Dan at the walkthrough.
- `MAX_LANES = 3`. A segment that would exceed it is not drawn and instead counts into `overflowByCol`, rendered as "+N" in each covered cell — degrade by telling the truth, never by hiding a booking.
- Gates before every commit: `npm test`, cold tsc (`rm -f tsconfig.tsbuildinfo .next/cache/.tsbuildinfo && npx tsc --noEmit`), `npm run build`. Never `npm run dev` — the preview tool only.

## Model tiering
Task 1 standard (the logic) · Task 2 standard · Task 3 standard (layout judgment) · final review top model.

---

### Task 1: `lib/showRuns.ts` — runs, week segments, lanes (TDD)

**Files:**
- Create: `lib/showRuns.ts`
- Test: `scripts/test/showRuns.test.ts`

**Interfaces — Produces (later tasks depend on these exact names):**
- `type RunDay = { showId: string; showName: string; date: string }`
- `type ShowRun = { showId: string; showName: string; start: string; end: string }`
- `type BarSegment = { startCol: number; span: number; continuesLeft: boolean; continuesRight: boolean }`
- `type PlacedBar = BarSegment & { lane: number; showId: string; showName: string }`
- `const MAX_LANES = 3`
- `contiguousRuns(days: RunDay[]): ShowRun[]`
- `segmentForWeek(run: ShowRun, week: string[]): BarSegment | null`
- `layOutWeek(runs: ShowRun[], week: string[], maxLanes?: number): { bars: PlacedBar[]; overflowByCol: number[] }`

**Consumes:** `addDays(iso, days)` from `lib/dates.ts` (already exists, line 58).

- [ ] **Step 1: Write the failing tests**

Create `scripts/test/showRuns.test.ts`:

```ts
// Run: npm test -- scripts/test/showRuns.test.ts
//
// The calendar's bar geometry. Dan's corner rule — a true start/finish is
// rounded, a week-boundary continuation is square — reduces entirely to the
// continuesLeft/continuesRight flags asserted here, so these tests are what
// keep the rendered corners honest.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { contiguousRuns, segmentForWeek, layOutWeek, MAX_LANES } from '../../lib/showRuns.ts'

const day = (showId: string, date: string, showName = showId) => ({ showId, showName, date })

// The real September 2026 grid rows this feature was designed against.
const W_AUG30 = ['2026-08-30','2026-08-31','2026-09-01','2026-09-02','2026-09-03','2026-09-04','2026-09-05']
const W_SEP13 = ['2026-09-13','2026-09-14','2026-09-15','2026-09-16','2026-09-17','2026-09-18','2026-09-19']
const W_SEP20 = ['2026-09-20','2026-09-21','2026-09-22','2026-09-23','2026-09-24','2026-09-25','2026-09-26']

test('a contiguous block of days is ONE run', () => {
  const runs = contiguousRuns([
    day('a', '2026-09-13'), day('a', '2026-09-14'), day('a', '2026-09-15'),
  ])
  assert.deepEqual(runs, [{ showId: 'a', showName: 'a', start: '2026-09-13', end: '2026-09-15' }])
})

test('a gap splits one show into two runs — a bar must never paper over a day he is not working', () => {
  const runs = contiguousRuns([
    day('a', '2026-09-13'), day('a', '2026-09-14'),
    day('a', '2026-09-17'), day('a', '2026-09-18'),
  ])
  assert.equal(runs.length, 2)
  assert.deepEqual(runs.map((r) => [r.start, r.end]), [
    ['2026-09-13', '2026-09-14'], ['2026-09-17', '2026-09-18'],
  ])
})

test('a single day is a run of one, and unsorted input still groups correctly', () => {
  const runs = contiguousRuns([day('b', '2026-09-15'), day('a', '2026-09-14'), day('a', '2026-09-13')])
  assert.deepEqual(runs, [
    { showId: 'a', showName: 'a', start: '2026-09-13', end: '2026-09-14' },
    { showId: 'b', showName: 'b', start: '2026-09-15', end: '2026-09-15' },
  ])
})

test('two shows never merge into one run even on adjacent days', () => {
  const runs = contiguousRuns([day('a', '2026-09-13'), day('b', '2026-09-14')])
  assert.equal(runs.length, 2)
})

test('a run inside one week: rounded on BOTH ends', () => {
  const seg = segmentForWeek(
    { showId: 'a', showName: 'BMS', start: '2026-09-13', end: '2026-09-17' }, W_SEP13,
  )
  assert.deepEqual(seg, { startCol: 0, span: 5, continuesLeft: false, continuesRight: false })
})

test("Dan's real PwC run (8/28-9/3) is SQUARE on the left in the 8/30 week — it arrived from August", () => {
  const seg = segmentForWeek(
    { showId: 'p', showName: 'PwC', start: '2026-08-28', end: '2026-09-03' }, W_AUG30,
  )
  assert.deepEqual(seg, { startCol: 0, span: 5, continuesLeft: true, continuesRight: false })
})

test("Children's Health (9/17-9/20) is square where it crosses and rounded where it truly ends", () => {
  const run = { showId: 'c', showName: 'CHF', start: '2026-09-17', end: '2026-09-20' }
  assert.deepEqual(segmentForWeek(run, W_SEP13), { startCol: 4, span: 3, continuesLeft: false, continuesRight: true })
  assert.deepEqual(segmentForWeek(run, W_SEP20), { startCol: 0, span: 1, continuesLeft: true, continuesRight: false })
})

test('a run that swallows the whole week is square on both sides', () => {
  const seg = segmentForWeek(
    { showId: 'x', showName: 'X', start: '2026-09-01', end: '2026-12-01' }, W_SEP13,
  )
  assert.deepEqual(seg, { startCol: 0, span: 7, continuesLeft: true, continuesRight: true })
})

test('a run outside the week yields no segment', () => {
  assert.equal(segmentForWeek({ showId: 'a', showName: 'A', start: '2026-10-01', end: '2026-10-02' }, W_SEP13), null)
  assert.equal(segmentForWeek({ showId: 'a', showName: 'A', start: '2026-09-01', end: '2026-09-02' }, W_SEP13), null)
})

test('overlapping runs take separate lanes; a finished lane is REUSED', () => {
  const runs = contiguousRuns([
    ...['2026-09-13','2026-09-14','2026-09-15','2026-09-16','2026-09-17'].map((d) => day('bms', d, 'BMS')),
    ...['2026-09-17','2026-09-18','2026-09-19'].map((d) => day('chf', d, 'CHF')),
  ])
  const { bars, overflowByCol } = layOutWeek(runs, W_SEP13)
  assert.deepEqual(bars.map((b) => [b.showName, b.lane, b.startCol, b.span]), [
    ['BMS', 0, 0, 5], ['CHF', 1, 4, 3],
  ])
  assert.deepEqual(overflowByCol, [0, 0, 0, 0, 0, 0, 0])

  // Same week, no overlap: the second run drops back to lane 0.
  const apart = contiguousRuns([
    day('a', '2026-09-13', 'A'), day('a', '2026-09-14', 'A'),
    day('b', '2026-09-17', 'B'), day('b', '2026-09-18', 'B'),
  ])
  assert.deepEqual(layOutWeek(apart, W_SEP13).bars.map((b) => b.lane), [0, 0])
})

test('beyond MAX_LANES a segment is NOT drawn and counts into overflowByCol on every column it covers', () => {
  const days = []
  for (let i = 0; i < MAX_LANES + 1; i++) {
    days.push(day(`s${i}`, '2026-09-14', `S${i}`), day(`s${i}`, '2026-09-15', `S${i}`))
  }
  const { bars, overflowByCol } = layOutWeek(contiguousRuns(days), W_SEP13)
  assert.equal(bars.length, MAX_LANES)
  assert.deepEqual(overflowByCol, [0, 1, 1, 0, 0, 0, 0])
})

test('lane order is stable — identical input gives an identical layout', () => {
  const days = [
    day('z', '2026-09-13', 'Z'), day('z', '2026-09-16', 'Z'),
    day('a', '2026-09-13', 'A'), day('a', '2026-09-15', 'A'),
  ]
  const once = layOutWeek(contiguousRuns(days), W_SEP13).bars
  const twice = layOutWeek(contiguousRuns([...days].reverse()), W_SEP13).bars
  assert.deepEqual(once, twice)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- scripts/test/showRuns.test.ts`
Expected: FAIL — cannot find module `../../lib/showRuns.ts`.

- [ ] **Step 3: Implement `lib/showRuns.ts`**

```ts
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
```

- [ ] **Step 4: Run to verify green**

Run: `npm test -- scripts/test/showRuns.test.ts` → all pass.
Then the full suite: `npm test` → 890 pre-existing plus the new ones, 0 fail.
Then cold tsc: `rm -f tsconfig.tsbuildinfo .next/cache/.tsbuildinfo && npx tsc --noEmit` → clean.

- [ ] **Step 5: Commit**

```bash
git add lib/showRuns.ts scripts/test/showRuns.test.ts
git commit -m "feat: pure show-run geometry for calendar bars"
```

---

### Task 2: The feed emits one event per run (migration 0047 + ics)

**Files:**
- Create: `scripts/sql/migrations/0047_calendar_feed_show_id.sql`
- Modify: `lib/ics.ts` (`FeedDay`, `showDayEvent` → `showRunEvent`, `buildCalendarFeed`)
- Modify: `app/cal/[token]/route.ts` (map the new field)
- Test: `scripts/test/ics.test.ts`

**Interfaces — Consumes:** `contiguousRuns`, `type RunDay`, `type ShowRun` from `lib/showRuns.ts` (Task 1); `addDays` from `lib/dates.ts`.

- [ ] **Step 1: Write migration 0047**

Create `scripts/sql/migrations/0047_calendar_feed_show_id.sql`:

```sql
-- 0047 — the calendar feed's day objects carry their show id
--
-- The feed becomes one VEVENT per show RUN instead of one per day (design:
-- docs/superpowers/specs/2026-08-25-calendar-show-bars-design.md, Dan's
-- own decision), so lib/ics.ts has to know which show each day belongs to
-- in order to group them. public_calendar_feed (0033) returns day objects
-- without show_id, and grouping by NAME would merge two different shows
-- that happen to share one. This adds the single missing field.
--
-- create or replace with an UNCHANGED signature: 0033's grants (anon,
-- authenticated), its security-definer posture and its pinned search_path
-- all carry over untouched, so no grant needs re-issuing here. The
-- SCHEDULE FACTS ONLY rule is unchanged — a show id is an opaque uuid, the
-- same class of identifier the old showday-<uuid> UIDs already published.

create or replace function public.public_calendar_feed(p_token uuid)
returns jsonb
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select case when s.owner_id is null then null else jsonb_build_object(
    'days', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',         d.id,
        'show_id',    d.show_id,
        'date',       d.date,
        'show_name',  sh.name,
        'venue',      sh.venue,
        'location',   sh.location,
        'client',     c.name
      ) order by d.date)
      from show_days d
      join shows sh on sh.id = d.show_id
      join clients c on c.id = sh.client_id
      where d.owner_id = s.owner_id
    ), '[]'::jsonb),
    'flights', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',          f.id,
        'flight_no',   f.flight_no,
        'flight_date', f.flight_date,
        'dep_airport', f.dep_airport,
        'arr_airport', f.arr_airport,
        'dep_at',      f.dep_at,
        'arr_at',      f.arr_at
      ) order by f.flight_date)
      from flights f
      where f.owner_id = s.owner_id
    ), '[]'::jsonb)
  ) end
  from (
    select owner_id from settings where calendar_token = p_token
  ) s
$$;
```

Run `npm run db:migrate` (DEV only). Verify with a temp file containing
`select jsonb_pretty(public_calendar_feed((select calendar_token from settings limit 1))) limit 1;`
run through `npm run db:sql -- <file>`, confirming a day object now carries `show_id`; delete the temp file. **Do NOT run `--prod`** — the controller ships that at the gate.

- [ ] **Step 2: Write the failing ics tests**

Append to `scripts/test/ics.test.ts` (keep the file's existing imports; add `buildCalendarFeed` if not already imported):

```ts
const runDay = (showId: string, date: string, showName = 'PwC Tax Assurance') => ({
  id: `d-${showId}-${date}`, showId, date, showName,
  venue: 'Hyatt', location: 'Chicago, IL', client: 'PwC',
})

test('an all-day run ends the DAY AFTER its last day — DTEND is exclusive (RFC 5545)', () => {
  const ics = buildCalendarFeed({
    days: [runDay('s1', '2026-08-28'), runDay('s1', '2026-08-29'), runDay('s1', '2026-08-30')],
    flights: [],
    nowIso: '2026-08-25T12:00:00Z',
  })
  assert.match(ics, /DTSTART;VALUE=DATE:20260828/)
  // Last day is the 30th, so DTEND must read the 31st. A DTEND of 20260830
  // would show subscribers a two-day show instead of three.
  assert.match(ics, /DTEND;VALUE=DATE:20260831/)
  assert.equal(ics.match(/BEGIN:VEVENT/g)?.length, 1)
})

test('a single-day show spans exactly one day', () => {
  const ics = buildCalendarFeed({ days: [runDay('s1', '2026-09-15')], flights: [], nowIso: '2026-08-25T12:00:00Z' })
  assert.match(ics, /DTSTART;VALUE=DATE:20260915/)
  assert.match(ics, /DTEND;VALUE=DATE:20260916/)
})

test('a gapped show emits two events with distinct, run-scoped UIDs', () => {
  const ics = buildCalendarFeed({
    days: [runDay('s1', '2026-09-13'), runDay('s1', '2026-09-14'), runDay('s1', '2026-09-17')],
    flights: [],
    nowIso: '2026-08-25T12:00:00Z',
  })
  assert.equal(ics.match(/BEGIN:VEVENT/g)?.length, 2)
  assert.match(ics, /UID:showrun-s1-2026-09-13@theaudiosmith\.com/)
  assert.match(ics, /UID:showrun-s1-2026-09-17@theaudiosmith\.com/)
})

test('two shows on adjacent days stay two events', () => {
  const ics = buildCalendarFeed({
    days: [runDay('s1', '2026-09-13', 'BMS'), runDay('s2', '2026-09-14', 'CHF')],
    flights: [],
    nowIso: '2026-08-25T12:00:00Z',
  })
  assert.equal(ics.match(/BEGIN:VEVENT/g)?.length, 2)
})

test('the run keeps the show details on its event', () => {
  const ics = buildCalendarFeed({ days: [runDay('s1', '2026-09-15')], flights: [], nowIso: '2026-08-25T12:00:00Z' })
  assert.match(ics, /SUMMARY:PwC Tax Assurance/)
  assert.match(ics, /LOCATION:Hyatt · Chicago\, IL/)
  assert.match(ics, /DESCRIPTION:PwC/)
})
```

Run: `npm test -- scripts/test/ics.test.ts`
Expected: FAIL — `showId` is not a property of `FeedDay`, and no `DTEND` is emitted.

- [ ] **Step 3: Implement the ics change**

In `lib/ics.ts`:

1. Add the imports at the top of the file:

```ts
import { addDays } from './dates.ts'
import { contiguousRuns, type RunDay, type ShowRun } from './showRuns.ts'
```

2. `FeedDay` gains one field:

```ts
export type FeedDay = {
  id: string
  /** Which show this day belongs to — the grouping key for runs (0047).
   *  Grouping by name instead would merge two shows that share one. */
  showId: string
  date: string // YYYY-MM-DD
  showName: string
  venue: string | null
  location: string | null
  client: string
}
```

3. Replace `showDayEvent` entirely with:

```ts
/**
 * One VEVENT per contiguous RUN of a show's days (Dan's decision,
 * 2026-08-25) rather than one per day, so a 9-day booking reads as a
 * single block in a subscriber's calendar. `meta` carries the show-level
 * fields, taken from any day of the run — they are identical across it.
 *
 * The UID is run-scoped and stable: an unchanged run keeps its identity
 * across refreshes, and a show with a gap publishes one event per run,
 * matching what the month grid draws. This DOES change every UID the feed
 * previously published (`showday-<dayId>`), so subscribers drop the old
 * per-day events and pick up these on the next refresh — the one-time
 * churn Dan accepted when he chose this.
 */
function showRunEvent(run: ShowRun, meta: FeedDay, stamp: string): string[] {
  const lines = [
    'BEGIN:VEVENT',
    `UID:showrun-${run.showId}-${run.start}@theaudiosmith.com`,
    `DTSTAMP:${stamp}`,
    `DTSTART;VALUE=DATE:${toDateBasic(run.start)}`,
    // DTEND is EXCLUSIVE for an all-day event (RFC 5545 3.6.1): a run
    // ending on the 30th must publish the 31st, or every subscriber sees
    // the show one day short. Pinned by its own test.
    `DTEND;VALUE=DATE:${toDateBasic(addDays(run.end, 1))}`,
    `SUMMARY:${escapeText(run.showName)}`,
  ]

  const location = [meta.venue, meta.location].filter((v): v is string => v !== null).join(' · ')
  if (location) lines.push(`LOCATION:${escapeText(location)}`)

  lines.push(`DESCRIPTION:${escapeText(meta.client)}`)
  lines.push('END:VEVENT')
  return lines
}
```

4. In `buildCalendarFeed`, replace the days loop (`for (const day of input.days) lines.push(...showDayEvent(day, stamp))`) with:

```ts
  // Runs come from the SAME helper the month grid uses (lib/showRuns.ts) —
  // one contiguity rule for both surfaces, so the feed can never disagree
  // with what he sees on screen.
  const runDays: RunDay[] = input.days.map((d) => ({
    showId: d.showId, showName: d.showName, date: d.date,
  }))
  const metaByShow = new Map<string, FeedDay>()
  for (const d of input.days) if (!metaByShow.has(d.showId)) metaByShow.set(d.showId, d)

  for (const run of contiguousRuns(runDays)) {
    const meta = metaByShow.get(run.showId)
    if (!meta) continue
    lines.push(...showRunEvent(run, meta, stamp))
  }
```

- [ ] **Step 4: Map the new field in the route**

In `app/cal/[token]/route.ts`, add `show_id: string` to the `FeedRow` days element type, and add one line to the `days` map:

```ts
  const days: FeedDay[] = row.days.map((d) => ({
    id: d.id,
    showId: d.show_id,
    date: d.date,
    showName: d.show_name,
    venue: d.venue,
    location: d.location,
    client: d.client,
  }))
```

- [ ] **Step 5: Gates and commit**

Run `npm test` (all green), cold tsc, `npm run build`.

```bash
git add scripts/sql/migrations/0047_calendar_feed_show_id.sql lib/ics.ts app/cal/\[token\]/route.ts scripts/test/ics.test.ts
git commit -m "feat: one calendar-feed event per show run"
```

---

### Task 3: The month grid draws bars

**Files:**
- Modify: `app/calendar/page.tsx` (the show-day fetch and a new `runs` prop)
- Modify: `components/CalendarMonth.tsx` (per-week rows + bar overlay)

**Interfaces — Consumes:** `contiguousRuns`, `layOutWeek`, `type ShowRun` from `lib/showRuns.ts`.

- [ ] **Step 1: Widen the page's show-day fetch**

In `app/calendar/page.tsx`, the `show_days` half of the existing `Promise.all` currently filters `.gte('date', first).lte('date', last)`. Replace that ONE query with a two-step fetch placed just before the `Promise.all` (leave the flights query in the `Promise.all`, on its own):

```ts
  // Runs have to be TRUE at the grid's edges. Fetching only the days inside
  // the window would make a show that carries on past the last cell look
  // like it FINISHES there — a rounded corner that lies (see
  // lib/showRuns.ts's own note). So: the show ids touching this window,
  // then every day those shows have, whichever month it falls in.
  const { data: windowRows, error: windowError } = await supabase
    .from('show_days')
    .select('show_id')
    .gte('date', first)
    .lte('date', last)
  if (windowError) return <LoadError message={windowError.message} />

  const showIds = [...new Set((windowRows ?? []).map((r) => r.show_id as string))]

  // A plain guarded read rather than a ternary around `await`: the two
  // branches of a ternary have different result shapes and the union does
  // not narrow cleanly under `tsc --noEmit`.
  let dayRows: unknown[] = []
  if (showIds.length > 0) {
    const { data, error: dayError } = await supabase
      .from('show_days')
      .select(
        'id, date, travel_in, travel_out, pay_as_half_day, show_id, ' +
          'shows(name, venue, location, timezone, clients(name))',
      )
      .in('show_id', showIds)
      .order('date')
    if (dayError) return <LoadError message={dayError.message} />
    dayRows = data ?? []
  }
```

`dayRowsTyped` stays as it is. Then, where `showsByDate` is built, clip it to the rendered window (it feeds the day dialog, which only ever asks about a visible date) and build `runs` from the full set:

The `showsByDate` loop keeps its existing body verbatim (the `DayEntry`
construction is unchanged). Insert exactly ONE new line, immediately after
its `if (!d.shows) continue`:

```ts
    // The fetch above deliberately reaches outside the grid for run
    // boundaries; the dialog only ever asks about a cell that is on screen.
    if (d.date < first || d.date > last) continue
```

Then add the runs derivation after that loop:

```ts

  const runs: ShowRun[] = contiguousRuns(
    dayRowsTyped.flatMap((d) =>
      d.shows ? [{ showId: d.show_id, showName: d.shows.name, date: d.date }] : [],
    ),
  )
```

Add the import `import { contiguousRuns, type ShowRun } from '@/lib/showRuns'` and pass `runs={runs}` to `<CalendarMonth …>`.

- [ ] **Step 2: Restructure the grid into week rows with a bar overlay**

In `components/CalendarMonth.tsx`:

1. Add imports: `import Link from 'next/link'` (if absent) and `import { layOutWeek, type ShowRun } from '@/lib/showRuns'`.
2. Add the prop `runs: ShowRun[]` to the component's signature and its props type.
3. Add the layout constants above the component:

```ts
// The date number's own line, and one bar lane, in px. The bar overlay is
// positioned against these rather than guessed, so a bar can never sit on
// top of the date or the flight chips below it.
const DATE_ROW_H = 18
const LANE_GAP = 4
const LANE_H = 20
```

The overlay's own `top` is those two constants PLUS the cell's padding,
which is responsive (`p-1.5` = 6px on phone, `p-2` = 8px from sm+) — hence
`top-[28px] sm:top-[30px]` below, not a single computed value. Get this
wrong and every bar sits two pixels off its lane at one breakpoint.

4. Replace the single flat `grid grid-cols-7` (the weekday header plus `grid.flat().map(...)`) with a weekday header row followed by one container per week:

```tsx
      <div className="border-t border-l border-line">
        <div className="grid grid-cols-7">
          {WEEKDAYS.map((w) => (
            <div key={w} className="border-b border-r border-line px-1 py-1.5 text-center">
              <span className="eyebrow">{w}</span>
            </div>
          ))}
        </div>

        {grid.map((week, wi) => {
          const { bars, overflowByCol } = layOutWeek(runs, week)
          const laneCount = bars.length === 0 ? 0 : Math.max(...bars.map((b) => b.lane)) + 1
          const laneBlock = laneCount * LANE_H

          return (
            <div key={week[0]} className="relative">
              <div className="grid grid-cols-7">
                {week.map((date, di) => {
                  const flights = flightsByDate[date] ?? []
                  const visible = flights.slice(0, MAX_VISIBLE)
                  const overflow = flights.length - visible.length
                  const isCurrentMonth = date.slice(0, 7) === month
                  const isToday = date === today
                  const dayNum = Number(date.slice(8, 10))

                  return (
                    <button
                      key={date}
                      type="button"
                      onClick={() => setSelectedDate(date)}
                      className={`min-h-[5.5rem] sm:min-h-[7rem] flex flex-col items-stretch
                                  border-b border-r border-line p-1.5 sm:p-2 text-left
                                  ${isCurrentMonth ? 'text-ink' : 'text-muted opacity-60'}
                                  ${isToday ? 'bg-accent-wash border-l-2 border-l-accent' : ''}`}
                    >
                      <span
                        className="self-end tabular text-[11px] sm:text-xs"
                        style={{ height: DATE_ROW_H, lineHeight: `${DATE_ROW_H}px` }}
                      >
                        {dayNum}
                      </span>

                      {/* Reserves exactly the space the bar overlay occupies
                          in THIS week, so flights never render underneath a
                          bar and a bar-free week keeps its old height. */}
                      <div aria-hidden style={{ height: laneBlock + LANE_GAP }} />

                      {overflowByCol[di] > 0 && (
                        <div className="text-[10px] text-muted">+{overflowByCol[di]} more</div>
                      )}

                      {/* Tablet/desktop: readable flight chips. Shows have
                          left the cell entirely — they are bars now. */}
                      <div className="hidden sm:flex flex-col gap-0.5 mt-1 min-w-0">
                        {visible.map((f) => (
                          <div key={f.id} className="truncate text-[11px] text-ink">✈ {f.flightNo}</div>
                        ))}
                        {overflow > 0 && <div className="text-[10px] text-muted">+{overflow} more</div>}
                      </div>

                      {/* Phone: flights stay dots (bars carry the shows). */}
                      {flights.length > 0 && (
                        <div className="sm:hidden flex flex-wrap gap-0.5 mt-1">
                          {flights.slice(0, 4).map((f) => (
                            <span key={f.id} className="h-1.5 w-1.5 rounded-full bg-accent-surface" />
                          ))}
                        </div>
                      )}
                    </button>
                  )
                })}
              </div>

              {/* The bar layer. It floats ABOVE the day buttons rather than
                  living inside them, which is what lets a bar be a <Link>
                  without nesting an interactive element inside a <button>
                  (invalid HTML, and a real click-target conflict). The layer
                  itself is click-through; only the bars take pointer events. */}
              {bars.length > 0 && (
                <div
                  className="pointer-events-none absolute inset-x-0 grid grid-cols-7
                             top-[28px] sm:top-[30px]"
                  style={{ rowGap: LANE_H - 17 }}
                >
                  {bars.map((b) => (
                    <Link
                      key={`${b.showId}-${b.startCol}-${wi}`}
                      href={`/shows/${b.showId}`}
                      title={b.showName}
                      className={`pointer-events-auto truncate h-[17px] leading-[17px] mx-px px-1.5
                                  bg-accent-surface text-accent-ink text-[11px] font-semibold
                                  hover:opacity-80 transition-opacity
                                  ${b.continuesLeft ? 'rounded-l-none' : 'rounded-l-field'}
                                  ${b.continuesRight ? 'rounded-r-none' : 'rounded-r-field'}`}
                      style={{ gridColumn: `${b.startCol + 1} / span ${b.span}`, gridRow: b.lane + 1 }}
                    >
                      {b.showName}
                    </Link>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
```

Note the corner classes read straight off `continuesLeft`/`continuesRight` — that is Dan's rule and the only place it is expressed.

- [ ] **Step 3: Gates**

`npm test`, cold tsc, `npm run build` — all clean. (`MAX_VISIBLE` now governs flights only; leave the constant where it is.)

- [ ] **Step 4: Commit**

```bash
git add app/calendar/page.tsx components/CalendarMonth.tsx
git commit -m "feat: one spanning bar per show on the month grid"
```

---

### Task 4: Docs, review, walkthrough, ship

- [ ] **Docs:** in `docs/BACKLOG.md`, convert the "Calendar: one bar per show" section to a SHIPPED entry (date, Dan's four decisions, the corner rule, migration 0047, the feed's one-time UID churn) and note the residual that per-show bar colour was deliberately NOT introduced; in `CLAUDE.md`'s calendar paragraph, add one line — the grid draws one bar per contiguous run via `lib/showRuns.ts`, the feed publishes one VEVENT per run with an EXCLUSIVE DTEND, and both read the same contiguity helper.
- [ ] **Final review** (top model, whole branch, via `scripts/review-package <merge-base> HEAD`): lens = Global Constraints. Especially: DTEND exclusivity; UID stability and the churn being intentional; no money field anywhere near the feed; the corner flags having exactly one home; the widened fetch actually fixing edge runs (and not breaking the dialog, which must still only receive in-window dates); no interactive nesting in the overlay; `MAX_LANES` overflow being counted rather than hidden; migration 0047 preserving 0033's grants.
- [ ] **Walkthrough** (preview tool, dev sandbox): open `/calendar?m=2026-09`; confirm a multi-day show is ONE bar; confirm a week-crossing run is square at the crossing and rounded at its true ends; confirm two overlapping shows stack; click a bar → lands on the show page; click empty cell space → day dialog still opens with flights; resize to mobile (375px) and confirm bars render there; screenshot for Dan. Then `curl` the dev feed URL and eyeball one VEVENT for DTSTART/DTEND.
- [ ] **Ship (Dan's gate):** `npm run db:migrate -- --prod` (0047) FIRST → merge → push → prod smoke (`/calendar` 307) → confirm the live feed returns a run-shaped VEVENT.

## Verification

Task 4's walkthrough plus the automated gates at every commit: the new `showRuns` tests, the new ics tests, full `npm test`, cold `npx tsc --noEmit`, `npm run build`.
