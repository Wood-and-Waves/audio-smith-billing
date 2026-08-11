# Show Time Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track punch in / punch out per show day, apply CrewTracker's seven payroll rules, and turn the result into draft invoice lines.

**Architecture:** CrewTracker's `lib/payroll.ts` is ported for its *hours* logic only — `calculateNetHours`, `paidOvertimeHours`, `mealPenaltyCount` and friends already return hours and counts, never money. Its three money functions (`totalPay`, `mealPenaltyTotal`, `travelLegPay`) are **not** ported; a new `lib/showBuckets.ts` turns hours into buckets and hands them to `lib/money.ts` for integer-cent arithmetic. Data lives in `shows` → `show_days` → `punches`, with the client's rate card frozen onto the show at creation.

**Tech Stack:** Next.js 16 App Router, React 19, Supabase (Postgres + RLS), Tailwind v4, `node --test` with `--experimental-strip-types`.

## Global Constraints

- Money is **always** `bigint` cents. Hours may be floats; the moment hours become money they pass through `lib/money.ts`.
- Quantities are integer hundredths (`4.5` → `450`), per `lib/money.ts:parseQty`.
- Plain dates (`YYYY-MM-DD`) format only through `lib/dates.ts`, which pins `timeZone: 'UTC'`. Never `new Date()` for "what day is it".
- Tests run under `TZ=America/Chicago` via `npm test`.
- Every new table: RLS enabled, one `owner_id = auth.uid()` policy, `revoke all from anon`, explicit grant to `authenticated`. Follow `scripts/sql/migrations/0001_initial_schema.sql`.
- No `'use client'` in `lib/`. Those modules must run in server trees, client trees and plain `node --test`.
- Commit after every task.

---

### Task 1: Port the hours calculator

**Files:**
- Create: `lib/punchTypes.ts`
- Create: `lib/payroll.ts`
- Test: `scripts/test/payroll.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `PUNCH_ORDER`, `MEAL_PAIRS`, `type PunchType`, `type PunchRecord`, `type ShowRuleset`, `type ShowDayLike`, and the functions `calculateNetHours`, `isShortTurnaround`, `paidNetHours`, `paidStraightTimeHours`, `paidOvertimeHours`, `paidDoubleTimeHours`, `mealPenaltyCount`. All hour-returning functions return `number` (hours, possibly fractional).

- [ ] **Step 1: Write `lib/punchTypes.ts`**

```ts
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

export type DayType = 'show' | 'travel' | 'pm'
```

- [ ] **Step 2: Write the failing test**

Create `scripts/test/payroll.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { calculateNetHours, paidOvertimeHours, type ShowRuleset, type ShowDayLike }
  from '../../lib/payroll.ts'

const RULES: ShowRuleset = {
  overtime_after_hours: 10,
  double_time_enabled: false,
  double_time_after_hours: 12,
  meal_penalty_enabled: false,
  meal_penalty_grace_hours: 6,
  minimum_meal_break_enabled: true,
  minimum_meal_break_minutes: 60,
  meal_break_deduction_cap: 60,
  short_turn_penalty_enabled: false,
  short_turn_rest_hours: 10,
  continuous_time_enabled: false,
}

const day = (punches: Record<string, string>, over: Partial<ShowDayLike> = {}): ShowDayLike => ({
  id: 'd1',
  date: '2026-08-10',
  day_type: 'show',
  pay_as_half_day: false,
  punches: Object.entries(punches).map(([punch_type, punched_at]) => ({ punch_type, punched_at })),
  ...over,
})

test('net hours deducts a qualifying meal break', () => {
  const d = day({
    start: '2026-08-10T13:00:00Z',      // 8am Chicago
    meal_out: '2026-08-10T18:00:00Z',
    meal_in: '2026-08-10T19:00:00Z',    // 60 minute break
    end: '2026-08-11T00:00:00Z',        // 7pm Chicago
  })
  assert.equal(calculateNetHours(d, RULES), 10)  // 11 gross - 1 meal
})

test('a break under the minimum is not deducted', () => {
  const d = day({
    start: '2026-08-10T13:00:00Z',
    meal_out: '2026-08-10T18:00:00Z',
    meal_in: '2026-08-10T18:30:00Z',    // 30 minutes, under the 60 minimum
    end: '2026-08-11T00:00:00Z',
  })
  assert.equal(calculateNetHours(d, RULES), 11)
})

test('overtime is hours past the threshold', () => {
  const d = day({ start: '2026-08-10T13:00:00Z', end: '2026-08-11T01:00:00Z' })  // 12h
  assert.equal(paidOvertimeHours(d, [], RULES), 2)
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../../lib/payroll.ts'`

- [ ] **Step 4: Write `lib/payroll.ts`**

Port from `crewtracker/lib/payroll.ts`. Changes from the original, all deliberate:
`TimecardLike` → `ShowDayLike` (a day, not a person's card); `is_travel_day` → `day_type !== 'show'`;
`crew_member_id` filtering drops out of `isShortTurnaround` because there is only one person;
`day_rate` leaves the type entirely, since nothing here returns money.

```ts
// Port of CrewTracker's lib/payroll.ts — HOURS ONLY.
//
// CrewTracker's totalPay/mealPenaltyTotal/travelLegPay are deliberately NOT
// ported. They compute money in floats, which is fine for a payroll estimate
// and not for a document a client pays against. lib/showBuckets.ts turns these
// hours into invoice lines through lib/money.ts, in integer cents.
//
// No 'use client'. Keep it that way.

import { MEAL_PAIRS, type DayType } from '@/lib/punchTypes'

export type PunchRecord = { punch_type: string; punched_at: string }

export type ShowRuleset = {
  overtime_after_hours: number
  double_time_enabled: boolean
  double_time_after_hours: number
  meal_penalty_enabled: boolean
  meal_penalty_grace_hours: number
  minimum_meal_break_enabled: boolean
  minimum_meal_break_minutes: number
  meal_break_deduction_cap: number
  short_turn_penalty_enabled: boolean
  short_turn_rest_hours: number
  continuous_time_enabled: boolean
}

export type ShowDayLike = {
  id: string
  date: string
  day_type: DayType
  pay_as_half_day: boolean
  punches: PunchRecord[]
}

const DISTANT_PAST = new Date(-8640000000000000)

function punchTime(punches: PunchRecord[], type: string): Date | null {
  const p = punches.find((x) => x.punch_type === type)
  return p ? new Date(p.punched_at) : null
}

function mealBreakPairs(d: ShowDayLike): [Date, Date][] {
  const pairs: [Date, Date][] = []
  for (const [outType, inType] of MEAL_PAIRS) {
    const out = punchTime(d.punches, outType)
    const back = punchTime(d.punches, inType)
    if (out && back) pairs.push([out, back])
  }
  return pairs
}

const isWorkDay = (d: ShowDayLike) => d.day_type === 'show'
const hasBothEnds = (d: ShowDayLike) =>
  !!punchTime(d.punches, 'start') && !!punchTime(d.punches, 'end')

export function calculateNetHours(d: ShowDayLike, rules: ShowRuleset, roundingMinutes = 1): number {
  const start = punchTime(d.punches, 'start')
  const end = punchTime(d.punches, 'end')
  if (!start || !end) return 0

  const grossSeconds = (end.getTime() - start.getTime()) / 1000

  let netSeconds: number
  if (rules.continuous_time_enabled) {
    netSeconds = Math.max(0, grossSeconds)
  } else {
    const minBreak = rules.minimum_meal_break_enabled ? rules.minimum_meal_break_minutes * 60 : 0
    const cap = rules.meal_break_deduction_cap * 60
    let deduction = 0
    for (const [out, back] of mealBreakPairs(d)) {
      const duration = (back.getTime() - out.getTime()) / 1000
      if (duration >= minBreak) deduction += Math.min(duration, cap)
    }
    netSeconds = Math.max(0, grossSeconds - deduction)
  }

  const netMinutes = Math.round(netSeconds / 60)
  const interval = roundingMinutes > 0 ? roundingMinutes : 1
  if (interval === 1) return netMinutes / 60
  const remainder = netMinutes % interval
  return (remainder > 0 ? netMinutes - remainder + interval : netMinutes) / 60
}

/**
 * Short turnaround looks only within one show, per the spec. A Streamline run
 * ending at 11pm followed by a Journey Church visit at 8am is two shows and
 * won't trigger this.
 */
export function isShortTurnaround(d: ShowDayLike, allDays: ShowDayLike[], rules: ShowRuleset): boolean {
  if (!rules.short_turn_penalty_enabled) return false
  const start = punchTime(d.punches, 'start')
  if (!start) return false

  const previous = allDays.filter((o) => {
    if (o.id === d.id) return false
    const end = punchTime(o.punches, 'end') ?? DISTANT_PAST
    return end < start
  })
  if (previous.length === 0) return false

  const last = previous.reduce((a, b) => {
    const aEnd = punchTime(a.punches, 'end') ?? DISTANT_PAST
    const bEnd = punchTime(b.punches, 'end') ?? DISTANT_PAST
    return aEnd < bEnd ? b : a
  })
  const lastEnd = punchTime(last.punches, 'end')
  if (!lastEnd) return false

  return (start.getTime() - lastEnd.getTime()) / 1000 < rules.short_turn_rest_hours * 3600
}

/** Ceiling-rounded per day before summing — Dan validated this against a real client spreadsheet. */
export function paidNetHours(d: ShowDayLike, rules: ShowRuleset, roundingMinutes = 1): number {
  if (!isWorkDay(d) || !hasBothEnds(d)) return 0
  return Math.ceil(calculateNetHours(d, rules, roundingMinutes))
}

export function paidStraightTimeHours(d: ShowDayLike, allDays: ShowDayLike[], rules: ShowRuleset, roundingMinutes = 1): number {
  if (!isWorkDay(d) || !hasBothEnds(d)) return 0
  if (isShortTurnaround(d, allDays, rules)) return 0
  return Math.min(paidNetHours(d, rules, roundingMinutes), rules.overtime_after_hours)
}

export function paidOvertimeHours(d: ShowDayLike, allDays: ShowDayLike[], rules: ShowRuleset, roundingMinutes = 1): number {
  if (!isWorkDay(d) || !hasBothEnds(d)) return 0
  if (isShortTurnaround(d, allDays, rules)) return 0
  const ot = paidNetHours(d, rules, roundingMinutes) - rules.overtime_after_hours
  if (ot <= 0) return 0
  if (rules.double_time_enabled) {
    return Math.min(ot, rules.double_time_after_hours - rules.overtime_after_hours)
  }
  return ot
}

export function paidDoubleTimeHours(d: ShowDayLike, allDays: ShowDayLike[], rules: ShowRuleset, roundingMinutes = 1): number {
  if (!isWorkDay(d) || !hasBothEnds(d)) return 0
  const paidNet = paidNetHours(d, rules, roundingMinutes)
  if (isShortTurnaround(d, allDays, rules)) return paidNet
  if (!rules.double_time_enabled) return 0
  return Math.max(0, paidNet - rules.double_time_after_hours)
}

/** One penalty per stretch longer than the grace period without a break. */
export function mealPenaltyCount(d: ShowDayLike, rules: ShowRuleset): number {
  if (!isWorkDay(d) || !rules.meal_penalty_enabled) return 0
  const start = punchTime(d.punches, 'start')
  if (!start) return 0

  const graceSeconds = rules.meal_penalty_grace_hours * 3600
  const end = punchTime(d.punches, 'end')
  let penalties = 0
  let segmentStart: Date | null = start

  for (const [outType, inType] of MEAL_PAIRS) {
    if (!segmentStart) break
    const out = punchTime(d.punches, outType)
    const segmentEnd = out ?? end
    if (!segmentEnd) return penalties
    if ((segmentEnd.getTime() - segmentStart.getTime()) / 1000 > graceSeconds) penalties += 1
    if (!out) return penalties
    segmentStart = punchTime(d.punches, inType)
  }
  return penalties
}

/** Actual hours for a PM day. No day-rate minimum: an hour of email bills as an hour. */
export function pmHours(d: ShowDayLike, rules: ShowRuleset, roundingMinutes = 1): number {
  if (d.day_type !== 'pm' || !hasBothEnds(d)) return 0
  return calculateNetHours(d, rules, roundingMinutes)
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test`
Expected: PASS — 3 payroll tests plus the existing 19.

- [ ] **Step 6: Commit**

```bash
git add lib/punchTypes.ts lib/payroll.ts scripts/test/payroll.test.ts
git commit -m "Port CrewTracker's payroll rules, hours only.

The money functions are deliberately left behind: they compute in floats,
which is fine for a payroll estimate and not for an invoice."
```

---

### Task 2: Turn hours into invoice lines

**Files:**
- Create: `lib/showBuckets.ts`
- Test: `scripts/test/showBuckets.test.ts`

**Interfaces:**
- Consumes: everything Task 1 produces, plus `lineTotal`, `travelRateFrom`, `overtimeRateFrom`, `doubleTimeRateFrom` from `lib/money.ts`.
- Produces: `type ShowRates`, `type BucketLine = { description: string; qty_hundredths: number; unit_price_cents: number }`, and `computeShowLines(days, rates, rules): BucketLine[]`.

- [ ] **Step 1: Write the failing test**

Create `scripts/test/showBuckets.test.ts`. The expected output reproduces invoice #385's shape:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeShowLines, type ShowRates } from '../../lib/showBuckets.ts'
import type { ShowRuleset, ShowDayLike } from '../../lib/payroll.ts'

const RATES: ShowRates = {
  day_rate_cents: 78000,        // Streamline
  travel_rate_cents: 39000,
  pm_rate_cents: 7800,
  ot_rate_cents: 10636,         // 780 / 11 * 1.5
  dt_rate_cents: 14182,
  meal_penalty_cents: 0,
}

const RULES: ShowRuleset = {
  overtime_after_hours: 11, double_time_enabled: false, double_time_after_hours: 14,
  meal_penalty_enabled: false, meal_penalty_grace_hours: 6,
  minimum_meal_break_enabled: true, minimum_meal_break_minutes: 60,
  meal_break_deduction_cap: 60, short_turn_penalty_enabled: false,
  short_turn_rest_hours: 10, continuous_time_enabled: false,
}

// 13:00Z to 23:00Z is 10 hours — under Streamline's 11-hour threshold, so a
// plain day rate with no overtime.
const showDay = (id: string, date: string): ShowDayLike => ({
  id, date, day_type: 'show', pay_as_half_day: false,
  punches: [
    { punch_type: 'start', punched_at: `${date}T13:00:00Z` },
    { punch_type: 'end', punched_at: `${date}T23:00:00Z` },
  ],
})

const travelDay = (id: string, date: string): ShowDayLike => ({
  id, date, day_type: 'travel', pay_as_half_day: false, punches: [],
})

test('day rates, travel and overtime become invoice lines', () => {
  const days: ShowDayLike[] = [
    travelDay('t1', '2026-07-13'),
    showDay('s1', '2026-07-14'),
    showDay('s2', '2026-07-15'),
    travelDay('t2', '2026-07-16'),
  ]
  const lines = computeShowLines(days, RATES, RULES)

  assert.deepEqual(lines, [
    { description: 'Day Rate', qty_hundredths: 200, unit_price_cents: 78000 },
    { description: 'Travel Rate', qty_hundredths: 200, unit_price_cents: 39000 },
  ])
})

test('a long day produces an overtime line', () => {
  const long: ShowDayLike = {
    id: 'l1', date: '2026-07-14', day_type: 'show', pay_as_half_day: false,
    punches: [
      { punch_type: 'start', punched_at: '2026-07-14T13:00:00Z' },
      { punch_type: 'end', punched_at: '2026-07-15T02:00:00Z' },   // 13 hours
    ],
  }
  const lines = computeShowLines([long], RATES, RULES)
  assert.deepEqual(lines, [
    { description: 'Day Rate', qty_hundredths: 100, unit_price_cents: 78000 },
    { description: 'Overtime', qty_hundredths: 200, unit_price_cents: 10636 },
  ])
})

test('PM hours bill actual time with no day-rate minimum', () => {
  const pm: ShowDayLike = {
    id: 'p1', date: '2026-07-10', day_type: 'pm', pay_as_half_day: false,
    punches: [
      { punch_type: 'start', punched_at: '2026-07-10T14:00:00Z' },
      { punch_type: 'end', punched_at: '2026-07-10T18:00:00Z' },   // 4 hours
    ],
  }
  const lines = computeShowLines([pm], RATES, RULES)
  assert.deepEqual(lines, [
    { description: 'PM Hours', qty_hundredths: 400, unit_price_cents: 7800 },
  ])
})

test('zero buckets produce no lines', () => {
  assert.deepEqual(computeShowLines([], RATES, RULES), [])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../../lib/showBuckets.ts'`

- [ ] **Step 3: Write `lib/showBuckets.ts`**

```ts
// Hours in, invoice lines out. This is the boundary where hours become money:
// everything above is floats, everything below is integer cents.
//
// Lines come out in the order Dan's invoices already use, and a bucket that is
// zero produces no line at all — matching InvoiceDocument's rule that
// zero-value rows are noise.

import {
  paidStraightTimeHours, paidOvertimeHours, paidDoubleTimeHours, mealPenaltyCount, pmHours,
  type ShowDayLike, type ShowRuleset,
} from '@/lib/payroll'

export type ShowRates = {
  day_rate_cents: number
  travel_rate_cents: number
  pm_rate_cents: number
  ot_rate_cents: number
  dt_rate_cents: number
  meal_penalty_cents: number
}

export type BucketLine = {
  description: string
  qty_hundredths: number
  unit_price_cents: number
}

/** Hours (float) to the integer hundredths lib/money.ts expects. */
const toHundredths = (hours: number) => Math.round(hours * 100)

export function computeShowLines(
  days: ShowDayLike[],
  rates: ShowRates,
  rules: ShowRuleset,
): BucketLine[] {
  let dayRateDays = 0
  let halfDays = 0
  let travelDays = 0
  let otHours = 0
  let dtHours = 0
  let pmTotal = 0
  let penalties = 0

  for (const d of days) {
    if (d.day_type === 'travel') { travelDays += 1; continue }
    if (d.day_type === 'pm') { pmTotal += pmHours(d, rules); continue }

    const st = paidStraightTimeHours(d, days, rules)
    const ot = paidOvertimeHours(d, days, rules)
    const dt = paidDoubleTimeHours(d, days, rules)

    // A show day with no punches bills nothing; the day rate is earned by working.
    if (st > 0 || ot > 0 || dt > 0) {
      if (d.pay_as_half_day) halfDays += 1
      else dayRateDays += 1
    }
    otHours += ot
    dtHours += dt
    penalties += mealPenaltyCount(d, rules)
  }

  const lines: BucketLine[] = []
  const push = (description: string, qty: number, unit_price_cents: number) => {
    if (qty > 0 && unit_price_cents >= 0) {
      lines.push({ description, qty_hundredths: toHundredths(qty), unit_price_cents })
    }
  }

  push('Day Rate', dayRateDays, rates.day_rate_cents)
  push('Day Rate (half)', halfDays, Math.round(rates.day_rate_cents / 2))
  push('Travel Rate', travelDays, rates.travel_rate_cents)
  push('Overtime', otHours, rates.ot_rate_cents)
  push('Double Time', dtHours, rates.dt_rate_cents)
  push('PM Hours', pmTotal, rates.pm_rate_cents)
  if (rates.meal_penalty_cents > 0) push('Meal Penalty', penalties, rates.meal_penalty_cents)

  return lines
}

/**
 * Combines lines from several shows onto one invoice. Two Streamline day-rate
 * lines at the same price become one line with double the quantity, which is
 * how Dan's invoices read today. Lines only merge when BOTH the description
 * and the unit price match — a $780 day rate and a $600 day rate stay apart.
 */
export function mergeLines(groups: BucketLine[][]): BucketLine[] {
  const merged: BucketLine[] = []
  for (const line of groups.flat()) {
    const hit = merged.find(
      (x) => x.description === line.description && x.unit_price_cents === line.unit_price_cents)
    if (hit) hit.qty_hundredths += line.qty_hundredths
    else merged.push({ ...line })
  }
  return merged
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS — 4 new tests.

- [ ] **Step 5: Commit**

```bash
git add lib/showBuckets.ts scripts/test/showBuckets.test.ts
git commit -m "Turn tracked hours into invoice lines in integer cents."
```

---

### Task 3: Schema

**Files:**
- Create: `scripts/sql/migrations/0003_show_tracking.sql`

**Interfaces:**
- Produces: tables `shows`, `show_days`, `punches`; column `invoices.show_ids` is NOT added — the link lives on `shows.invoice_id`.

- [ ] **Step 1: Write the migration**

```sql
-- 0003 — show time tracking
--
-- The rate card is COPIED onto the show, not referenced. Raising a client's
-- day rate next year must not retroactively change a show already billed —
-- the same reasoning as invoices.bill_to_snapshot.

create table shows (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users(id) on delete cascade,
  client_id   uuid not null references clients(id) on delete restrict,

  name        text not null,
  venue       text,
  timezone    text not null default 'America/Chicago',

  status      text not null default 'open',      -- open | billed
  invoice_id  uuid references invoices(id) on delete set null,

  -- Frozen rate card. Stored, not computed on read.
  day_rate_cents              bigint not null default 0,
  travel_rate_cents           bigint not null default 0,
  pm_rate_cents               bigint not null default 0,
  ot_after_hours              numeric(4,1) not null default 10,
  dt_after_hours              numeric(4,1),          -- null = no double time
  minimum_meal_break_minutes  int not null default 60,
  meal_break_deduction_cap    int not null default 60,
  meal_penalty_grace_hours    numeric(4,1) not null default 6,
  meal_penalty_cents          bigint not null default 0,
  short_turn_rest_hours       numeric(4,1) not null default 10,
  continuous_time_enabled     boolean not null default false,

  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint shows_status_valid check (status in ('open','billed')),
  constraint shows_name_not_blank check (length(btrim(name)) > 0)
);

create index shows_owner_status_idx on shows (owner_id, status);
create index shows_client_idx on shows (client_id);

create table show_days (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid not null references auth.users(id) on delete cascade,
  show_id         uuid not null references shows(id) on delete cascade,

  date            date not null,
  day_type        text not null default 'show',   -- show | travel | pm
  pay_as_half_day boolean not null default false,
  notes           text,
  created_at      timestamptz not null default now(),

  constraint show_days_type_valid check (day_type in ('show','travel','pm')),
  unique (show_id, date, day_type)
);

create index show_days_show_idx on show_days (show_id, date);

create table punches (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references auth.users(id) on delete cascade,
  show_day_id  uuid not null references show_days(id) on delete cascade,

  punch_type   text not null,
  punched_at   timestamptz not null,
  created_at   timestamptz not null default now(),

  constraint punches_type_valid check (
    punch_type in ('start','meal_out','meal_in','meal2_out','meal2_in','end')),
  unique (show_day_id, punch_type)
);

create index punches_day_idx on punches (show_day_id);

-- RLS, matching 0001.
alter table shows     enable row level security;
alter table show_days enable row level security;
alter table punches   enable row level security;

do $$
declare t text;
begin
  foreach t in array array['shows','show_days','punches'] loop
    execute format(
      'create policy %I_owner_all on public.%I
         for all to authenticated
         using (owner_id = auth.uid())
         with check (owner_id = auth.uid())', t, t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;

create trigger shows_updated_at before update on shows
  for each row execute function set_updated_at();
```

- [ ] **Step 2: Apply and verify**

Run: `npm run db:migrate`
Expected: `0003_show_tracking.sql … ok`

Then verify RLS and grants landed:

```bash
npm run db:sql -- /dev/stdin <<'SQL'
select tablename, rowsecurity from pg_tables t
  join pg_class c on c.relname = t.tablename
 where t.tablename in ('shows','show_days','punches');
select count(*) as anon_grants from information_schema.role_table_grants
 where table_name in ('shows','show_days','punches') and grantee='anon';
SQL
```
Expected: all three `rowsecurity = t`, and `anon_grants = 0`.

- [ ] **Step 3: Commit**

```bash
git add scripts/sql/migrations/0003_show_tracking.sql
git commit -m "Add shows, show_days and punches, with the rate card frozen per show."
```

---

### Task 4: Show actions

**Files:**
- Create: `app/shows/actions.ts`
- Test: `scripts/test/chronology.test.ts`
- Create: `lib/chronology.ts`

**Interfaces:**
- Consumes: `PUNCH_ORDER` from Task 1, `computeShowLines` from Task 2.
- Produces: `chronologyError(type, at, existing): string | null`; server actions `createShow(input)`, `addShowDay(showId, date, dayType)`, `recordPunch(showDayId, type, at)`, `deletePunch(punchId)`, `billShows(showIds): {invoiceId}`.

- [ ] **Step 1: Write the failing chronology test**

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chronologyError } from '../../lib/chronology.ts'

const at = (h: number) => `2026-08-10T${String(h).padStart(2, '0')}:00:00Z`

test('a punch cannot land before the one that precedes it', () => {
  const existing = [{ punch_type: 'start', punched_at: at(13) }]
  assert.match(chronologyError('end', at(12), existing) ?? '', /after/i)
  assert.equal(chronologyError('end', at(23), existing), null)
})

test('a meal cannot end before it began', () => {
  const existing = [
    { punch_type: 'start', punched_at: at(13) },
    { punch_type: 'meal_out', punched_at: at(18) },
  ]
  assert.match(chronologyError('meal_in', at(17), existing) ?? '', /after/i)
  assert.equal(chronologyError('meal_in', at(19), existing), null)
})

test('a duplicate punch type is refused', () => {
  const existing = [{ punch_type: 'start', punched_at: at(13) }]
  assert.match(chronologyError('start', at(14), existing) ?? '', /already/i)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../../lib/chronology.ts'`

- [ ] **Step 3: Write `lib/chronology.ts`**

```ts
// Punch ordering validation, adapted from CrewTracker's lib/punches.ts.
// Rejecting an impossible punch at entry is far cheaper than discovering a
// 33.5-hour day at billing time.

import { PUNCH_ORDER, PUNCH_LABELS, type PunchType } from '@/lib/punchTypes'

type Existing = { punch_type: string; punched_at: string }

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

  for (let i = 0; i < index; i++) {
    const earlier = byType.get(PUNCH_ORDER[i])
    if (earlier !== undefined && when < earlier) {
      return `${PUNCH_LABELS[type]} must be after ${PUNCH_LABELS[PUNCH_ORDER[i]]}.`
    }
  }
  for (let i = index + 1; i < PUNCH_ORDER.length; i++) {
    const later = byType.get(PUNCH_ORDER[i])
    if (later !== undefined && when > later) {
      return `${PUNCH_LABELS[type]} must be before ${PUNCH_LABELS[PUNCH_ORDER[i]]}.`
    }
  }
  return null
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Write `app/shows/actions.ts`**

Mirror the structure of `app/invoices/actions.ts`: `'use server'`, `createClient()`, `getUser()` guard, `{error}` returns, `revalidatePath`.

```ts
'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { chronologyError } from '@/lib/chronology'
import { computeShowLines, mergeLines, type ShowRates, type BucketLine } from '@/lib/showBuckets'
import { travelRateFrom, overtimeRateFrom, doubleTimeRateFrom } from '@/lib/money'
import { addDays, todayInChicago } from '@/lib/dates'
import type { PunchType, DayType } from '@/lib/punchTypes'
import type { ShowDayLike, ShowRuleset } from '@/lib/payroll'

type Fail = { error: string }

/** Copies the client's rate card onto the show. See migration 0003. */
export async function createShow(input: {
  client_id: string; name: string; venue?: string
}): Promise<Fail | { ok: true; id: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }
  if (!input.client_id) return { error: 'Choose a client.' }
  if (!input.name.trim()) return { error: 'Give the show a name.' }

  const { data: client } = await supabase
    .from('clients').select('day_rate_cents, ot_after_hours')
    .eq('id', input.client_id).maybeSingle()

  const day = client?.day_rate_cents ?? 0
  const hours = Number(client?.ot_after_hours ?? 10)

  const { data, error } = await supabase.from('shows').insert({
    owner_id: user.id,
    client_id: input.client_id,
    name: input.name.trim(),
    venue: input.venue?.trim() || null,
    day_rate_cents: day,
    travel_rate_cents: travelRateFrom(day),
    pm_rate_cents: hours > 0 ? Math.round(day / hours) : 0,
    ot_after_hours: hours,
  }).select('id').single()

  if (error) return { error: error.message }
  revalidatePath('/shows')
  return { ok: true, id: data.id }
}

export async function addShowDay(
  showId: string, date: string, dayType: DayType,
): Promise<Fail | { ok: true; id: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  const { data: show } = await supabase.from('shows').select('status').eq('id', showId).maybeSingle()
  if (show?.status === 'billed') return { error: 'This show is billed. Unlink it before editing.' }

  const { data, error } = await supabase.from('show_days')
    .insert({ owner_id: user.id, show_id: showId, date, day_type: dayType })
    .select('id').single()
  if (error) return { error: error.message }
  revalidatePath(`/shows/${showId}`)
  return { ok: true, id: data.id }
}

export async function recordPunch(
  showDayId: string, type: PunchType, at: string,
): Promise<Fail | { ok: true }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  const { data: day } = await supabase.from('show_days')
    .select('show_id, shows(status), punches(punch_type, punched_at)')
    .eq('id', showDayId).maybeSingle()
  if (!day) return { error: 'That day no longer exists.' }

  const status = (day as unknown as { shows: { status: string } }).shows?.status
  if (status === 'billed') return { error: 'This show is billed. Unlink it before editing.' }

  const existing = (day as unknown as { punches: { punch_type: string; punched_at: string }[] }).punches ?? []
  const problem = chronologyError(type, at, existing)
  if (problem) return { error: problem }

  const { error } = await supabase.from('punches')
    .insert({ owner_id: user.id, show_day_id: showDayId, punch_type: type, punched_at: at })
  if (error) return { error: error.message }

  revalidatePath(`/shows/${(day as unknown as { show_id: string }).show_id}`)
  return { ok: true }
}

export async function deletePunch(punchId: string, showId: string): Promise<Fail | { ok: true }> {
  const supabase = await createClient()
  const { data: show } = await supabase.from('shows').select('status').eq('id', showId).maybeSingle()
  if (show?.status === 'billed') return { error: 'This show is billed. Unlink it before editing.' }

  const { error } = await supabase.from('punches').delete().eq('id', punchId)
  if (error) return { error: error.message }
  revalidatePath(`/shows/${showId}`)
  return { ok: true }
}
```

- [ ] **Step 6: Commit**

```bash
git add lib/chronology.ts scripts/test/chronology.test.ts app/shows/actions.ts
git commit -m "Add show actions and punch chronology validation."
```

---

### Task 5: Billing flow

**Files:**
- Modify: `app/shows/actions.ts` (append `billShows`)
- Test: `scripts/test/showBuckets.test.ts` (append a combining test)

**Interfaces:**
- Consumes: `computeShowLines`, `saveInvoice` from `app/invoices/actions.ts`.
- Produces: `billShows(showIds: string[]): Fail | { ok: true; invoiceId: string }`.

- [ ] **Step 1: Write the failing test for `mergeLines`**

This tests the exported `mergeLines` from Task 2 — the same function `billShows`
calls. Do not reimplement the merge inside the test; a test that reimplements
its subject proves only that you can write the same bug twice.

Append to `scripts/test/showBuckets.test.ts`, and add `mergeLines` to the import
at the top of the file:

```ts
test('lines from several shows combine by bucket', () => {
  const mk = (id: string, date: string): ShowDayLike => ({
    id, date, day_type: 'show', pay_as_half_day: false,
    punches: [
      { punch_type: 'start', punched_at: `${date}T13:00:00Z` },
      { punch_type: 'end', punched_at: `${date}T23:00:00Z` },
    ],
  })
  const a = computeShowLines([mk('a', '2026-07-01')], RATES, RULES)
  const b = computeShowLines([mk('b', '2026-07-08')], RATES, RULES)

  assert.deepEqual(mergeLines([a, b]), [
    { description: 'Day Rate', qty_hundredths: 200, unit_price_cents: 78000 },
  ])
})

test('the same description at different prices does not merge', () => {
  const cheap: ShowRates = { ...RATES, day_rate_cents: 60000 }
  const mk = (id: string, date: string): ShowDayLike => ({
    id, date, day_type: 'show', pay_as_half_day: false,
    punches: [
      { punch_type: 'start', punched_at: `${date}T13:00:00Z` },
      { punch_type: 'end', punched_at: `${date}T23:00:00Z` },
    ],
  })
  const merged = mergeLines([
    computeShowLines([mk('a', '2026-07-01')], RATES, RULES),
    computeShowLines([mk('b', '2026-07-08')], cheap, RULES),
  ])
  assert.equal(merged.length, 2)
  assert.deepEqual(merged.map((l) => l.unit_price_cents).sort((x, y) => x - y), [60000, 78000])
})
```

- [ ] **Step 2: Run test to verify it fails, then passes**

Run: `npm test`
Expected: FAIL if `mergeLines` was not exported in Task 2 — `mergeLines is not a function`.
Export it, re-run, expect PASS.

- [ ] **Step 3: Append `billShows` to `app/shows/actions.ts`**

```ts
/**
 * Generates a DRAFT invoice from one or more unbilled shows for the same
 * client, then locks those shows. The lines are a snapshot: editing punches
 * afterwards cannot change an invoice a client already holds.
 */
export async function billShows(showIds: string[]): Promise<Fail | { ok: true; invoiceId: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }
  if (showIds.length === 0) return { error: 'Select at least one show.' }

  const { data: shows, error } = await supabase
    .from('shows')
    .select(`id, name, client_id, status,
             day_rate_cents, travel_rate_cents, pm_rate_cents, ot_after_hours,
             dt_after_hours, minimum_meal_break_minutes, meal_break_deduction_cap,
             meal_penalty_grace_hours, meal_penalty_cents, short_turn_rest_hours,
             continuous_time_enabled,
             show_days(id, date, day_type, pay_as_half_day, punches(punch_type, punched_at))`)
    .in('id', showIds)
  if (error) return { error: error.message }
  if (!shows?.length) return { error: 'Those shows no longer exist.' }

  if (shows.some((s) => s.status === 'billed')) return { error: 'One of those shows is already billed.' }
  const clientId = shows[0].client_id
  if (shows.some((s) => s.client_id !== clientId)) {
    return { error: 'All shows on one invoice must be for the same client.' }
  }

  // An incomplete day would silently bill zero hours, so refuse instead.
  for (const s of shows) {
    for (const d of (s.show_days ?? []) as { date: string; day_type: string; punches: { punch_type: string }[] }[]) {
      if (d.day_type === 'travel') continue
      const types = new Set(d.punches.map((p) => p.punch_type))
      if (types.has('start') !== types.has('end')) {
        return { error: `${s.name}: ${d.date} has an unfinished punch. Complete or remove it first.` }
      }
    }
  }

  const perShow: BucketLine[][] = []
  for (const s of shows) {
    const hours = Number(s.ot_after_hours)
    const rules: ShowRuleset = {
      overtime_after_hours: hours,
      double_time_enabled: s.dt_after_hours != null,
      double_time_after_hours: Number(s.dt_after_hours ?? 12),
      meal_penalty_enabled: s.meal_penalty_cents > 0,
      meal_penalty_grace_hours: Number(s.meal_penalty_grace_hours),
      minimum_meal_break_enabled: s.minimum_meal_break_minutes > 0,
      minimum_meal_break_minutes: s.minimum_meal_break_minutes,
      meal_break_deduction_cap: s.meal_break_deduction_cap,
      short_turn_penalty_enabled: true,
      short_turn_rest_hours: Number(s.short_turn_rest_hours),
      continuous_time_enabled: s.continuous_time_enabled,
    }
    const rates: ShowRates = {
      day_rate_cents: s.day_rate_cents,
      travel_rate_cents: s.travel_rate_cents,
      pm_rate_cents: s.pm_rate_cents,
      ot_rate_cents: overtimeRateFrom(s.day_rate_cents, hours),
      dt_rate_cents: doubleTimeRateFrom(s.day_rate_cents, hours),
      meal_penalty_cents: s.meal_penalty_cents,
    }
    const days = ((s.show_days ?? []) as unknown as ShowDayLike[])
    perShow.push(computeShowLines(days, rates, rules))
  }
  const merged = mergeLines(perShow)

  if (merged.length === 0) return { error: 'Nothing to bill — those shows have no completed days.' }

  const { saveInvoice } = await import('@/app/invoices/actions')
  const issue = todayInChicago()
  const result = await saveInvoice({
    client_id: clientId,
    issue_date: issue,
    terms_days: 30,
    deposit_cents: 0,
    tax_bp: 0,
    notes: shows.map((s) => s.name).join(', '),
    lines: merged,
  })
  if ('error' in result) return result

  const { error: linkError } = await supabase
    .from('shows')
    .update({ status: 'billed', invoice_id: result.id })
    .in('id', showIds)
  if (linkError) return { error: linkError.message }

  revalidatePath('/shows')
  revalidatePath('/invoices')
  return { ok: true, invoiceId: result.id }
}

/** Returns a show to unbilled so its punches can be edited again. */
export async function unlinkShow(showId: string): Promise<Fail | { ok: true }> {
  const supabase = await createClient()
  const { error } = await supabase
    .from('shows').update({ status: 'open', invoice_id: null }).eq('id', showId)
  if (error) return { error: error.message }
  revalidatePath('/shows')
  revalidatePath(`/shows/${showId}`)
  return { ok: true }
}
```

- [ ] **Step 4: Verify the build**

Run: `npm run build`
Expected: `✓ Compiled successfully`

- [ ] **Step 5: Commit**

```bash
git add app/shows/actions.ts scripts/test/showBuckets.test.ts
git commit -m "Generate a draft invoice from tracked shows, and lock them once billed."
```

---

### Task 6: Tracker screens

**Files:**
- Create: `app/shows/page.tsx` (list, with an Unbilled section)
- Create: `app/shows/new/page.tsx`
- Create: `app/shows/[id]/page.tsx` (day list + punch buttons)
- Create: `components/PunchClock.tsx` (client component)
- Modify: `components/AppShell.tsx` — add `Shows` to `NAV`

**Interfaces:**
- Consumes: every action from Tasks 4 and 5.
- Produces: no exports other components rely on.

- [ ] **Step 1: Add Shows to the nav**

In `components/AppShell.tsx`, change the `NAV` array to:

```tsx
const NAV = [
  { href: '/invoices', label: 'Invoices', key: 'invoices' },
  { href: '/shows', label: 'Shows', key: 'shows' },
  { href: '/clients', label: 'Clients', key: 'clients' },
  { href: '/settings', label: 'Settings', key: 'settings' },
] as const
```

Widen the `current` prop type to `'invoices' | 'shows' | 'clients' | 'settings'`.

- [ ] **Step 2: Write `components/PunchClock.tsx`**

```tsx
'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { PUNCH_ORDER, PUNCH_LABELS, type PunchType } from '@/lib/punchTypes'
import { recordPunch } from '@/app/shows/actions'

// One row per day. The next expected punch is the prominent button; the rest
// stay available because a real show floor doesn't run in order.

export default function PunchClock({
  showDayId, timezone, punches, locked,
}: {
  showDayId: string
  timezone: string
  punches: { id: string; punch_type: string; punched_at: string }[]
  locked: boolean
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const recorded = new Set(punches.map((p) => p.punch_type))
  const next = PUNCH_ORDER.find((t) => !recorded.has(t))

  const fmt = (iso: string) =>
    new Intl.DateTimeFormat('en-US', {
      hour: 'numeric', minute: '2-digit', timeZone: timezone,
    }).format(new Date(iso))

  function punch(type: PunchType) {
    setError(null)
    start(async () => {
      const result = await recordPunch(showDayId, type, new Date().toISOString())
      if ('error' in result) { setError(result.error); return }
      router.refresh()
    })
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        {PUNCH_ORDER.map((type) => {
          const hit = punches.find((p) => p.punch_type === type)
          if (hit) {
            return (
              <span key={type} className="tabular text-sm text-muted">
                {PUNCH_LABELS[type]} {fmt(hit.punched_at)}
              </span>
            )
          }
          const isNext = type === next
          return (
            <button
              key={type} type="button" disabled={locked || pending}
              onClick={() => punch(type)}
              className={
                isNext
                  ? 'px-3 py-1.5 text-xs font-bold uppercase tracking-wider rounded-field bg-accent text-accent-ink disabled:opacity-50'
                  : 'px-3 py-1.5 text-xs font-semibold uppercase tracking-wider rounded-field border border-line text-muted hover:text-ink disabled:opacity-40'
              }
            >
              {PUNCH_LABELS[type]}
            </button>
          )
        })}
      </div>
      {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
    </div>
  )
}
```

- [ ] **Step 3: Write `app/shows/page.tsx`**

Follows the two-section structure of `app/invoices/page.tsx` — an emphasised section on top, everything else below.

```tsx
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { formatDateShort } from '@/lib/dates'
import AppShell from '@/components/AppShell'

export const dynamic = 'force-dynamic'

export default async function ShowsPage() {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('shows')
    .select('id, name, venue, status, created_at, clients(name), show_days(id, date)')
    .order('created_at', { ascending: false })

  if (error) {
    return (
      <AppShell current="shows">
        <p role="alert" className="text-danger border-l-2 border-danger pl-4 py-2">
          Couldn&rsquo;t load shows: {error.message}
        </p>
      </AppShell>
    )
  }

  type Row = {
    id: string; name: string; venue: string | null; status: string
    clients: { name: string } | null; show_days: { id: string; date: string }[]
  }
  const rows = (data ?? []) as unknown as Row[]
  const unbilled = rows.filter((r) => r.status === 'open')
  const billed = rows.filter((r) => r.status === 'billed')

  const Row = ({ r }: { r: Row }) => {
    const dates = r.show_days.map((d) => d.date).sort()
    return (
      <li>
        <Link href={`/shows/${r.id}`}
              className="block border-b border-line py-4 px-2 -mx-2 hover:bg-surface transition-colors">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <span className="font-semibold">{r.name}</span>
            <span className="text-sm text-muted tabular">
              {dates.length} {dates.length === 1 ? 'day' : 'days'}
              {dates.length > 0 && ` · ${formatDateShort(dates[0])}`}
            </span>
          </div>
          <p className="text-xs text-muted mt-1">
            {r.clients?.name}{r.venue ? ` · ${r.venue}` : ''}
          </p>
        </Link>
      </li>
    )
  }

  return (
    <AppShell current="shows">
      <div className="flex items-baseline gap-4 mb-4">
        <h2 className="eyebrow">Unbilled</h2>
        <Link href="/shows/new"
              className="text-xs font-semibold uppercase tracking-wider text-accent hover:opacity-80">
          + New show
        </Link>
      </div>
      {unbilled.length === 0 ? (
        <p className="text-muted border-l-2 border-line pl-4 py-1 mb-12">
          Nothing untracked and unbilled. Everything you&rsquo;ve worked is on an invoice.
        </p>
      ) : (
        <ul className="border-t border-line mb-12">{unbilled.map((r) => <Row key={r.id} r={r} />)}</ul>
      )}

      <h2 className="eyebrow mb-4">Billed</h2>
      <ul className="border-t border-line">{billed.map((r) => <Row key={r.id} r={r} />)}</ul>
    </AppShell>
  )
}
```

- [ ] **Step 4: Write `app/shows/new/page.tsx`**

A server page loading clients, wrapping a client component that calls `createShow`.

```tsx
import { createClient } from '@/lib/supabase/server'
import AppShell from '@/components/AppShell'
import NewShowForm from '@/components/NewShowForm'

export const dynamic = 'force-dynamic'

export default async function NewShowPage() {
  const supabase = await createClient()
  const { data } = await supabase
    .from('clients').select('id, name').eq('archived', false).order('name')
  return (
    <AppShell current="shows">
      <NewShowForm clients={(data ?? []) as { id: string; name: string }[]} />
    </AppShell>
  )
}
```

Create `components/NewShowForm.tsx`:

```tsx
'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { createShow } from '@/app/shows/actions'

const field =
  'w-full px-3 py-2 bg-surface border border-line rounded-field text-ink text-sm ' +
  'focus:border-accent focus:outline-none'

export default function NewShowForm({ clients }: { clients: { id: string; name: string }[] }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [clientId, setClientId] = useState('')
  const [name, setName] = useState('')
  const [venue, setVenue] = useState('')

  function submit() {
    setError(null)
    start(async () => {
      const result = await createShow({ client_id: clientId, name, venue })
      if ('error' in result) { setError(result.error); return }
      router.push(`/shows/${result.id}`)
      router.refresh()
    })
  }

  return (
    <div className="max-w-xl">
      <h1 className="display text-3xl font-bold mb-8">New show</h1>

      <div className="mb-4">
        <label className="eyebrow block mb-2" htmlFor="client">Client</label>
        <select id="client" className={field} value={clientId}
                onChange={(e) => setClientId(e.target.value)}>
          <option value="">Choose a client…</option>
          {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <p className="text-xs text-muted mt-1.5">
          Their rate card is copied onto this show, so a later rate change
          won&rsquo;t alter what you bill here.
        </p>
      </div>

      <div className="mb-4">
        <label className="eyebrow block mb-2" htmlFor="name">Name</label>
        <input id="name" className={field} value={name} placeholder="GLS 2026"
               onChange={(e) => setName(e.target.value)} />
      </div>

      <div className="mb-8">
        <label className="eyebrow block mb-2" htmlFor="venue">Venue (optional)</label>
        <input id="venue" className={field} value={venue}
               onChange={(e) => setVenue(e.target.value)} />
      </div>

      {error && (
        <p role="alert" className="mb-5 text-sm text-danger border-l-2 border-danger pl-3 py-1">
          {error}
        </p>
      )}

      <button type="button" onClick={submit} disabled={pending}
              className="px-5 py-2.5 bg-accent text-accent-ink font-bold uppercase tracking-wider
                         text-sm rounded-field cursor-pointer hover:opacity-90 disabled:opacity-50">
        {pending ? 'Creating…' : 'Create show'}
      </button>
    </div>
  )
}
```

- [ ] **Step 4b: Write `app/shows/[id]/page.tsx`**

A server page that loads the show with its days and punches, renders one
`<PunchClock>` per day sorted by date, an Add-day control offering
`show | travel | pm`, a live preview of the lines `computeShowLines` would
produce for this show (call it directly — it is a pure function), and a
**Bill this show** button calling `billShows([id])`.

When `status === 'billed'`: render a link to `/invoices/{invoice_id}`, an
**Unlink** button calling `unlinkShow(id)`, and pass `locked={true}` to every
`PunchClock` so its buttons disable.

Use `formatDateLong` from `@/lib/dates` for day headings — never `new Date()`
formatting, which shifts a plain date backwards west of UTC.

The Add-day and Bill controls need a small client component
(`components/ShowDayControls.tsx`) since they call server actions; follow the
`useTransition` + `{error}` pattern in `components/NewShowForm.tsx` above.

- [ ] **Step 5: Verify in a browser**

```bash
npm run dev -- --port 3100
```

Then: create a show for Streamline Pictures, add a show day, punch In and Out, confirm the preview shows `Day Rate x1 @ $780.00`, hit Bill, and confirm the draft invoice opens with that line.

- [ ] **Step 6: Commit**

```bash
git add app/shows components/PunchClock.tsx components/AppShell.tsx
git commit -m "Add the show tracker screens."
```

---

## Self-review notes

Spec coverage checked against `2026-08-10-show-time-tracking-design.md`:

| Spec requirement | Task |
|---|---|
| Punch in/out, 6 punch types | 1, 4, 6 |
| All seven payroll rules | 1 |
| Floats stop at the hours/money boundary | 2 |
| Per-day ceiling rounding | 1 (`paidNetHours`) |
| `show` / `travel` / `pm` day types | 1, 2, 3 |
| PM days with no day-rate minimum | 2 (`pmHours`, no day-rate push) |
| Rate card frozen on the show | 3 (columns), 4 (`createShow` copies) |
| Many shows on one invoice | 5 (`billShows` merges) |
| Billed shows locked | 4 (guards), 5 (`unlinkShow`) |
| Punch chronology rejected at entry | 4 |
| Incomplete days block billing | 5 |
| Zero buckets produce no line | 2 |
| Meal penalties built, default off | 1, 2 (gated on `meal_penalty_cents > 0`) |
| RLS + anon revoked | 3 |

**Known gap, deliberate:** overnight-shift day attribution is handled by storing `punched_at` as a
`timestamptz` and letting the day's `date` be chosen by Dan when he adds it — a 2am wrap belongs
to the day he punched in on, which is the day the punch row hangs off. No timezone-derived
bucketing is needed because punches attach to a day directly rather than being sorted into one.
