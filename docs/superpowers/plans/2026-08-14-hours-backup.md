# Hours Backup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an hours page to the invoice PDF for clients who want backup, and freeze both it and the existing expense itemisation onto the invoice at bill time.

**Architecture:** A pure builder turns a show's days and punches into a snapshot object; `billShows` writes that object to `invoices.backup_snapshot` alongside the frozen lines; the PDF renders from the snapshot rather than from a live join.

**Tech Stack:** Next.js 16 App Router, Supabase Postgres + RLS, `@react-pdf/renderer`, `node --test` with native type stripping.

**Spec:** `docs/superpowers/specs/2026-08-14-hours-backup-design.md`

**The PDF page in Task 4 has already been rendered and looked at.** Its exact code is in this plan because it is verified, not sketched — an earlier version printed `12.010.0 ST` where two columns collided, which is why it is a fixed-column table rather than flex-grown text.

## Global Constraints

- **Money is integer cents.** Never recomputed from a rate. Rendered only via `formatUSD`.
- **The NET column is the BILLED figure (`paidNetHours`), not raw elapsed time.** Hours bill ceiling-rounded per day, and ST/OT derive from that ceiling — so **ST + OT + DT always equals NET**. The page does not explain the rounding: it is standard practice in this industry and the accountants receiving it expect it.
- **Clock times are frozen as formatted strings** in the show's zone at bill time. Never store the instant and format later: editing a show's timezone would retro-shift times a client already received.
- **Prep/PM is NOT on the hours page** and not in the snapshot. It bills as its own line on page 1.
- **The reconciliation is a test, not an intention:** OT hours summed across the snapshot must equal the `Overtime` line's `qty_hundredths / 100`, and likewise double time.
- **`anon` keeps ZERO privileges.** RLS on, owner-scoped, `revoke all from anon`.
- **Historical invoices must render byte-identically.** All 105 have no linked show; their snapshot is null and they gain no pages.
- **`lib/` imports are relative with explicit `.ts` extensions**, never `'@/lib/…'`; no JSX in `lib/`. `app/` uses the `@/` alias.
- The live database holds **105 real invoices and $185,484.28**. Migrations additive; no destructive SQL; no email sent by any test.
- Every task ends with `npm test`, `npx tsc --noEmit` and `npm run build` clean.

---

### Task 1: Schema

**Files:**
- Create: `scripts/sql/migrations/0012_hours_backup.sql`

**Interfaces:**
- Produces: `clients.show_hours_on_invoice boolean`, `invoices.backup_snapshot jsonb`.

- [ ] **Step 1: Write the migration**

```sql
-- 0012 — hours on the invoice, and a frozen backup
--
-- Two columns, one idea: the PDF's backup pages become part of the invoice
-- rather than a live view of the shows behind it.
--
-- invoice_lines has always been a snapshot. The expense itemisation shipped
-- deriving live from `shows where invoice_id = …`, so unlinking one show of two
-- left page 1 charging Meal Expenses $386.21 while the itemisation re-derived
-- to $266.21 — one document disagreeing with itself. Hours would be worse: they
-- are the JUSTIFICATION for money already charged, and backup that contradicts
-- the charge turns a client's silent trust into a dispute.
alter table invoices add column backup_snapshot jsonb;

-- Wanting backup is a property of the client, like their rate card — a
-- production company does, a church does not. Off by default.
alter table clients add column show_hours_on_invoice boolean not null default false;

comment on column invoices.backup_snapshot is
  'Frozen at bill time: hours rows, the expense itemisation, and the render '
  'decision. Null on every invoice billed before migration 0012 — those render '
  'no backup pages, which is what they already do.';
```

No new grants or policies: both tables already carry owner-scoped RLS and the
correct grants, and a new column inherits them.

- [ ] **Step 2: Apply it**

```bash
npm run db:migrate
```

Expected: `0012_hours_backup.sql … ok`, no drift on 0001–0011. Drift on an earlier file is a STOP — report it, repair nothing.

- [ ] **Step 3: Verify anon gained nothing and the ledger is untouched**

Write to the session scratchpad and run with `npm run db:sql -- <file>`:

```sql
set local role anon;
select current_user as who,
       has_column_privilege('public.invoices','backup_snapshot','select') as inv_read,
       has_column_privilege('public.clients','show_hours_on_invoice','select') as cli_read;
reset role;
select count(*) as invoices, sum(total_cents) as cents,
       count(backup_snapshot) as snapshots,
       (select count(*) from clients where show_hours_on_invoice) as opted_in
  from invoices;
```

Expected: `who = anon`, both privileges **false**; 105 invoices, 18548428 cents, 0 snapshots, 0 opted in. Any `true` is a STOP.

- [ ] **Step 4: Verify and commit**

```bash
npm test && npx tsc --noEmit && npm run build 2>&1 | grep -E "Compiled|Failed"
git add scripts/sql/migrations/0012_hours_backup.sql
git commit -m "Add a frozen backup snapshot and the per-client hours option."
```

---

### Task 2: The snapshot builder

Pure. No database, no clock, no rendering.

**Files:**
- Create: `lib/backupSnapshot.ts`
- Create: `scripts/test/backupSnapshot.test.ts`

**Interfaces:**
- Consumes: `calculateNetHours`, `paidStraightTimeHours`, `paidOvertimeHours`, `paidDoubleTimeHours`, `mealPenaltyCount`, `type ShowDayLike`, `type ShowRuleset` from `lib/payroll.ts`; `instantToWall`, `friendlyTime` from `lib/zonedTime.ts`; `timezoneShortLabel` from `lib/timezones.ts`; `type ExpenseLike` from `lib/expenses.ts`.
- Produces:
  - `export type SnapshotDay = { day: string; in: string | null; out: string | null; meal_minutes: number; net_hours: number; st_hours: number; ot_hours: number; dt_hours: number; travel_in: boolean; travel_out: boolean; half_day: boolean; meal_penalties: number }`
  - `export type SnapshotShow = { name: string; zone_label: string; days: SnapshotDay[] }`
  - `export type BackupSnapshot = { show_hours: boolean; shows: SnapshotShow[]; total_net: number; total_st: number; total_ot: number; total_dt: number; expenses: SnapshotExpense[] }`
  - `export type SnapshotExpense = { category: string; where_spent: string; amount_cents: number; spent_on: string; receipt_path: string | null }`
  - `export function buildBackupSnapshot(input: { shows: SnapshotInput[]; showHours: boolean }): BackupSnapshot`
  - `export type SnapshotInput = { name: string; timezone: string; days: ShowDayLike[]; rules: ShowRuleset; expenses: ExpenseLike[] }`
  - `export function dayLabel(iso: string): string`

- [ ] **Step 1: Write the failing test**

Create `scripts/test/backupSnapshot.test.ts`:

```ts
// The frozen backup. Pure — no database, no clock, no rendering.
//
// The invariant under test is the one the whole feature rests on: what the
// hours page CLAIMS must equal what the invoice CHARGES.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildBackupSnapshot, dayLabel, type SnapshotInput } from '../../lib/backupSnapshot.ts'
import { computeShowLines, type ShowRates } from '../../lib/showBuckets.ts'
import type { ShowRuleset, ShowDayLike } from '../../lib/payroll.ts'

// These field lists are the real ones from lib/payroll.ts and
// lib/showBuckets.ts — checked, not remembered. Every field is required.
const RULES: ShowRuleset = {
  overtime_after_hours: 10,
  double_time_enabled: false,
  double_time_after_hours: 0,
  meal_penalty_enabled: true,
  meal_penalty_grace_hours: 6,
  minimum_meal_break_enabled: true,
  minimum_meal_break_minutes: 30,
  meal_break_deduction_cap: 60,
  short_turn_penalty_enabled: false,
  short_turn_rest_hours: 8,
  continuous_time_enabled: false,
}
const RATES: ShowRates = {
  day_rate_cents: 78000, travel_rate_cents: 39000, pm_rate_cents: 8500,
  ot_rate_cents: 11700, dt_rate_cents: 15600, meal_penalty_cents: 5000,
}

/** A worked day in Eastern: punches are instants, so build them as UTC. */
const day = (date: string, startZ: string, endZ: string, over: Partial<ShowDayLike> = {}) => ({
  id: `d-${date}`,
  date,
  travel_in: false, travel_out: false, pay_as_half_day: false,
  punches: [
    { punch_type: 'start', punched_at: `${date}T${startZ}:00.000Z` },
    { punch_type: 'end', punched_at: `${date}T${endZ}:00.000Z` },
  ],
  ...over,
}) as ShowDayLike

const show = (days: ShowDayLike[], over: Partial<SnapshotInput> = {}): SnapshotInput => ({
  name: 'PwC Orlando', timezone: 'America/New_York', days, rules: RULES, expenses: [], ...over,
})

test('the OT on the page equals the OT on the invoice', () => {
  // THE invariant. Two views of the same work, computed by different code, that
  // must never disagree — this project has shipped a $1,560 overbill, a preview
  // reading $5,850 against an invoice of $6,226.21, and an itemisation $120
  // adrift. Each was two views drifting apart.
  const days = [
    day('2026-08-30', '12:00', '00:30'),  // 12.5h gross, 12.0 net after meal
    day('2026-08-31', '13:00', '23:00'),  // 9.5 net
    day('2026-09-01', '12:00', '01:00'),  // 12.0 net
  ]
  const snap = buildBackupSnapshot({ shows: [show(days)], showHours: true })
  const lines = computeShowLines(days, [], RATES, RULES)

  const otLine = lines.find((l) => l.description === 'Overtime')
  assert.ok(otLine, 'this fixture is meant to generate overtime')
  assert.equal(snap.total_ot, otLine.qty_hundredths / 100,
    'the hours page and the invoice disagree about overtime')
})

test('straight time reconciles too', () => {
  const days = [day('2026-08-30', '12:00', '00:30')]
  const snap = buildBackupSnapshot({ shows: [show(days)], showHours: true })
  assert.equal(snap.total_st + snap.total_ot, snap.total_net,
    'ST + OT must account for every net hour')
})

test('clock times are frozen in the show zone, not the machine zone', () => {
  // 12:00Z on 30 Aug is 8:00 AM Eastern and 7:00 AM Central. If this ever
  // rendered as 7:00 the show's zone is being ignored.
  const snap = buildBackupSnapshot({
    shows: [show([day('2026-08-30', '12:00', '00:30')])], showHours: true,
  })
  assert.equal(snap.shows[0].days[0].in, '8:00 AM')
  assert.equal(snap.shows[0].zone_label, 'Eastern')

  const central = buildBackupSnapshot({
    shows: [show([day('2026-08-30', '12:00', '00:30')], { timezone: 'America/Chicago' })],
    showHours: true,
  })
  assert.equal(central.shows[0].days[0].in, '7:00 AM', 'the same instant, a different clock')
})

test('a travel day is labelled, not given hours', () => {
  const travel = {
    id: 'd-travel', date: '2026-08-29', travel_in: true, travel_out: false,
    pay_as_half_day: false, punches: [],
  } as ShowDayLike
  const snap = buildBackupSnapshot({ shows: [show([travel])], showHours: true })
  const d = snap.shows[0].days[0]
  assert.equal(d.travel_in, true)
  assert.equal(d.in, null, 'no punches means no clock times, not a fabricated pair')
  assert.equal(d.net_hours, 0)
})

test('the flag off still records the hours, it only stops them rendering', () => {
  // The data is frozen either way, so turning the option on for a billed
  // invoice later has something to show.
  const snap = buildBackupSnapshot({
    shows: [show([day('2026-08-30', '12:00', '00:30')])], showHours: false,
  })
  assert.equal(snap.show_hours, false)
  assert.equal(snap.shows[0].days.length, 1, 'the rows are captured regardless')
})

test('expenses are frozen onto the snapshot with their receipt paths', () => {
  const snap = buildBackupSnapshot({
    shows: [show([], { expenses: [{
      id: 'e1', category: 'meals', where_spent: 'HMS Host',
      amount_cents: 1998, spent_on: '2026-08-29', receipt_path: 'owner/show/x-enhanced.jpg',
    }] })],
    showHours: false,
  })
  assert.equal(snap.expenses.length, 1)
  assert.equal(snap.expenses[0].amount_cents, 1998)
  assert.equal(snap.expenses[0].receipt_path, 'owner/show/x-enhanced.jpg',
    'the path is what can be frozen — the bucket is private and its URLs expire')
})

test('no prep data reaches the snapshot', () => {
  // Deliberately absent: prep is work done at home weeks earlier, it bills as
  // its own PM Hours line, and its minutes round UP to the next whole hour so
  // showing them raw beside that line reads as an overcharge.
  const snap = buildBackupSnapshot({
    shows: [show([day('2026-08-30', '12:00', '00:30')])], showHours: true,
  })
  assert.equal(JSON.stringify(snap).includes('pm'), false, 'no pm key anywhere')
})

test('day labels carry the weekday, deterministically', () => {
  assert.equal(dayLabel('2026-08-30'), 'Sun 8/30')
  assert.equal(dayLabel('2026-09-01'), 'Tue 9/1')
})

test('totals sum across several shows', () => {
  const a = show([day('2026-08-30', '12:00', '00:30')])
  const b = show([day('2026-09-05', '13:00', '23:00')], { name: 'Second' })
  const snap = buildBackupSnapshot({ shows: [a, b], showHours: true })
  assert.equal(snap.shows.length, 2)
  assert.equal(snap.total_net,
    snap.shows.flatMap((s) => s.days).reduce((t, d) => t + d.net_hours, 0))
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test 2>&1 | tail -20
```

Expected: FAIL — `Cannot find module '../../lib/backupSnapshot.ts'`.

- [ ] **Step 3: Write the module**

Create `lib/backupSnapshot.ts`:

```ts
// The frozen backup that travels with an invoice.
//
// invoice_lines has always been a snapshot; this gives the PDF's backup pages
// the same property. A sent invoice is a fixed document — re-downloading it in
// a year produces the same pages, whatever has happened to the shows since.
//
// Pure: no database, no clock, no rendering. No '@/' imports and no JSX.

import {
  calculateNetHours, paidStraightTimeHours, paidOvertimeHours, paidDoubleTimeHours,
  mealPenaltyCount, type ShowDayLike, type ShowRuleset,
} from './payroll.ts'
import { instantToWall, friendlyTime } from './zonedTime.ts'
import { timezoneShortLabel } from './timezones.ts'
import type { ExpenseLike } from './expenses.ts'

export type SnapshotDay = {
  day: string
  in: string | null
  out: string | null
  meal_minutes: number
  net_hours: number
  st_hours: number
  ot_hours: number
  dt_hours: number
  travel_in: boolean
  travel_out: boolean
  half_day: boolean
  meal_penalties: number
}

export type SnapshotShow = { name: string; zone_label: string; days: SnapshotDay[] }

export type SnapshotExpense = {
  category: string
  where_spent: string
  amount_cents: number
  spent_on: string
  receipt_path: string | null
}

export type BackupSnapshot = {
  show_hours: boolean
  shows: SnapshotShow[]
  total_net: number
  total_st: number
  total_ot: number
  total_dt: number
  expenses: SnapshotExpense[]
}

export type SnapshotInput = {
  name: string
  timezone: string
  days: ShowDayLike[]
  rules: ShowRuleset
  expenses: ExpenseLike[]
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** `2026-08-30` -> `Sun 8/30`. Built from the plain date in UTC, so it cannot
 *  shift by a day on a machine west of Greenwich. */
export function dayLabel(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  const at = new Date(Date.UTC(y, m - 1, d))
  return `${WEEKDAYS[at.getUTCDay()]} ${m}/${d}`
}

/** Minutes deducted for a meal, from the paired meal punches. */
function mealMinutes(day: ShowDayLike): number {
  const out = day.punches.find((p) => p.punch_type === 'meal_out')
  const back = day.punches.find((p) => p.punch_type === 'meal_in')
  if (!out || !back) return 0
  return Math.round(
    (new Date(back.punched_at).getTime() - new Date(out.punched_at).getTime()) / 60000)
}

/**
 * Freezes a set of billed shows into the document that backs their invoice.
 *
 * Hours come from the SAME functions billing uses, at the same rounding. A page
 * derived from the same punches but rounded differently would disagree with the
 * invoice by minutes — worse than showing nothing, because it invites a query
 * about a discrepancy that is purely cosmetic.
 */
export function buildBackupSnapshot(
  input: { shows: SnapshotInput[]; showHours: boolean },
): BackupSnapshot {
  const shows: SnapshotShow[] = input.shows.map((s) => ({
    name: s.name,
    zone_label: timezoneShortLabel(s.timezone),
    days: [...s.days]
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((d) => {
        const start = d.punches.find((p) => p.punch_type === 'start')
        const end = d.punches.find((p) => p.punch_type === 'end')
        const complete = Boolean(start && end)

        return {
          day: dayLabel(d.date),
          // Formatted HERE, in the show's zone, and stored as text. Keeping the
          // instant and formatting at render would let a later edit to the
          // show's timezone retro-shift times a client already received.
          in: complete ? friendlyTime(instantToWall(start!.punched_at, s.timezone).time) : null,
          out: complete ? friendlyTime(instantToWall(end!.punched_at, s.timezone).time) : null,
          meal_minutes: mealMinutes(d),
          net_hours: complete ? calculateNetHours(d, s.rules) : 0,
          st_hours: complete ? paidStraightTimeHours(d, s.days, s.rules) : 0,
          ot_hours: complete ? paidOvertimeHours(d, s.days, s.rules) : 0,
          dt_hours: complete ? paidDoubleTimeHours(d, s.days, s.rules) : 0,
          travel_in: d.travel_in,
          travel_out: d.travel_out,
          half_day: d.pay_as_half_day,
          meal_penalties: complete ? mealPenaltyCount(d, s.rules) : 0,
        }
      }),
  }))

  const allDays = shows.flatMap((s) => s.days)
  const sum = (pick: (d: SnapshotDay) => number) => allDays.reduce((t, d) => t + pick(d), 0)

  return {
    // The DECISION is frozen with the data, so a sent invoice is fixed. The
    // rows are captured either way, so turning the option on for an already
    // billed invoice has something to render.
    show_hours: input.showHours,
    shows,
    total_net: sum((d) => d.net_hours),
    total_st: sum((d) => d.st_hours),
    total_ot: sum((d) => d.ot_hours),
    total_dt: sum((d) => d.dt_hours),
    expenses: input.shows.flatMap((s) => s.expenses.map((e) => ({
      category: e.category,
      where_spent: e.where_spent,
      amount_cents: e.amount_cents,
      spent_on: e.spent_on,
      receipt_path: e.receipt_path,
    }))),
  }
}
```

`timezoneShortLabel('America/New_York')` returns `Eastern` and
`America/Chicago` returns `Central` — verified before this plan shipped, so the
test's expectations are the real function's output.

- [ ] **Step 4: Run the tests**

```bash
npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"
```

Expected: 115 existing plus 9 new = **124 passing**, 0 failing.

- [ ] **Step 5: Typecheck, build, commit**

```bash
npx tsc --noEmit && npm run build 2>&1 | grep -E "Compiled|Failed"
git add lib/backupSnapshot.ts scripts/test/backupSnapshot.test.ts
git commit -m "Freeze a show's hours and expenses into the invoice's backup."
```

---

### Task 3: Write it at bill time, and the client option

**Files:**
- Modify: `app/shows/actions.ts` — `billShows` builds and passes the snapshot
- Modify: `app/invoices/actions.ts` — `saveInvoice` persists it
- Modify: `components/ClientEditor.tsx` — the checkbox
- Modify: `app/clients/actions.ts` — save the new field
- Modify: `app/clients/[id]/page.tsx` — load it

**Interfaces:**
- Consumes: `buildBackupSnapshot`, `type BackupSnapshot` from `lib/backupSnapshot.ts`.
- Produces: `saveInvoice` accepts an optional `backupSnapshot: BackupSnapshot | null` and writes it to `invoices.backup_snapshot`.

- [ ] **Step 1: Build the snapshot in `billShows`**

Read `app/shows/actions.ts` first. `billShows` already loads each show's `show_days`, `punches`, `pm_entries` and `expenses`, and computes `rulesetAndRatesFor(s)` inside the `perShow` loop. Add `timezone` to its select list if absent, and the client's flag to the client lookup.

After `const merged = mergeLines(perShow)` and before the invoice is created:

```ts
  // Frozen here, from the SAME days and rules that produced the lines above.
  // Deriving it later from the shows would reintroduce exactly the drift this
  // replaces: unlink one show of two and the backup stops matching the charge.
  const backupSnapshot = buildBackupSnapshot({
    showHours: client.show_hours_on_invoice ?? false,
    shows: shows.map((s) => {
      const { rules } = rulesetAndRatesFor(s)
      return {
        name: s.name,
        timezone: s.timezone,
        days: ((s.show_days ?? []) as unknown as ShowDayLike[]),
        rules,
        expenses: ((s as unknown as { expenses?: ExpenseLike[] }).expenses ?? []),
      }
    }),
  })
```

Pass `backupSnapshot` through to `saveInvoice`.

- [ ] **Step 2: Persist it in `saveInvoice`**

In `app/invoices/actions.ts`, add `backupSnapshot?: BackupSnapshot | null` to `saveInvoice`'s input and include `backup_snapshot: input.backupSnapshot ?? null` in the invoice insert. An invoice created by hand through `InvoiceEditor` passes nothing and stores null — it has no shows, so it has no backup.

- [ ] **Step 3: The client checkbox**

In `components/ClientEditor.tsx`, add `show_hours_on_invoice: boolean` to `EditorClient`, a `useState` beside `archived`, and a checkbox in the same block, matching the existing `archived` control exactly:

```tsx
          <label className="flex items-center gap-2 text-sm text-muted">
            <input type="checkbox" className="h-4 w-4 accent-accent"
                   checked={showHours} disabled={pending}
                   onChange={(e) => setShowHours(e.target.checked)} />
            Attach an hours breakdown to this client&rsquo;s invoices
          </label>
          <p className="text-xs text-muted mt-1.5">
            Adds a page listing each day worked, with in and out times and the
            overtime split. Useful for production clients who reconcile against
            a call sheet.
          </p>
```

Thread it through `saveClient` in `app/clients/actions.ts` and the loader in `app/clients/[id]/page.tsx`, following how `archived` already flows.

- [ ] **Step 4: Verify**

```bash
npm test 2>&1 | grep -E "^ℹ (pass|fail)" && npx tsc --noEmit && npm run build 2>&1 | grep -E "Compiled|Failed"
```

Expected: 124 passing, clean, compiles.

- [ ] **Step 5: Confirm nothing was written to the live database**

```bash
npm run db:sql -- /dev/stdin <<'EOF'
select count(backup_snapshot) as snapshots, count(*) as invoices from invoices;
EOF
```

Expected: `0` snapshots, `105` invoices.

- [ ] **Step 6: Commit**

```bash
git add app/shows/actions.ts app/invoices/actions.ts components/ClientEditor.tsx app/clients/actions.ts "app/clients/[id]/page.tsx"
git commit -m "Freeze the backup when a show is billed, and let a client opt in."
```

---

### Task 4: The hours page, and the itemisation off the snapshot

**Files:**
- Modify: `lib/invoicePdf.ts`
- Modify: `components/InvoiceDocument.tsx` — `DocumentData` gains `backup`
- Modify: `app/invoices/[id]/page.tsx` and `app/invoices/actions.ts` — read the snapshot
- Modify: `scripts/test/invoicePdf.test.ts`

**Interfaces:**
- Consumes: `type BackupSnapshot` from `lib/backupSnapshot.ts`.
- Produces: `DocumentData` gains `backup?: BackupSnapshot & { expenses: (SnapshotExpense & { receiptDataUri: string | null })[] }`.

- [ ] **Step 1: Add `backup` to `DocumentData`**

In `components/InvoiceDocument.tsx`:

```ts
  /**
   * The frozen backup, present only on invoices billed from shows after
   * migration 0012. Receipt images arrive already fetched as data URIs — the
   * PDF renderer must not pull remote URLs itself.
   */
  backup?: {
    show_hours: boolean
    shows: { name: string; zone_label: string; days: {
      day: string; in: string | null; out: string | null; meal_minutes: number
      net_hours: number; st_hours: number; ot_hours: number; dt_hours: number
      travel_in: boolean; travel_out: boolean; half_day: boolean; meal_penalties: number
    }[] }[]
    total_net: number; total_st: number; total_ot: number; total_dt: number
    expenses: {
      category: 'meals' | 'rides' | 'baggage' | 'other'
      where_spent: string; amount_cents: number; spent_on: string
      receiptDataUri: string | null
    }[]
  }
```

- [ ] **Step 2: Add the styles**

In `lib/invoicePdf.ts`, add to the `s` object, immediately before `receiptPage`:

```ts
  hoursShow: { fontSize: 9, color: MUTED, letterSpacing: 1, marginTop: 16, marginBottom: 6 },
  hoursHead: {
    flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: INK,
    paddingBottom: 4, fontSize: 7, color: MUTED, letterSpacing: 0.5,
  },
  hoursRow: {
    flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: LINE, paddingVertical: 4,
  },
  hDay:   { width: 58 },
  hClock: { width: 132 },
  hMeal:  { width: 56, color: MUTED_DARK },
  hNum:   { width: 42, textAlign: 'right' },
  hFlag:  { width: 118, paddingLeft: 16, color: MUTED_DARK, fontSize: 8 },
  hoursTotal: {
    flexDirection: 'row', borderTopWidth: 2, borderTopColor: INK, paddingTop: 8, marginTop: 14,
  },
```

**Fixed column widths, not flex-grow.** An earlier version used `flexGrow` with `textAlign: 'right'` and printed `12.010.0 ST` — the net and split columns ran together. This layout has been rendered and looked at.

- [ ] **Step 3: Build the page**

In `buildInvoicePdf`, declare this **above** the `return h(Document, …)`, beside `expensePages`:

```ts
  const hrs = (n: number) => (n ? n.toFixed(1) : '')
  const backup = data.backup
  // The DT column only exists when there is double time — an empty column on
  // an ordinary show is noise.
  const anyDt = Boolean(backup?.shows.some((sh) => sh.days.some((d) => d.dt_hours > 0)))

  const hoursPages = !backup?.show_hours ? [] : [
    h(Page, { size: 'LETTER', style: s.page },
      V(s.body, [
        T(s.expenseHead, `HOURS — INVOICE #${data.number}`),
        ...backup.shows.flatMap((sh) => [
          T(s.hoursShow, `${sh.name.toUpperCase()}   ·   ${sh.zone_label}`),
          V(s.hoursHead, [
            T(s.hDay, 'DAY'), T(s.hClock, 'TIMES'), T(s.hMeal, 'MEAL'),
            T(s.hNum, 'NET'), T(s.hNum, 'ST'), T(s.hNum, 'OT'),
            ...(anyDt ? [T(s.hNum, 'DT')] : []), T(s.hFlag, ''),
          ]),
          ...sh.days.map((d) => {
            const flag = [d.travel_in && 'travel in', d.travel_out && 'travel out',
                          d.half_day && 'half day',
                          d.meal_penalties ? 'meal penalty' : ''].filter(Boolean).join(' · ')
            // A travel or half day carries no punches. Left blank it reads as
            // missing data, so it is labelled instead of given empty columns.
            if (!d.in || !d.out) {
              return V(s.hoursRow, [
                T(s.hDay, d.day),
                T({ ...s.hClock, color: MUTED_DARK, fontSize: 8 }, flag || '—'),
              ])
            }
            return V(s.hoursRow, [
              T(s.hDay, d.day),
              T(s.hClock, `${d.in} – ${d.out}`),
              T(s.hMeal, d.meal_minutes ? `${d.meal_minutes} min` : ''),
              T(s.hNum, hrs(d.net_hours)),
              T(s.hNum, hrs(d.st_hours)),
              T(s.hNum, hrs(d.ot_hours)),
              ...(anyDt ? [T(s.hNum, hrs(d.dt_hours))] : []),
              T(s.hFlag, flag),
            ])
          }),
        ]),
        V(s.hoursTotal, [
          T({ ...s.hDay, fontFamily: 'Oswald', fontSize: 10 }, 'TOTAL'),
          T(s.hClock, ''), T(s.hMeal, ''),
          T({ ...s.hNum, fontFamily: 'Oswald', fontSize: 10 }, hrs(backup.total_net)),
          T({ ...s.hNum, fontFamily: 'Oswald', fontSize: 10 }, hrs(backup.total_st)),
          T({ ...s.hNum, fontFamily: 'Oswald', fontSize: 10 }, hrs(backup.total_ot)),
          ...(anyDt ? [T({ ...s.hNum, fontFamily: 'Oswald', fontSize: 10 }, hrs(backup.total_dt))] : []),
          T(s.hFlag, ''),
        ]),
      ]),
    ),
  ]
```

Spread it into the `Document` **before** `expensePages` — labour, then costs, matching page one:

```ts
    ...hoursPages,
    ...expensePages,
```

The ASCII en dash `–` between clock times is safe: a glyph probe confirmed it renders in both Helvetica and Oswald. **U+2212 renders as nothing** and must never appear.

- [ ] **Step 4: Move the itemisation onto the snapshot**

`expensePages` currently reads `data.expenses`. Change it to read `data.backup?.expenses ?? []`, and change both assembly points (`app/invoices/[id]/page.tsx`, `app/invoices/actions.ts`) to read `invoices.backup_snapshot` instead of joining through `shows`. Keep the existing parallel `Promise.all` fetch with its per-item `catch` — only the source of the expense rows changes, not how images are fetched.

Delete the now-dead `shows(expenses(…))` query and the `expenses` field on `DocumentData`.

- [ ] **Step 5: Write the tests**

Append to `scripts/test/invoicePdf.test.ts`:

```ts
test('the hours page prints only when the client opted in', () => {
  const withHours: DocumentData = {
    ...INVOICE,
    backup: {
      show_hours: true,
      shows: [{ name: 'PwC Orlando', zone_label: 'Eastern', days: [
        { day: 'Sat 8/30', in: '8:00 AM', out: '8:30 PM', meal_minutes: 30,
          net_hours: 12, st_hours: 10, ot_hours: 2, dt_hours: 0,
          travel_in: false, travel_out: false, half_day: false, meal_penalties: 0 },
      ] }],
      total_net: 12, total_st: 10, total_ot: 2, total_dt: 0, expenses: [],
    },
  }
  const on = textOf(buildInvoicePdf(PARTS, withHours, ASSETS)).join(' ')
  assert.ok(on.includes('PWC ORLANDO'), 'the show is named')
  assert.ok(on.includes('8:00 AM'), 'clock times print')
  assert.ok(on.includes('Eastern'), 'and the zone they are quoted in')

  const off = textOf(buildInvoicePdf(
    PARTS, { ...withHours, backup: { ...withHours.backup!, show_hours: false } }, ASSETS)).join(' ')
  assert.ok(!off.includes('PWC ORLANDO'), 'the flag off suppresses the page entirely')
})

test('an invoice with no snapshot renders exactly as it always did', () => {
  const joined = textOf(buildInvoicePdf(PARTS, INVOICE, ASSETS)).join(' ')
  assert.ok(!/HOURS —/.test(joined), 'no hours page')
  assert.ok(!/itemis|EXPENSES/i.test(joined), 'and no expense pages')
})

test('a travel day is labelled instead of showing empty columns', () => {
  const travelOnly: DocumentData = {
    ...INVOICE,
    backup: {
      show_hours: true,
      shows: [{ name: 'PwC Orlando', zone_label: 'Eastern', days: [
        { day: 'Fri 8/29', in: null, out: null, meal_minutes: 0,
          net_hours: 0, st_hours: 0, ot_hours: 0, dt_hours: 0,
          travel_in: true, travel_out: false, half_day: false, meal_penalties: 0 },
      ] }],
      total_net: 0, total_st: 0, total_ot: 0, total_dt: 0, expenses: [],
    },
  }
  const joined = textOf(buildInvoicePdf(PARTS, travelOnly, ASSETS)).join(' ')
  assert.ok(joined.includes('travel in'), 'the day says what it is')
})

test('no Unicode minus reaches the page', () => {
  // U+2212 renders as NOTHING in Helvetica. A deposit once printed as a charge
  // rather than a credit because of it.
  const joined = textOf(buildInvoicePdf(PARTS, INVOICE, ASSETS)).join(' ')
  assert.ok(!joined.includes('−'))
})
```

- [ ] **Step 6: Verify, and LOOK at it**

```bash
npm test 2>&1 | grep -E "^ℹ (pass|fail)"
npx tsc --noEmit && npm run build 2>&1 | grep -E "Compiled|Failed"
npm run pdf:sample && sips -s format png tmp/invoice-simple.pdf --out tmp/check.png
```

Expected: **128 passing** (124 + 4), clean, compiles, and the existing samples still render — they carry no snapshot, so they must be unchanged.

- [ ] **Step 7: Commit**

```bash
git add lib/invoicePdf.ts components/InvoiceDocument.tsx "app/invoices/[id]/page.tsx" app/invoices/actions.ts scripts/test/invoicePdf.test.ts
git commit -m "Print the hours page, and read the itemisation from the snapshot."
```

---

### Task 5: Turning hours on after an invoice is billed

Without this, billing an invoice and *then* learning the client wanted hours is a dead end: the flag is frozen and the show is locked.

**Files:**
- Modify: `app/invoices/actions.ts` — a `setInvoiceHours` action
- Modify: `app/invoices/[id]/page.tsx` — the control

**Interfaces:**
- Produces: `setInvoiceHours(invoiceId: string, show: boolean): Promise<{ error: string } | { ok: true }>`

- [ ] **Step 1: The action**

```ts
/**
 * Flips only the `show_hours` flag inside an already-frozen snapshot.
 *
 * The rest of the snapshot is untouched: this changes whether the backup
 * PRINTS, never what it says. An explicit act rather than silent drift, which
 * is the whole reason the flag was frozen in the first place.
 */
export async function setInvoiceHours(
  invoiceId: string, show: boolean,
): Promise<Fail | { ok: true }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  const { data: inv } = await supabase
    .from('invoices').select('backup_snapshot').eq('id', invoiceId).maybeSingle()
  if (!inv) return { error: 'That invoice no longer exists.' }

  const snapshot = inv.backup_snapshot as { show_hours?: boolean } | null
  if (!snapshot) {
    return { error: 'This invoice has no hours recorded — it was not billed from a show.' }
  }

  const { error } = await supabase.from('invoices')
    .update({ backup_snapshot: { ...snapshot, show_hours: show } })
    .eq('id', invoiceId)
  if (error) return { error: error.message }

  revalidatePath(`/invoices/${invoiceId}`)
  return { ok: true }
}
```

- [ ] **Step 2: The control**

On `app/invoices/[id]/page.tsx`, render a checkbox only when `backup_snapshot` is non-null, labelled "Include the hours breakdown in the PDF", wired to `setInvoiceHours`. Follow the pattern of an existing small toggle component such as `components/HalfDayToggle.tsx` — a client component that calls the action and `router.refresh()`.

- [ ] **Step 3: Verify and commit**

```bash
npm test 2>&1 | grep -E "^ℹ (pass|fail)" && npx tsc --noEmit && npm run build 2>&1 | grep -E "Compiled|Failed"
git add app/invoices/actions.ts "app/invoices/[id]/page.tsx" components/
git commit -m "Allow the hours page to be switched on after billing."
```

---

## Verification

- `npm test` — 128 passing.
- `tsc` clean, `npm run build` compiles.
- `anon` holds no privilege on either new column.
- The OT total on the snapshot equals the `Overtime` line's quantity.
- An invoice with a null snapshot renders exactly as it does today.

## Manual verification, on the test client

1. Tick "Attach an hours breakdown" on `ZZ TEST — Dan Smith`.
2. Bill the test show; download the PDF.
3. Confirm page 2 lists each day with in/out times, and the OT column total matches the `Overtime` line on page 1.
4. Untick the invoice-level toggle; confirm the page disappears and the expense pages stay.
5. Open a historical invoice (#380 say) and confirm it is unchanged.

## Blast radius

Two additive columns, one new `lib/` module, one new action. No existing row is
modified. All 105 historical invoices have a null snapshot and render exactly as
they do today. The one behavioural change to existing code is that the expense
itemisation reads the snapshot instead of a live join — which is the point.
