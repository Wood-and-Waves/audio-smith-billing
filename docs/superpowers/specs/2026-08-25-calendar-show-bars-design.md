# Calendar: one spanning bar per show — design

Dan's original ask (2026-08-22, BACKLOG): *"I would like the calendar to show
one big bar for each show instead of a breakdown per day."* Approved
2026-08-25 after a mockup review, with four decisions made by him directly:

1. **One uniform bar.** No travel-day shading inside the bar; travel detail
   stays in the day dialog. (The deferred "travel days render differently"
   backlog item stays deferred.)
2. **Bar click → the show page; anywhere else in a cell → the day dialog.**
3. **Bars on phone too**, replacing the show dots. Flights keep their dots.
4. **The ICS feed follows**: one event per show run instead of one per day.
   He accepted the stated cost — every existing event's UID changes, so
   subscribers (his wife) see a one-time churn on next refresh.

Plus one correction he made to the mockup, now the rule: **a bar's true start
and true finish are rounded; an edge where the run continues into another
week is square.**

## What he sees

A 9-day run is one bar, not nine chips. A run crossing a week boundary is one
bar per week row, square where it crosses, so it reads as a single booking
flowing across the break. Concurrent shows (his 9/17 BMS + Children's Health
overlap) stack in lanes; each week reserves exactly the height its own lanes
need. Every bar carries the show name, repeated per week segment so it is
readable in any row.

## Architecture

### `lib/showRuns.ts` (new, pure)

The whole decision layer, no I/O, testable in isolation:

- `contiguousRuns(days: RunDay[]): ShowRun[]` — group days by `showId`, sort
  by date, split into runs wherever there is a calendar gap. A show whose
  days are not contiguous therefore yields SEVERAL runs, and renders as
  several bars — the honest reading, since a papered-over bar would claim a
  day he is not working. Every show on the books today is unbroken.
- `segmentForWeek(run: ShowRun, week: string[]): BarSegment | null` — the
  intersection of one run with one week: `{ startCol, span, continuesLeft,
  continuesRight }`. `continuesLeft` is true when the run starts strictly
  before `week[0]`; `continuesRight` when it ends strictly after `week[6]`.
  Those two flags are the ONLY input to the corner rule (square when
  continuing, rounded otherwise) — the component never re-derives them.
- `layOutWeek(runs, week, maxLanes): { bars: PlacedBar[]; overflowByCol:
  number[] }` — greedy lane assignment: segments sorted by run start date,
  then show name, then showId (a total order, so the layout is stable across
  renders); each takes the lowest lane free across its whole span. Segments
  that would land beyond `maxLanes` are not drawn and instead increment
  `overflowByCol` for each column they cover, which the cell renders as
  "+N". `MAX_LANES = 3`; his real maximum is 2, so this is defensive, and it
  degrades by telling the truth rather than silently hiding a booking.

### `app/calendar/page.tsx`

The current query fetches `show_days` between the grid's first and last cell.
That is not enough any more: a run extending past the grid edge would look
like it FINISHES there, drawing a rounded corner that lies. Replaced with a
two-step, owner-scoped fetch — the show ids that have any day inside the
window, then every day belonging to those shows — so run boundaries are true
even when a run reaches outside the visible grid. Cheap: his longest run is
9 days.

`showsByDate` (the per-date grouping) stays, because the day dialog still
reads it. `runs` is a new prop alongside it.

### `components/CalendarMonth.tsx`

Each week becomes its own `relative` row containing two layers:

- **Cells** — a 7-column grid of `<button>`s, exactly today's behavior: date
  number, today highlight, previous/next-month dimming, flight chips (sm+)
  or flight dots (phone), click opens the day dialog. Cell content is pushed
  down by the week's own lane block so flights never sit under a bar.
- **Bar layer** — an absolutely positioned 7-column grid above the cells,
  `pointer-events: none`, with each bar an `<a href="/shows/{id}">` carrying
  `pointer-events: auto`. Placement is `grid-column: {startCol+1} / span
  {span}`, `grid-row: {lane+1}` — CSS grid does the arithmetic, no pixel
  math. The overlay is why a link can sit above a button without nesting an
  interactive element inside another, which would be invalid HTML.

Bars render at every breakpoint. Show dots on phone are removed (bars replace
them); flight dots stay.

### `lib/ics.ts` + migration 0047

`showDayEvent` becomes `showRunEvent`, one VEVENT per contiguous run:

- `UID:showrun-{showId}-{runStart}@theaudiosmith.com` — stable across
  refreshes for an unchanged run, and run-scoped so a show with a gap emits
  one event per run, matching the grid.
- `DTSTART;VALUE=DATE:{runStart}` and `DTEND;VALUE=DATE:{dayAfterRunEnd}`.
  **DTEND is exclusive in RFC 5545**: a run ending 9/3 carries DTEND 9/4, or
  every subscriber sees the show one day short. This is the single most
  likely bug in the wave and gets its own test.
- SUMMARY / LOCATION / DESCRIPTION unchanged. Flights untouched.

The feed RPC (`public_calendar_feed`, migration 0033) returns day objects
WITHOUT `show_id`, so runs cannot be grouped from it today. Migration 0047 is
a `create or replace` of that function adding `'show_id', d.show_id` to each
day object — same signature, so its grants and the security-definer/pinned
search_path posture carry over untouched. It returns every day the owner has
(no date window), so run boundaries in the feed are complete by construction.
Exposing a show uuid in a UID is the same class of exposure as today's
show-day uuid; no money or rate field goes near this path, per the feed's
schedule-facts-only rule.

## Testing

Pure-lib tests (`node --test`) are where the logic is proven:

- contiguity: a 9-day run is one run; a gap splits it into two; a single day
  is a run of one
- week segmentation: a run inside one week; a run crossing a week boundary
  (his PwC 8/28–9/3) yielding two segments with the correct continue flags;
  a run crossing a MONTH boundary inside the padded grid; a run extending
  past both grid edges (continues on both sides)
- corner flags are the only signal: assert `continuesLeft/Right` explicitly
- lanes: two overlapping runs take lanes 0 and 1; a run that ends before
  another begins REUSES lane 0; ordering is stable; beyond `MAX_LANES` the
  segment is dropped and `overflowByCol` counts it on every covered column
- ICS: DTEND is the day after the run's last day; a single-day run spans
  exactly one day; a gapped show emits two VEVENTs with distinct UIDs; UID
  is stable for an unchanged run

Plus the usual gates (`npm test`, cold `tsc --noEmit`, `npm run build`) and a
browser walkthrough on the dev sandbox against September 2026, whose real
data already contains a week-crossing run, a month-crossing run, and two
overlaps.

## Out of scope (deliberate)

- Travel-day rendering inside the bar (decision 1; stays in BACKLOG).
- Flights as anything other than per-day marks.
- Punch times in the feed; show↔flight linkage; per-day travel flags in the
  feed — all separately deferred already.
- Any change to the day dialog, the feed token, Settings, or month navigation.
