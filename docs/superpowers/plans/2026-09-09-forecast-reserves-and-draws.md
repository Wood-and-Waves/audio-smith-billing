# Forecast: reserved money and planned draws — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the forecast start from unreserved cash, and charge the current month what is actually left to draw instead of a calendar fraction.

**Architecture:** All arithmetic stays in `lib/forecast.ts`, which is pure and already well tested. The page supplies three new numbers (reserved cents, owner pay already drawn this month, planned draws per month); a new `forecast_draw_plans` table stores the per-month plan; `components/ForecastTable.tsx` gains an editable draw cell.

**Tech Stack:** Next.js 16 App Router, TypeScript, Supabase Postgres, `node --test`.

**Spec:** `docs/superpowers/specs/2026-09-09-forecast-reserves-and-draws-design.md` — read it first; it carries the measured figures and Dan's own words on each decision.

## Global Constraints

- **Ship order is non-negotiable: apply the prod migration FIRST, then merge/push.**
- Migrations are `scripts/sql/migrations/NNNN_*.sql`, checksummed, **ADDITIVE ONLY**.
- Gates before every commit: `npm test`, cold `rm -f tsconfig.tsbuildinfo .next/cache/.tsbuildinfo && npx tsc --noEmit`, `npm run build`. **Never pipe `npm test` into anything** — a pipeline's exit code has masked a real failure here before.
- **Never run `npm run dev`.**
- `lib/*.ts` is pure: no `@/` imports, no JSX, relative `.ts` imports, no clock reads (`today` is always a parameter).
- The owner-pay category is identified by `OWNER_PAY_CATEGORY_NAME` from `lib/ledgerCategories.ts` — never a new string literal.
- Money is integer cents everywhere.
- Fail direction: destructure `error` and return BEFORE presence tests.
- Dan's live books are in this database. Reads against prod are fine; writes go through migrations only.

---

### Task 1: The `forecast_draw_plans` table

**Files:**
- Create: `scripts/sql/migrations/0051_forecast_draw_plans.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: table `forecast_draw_plans (id uuid, owner_id uuid, month date, amount_cents integer, created_at timestamptz, updated_at timestamptz)`, unique on `(owner_id, month)`.

- [ ] **Step 1: Write the migration**

```sql
-- 0051 — the draw Dan plans to take in a given month
--
-- The forecast used to charge a single monthly take-home every month, and to
-- pro-rate it by calendar day in the current month. Dan (2026-09-09):
-- "Proration is just flat out incorrect for how this should be calculated."
-- His draws are lumpy on purpose — $14,936 in July, $0 in August, $925 in
-- September because he took the rest from Wood and Waves that month — so a
-- calendar fraction cannot describe them.
--
-- WHY A TABLE rather than deriving it from the budget: the owner-pay
-- category's monthly ASSIGNMENT looks like a draw plan and is not one.
-- September assigns $3,784.65 while Dan intended to take $925; the envelope
-- accumulates toward future draws and also carries personal expenses. Dan:
-- "That available is set aside for the next time I pay myself." So the plan
-- has to be stated, not inferred.
--
-- A month with no row here falls back to settings.monthly_take_home_cents.
-- Absence means "the usual", never "zero" — a blank plan must not read as a
-- month where Dan takes nothing, which would flatter the runway.
--
-- ADDITIVE ONLY, per the 0020 rule.

create table forecast_draw_plans (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references auth.users(id) on delete cascade,

  -- Always the first of the month. The app writes 'YYYY-MM-01'; the check
  -- keeps a mid-month date from creating a second row for the same month
  -- that the unique constraint below would then fail to catch.
  month        date not null check (date_trunc('month', month) = month),

  -- A planned draw is never negative. Zero is meaningful and allowed: it is
  -- exactly September's case, a month where Dan plans to take nothing more.
  amount_cents integer not null check (amount_cents >= 0),

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  unique (owner_id, month)
);

alter table forecast_draw_plans enable row level security;
create policy forecast_draw_plans_owner_all on public.forecast_draw_plans
  for all to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
revoke all on public.forecast_draw_plans from anon;
grant select, insert, update, delete on public.forecast_draw_plans to authenticated;
grant all on public.forecast_draw_plans to service_role;
```

- [ ] **Step 2: Apply it to DEV and confirm**

Run: `npm run db:migrate` (dev is the default target)
Expected: `51 applied, 0 pending`

- [ ] **Step 3: Commit**

```bash
git add scripts/sql/migrations/0051_forecast_draw_plans.sql
git commit -m "migration 0051: per-month planned draw"
```

---

### Task 2: `reservedCents` — what the forecast must not count as runway

**Files:**
- Modify: `lib/forecast.ts` (add one exported function; import `OWNER_PAY_CATEGORY_NAME`)
- Test: `scripts/test/forecast.test.ts`

**Interfaces:**
- Consumes: `OWNER_PAY_CATEGORY_NAME` from `lib/ledgerCategories.ts`.
- Produces: `export function reservedCents(rows: { name: string; availableCents: number }[]): number`

- [ ] **Step 1: Write the failing tests**

Add to `scripts/test/forecast.test.ts`, and add `reservedCents` to the existing import from `'../../lib/forecast.ts'`:

```ts
// ---------------------------------------------------------------------------
// reservedCents — Dan (2026-09-09): "All saving money except for any in owner
// investment, pay, and personal expenses, should be off limits. They are saved
// for a purpose and not a payout."

test('reservedCents sums every category except owner pay', () => {
  assert.equal(reservedCents([
    { name: 'Taxes', availableCents: 1_300_000 },
    { name: 'Retained Earnings', availableCents: 68_061 },
    { name: OWNER_PAY_CATEGORY_NAME, availableCents: 310_417 },
  ]), 1_368_061)
})

// The owner-pay envelope is the one exception, and the reason is structural:
// its balance funds the very line the forecast already subtracts (the draw),
// where Taxes and Retained Earnings fund things the forecast does not model.
test('reservedCents excludes owner pay however large it grows', () => {
  assert.equal(reservedCents([
    { name: OWNER_PAY_CATEGORY_NAME, availableCents: 5_000_000 },
  ]), 0)
})

// An overspent category must not quietly hand runway back.
test('reservedCents floors each category at zero rather than netting negatives', () => {
  assert.equal(reservedCents([
    { name: 'Meals and Entertainment', availableCents: -9_327 },
    { name: 'Taxes', availableCents: 1_300_000 },
  ]), 1_300_000)
})

test('reservedCents is zero for an empty ledger', () => {
  assert.equal(reservedCents([]), 0)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `TZ=America/Chicago node --conditions=react-server --test scripts/test/forecast.test.ts`
Expected: FAIL — `reservedCents is not exported` / `is not a function`

- [ ] **Step 3: Implement**

In `lib/forecast.ts`, add the import beside the existing `./dates.ts` import:

```ts
import { OWNER_PAY_CATEGORY_NAME } from './ledgerCategories.ts'
```

and add, near `computeOverheadCents`:

```ts
/**
 * Money the forecast must NOT treat as runway: everything sitting available
 * in a category, except the owner-pay envelope.
 *
 * Dan's rule (2026-09-09): "All saving money except for any in owner
 * investment, pay, and personal expenses, should be off limits. They are
 * saved for a purpose and not a payout." Measured the day he asked: of an
 * $18,350.27 balance, $15,802.47 was reserved — including $13,000 held for
 * taxes, which the forecast had been offering him as runway.
 *
 * Owner pay is excluded for a structural reason, not as a preference. Its
 * balance is reserved for the one outflow the forecast ALREADY subtracts —
 * the draw — so hiding it while still charging the draw would count it
 * twice. Taxes and Retained Earnings fund obligations the forecast models
 * nowhere, which is exactly why leaving them in inflates the runway.
 *
 * Each category floors at zero: an overspent category means money already
 * left the account, which the starting balance reflects; letting its negative
 * offset a real reserve would hand runway back that does not exist.
 */
export function reservedCents(rows: { name: string; availableCents: number }[]): number {
  let total = 0
  for (const r of rows) {
    if (r.name === OWNER_PAY_CATEGORY_NAME) continue
    total += Math.max(0, r.availableCents)
  }
  return total
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `TZ=America/Chicago node --conditions=react-server --test scripts/test/forecast.test.ts`
Expected: PASS

- [ ] **Step 5: Gates and commit**

```bash
npm test
rm -f tsconfig.tsbuildinfo .next/cache/.tsbuildinfo && npx tsc --noEmit
npm run build
git add lib/forecast.ts scripts/test/forecast.test.ts
git commit -m "forecast: reservedCents, the money that is not runway"
```

---

### Task 3: Planned draws, drawn-so-far, and the end of pro-ration

**Files:**
- Modify: `lib/forecast.ts:385-393` (input type) and `lib/forecast.ts:515-545` (the month loop)
- Test: `scripts/test/forecast.test.ts`

**Interfaces:**
- Consumes: nothing from Task 2.
- Produces: `buildForecast` gains two OPTIONAL inputs, so every existing caller and fixture still compiles:
  - `plannedDrawCentsByMonth?: Map<string, number>` — key `'YYYY-MM'`; a missing month falls back to `assumptions.takeHomeCents`
  - `ownerPayDrawnThisMonthCents?: number` — default `0`

**This task changes six existing tests.** Their exact new values are given below — do not re-derive them.

- [ ] **Step 1: Write the failing tests**

Add to `scripts/test/forecast.test.ts`:

```ts
// ---------------------------------------------------------------------------
// The current month charges what is LEFT to draw. Dan's draws are lumpy on
// purpose: $14,936 in July, $0 in August, $925 in September (he took the rest
// from Wood and Waves that month). A calendar fraction cannot describe that.

test('the current month charges the planned draw minus what has already been drawn', () => {
  const result = buildForecast(baseInput({
    assumptions: assumptions({ overheadCents: 0, takeHomeCents: 750_000, taxRateBp: 0 }),
    ownerPayDrawnThisMonthCents: 92_500,
  }))
  assert.equal(result.months[0].drawCents, 657_500) // 750,000 - 92,500
})

test('a month already drawn beyond its plan charges nothing more, never a negative', () => {
  const result = buildForecast(baseInput({
    assumptions: assumptions({ overheadCents: 0, takeHomeCents: 750_000, taxRateBp: 0 }),
    ownerPayDrawnThisMonthCents: 1_493_600, // July's real figure
  }))
  assert.equal(result.months[0].drawCents, 0)
})

test('drawn-so-far applies ONLY to the current month, never to later ones', () => {
  const result = buildForecast(baseInput({
    assumptions: assumptions({ overheadCents: 0, takeHomeCents: 750_000, taxRateBp: 0 }),
    ownerPayDrawnThisMonthCents: 92_500,
  }))
  assert.equal(result.months[1].drawCents, 750_000)
})

test('a per-month plan overrides the take-home for that month only', () => {
  const result = buildForecast(baseInput({
    assumptions: assumptions({ overheadCents: 0, takeHomeCents: 750_000, taxRateBp: 0 }),
    plannedDrawCentsByMonth: new Map([['2026-09', 200_000]]),
  }))
  assert.equal(result.months[0].drawCents, 750_000) // 2026-08, no plan -> take-home
  assert.equal(result.months[1].drawCents, 200_000) // 2026-09, planned
  assert.equal(result.months[2].drawCents, 750_000) // 2026-10, back to take-home
})

// A planned ZERO is a real instruction and must not read as "unset".
test('a planned draw of zero is honoured, not treated as missing', () => {
  const result = buildForecast(baseInput({
    assumptions: assumptions({ overheadCents: 0, takeHomeCents: 750_000, taxRateBp: 0 }),
    plannedDrawCentsByMonth: new Map([['2026-08', 0]]),
  }))
  assert.equal(result.months[0].drawCents, 0)
})

test('the current month applies drawn-so-far against the PLAN, not the take-home', () => {
  const result = buildForecast(baseInput({
    assumptions: assumptions({ overheadCents: 0, takeHomeCents: 750_000, taxRateBp: 0 }),
    plannedDrawCentsByMonth: new Map([['2026-08', 100_000]]),
    ownerPayDrawnThisMonthCents: 40_000,
  }))
  assert.equal(result.months[0].drawCents, 60_000)
})

// Overhead no longer pro-rates either. It does NOT get the "what's left"
// treatment: with Dan's manual override in force, "overhead spent so far this
// month" has no clean definition, and most of a month's real spend is
// reimbursable gig cost that is not overhead at all.
test('the current month charges a full month of overhead regardless of the day', () => {
  for (const today of ['2026-08-01', '2026-08-21', '2026-08-31']) {
    const result = buildForecast(baseInput({
      today,
      assumptions: assumptions({ overheadCents: 310_000, takeHomeCents: 0, taxRateBp: 0 }),
    }))
    assert.equal(result.months[0].overheadCents, 310_000, `overhead on ${today}`)
  }
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `TZ=America/Chicago node --conditions=react-server --test scripts/test/forecast.test.ts`
Expected: FAIL — the new inputs are not accepted, and month 0 is still pro-rated.

- [ ] **Step 3: Change the input type**

`lib/forecast.ts`, in `buildForecast`'s parameter object, after `assumptions: ForecastAssumptions`:

```ts
  /** 'YYYY-MM' -> the draw Dan plans for that month. A missing month means
   *  "the usual" and falls back to assumptions.takeHomeCents — absence must
   *  never read as a zero-draw month, which would flatter the runway. */
  plannedDrawCentsByMonth?: Map<string, number>
  /** Owner pay already taken in the CURRENT month, from the ledger. */
  ownerPayDrawnThisMonthCents?: number
```

and add both to the destructure with defaults:

```ts
  const {
    today, startingBalanceCents, homeState, shows, invoices, clients, assumptions,
    plannedDrawCentsByMonth, ownerPayDrawnThisMonthCents = 0,
  } = input
```

- [ ] **Step 4: Replace the month-0 block**

Replace the pro-ration block (the `let overheadCents` / `let drawCents` / `if (i === 0)` section) with:

```ts
    // Overhead is charged in full every month, month 0 included. Pro-ration
    // by calendar day was removed 2026-09-09 — Dan: "Proration is just flat
    // out incorrect for how this should be calculated." Overhead does NOT get
    // month 0's "what's left" treatment either: with his manual override in
    // force, "overhead spent so far this month" has no clean definition, and
    // most of a month's real spend is reimbursable gig cost that is not
    // overhead at all. Charging the full month errs conservative and bounds
    // the error at one month's overhead.
    const overheadCents = assumptions.overheadCents

    // The draw is what he PLANS to take, per month, falling back to the
    // single take-home figure for any month he has not planned. Month 0
    // charges only what is still to come: his September plan is $925 and he
    // has already taken $925, so the honest answer for this month is nothing
    // more — which neither pro-ration nor a flat monthly figure can express.
    const planned = plannedDrawCentsByMonth?.get(month) ?? assumptions.takeHomeCents
    const drawCents = i === 0 ? Math.max(0, planned - ownerPayDrawnThisMonthCents) : planned
```

- [ ] **Step 5: Update the six existing tests that pinned pro-ration**

Use these exact values.

1. In `'a mid-month start pro-rates both overhead and the draw by the days remaining, today included'` — rename to `'a mid-month start charges a full month of overhead and the full planned draw'`, keep the same input, and change the assertions to:

```ts
  assert.equal(result.months[0].overheadCents, 310000)
  assert.equal(result.months[0].drawCents, 620000)
```

2. In `'a forecast run on the 1st of the month charges the full month\'s overhead and draw'` — assertions are already `500000` / `760000` and still pass. Replace the comment `// All 31 days remain, today included -> fraction is 31/31 = 1.` with `// No pro-ration at all now; the day of the month is irrelevant.`

3. In `'a forecast run on the last day of the month charges roughly one day\'s worth'` — rename to `'a forecast run on the last day of the month still charges the full month'` and change the assertions to:

```ts
  assert.equal(result.months[0].overheadCents, 310000)
  assert.equal(result.months[0].drawCents, 620000)
```

4. In the test asserting `endingBalanceCents` of `429032` / `5229032` / `5029032`, replace those three assertions with:

```ts
  assert.equal(result.months[0].endingBalanceCents, 300000) // 500000 - 100000 - 100000
  assert.equal(result.months[1].endingBalanceCents, 5100000) // 300000 + 5000000 - 200000
  assert.equal(result.months[2].endingBalanceCents, 4900000) // 5100000 - 200000
```

and delete the three comment lines about the 11/31 fraction.

5. In `'the first uncovered month is identified exactly, and coveredThrough is the month before it'`, replace the two balance assertions with:

```ts
  assert.equal(result.months[0].endingBalanceCents, 50000) // 250000 - 200000
  assert.equal(result.months[1].endingBalanceCents, -150000)
```

and replace the pro-ration comment with `// no income at all; each month costs a full 100000 + 100000.` The other assertions in that test are unchanged.

6. In `'a balance of exactly zero counts as covered, and the walk continues'`, change the starting balance and comment:

```ts
    startingBalanceCents: 62000, // one full month: 31000 overhead + 31000 draw
```

and replace the three-line pro-ration comment above it with `// A full month of overhead and draw now, so the starting balance that lands exactly on zero is their sum.`

- [ ] **Step 6: Run the tests to verify they pass**

Run: `TZ=America/Chicago node --conditions=react-server --test scripts/test/forecast.test.ts`
Expected: PASS, with no remaining references to pro-ration.

- [ ] **Step 7: Gates and commit**

```bash
npm test
rm -f tsconfig.tsbuildinfo .next/cache/.tsbuildinfo && npx tsc --noEmit
npm run build
git add lib/forecast.ts scripts/test/forecast.test.ts
git commit -m "forecast: planned draws per month, and no more pro-ration"
```

---

### Task 4: Feed the page real numbers

**Files:**
- Modify: `app/money/forecast/page.tsx` (the assembly around lines 380-600)

**Interfaces:**
- Consumes: `reservedCents` (Task 2); `buildForecast`'s two new inputs (Task 3); `assembleBudget` from `app/money/budget/data.ts`; `OWNER_PAY_CATEGORY_NAME`.
- Produces: nothing later tasks import.

Three notes before you start:

- The page currently computes its starting balance with `availableToAllocate(workingBalanceCents, moveRows)`, where `moveRows` comes from **`ledger_envelope_moves` — a dead table nothing can write to**, so the subtraction is permanently zero. The page's own comment says so. Delete that path rather than leaving a misleading one.
- `assembleBudget(supabase, viewMonth)` is the ONE budget assembly and already returns per-category `availableCents`. Do not hand-roll a second one.
- Owner pay already drawn reads `kind = 'owner_pay'`, not the category. Verified against prod: every row in that category is `owner_pay` and every one is an outflow, so there is no inflow to net against.

- [ ] **Step 1: Replace the starting-balance computation**

Remove the `fetchAllForecastMoves` call, its `movesRes` destructuring, the `availableToAllocate` call and the now-unused imports from `@/lib/envelopes`. In their place, after `workingBalanceCents` is computed:

```ts
  // Runway is UNRESERVED cash. Dan (2026-09-09): "All saving money except for
  // any in owner investment, pay, and personal expenses, should be off
  // limits. They are saved for a purpose and not a payout." Until today this
  // page started from the whole working balance and offered him $13,000 of
  // tax money as runway — a gap this file's own comment had recorded as
  // deferred. reservedCents (lib/forecast.ts) holds the rule and its reasons.
  const budgetForReserves = await assembleBudget(supabase, today.slice(0, 7))
  if (!budgetForReserves.ok) return <LoadError message={budgetForReserves.error} />
  const reserveRows = budgetForReserves.assembly
    ? (budgetForReserves.assembly.months.get(today.slice(0, 7))?.rows ?? []).map((r) => ({
        name: budgetForReserves.assembly!.categories.find((c) => c.id === r.categoryId)?.name ?? '',
        availableCents: r.availableCents,
      }))
    : []
  const startingBalanceCents = workingBalanceCents - reservedCents(reserveRows)
```

- [ ] **Step 2: Read owner pay already drawn this month**

`txnRows` is already fetched for `workingBalance` and carries `date`, `amount_cents` and `kind`. Add:

```ts
  // Only the current month, only outflows: what he has already paid himself
  // this month, which month 0's draw is charged NET of.
  const thisMonth = today.slice(0, 7)
  const ownerPayDrawnThisMonthCents = txnRows.reduce(
    (sum, t) => (t.kind === 'owner_pay' && t.date.slice(0, 7) === thisMonth && t.amount_cents < 0
      ? sum - t.amount_cents
      : sum),
    0,
  )
```

`fetchAllForecastTxns` already selects `id, date, amount_cents, kind, category_id` (`app/money/forecast/page.tsx:63`), so no query change is needed here.

- [ ] **Step 3: Load the planned draws**

Add to the existing `Promise.all` wave (never a new serial await — this page was parallelised deliberately):

```ts
    supabase.from('forecast_draw_plans').select('month, amount_cents'),
```

and after the wave:

```ts
  const { data: drawPlanRows, error: drawPlanError } = drawPlansRes
  if (drawPlanError) return <LoadError message={drawPlanError.message} />
  const plannedDrawCentsByMonth = new Map<string, number>(
    (drawPlanRows ?? []).map((r) => [String(r.month).slice(0, 7), r.amount_cents]),
  )
```

- [ ] **Step 4: Pass all three into buildForecast**

```ts
  const forecast = buildForecast({
    today,
    startingBalanceCents,
    homeState,
    shows: forecastShows,
    invoices: forecastInvoices,
    clients,
    assumptions: { takeHomeCents, overheadCents, taxRateBp, billingLagDays },
    plannedDrawCentsByMonth,
    ownerPayDrawnThisMonthCents,
  })
```

Keep the existing variable names for the first seven fields exactly as the file already has them.

- [ ] **Step 5: Gates**

```bash
npm test
rm -f tsconfig.tsbuildinfo .next/cache/.tsbuildinfo && npx tsc --noEmit
npm run build
```

- [ ] **Step 6: Verify against live data before committing**

Run this read-only check and confirm the starting balance matches what the page will now use:

```bash
node --env-file=.env.local scripts/parity/ynab-live.mjs
```

Expected: parity output unchanged (this task touches no budget arithmetic). If any category figure moved, stop — something in the reserve read is wrong.

- [ ] **Step 7: Commit**

```bash
git add app/money/forecast/page.tsx
git commit -m "forecast: start from unreserved cash and net out this month's draw"
```

---

### Task 5: Edit a month's planned draw on the forecast table

**Files:**
- Create: `app/money/forecast/actions.ts`
- Modify: `components/ForecastTable.tsx`

**Interfaces:**
- Consumes: the `forecast_draw_plans` table (Task 1).
- Produces: `setDrawPlan(month: string, amountCents: number | null): Promise<{ ok: true } | { error: string }>` — `null` clears the row so the month falls back to the take-home figure.

- [ ] **Step 1: Write the server action**

`app/money/forecast/actions.ts`:

```ts
'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'

/**
 * Sets (or clears) the draw Dan plans for one month. Clearing means "the
 * usual" — the month falls back to settings.monthly_take_home_cents — which
 * is why null is a real argument and not just an empty string.
 */
export async function setDrawPlan(
  month: string, amountCents: number | null,
): Promise<{ ok: true } | { error: string }> {
  if (!/^\d{4}-\d{2}$/.test(month)) return { error: 'That is not a month.' }
  if (amountCents !== null && (!Number.isInteger(amountCents) || amountCents < 0)) {
    return { error: 'A planned draw cannot be negative.' }
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  if (amountCents === null) {
    const { error } = await supabase
      .from('forecast_draw_plans').delete().eq('owner_id', user.id).eq('month', `${month}-01`)
    if (error) return { error: error.message }
  } else {
    const { error } = await supabase
      .from('forecast_draw_plans')
      .upsert(
        { owner_id: user.id, month: `${month}-01`, amount_cents: amountCents, updated_at: new Date().toISOString() },
        { onConflict: 'owner_id,month' },
      )
    if (error) return { error: error.message }
  }

  revalidatePath('/money/forecast')
  return { ok: true }
}
```

- [ ] **Step 2: Make the draw cell editable**

`components/ForecastTable.tsx` becomes a client component. Add at the top of the file:

```tsx
'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { FIELD_FULL } from '@/components/ui/field'
import { setDrawPlan } from '@/app/money/forecast/actions'
```

and inside the component, above the returned markup:

```tsx
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
```

Render `{error && <p role="alert" className="text-danger text-xs mt-2">{error}</p>}` directly beneath the table. `monthLabel` is already imported by this file for the month column — reuse it rather than adding a second formatter.

In the row map, replace the static draw cell with an input that saves on blur, following the register's established idiom — `useTransition`, `router.refresh()`, and an `{error}` line:

```tsx
<td className="tabular text-right">
  <input
    aria-label={`Planned draw for ${monthLabel(m.month)}`}
    inputMode="decimal"
    className={`${FIELD_FULL} tabular text-right`}
    defaultValue={(m.drawCents / 100).toFixed(2)}
    disabled={pending}
    onBlur={(e) => {
      const raw = e.target.value.trim()
      const cents = raw === '' ? null : Math.round(Number(raw) * 100)
      if (cents !== null && !Number.isFinite(cents)) return
      startTransition(async () => {
        const res = await setDrawPlan(m.month, cents)
        if ('error' in res) setError(res.error)
        else { setError(null); router.refresh() }
      })
    }}
  />
</td>
```

Note the value shown is `m.drawCents`, which for the CURRENT month is already net of what he has drawn. Label that column's current-month cell so it does not read as a plan he can edit back upward — add, beneath the input and only when `i === 0`, `<span className="text-xs text-muted">left to take</span>`.

- [ ] **Step 3: Gates**

```bash
npm test
rm -f tsconfig.tsbuildinfo .next/cache/.tsbuildinfo && npx tsc --noEmit
npm run build
```

- [ ] **Step 4: Commit**

```bash
git add app/money/forecast/actions.ts components/ForecastTable.tsx
git commit -m "forecast: edit a month's planned draw on the table"
```

---

### Task 6: Prod migration, docs, ship

**Files:**
- Modify: `CLAUDE.md` (Current state section), `docs/BACKLOG.md`

- [ ] **Step 1: Apply the migration to PRODUCTION — before any merge**

```bash
npm run db:migrate -- --status --prod
```
Expected: `50 applied, 1 pending`

```bash
npm run db:migrate -- --prod
```
Expected: `51 applied, 0 pending`

- [ ] **Step 2: Record it in the docs**

In `CLAUDE.md`'s Current state section, change "Prod migrations through 0050" to 0051 and add one line: the forecast starts from unreserved cash (all category availables except owner pay), charges the current month what is left to draw, and no longer pro-rates.

In `docs/BACKLOG.md`, add a SHIPPED entry pointing at `docs/superpowers/specs/2026-09-09-forecast-reserves-and-draws-design.md` for the reasoning, and record the two facts worth keeping: the owner-pay exception is structural (its balance funds the draw line the forecast already subtracts), and the current-month draw reads imported bank data, so it runs optimistic until Dan imports.

- [ ] **Step 3: Commit and push**

```bash
git add CLAUDE.md docs/BACKLOG.md
git commit -m "docs: forecast reserves and planned draws shipped (0051)"
git push origin main
```

- [ ] **Step 4: Verify on the live site**

Open `/money/forecast` and confirm:
- The starting balance is roughly **$15,800 lower** than before — every month's ending balance moves by the same amount, since only the opening changes.
- September's draw cell reads **$0.00 left to take** (he planned $925 and has drawn $925).
- Editing October's draw and reloading keeps the new figure.

---

## Deliberately NOT in this plan

- **Overhead derived from budgeted targets.** Dan is keeping his manual override. Doing it properly needs a per-category "counts as overhead" flag, because his groups cannot express it — Savings holds Tax Prep (a real future payment) beside Taxes (which the forecast already models) and Retained Earnings (not a cost). The spec records this.
- **A one-off planned purchase with a date.** Only if he asks.
- **Hardening the reconciled lock in Postgres.** Unrelated, and already recorded in `docs/BACKLOG.md`.
