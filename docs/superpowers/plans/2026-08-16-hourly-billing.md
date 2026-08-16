# Hourly Billing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a show bill sub-threshold worked days by the hour (`net hours × day_rate ÷ ot_after_hours`) instead of a flat day rate, behind a `bill_hourly` switch, with 10h+ days unchanged.

**Architecture:** One additive boolean, `bill_hourly`, threaded through exactly the path the existing `continuous_time_enabled` boolean already travels (rate card → show → persistence → `FrozenShowColumns` → `rulesetAndRatesFor` → billing). The billing rule lives entirely in `computeShowLines`/`rulesetAndRatesFor` in `lib/showBuckets.ts`, gated so day-rate shows are byte-identical. The hourly rate is derived, never stored.

**Tech Stack:** Next.js 16 App Router, TypeScript, Supabase (Postgres), `node --test` with native type stripping.

## Global Constraints

- **`computeShowLines` produces every invoice line.** The entire change is behind `if (rates.bill_hourly && …)`; a day-rate show must bill byte-identically to today, proven by a regression test, not assumed.
- The hourly rate is **derived, never stored**: `Math.round(day_rate_cents / ot_after_hours)`.
- Hours round **UP to the next whole hour, per day** — this is the existing `paidNetHours` ceiling (`lib/payroll.ts`), reused, not re-implemented. 6.25h bills 7h.
- Short-turnaround is **disabled when `bill_hourly` is on**: `short_turn_penalty_enabled: !bill_hourly` in `rulesetAndRatesFor`. `isShortTurnaround` already returns false when that flag is off (`lib/payroll.ts:108`).
- Migration is **0022**, additive only: `bill_hourly boolean not null default false` on `client_rate_cards` and `shows`. Numbered/checksummed; editing an applied migration is refused. **The controller applies migrations, not the implementer.**
- Money is integer cents. `parseUSD('')` returns **0, not null**.
- Tests live in `scripts/test/*.test.ts`, run by `npm test` (`node --test`, native type stripping, `--conditions=react-server`); `lib/` imports use relative `.ts` paths. `npx tsc --noEmit` and `npm run build` must be clean.
- Never write a literal control character or zero-width character into source.
- **`bill_hourly` mirrors `continuous_time_enabled` everywhere.** That boolean is already threaded through `client_rate_cards`, `shows`, `createShow`, `updateShow`, the show selects, `FrozenShowColumns`, `ShowRuleset`, `ClientEditor`, and `ShowSettings`. Anywhere `continuous_time_enabled` appears, `bill_hourly` needs a sibling — that grep is the task's own checklist: `grep -rn "continuous_time_enabled" app/ lib/ components/`.
- Commit messages explain the failure/behaviour, ending with:
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`

---

### Task 1: The billing calculation (pure, TDD)

The heart of the feature. Pure functions in `lib/showBuckets.ts`; no DB, no UI. Fully test-driven.

**Files:**
- Modify: `lib/showBuckets.ts` (`ShowRates`, `FrozenShowColumns`, `rulesetAndRatesFor`, `computeShowLines`)
- Test: `scripts/test/showBuckets.test.ts`

**Interfaces:**
- Consumes: `ShowDayLike`, `ShowRuleset` (`lib/payroll.ts`); `paidStraightTimeHours`, `paidOvertimeHours`, `paidDoubleTimeHours`, `mealPenaltyCount` (already imported).
- Produces:
  - `ShowRates` gains `bill_hourly: boolean` and `hourly_rate_cents: number`.
  - `FrozenShowColumns` gains `bill_hourly: boolean`.
  - `rulesetAndRatesFor(show)` derives both, and sets `short_turn_penalty_enabled: !show.bill_hourly`.
  - `computeShowLines` emits an `Hourly` line (card-name-suffixed) for sub-threshold worked days when `bill_hourly`.

- [ ] **Step 1: Write the failing tests**

Add to `scripts/test/showBuckets.test.ts`. Read the file's existing helpers first (how it builds days/rates/rules); construct `ShowRates`/`ShowRuleset` the same way the existing tests do. These assertions describe the behaviour:

```ts
// A helper mirroring the existing tests' rate/rule construction, hourly ON.
// day $600, ot after 10 -> derived $60/hr. Adjust field names to match the
// file's existing helpers if they differ.
const hourlyRates = { ...baseRates, day_rate_cents: 60000, bill_hourly: true, hourly_rate_cents: 6000 }
const hourlyRules = { ...baseRules, overtime_after_hours: 10, short_turn_penalty_enabled: false }

test('a sub-threshold day bills hours × hourly, not a day rate', () => {
  // A 6-hour worked day. Expect one Hourly line, 6.00 × $60, no Day Rate line.
  const lines = computeShowLines([sixHourDay], [], hourlyRates, hourlyRules)
  const hourly = lines.find((l) => l.description.startsWith('Hourly'))
  assert.ok(hourly, 'an Hourly line exists')
  assert.equal(hourly.qty_hundredths, 600)      // 6.00 hours
  assert.equal(hourly.unit_price_cents, 6000)   // $60.00
  assert.equal(lines.find((l) => l.description.startsWith('Day Rate')), undefined)
})

test('6.25 hours rounds up to 7 (per-day ceiling, reused)', () => {
  const lines = computeShowLines([sixTwentyFiveDay], [], hourlyRates, hourlyRules)
  const hourly = lines.find((l) => l.description.startsWith('Hourly'))
  assert.equal(hourly.qty_hundredths, 700)      // 7.00 hours, not 6.25
})

test('a day at exactly the threshold bills the full day rate, no Hourly line', () => {
  // 10-hour day. The seamless crossover: $600 either way, but it bills as a day.
  const lines = computeShowLines([tenHourDay], [], hourlyRates, hourlyRules)
  assert.ok(lines.find((l) => l.description.startsWith('Day Rate')))
  assert.equal(lines.find((l) => l.description.startsWith('Hourly')), undefined)
  assert.equal(lines.find((l) => l.description.startsWith('Overtime')), undefined)
})

test('a day over the threshold bills day rate + overtime, no Hourly line', () => {
  const lines = computeShowLines([elevenHourDay], [], hourlyRates, hourlyRules)
  assert.ok(lines.find((l) => l.description.startsWith('Day Rate')))
  assert.ok(lines.find((l) => l.description.startsWith('Overtime')))
  assert.equal(lines.find((l) => l.description.startsWith('Hourly')), undefined)
})

test('a mixed show: hourly day and a long day on one invoice', () => {
  const lines = computeShowLines([sixHourDay, elevenHourDay], [], hourlyRates, hourlyRules)
  assert.equal(lines.find((l) => l.description.startsWith('Hourly')).qty_hundredths, 600)
  assert.equal(lines.find((l) => l.description.startsWith('Day Rate')).qty_hundredths, 100) // 1 day
  assert.ok(lines.find((l) => l.description.startsWith('Overtime')))
})

test('short-turnaround is inert in hourly mode: no double-time penalty', () => {
  // Two short days close enough to trip short-turnaround. With bill_hourly on,
  // short_turn_penalty_enabled is false, so each bills its own hours hourly —
  // no Double Time line.
  const lines = computeShowLines([shortDay1, shortDay2], [], hourlyRates, hourlyRules)
  assert.equal(lines.find((l) => l.description.startsWith('Double Time')), undefined)
})

test('the Hourly line carries the rate card name like every other line', () => {
  const named = { ...hourlyRates, rate_card_name: 'Willow Creek' }
  const lines = computeShowLines([sixHourDay], [], named, { ...hourlyRules })
  assert.ok(lines.find((l) => l.description === 'Hourly — Willow Creek'))
})

test('bill_hourly OFF is byte-identical to a day-rate show (regression)', () => {
  // The load-bearing guard. A representative multi-day show billed with
  // bill_hourly:false must equal exactly what it bills today.
  const dayRateRates = { ...baseRates, day_rate_cents: 60000, bill_hourly: false, hourly_rate_cents: 6000 }
  const dayRateRules = { ...baseRules, overtime_after_hours: 10, short_turn_penalty_enabled: true }
  const lines = computeShowLines([sixHourDay, elevenHourDay], [], dayRateRates, dayRateRules)
  // 6-hour day bills a full day rate (unchanged behaviour), plus the 11-hour day.
  assert.equal(lines.find((l) => l.description.startsWith('Hourly')), undefined)
  assert.equal(lines.find((l) => l.description.startsWith('Day Rate')).qty_hundredths, 200) // 2 days
})

test('rulesetAndRatesFor derives hourly rate and flips short-turn off', () => {
  const { rates, rules } = rulesetAndRatesFor({ ...frozenColumns, day_rate_cents: 60000, ot_after_hours: 10, bill_hourly: true })
  assert.equal(rates.bill_hourly, true)
  assert.equal(rates.hourly_rate_cents, 6000)     // 60000 / 10
  assert.equal(rules.short_turn_penalty_enabled, false)
})

test('rulesetAndRatesFor with bill_hourly false keeps short-turn on', () => {
  const { rates, rules } = rulesetAndRatesFor({ ...frozenColumns, bill_hourly: false })
  assert.equal(rates.bill_hourly, false)
  assert.equal(rules.short_turn_penalty_enabled, true)
})
```

Build the day fixtures (`sixHourDay`, `tenHourDay`, etc.) with start/end punches the same way the existing `showBuckets.test.ts` / `payroll.test.ts` fixtures do — read those files and match their punch-construction helper. A "6-hour day" needs start and end punches 6 hours apart (net, after any meal rules) so `paidNetHours` returns 6.

- [ ] **Step 2: Run the tests, watch them fail**

Run: `npm test 2>&1 | grep -E "showBuckets|^ℹ (pass|fail)"`
Expected: the new tests fail — `bill_hourly`/`hourly_rate_cents` are not on the types, and no Hourly line is emitted.

- [ ] **Step 3: Extend the types**

In `lib/showBuckets.ts`, add to `ShowRates` (after `rate_card_name`):

```ts
  /** When true, sub-threshold worked days bill by the hour, not a flat day rate. */
  bill_hourly: boolean
  /** Derived day_rate_cents / ot_after_hours; only read when bill_hourly. */
  hourly_rate_cents: number
```

Add to `FrozenShowColumns`:

```ts
  bill_hourly: boolean
```

- [ ] **Step 4: Derive the rate and flip short-turn in `rulesetAndRatesFor`**

In `rulesetAndRatesFor`, change the hardcoded `short_turn_penalty_enabled: true` to:

```ts
    short_turn_penalty_enabled: !show.bill_hourly,
```

and add to the `rates` object (after `rate_card_name: show.rate_card_name`):

```ts
    bill_hourly: show.bill_hourly,
    hourly_rate_cents: Math.round(show.day_rate_cents / hours),
```

(`hours` is the already-computed `Number(show.ot_after_hours)` at the top of the function.)

- [ ] **Step 5: Emit the Hourly line in `computeShowLines`**

Add an `hourlyHours` accumulator beside `dayRateDays`/`halfDays`:

```ts
  let hourlyHours = 0
```

Change the worked-day branch:

```ts
    if (st > 0) {
      if (rates.bill_hourly && st < rules.overtime_after_hours) hourlyHours += st
      else if (d.pay_as_half_day) halfDays += 1
      else dayRateDays += 1
    }
```

(`st` is already the per-day ceiling-rounded straight time, so `st < overtime_after_hours` is exactly "under 10h," and its `ot`/`dt` are zero — the existing `otHours += ot` / `dtHours += dt` lines add nothing.)

Push the line, beside the `Day Rate` push, using the existing `label` helper:

```ts
  push(label('Hourly'), hourlyHours, rates.hourly_rate_cents)
```

- [ ] **Step 6: Run the tests, watch them pass**

Run: `npm test 2>&1 | grep -E "^ℹ (pass|fail)"`
Expected: all pass. `npx tsc --noEmit` clean.

Note: adding the two required fields to `ShowRates`/`FrozenShowColumns` will make `tsc` flag every existing construction site of those types (the callers in `app/shows/`). Those are fixed in Task 2. If the existing `showBuckets.test.ts` constructs these types inline, update those constructions to include `bill_hourly`/`hourly_rate_cents` so the test file compiles.

- [ ] **Step 7: Commit**

```bash
git add lib/showBuckets.ts scripts/test/showBuckets.test.ts
git commit -m "Bill sub-threshold days by the hour when a show is hourly"
```

---

### Task 2: Migration 0022 + thread `bill_hourly` through persistence

Add the column and carry the boolean everywhere `continuous_time_enabled` already travels, so a show and a rate card can store it.

**Files:**
- Create: `scripts/sql/migrations/0022_bill_hourly.sql`
- Modify: `app/shows/actions.ts` (createShow card select, persist, updateShow input+persist+select, the show selects)
- Modify: `app/clients/actions.ts` (rate-card save/parse)
- Modify: any `FrozenShowColumns` / rate-card row types that list the columns

**Interfaces:**
- Consumes: `FrozenShowColumns.bill_hourly` (Task 1).
- Produces: `bill_hourly` persisted on `shows` and `client_rate_cards`, and present in every `select` that feeds `rulesetAndRatesFor`.

- [ ] **Step 1: Write the migration**

Create `scripts/sql/migrations/0022_bill_hourly.sql`:

```sql
-- 0022 — bill a show by the hour below the overtime threshold
--
-- Some work (a church, Willow Creek) pays hourly for a sub-10-hour day, then
-- day-rate + OT at 10h+. The hourly rate is always day_rate / ot_after_hours
-- ($600/10 = $60), so it is derived, never stored — this flag is the only new
-- state. Off by default: every existing show and card bills exactly as before.
--
-- On both tables, mirroring every other rate rule: the card carries the
-- default, the show freezes it at creation and can override it.
--
-- Additive only. Nothing dropped or altered — Postgres stores a non-volatile
-- default in the catalogue rather than rewriting the table.
alter table client_rate_cards add column bill_hourly boolean not null default false;
alter table shows            add column bill_hourly boolean not null default false;
```

- [ ] **Step 2: Thread it through — use the grep as a checklist**

Run `grep -rn "continuous_time_enabled" app/ lib/ components/`. For **every** hit in `app/shows/actions.ts` and `app/clients/actions.ts` (selects, insert/update payloads, input types, row types, the `FrozenShowColumns` mapping), add a `bill_hourly` sibling. Specifically in `app/shows/actions.ts`:

- The createShow card `select` (~line 106-109): add `bill_hourly` to the selected columns.
- The persisted show payload (~line 224, beside `continuous_time_enabled: card.continuous_time_enabled`): add `bill_hourly: card.bill_hourly`.
- `updateShow`'s input type (~line 808) and its persisted payload and its `select` (~line 590-593): add `bill_hourly`.
- Every show `select` that lists the frozen columns (so `rulesetAndRatesFor` receives it): add `bill_hourly`.

In `app/clients/actions.ts`: the rate-card row type, the card `select`, and the card insert/update payload in `saveClient`/`parseCards` — add `bill_hourly` beside `continuous_time_enabled`.

The compiler is your checklist too: after Task 1, `tsc` errors on every `FrozenShowColumns`/`ShowRates` construction missing the new field. Resolve each by threading the real value, never a hardcoded `false`.

- [ ] **Step 3: Verify it compiles and builds**

Run: `npx tsc --noEmit && npm run build`
Expected: both clean. `npm test` still green (the migration isn't applied yet, but nothing tested reads the column — the calc tests pass their own values).

- [ ] **Step 4: Commit, then STOP for the controller to apply the migration**

```bash
git add scripts/sql/migrations/0022_bill_hourly.sql app/shows/actions.ts app/clients/actions.ts lib/showBuckets.ts
git commit -m "Persist bill_hourly on shows and rate cards"
```

Hand back: the controller reads the migration SQL and runs `npm run db:migrate` (it is additive and defaults false, so it cannot change any existing bill). Tasks 3–4 assume the column exists.

---

### Task 3: The toggle — rate card and show settings

How the switch gets turned on, with a live derived note.

**Files:**
- Modify: `components/ClientEditor.tsx` (rate-card row: the `bill_hourly` checkbox)
- Modify: `components/ShowSettings.tsx` (the show's `bill_hourly` toggle + derived note)

**Interfaces:**
- Consumes: `bill_hourly` persisted (Task 2).
- Produces: a UI control setting `bill_hourly`, wired into the same save path `continuous_time_enabled` uses.

- [ ] **Step 1: Mirror `continuous_time_enabled`'s control in `ClientEditor`**

Read how `ClientEditor.tsx` renders and edits `continuous_time_enabled` for a card row (it is a boolean on `RateCard`/`CardRow`). Add `bill_hourly` the same way: to the `RateCard` type (already added in Task 2's row type), to `CardRow` and `toCardRow`, and a checkbox in the card-row markup labelled **"Bill by the hour under the overtime threshold."**

- [ ] **Step 2: Add the toggle + derived note to `ShowSettings`**

`ShowSettings.tsx` already receives `initial.day_rate_cents`, `initial.ot_after_hours`, `initial.continuous_time_enabled`. Add `initial.bill_hourly` (thread through its `initial` type and the page that renders it, `app/shows/[id]/page.tsx`, mirroring `continuous_time_enabled`). Add a `useState` for it, a checkbox, and include it in the save payload.

Beneath the checkbox, a live note computed from the on-screen day rate and OT threshold:

```tsx
{billHourly && (
  <p className="text-xs text-muted mt-1">
    Days under {otHours}h bill at {formatUSD(Math.round(dayRateCents / otHours))}/hr
    ({formatUSD(dayRateCents)} ÷ {otHours}). {otHours}h+ days bill the day rate plus overtime.
  </p>
)}
```

Use the component's existing state for the day rate and OT hours (`dayRate`, and the OT field) converted to numbers via the existing `parseUSD`/`Number` the file already uses; guard against a zero/blank OT so the division never shows `Infinity`.

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit && npm run build`
Expected: clean. Manually (or note for the controller): the toggle appears on a show's settings and on a rate card, and the note recomputes as the day rate / OT change.

- [ ] **Step 4: Commit**

```bash
git add components/ClientEditor.tsx components/ShowSettings.tsx app/shows/[id]/page.tsx
git commit -m "Add the hourly-billing toggle to rate cards and show settings"
```

---

### Task 4: The show-page display

How an hourly day reads on the show page: hourly in the per-day breakdown, and no half-day toggle.

**Files:**
- Modify: `app/shows/[id]/page.tsx`

**Interfaces:**
- Consumes: `rates.bill_hourly`, `rates.hourly_rate_cents` (Task 1, now populated because Task 2 selects the column and `rulesetAndRatesFor` derives it).

- [ ] **Step 1: Show a sub-threshold hourly day as hourly in the breakdown**

The per-day breakdown built earlier computes `net`, `st`, `ot`, `dt`, `mp` and joins them. When `rates.bill_hourly && st > 0 && st < rules.overtime_after_hours`, replace that day's breakdown with the hourly reading instead:

```tsx
const breakdown = (rates.bill_hourly && st > 0 && st < rules.overtime_after_hours)
  ? `${fmtHours(st)} hrs → ${formatUSD(st * rates.hourly_rate_cents)} hourly`
  : [ /* the existing net · ST · OT · DT · meal join */ ].filter(Boolean).join(' · ')
```

(`st` is whole hours here, so `st * hourly_rate_cents` is the exact line total. `formatUSD` is already imported on this page.)

- [ ] **Step 2: Hide the half-day toggle in hourly mode**

The `HalfDayToggle` renders when `calculateNetHours(...) < 5 || d.pay_as_half_day`. Add `&& !rates.bill_hourly` so an hourly show never shows it (hourly billing is already finer-grained than a half day):

```tsx
{!rates.bill_hourly && (calculateNetHours(d as unknown as ShowDayLike, rules) < 5 || d.pay_as_half_day) && (
  <HalfDayToggle ... />
)}
```

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit && npm run build`
Expected: clean. `npm test` still green.

- [ ] **Step 4: Commit**

```bash
git add app/shows/[id]/page.tsx
git commit -m "Read an hourly day as hourly on the show page, and hide the half-day toggle"
```

---

## Verification for the whole plan

- `npm test` green, including the new Task 1 tests and the byte-identical regression.
- `npx tsc --noEmit` and `npm run build` clean.
- `grep -rn "continuous_time_enabled" app/ lib/ components/` and confirm a `bill_hourly` sibling exists at each persistence/select/type hit.
- After the controller applies 0022 and deploys: on the Willow Creek show, flip the toggle on; a 6h day reads `6.00 hrs → $360.00 hourly`; the preview shows an Hourly line; a 10h+ day still shows Day Rate + Overtime.
- A day-rate show (e.g. Streamline) is unchanged — same preview and same billed lines as before.

## Blast radius

`computeShowLines` and `rulesetAndRatesFor` touch every invoice. The behaviour change is behind `bill_hourly` and the migration defaults it off, so every existing show and card is unaffected — proven by the Task 1 regression test. One additive migration; no column changes type or meaning.
