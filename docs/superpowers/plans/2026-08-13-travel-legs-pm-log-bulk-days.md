# Travel Legs, PM Log, Bulk Days and Show Deletion — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Travel becomes a flag rather than a day type, PM work becomes a duration log rather than punched days, days are added by range, and a show can be deleted.

**Architecture:** `show_days.day_type` is dropped entirely — travel moves to two booleans on the day, PM moves to a new `pm_entries` table. That leaves one row per date, which removes a whole class of ambiguity. `computeShowLines` loses its travel and PM branches and gains a leg count and a ceiling-rounded PM total.

**Tech Stack:** Next.js 16 App Router, React 19, Supabase, Tailwind v4, `node --test`.

## Global Constraints

- Money is integer cents held as a JS `number`; Postgres columns are `bigint`. Quantities are
  integer hundredths (2.25 hours → 225). Never a fractional cent.
- Dates format only through `lib/dates.ts`, which pins `timeZone: 'UTC'`. Never `new Date()` to
  derive or render a calendar date.
- Server actions: `'use server'`, `getUser()` guard, `{ error: string }` returns rather than thrown
  exceptions, `revalidatePath` after writes. Read `app/shows/actions.ts` for the shape.
- **The billed-show lock.** Every write path must refuse when `shows.status = 'billed'`, deriving
  status from the row being changed and never from a caller-supplied id. `deletePunch` shows the
  pattern. This has been broken twice in review; do not make it three.
- `lib/` modules import each other RELATIVELY with a `.ts` extension (`./payroll.ts`), never `@/`.
  Files under `app/` and `components/` use `@/`.
- Tests run under `TZ=America/Chicago` via `npm test`. 41 pass today.
- Dark theme with a light counterpart driven by `prefers-color-scheme`; use existing token classes
  only, no new colour values, every screen works at 375px.
- **This runs against a live database holding 105 real invoices, 19 clients and one real show.**
  Migrations must preserve that show's data. Never run destructive SQL beyond what a migration
  explicitly requires.
- Commit after every task.

## The live data this must not break

Checked immediately before implementation, 2026-08-13:

| table | rows |
|---|---|
| `shows` | 1 — *PwC Tax Start Sept - Orlando, FL* (Streamline, $780/day, OT after 11h, `open`) |
| `show_days` | **0** |
| `punches` | **0** |
| `invoices` / `clients` | 105 / 19 — must be untouched |

The show's two days were deleted by the owner before this ran, so **the conversion branches in the
migration will match nothing**. Do not treat that as a failure, and do not "fix" the migration
because its `update` and `insert` report zero rows.

Those branches still have to be written and still have to be correct: this migration will run again
on any future rebuild of the database from `scripts/sql/migrations/`, when rows may well exist. A
migration that is only correct against today's empty tables is a bug waiting for a restore.

Verify against what is actually there: the columns and constraints change shape, and the 105
invoices and 19 clients survive.

---

### Task 1: Schema — travel flags, PM log, drop day_type

**Files:**
- Create: `scripts/sql/migrations/0005_travel_legs_and_pm_log.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 0005 — travel becomes a flag, PM becomes a log, day_type disappears
--
-- Travel was a day type, which could not express flying in and working the same
-- day. The invoice history is unambiguous: travel bills as exactly two legs on
-- every trip while day rates range 1 to 6. It is a leg, not a day.
--
-- PM work was punched days. Real use showed prep happens in sporadic 30- and
-- 60-minute pieces; clocking in for half an hour of email is friction nobody
-- sustains. It becomes a logged duration.
--
-- With both gone, every show_days row is a work day and day_type has one
-- possible value, so it is dropped. That makes the unique constraint
-- (show_id, date) — one row per date — which removes the possibility of two
-- rows on one date each claiming the same travel leg.

alter table show_days
  add column travel_in  boolean not null default false,
  add column travel_out boolean not null default false;

-- Prep work, logged rather than punched. Minutes, because that is what gets
-- entered; hours are derived. Fifteen-minute increments are enforced in the
-- application, not here, so a correction typed directly into SQL is possible.
create table pm_entries (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references auth.users(id) on delete cascade,
  show_id    uuid not null references shows(id) on delete cascade,

  worked_on  date not null,
  minutes    int  not null,
  note       text,
  created_at timestamptz not null default now(),

  constraint pm_entries_minutes_positive check (minutes > 0)
);

create index pm_entries_show_idx on pm_entries (show_id, worked_on);

alter table pm_entries enable row level security;

create policy pm_entries_owner_all on public.pm_entries
  for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

revoke all on public.pm_entries from anon;
grant select, insert, update, delete on public.pm_entries to authenticated;
grant all on public.pm_entries to service_role;

-- --- Convert existing rows before the column can go -----------------------

-- A travel day becomes an ordinary day carrying the inbound leg. Which leg it
-- was is unknowable from the old model; inbound is the safer guess because a
-- trip's first travel day is its arrival, and it is one checkbox to correct.
update show_days set travel_in = true where day_type = 'travel';

-- A PUNCHED pm day carries real recorded time and must not be lost: convert it
-- to a log entry with its worked minutes. None exist today, but this migration
-- must be correct whenever it runs.
insert into pm_entries (owner_id, show_id, worked_on, minutes, note)
select d.owner_id, d.show_id, d.date,
       greatest(1, round(extract(epoch from (
         max(p.punched_at) filter (where p.punch_type = 'end') -
         min(p.punched_at) filter (where p.punch_type = 'start')
       )) / 60)::int),
       'Converted from a punched PM day'
  from show_days d
  join punches p on p.show_day_id = d.id
 where d.day_type = 'pm'
 group by d.id, d.owner_id, d.show_id, d.date
having max(p.punched_at) filter (where p.punch_type = 'end') is not null
   and min(p.punched_at) filter (where p.punch_type = 'start') is not null;

-- An UNPUNCHED pm day recorded no time at all, so it carries nothing forward.
delete from show_days where day_type = 'pm';

-- --- Drop the column ------------------------------------------------------

alter table show_days drop constraint if exists show_days_type_valid;
alter table show_days drop constraint if exists show_days_show_id_date_day_type_key;
alter table show_days drop column day_type;

-- One row per date. This is what makes a travel leg unambiguous.
alter table show_days add constraint show_days_show_date_uniq unique (show_id, date);
```

`pm_entries` deliberately has no `updated_at` column and therefore no `set_updated_at` trigger —
an entry is a fact about time already worked, so it is added or removed, not revised.

- [ ] **Step 2: Apply and verify**

```bash
npm run db:migrate -- --status   # see it pending
npm run db:migrate
```

Then verify with real query output in your report:
- `show_days` has no `day_type` column and a unique constraint on `(show_id, date)`.
- `show_days` still has 0 rows and the single `shows` row survives untouched — the conversion
  branches match nothing today, which is expected, not a failure.
- `pm_entries` has RLS on, one policy, and zero `anon` privileges.
- 105 invoices and 19 clients are untouched.

- [ ] **Step 3: Commit**

```bash
git add scripts/sql/migrations/0005_travel_legs_and_pm_log.sql
git commit -m "Travel becomes a flag, PM becomes a log, day_type is dropped."
```

---

### Task 2: The calculation

**Files:**
- Modify: `lib/payroll.ts` — `ShowDayLike`, remove `pmHours`
- Modify: `lib/showBuckets.ts` — `computeShowLines`, `rulesetAndRatesFor`
- Test: `scripts/test/showBuckets.test.ts`

**Interfaces:**
- Produces: `computeShowLines(days, pmEntries, rates, rules)` — note the new second argument.

- [ ] **Step 1: Write the failing tests**

Append to `scripts/test/showBuckets.test.ts`. These encode the three rules that matter:

```ts
test('travel legs bill per leg, not per day', () => {
  const legDay = (id: string, date: string, over: Partial<ShowDayLike> = {}): ShowDayLike => ({
    id, date, pay_as_half_day: false, travel_in: false, travel_out: false, punches: [], ...over,
  })
  // A trip: fly in, work two days, fly home. Two legs regardless of day count.
  const days = [
    legDay('a', '2026-07-13', { travel_in: true }),
    legDay('b', '2026-07-14', { punches: [
      { punch_type: 'start', punched_at: '2026-07-14T13:00:00Z' },
      { punch_type: 'end',   punched_at: '2026-07-14T23:00:00Z' }] }),
    legDay('c', '2026-07-15', { punches: [
      { punch_type: 'start', punched_at: '2026-07-15T13:00:00Z' },
      { punch_type: 'end',   punched_at: '2026-07-15T23:00:00Z' }] }),
    legDay('d', '2026-07-16', { travel_out: true }),
  ]
  assert.deepEqual(computeShowLines(days, [], RATES, RULES), [
    { description: 'Day Rate', qty_hundredths: 200, unit_price_cents: 78000 },
    { description: 'Travel Rate', qty_hundredths: 200, unit_price_cents: 39000 },
  ])
})

test('a day flown in AND worked bills the leg and the full day rate', () => {
  // Invoice #384's shape: fly in, work a long day, fly home.
  const day: ShowDayLike = {
    id: 'x', date: '2026-07-14', pay_as_half_day: false,
    travel_in: true, travel_out: true,
    punches: [
      { punch_type: 'start', punched_at: '2026-07-14T13:00:00Z' },
      { punch_type: 'end',   punched_at: '2026-07-15T02:00:00Z' }],  // 13 hours
  }
  assert.deepEqual(computeShowLines([day], [], RATES, RULES), [
    { description: 'Day Rate', qty_hundredths: 100, unit_price_cents: 78000 },
    { description: 'Travel Rate', qty_hundredths: 200, unit_price_cents: 39000 },
    { description: 'Overtime', qty_hundredths: 200, unit_price_cents: 10636 },
  ])
})

test('PM minutes sum then round UP to the next whole hour, once', () => {
  const pm = (minutes: number) => ({ minutes })
  // Four 30-minute sessions are exactly 2 hours and bill 2 — NOT 4, which is
  // what rounding each session separately would produce.
  assert.deepEqual(computeShowLines([], [pm(30), pm(60), pm(30)], RATES, RULES), [
    { description: 'PM Hours', qty_hundredths: 200, unit_price_cents: 7800 },
  ])
  // 2.5 hours bills 3.
  assert.deepEqual(computeShowLines([], [pm(30), pm(60), pm(60)], RATES, RULES), [
    { description: 'PM Hours', qty_hundredths: 300, unit_price_cents: 7800 },
  ])
  // A single 15-minute session still bills a whole hour.
  assert.deepEqual(computeShowLines([], [pm(15)], RATES, RULES), [
    { description: 'PM Hours', qty_hundredths: 100, unit_price_cents: 7800 },
  ])
  assert.deepEqual(computeShowLines([], [], RATES, RULES), [])
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test` — expect failures on the new signature and the missing fields.

- [ ] **Step 3: Update `lib/payroll.ts`**

`ShowDayLike` loses `day_type` and gains the flags:

```ts
export type ShowDayLike = {
  id: string
  date: string
  pay_as_half_day: boolean
  travel_in: boolean
  travel_out: boolean
  punches: PunchRecord[]
}
```

Delete `pmHours` — PM is no longer derived from punches. Replace the `isWorkDay` helper (which
tested `day_type === 'show'`) with the fact that every day is now a work day: the punch checks in
`hasBothEnds` already handle a day with no punches, so the guard simply goes. Verify each function
that called `isWorkDay` still behaves: a travel-only day has no punches, so straight time, overtime
and double time are all zero, which is exactly right.

- [ ] **Step 4: Update `lib/showBuckets.ts`**

```ts
export type PmEntryLike = { minutes: number }

export function computeShowLines(
  days: ShowDayLike[],
  pmEntries: PmEntryLike[],
  rates: ShowRates,
  rules: ShowRuleset,
): BucketLine[] {
```

Inside the day loop, delete the `day_type === 'travel'` and `day_type === 'pm'` branches and count
legs instead:

```ts
    travelLegs += (d.travel_in ? 1 : 0) + (d.travel_out ? 1 : 0)
```

PM comes from its own array, summed in minutes and ceiling-rounded once:

```ts
  // Sessions sum first, THEN round up — once, for the whole show. Rounding each
  // session would bill four half-hours as four hours instead of two.
  const pmMinutes = pmEntries.reduce((t, e) => t + e.minutes, 0)
  const pmHours = pmMinutes > 0 ? Math.ceil(pmMinutes / 60) : 0
```

`rulesetAndRatesFor` is unchanged — it reads show columns that did not move.

- [ ] **Step 5: Run tests**

Run: `npm test` — all must pass, including the pre-existing 41.

- [ ] **Step 6: Commit**

```bash
git add lib/payroll.ts lib/showBuckets.ts scripts/test/showBuckets.test.ts
git commit -m "Count travel legs and ceiling-round PM hours per show."
```

---

### Task 3: Actions

**Files:**
- Modify: `app/shows/actions.ts`

**Interfaces:**
- Produces: `addShowDays(showId, startDate, endDate)`, `setTravelLeg(showDayId, leg, value)`,
  `addPmEntry(showId, workedOn, minutes, note)`, `deletePmEntry(pmEntryId)`, `deleteShow(showId)`.
- Changes: `addShowDay` is replaced by `addShowDays`; every call site must move.
- Removed: nothing else. `billShows` must be updated to load `pm_entries` and pass them to
  `computeShowLines`, and its incomplete-day check must drop its `day_type === 'travel'` skip —
  a day with no punches is simply not incomplete.

- [ ] **Step 1: Write `addShowDays`**

```ts
/**
 * Creates a day per date across a range. Dates that already exist are SKIPPED,
 * not errors: re-running an overlapping range must not fail halfway and leave a
 * partial trip.
 */
export async function addShowDays(
  showId: string, startDate: string, endDate: string,
): Promise<Fail | { ok: true; created: number; skipped: number }> {
```

Rules, each for a stated reason:
- Refuse when the show is billed, deriving status from the show row itself.
- Refuse an end date before the start date.
- Refuse a range over 60 days — a mistyped year would otherwise create thousands of rows.
- Read the existing dates for the show and skip any already present. Report both counts so the UI
  can say "6 added, 2 already there".
- Walk the range with `addDays` from `lib/dates.ts`. Never `new Date()` arithmetic.

- [ ] **Step 2: Write `setTravelLeg` and the PM actions**

`setTravelLeg(showDayId, leg: 'in' | 'out', value: boolean)` — derive the lock by walking
`show_days.show_id -> shows.status`, exactly as `setDayHalfDay` does.

`addPmEntry(showId, workedOn, minutes, note)`:
- Refuse when the show is billed.
- Refuse minutes that are not a positive multiple of 15, naming the rule in the message. The UI
  offers preset increments, but the action is the boundary that must hold.
- Refuse a single entry over 24 hours (1440 minutes) as a fat-finger guard.

`deletePmEntry(pmEntryId)` — derive the lock from the entry's own `show_id`.

- [ ] **Step 3: Write `deleteShow`**

```ts
/**
 * Deletes a show and, by cascade, its days, punches and PM log. This destroys
 * recorded work, so it is refused while the show is billed — unlink it first,
 * which is a deliberate second step rather than a confirmation dialog.
 */
export async function deleteShow(showId: string): Promise<Fail | { ok: true }> {
```

Refuse when billed. Verify the cascade is real before relying on it: `show_days.show_id`,
`punches.show_day_id` and `pm_entries.show_id` are all `on delete cascade`, so deleting the show
row is sufficient. Say so in a comment.

- [ ] **Step 4: Update `billShows` and the previews**

`billShows` and `app/shows/[id]/page.tsx` and `app/shows/page.tsx` all call `computeShowLines`.
Each must now also load `pm_entries` for the show and pass them. Miss one and the preview will
disagree with the invoice — the exact bug found and fixed in the last round.

- [ ] **Step 5: Verify and commit**

`npm run build` clean, `npm test` unchanged.

```bash
git add app/shows/actions.ts app/shows/page.tsx "app/shows/[id]/page.tsx"
git commit -m "Add bulk day creation, travel-leg toggles, the PM log and show deletion."
```

---

### Task 4: Screens

**Files:**
- Modify: `components/ShowDayControls.tsx` — the add-day control becomes a range
- Modify: `app/shows/[id]/page.tsx` — travel checkboxes per day, PM log section, delete
- Create: `components/TravelLegToggle.tsx`
- Create: `components/PmLog.tsx`
- Create: `components/DeleteShowButton.tsx`

- [ ] **Step 1: The range picker**

Replace the single date and type control with **From** and **To** date inputs and one Add button. The
type dropdown goes — there are no day types any more.

Defaults: **From** is the day after the show's last existing day, or today if the show is empty.
**To** defaults to match **From**, so adding a single day is still one click. Today the control
defaults to today regardless, which means every add on an existing show starts by correcting the
date — fix that.

On success report what happened: "6 days added, 2 were already there."

- [ ] **Step 2: Travel checkboxes per day**

Two checkboxes on each day row — "Travelled in" and "Travelled out" — calling `setTravelLeg`.
Follow `components/HalfDayToggle.tsx` exactly: same props shape, `useTransition`, `{error}`
handling, `router.refresh()`, and `disabled` when the show is locked.

A day carrying a leg but no punches should read as intentional rather than unfinished — label it
"Travel only" rather than leaving it looking like a day someone forgot to punch.

- [ ] **Step 3: The PM log**

A section on the show page listing entries — date, duration, note, and a remove control — with a
running total that shows both the raw sum and what will bill:

```
2.25 hours logged  ·  bills 3
```

The add control takes a date (defaulting to today), a duration, and an optional note. Offer the
duration as preset buttons — **15m, 30m, 45m, 1h, 1h30, 2h** — plus a free field that accepts any
15-minute multiple. Presets are the point: the whole feature exists because logging half an hour
should take one tap.

- [ ] **Step 4: Delete show**

A quiet control at the bottom of the show page. Two-step confirm, like
`components/RemoveDayButton.tsx` — read it and follow its shape, including the auto-disarm. The
confirmation must name what is destroyed: the day count, the punch count and the PM entry count,
so a mis-click on a real trip is recoverable by reading before confirming.

Hidden entirely when the show is billed, with a line saying it must be unlinked from its invoice
first.

- [ ] **Step 5: Verify in a browser**

`npm run dev -- --port 3100`. Authenticating needs the dev-login secret in a URL, which a security
classifier blocks — do NOT work around it; report it and fall back to build plus inspection.

- [ ] **Step 6: Commit**

```bash
git add app/shows components/TravelLegToggle.tsx components/PmLog.tsx components/DeleteShowButton.tsx components/ShowDayControls.tsx
git commit -m "Range day picker, travel-leg toggles, PM log and show deletion."
```

---

## Self-review notes

| Requirement | Task |
|---|---|
| Travel is a flag, not a day type | 1, 2, 4 |
| A hybrid day bills leg + full day rate | 2 (test), 4 |
| Travel bills exactly 2 legs per trip | 2 (test) |
| Days added by range, existing skipped | 3, 4 |
| PM is a logged duration, not punched | 1, 3, 4 |
| PM sums then rounds up once per show | 2 (test) |
| 15-minute increments enforced | 3 (action), 4 (presets) |
| `day_type` dropped, one row per date | 1 |
| Delete a show | 3, 4 |
| Billed shows stay locked | every action in 3 |
| Live PwC show survives the migration | 1, Step 2 |

**Deliberately out of scope:** cross-show short-turnaround; a database-level lock on billed shows;
`roundingMinutes`, still threaded through `lib/payroll.ts` and passed by nobody.
