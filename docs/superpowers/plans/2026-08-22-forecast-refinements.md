# Forecast Refinements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** Four changes Dan asked for after using the forecast: drop learned pay lags (everyone Net 30), assume two travel legs on out-of-state shows, mark PM shows and forecast 4 PM hours each, and show expected pay per show on the forecast screen.

**Architecture:** Migration 0035 (two additive columns). `lib/forecast.ts` loses its pay-lag learner and gains travel/PM projection plus a per-show breakdown in its output. The show form and Settings gain one field each; the forecast page swaps its pay-lag section for a booked-shows list.

## Context — why each change

1. **Learned pay lags removed.** Dan: *"The billing lags are usually because I am not home when the check comes."* The lag the model was learning is an artifact of his mail, not the client's behavior — so learning it teaches the forecast the wrong thing. Everyone gets Net 30. This deletes `payLagFor`, the 365-day window, and the Journey-anomaly machinery built for it (all of it correct, all of it now moot).
2. **Out-of-state shows get two travel legs.** Dan: *"Each show that is not chicago has a travel day at that companies travel rate both at the beginning and the end."* Rule chosen with Dan: **same state as home = local**, so Chicago and South Barrington (Willow Creek, a drive) stay local while Orlando/Denver/San Diego/Park City each earn two legs at that show's own `travel_rate_cents`. Blank location → local (never invent travel we can't justify).
3. **PM role per show.** Dan: *"We need to find a way to mark my role as PM on a per show basis. We can forecast 4 hours of PM work per show when I am PM."* New `shows.pm_role` flag; when set, the projection adds **4 hours × that show's `pm_rate_cents`** (per show, not per day). Actual PM work still bills from `pm_entries` as it always has — this only affects the forecast.
4. **Expected pay per show on the forecast screen.** Dan wants to see the shows behind the number.

## Global Constraints

- Pure logic stays in `lib/forecast.ts` (no `@/`, no JSX, relative `.ts` imports, tested under `npm test`); `today` and `homeState` are parameters — no clock reads, no ambient config.
- Migration ADDITIVE ONLY: `scripts/sql/migrations/0035_pm_role_home_state.sql`. **SHIP ORDER: prod FIRST, then merge.**
- Money integer cents; UTC-pinned dates; owner-scoped reads; the forecast still **writes nothing** and never reaches a client-facing surface.
- Estimates, never advice. Nothing implies tax guidance.
- **The travel assumption must not double-count**: a show that already carries `travel_in`/`travel_out` flags uses those; the out-of-state assumption applies only when the show has no flagged legs. (No show uses flags today — verified on prod — but the guard is the point.)
- UI copy minimal; house idioms throughout.

## Model tiering
Task 1 cheapest · Tasks 2–4 mid · final review top model (money math Dan acts on).

---

## Task 1: Migration 0035

**Files:** Create `scripts/sql/migrations/0035_pm_role_home_state.sql`

```sql
-- 0035 — two facts the forecast needs and could not infer.
--
-- pm_role: whether Dan is the production manager on this show. Actual PM work
-- has always billed from pm_entries; this flag is what lets a show that has
-- not happened yet project the PM hours it will almost certainly carry.
alter table shows add column pm_role boolean not null default false;

comment on column shows.pm_role is
  'Dan is PM on this show. Forecast-only: projects a fixed block of PM hours. Actual PM billing still comes from pm_entries.';

-- home_state: the forecast assumes a show outside Dan''s home state costs two
-- travel legs (out and back) at that show''s own travel rate. Same-state shows
-- are drives — Chicago and South Barrington both being IL is exactly the case
-- a city-name test got wrong.
alter table settings add column home_state text not null default 'IL';

comment on column settings.home_state is
  'Two-letter state Dan travels from. A show whose location names a different state projects two travel legs.';
```

- [ ] Write · `npm run db:migrate` (DEV) · verify both columns via a `db:sql` information_schema check (delete the check file) · commit `0035: pm_role and home_state`. **Prod at ship, FIRST.**

---

## Task 2: `lib/forecast.ts` — remove learning, add travel + PM + per-show output (TDD)

**Files:** Modify `lib/forecast.ts`, `scripts/test/forecast.test.ts`

**Interface changes (exact):**

```ts
// REMOVED entirely: PayLag, payLagFor, Forecast.payLags.
// Pay lag is now simply the client's terms_days.

export const PM_FORECAST_HOURS = 4

export type ForecastShow = {
  id: string; name: string; client_id: string; status: 'open' | 'billed'
  day_rate_cents: number; travel_rate_cents: number
  pm_rate_cents: number          // NEW
  pm_role: boolean               // NEW
  location: string | null        // NEW — free text, "City, ST"
  days: ForecastShowDay[]
}

/** NEW — the per-show breakdown the forecast screen lists. */
export type ShowProjection = {
  showId: string; name: string
  firstDay: string; lastDay: string
  dayCents: number               // full + half days
  travelCents: number
  pmCents: number
  totalCents: number
  travelAssumed: boolean         // true when legs came from the out-of-state rule
  landsMonth: string             // YYYY-MM the cash is expected
}

export type Forecast = {
  months: ForecastMonth[]
  coveredThrough: string | null
  beyondHorizon: boolean
  bookedThrough: string | null
  inflows: ExpectedInflow[]
  notProjected: { showId: string; name: string; reason: 'no days' | 'no rate' }[]
  showProjections: ShowProjection[]   // NEW, ordered by firstDay then name
}

/** Two-letter state parsed from a free-text location ("Orlando, FL" -> "FL").
 *  Null when the text has no recognizable trailing state. */
export function stateOf(location: string | null): string | null

export function projectedShowCents(show: ForecastShow, homeState: string): number

export function buildForecast(input: {
  today: string
  startingBalanceCents: number
  homeState: string              // NEW
  shows: ForecastShow[]
  invoices: ForecastInvoice[]
  clients: ForecastClient[]
  assumptions: ForecastAssumptions
}): Forecast
```

**Pinned rules:**
- `stateOf`: take the text after the last comma, trim, uppercase; return it only when it matches `/^[A-Z]{2}$/`, else null. `"Orlando, FL"` → `FL`; `"Chicago, IL"` → `IL`; `"South Barrington, IL"` → `IL`; `""`/null/`"Somewhere"` → null.
- Travel legs: `flagged = count(travel_in) + count(travel_out)` across days. If `flagged > 0` use it and set `travelAssumed: false`. Else if `stateOf(location)` is non-null AND differs from `homeState` → 2 legs, `travelAssumed: true`. Else 0 legs. (Superseded by 0cf9fcb: multi-day shows only — a one-day show never picks up the assumption. Historical plan left otherwise unedited.)
- PM: `show.pm_role ? PM_FORECAST_HOURS * pm_rate_cents : 0`. Per show, not per day. A show with `pm_role` but `pm_rate_cents === 0` contributes 0 (and is NOT a "no rate" exclusion — its day rate may still be fine).
- `projectedShowCents` = dayCents + travelCents + pmCents, where dayCents is the existing full/half arithmetic.
- Pay lag everywhere = the client's `terms_days` (fallback 30 when the client is missing).
- `showProjections` covers only shows the forecast actually counted (open, with days, non-zero total or not — a zero-total show with days still lists, so nothing is invisible); `landsMonth` is the month its inflow was bucketed into.
- Everything else (month walk, pro-rated first month, overdue handling, notProjected, bookedThrough from work dates) is UNCHANGED.

**Required tests:** `stateOf` on each shape above; out-of-state show gets 2 legs at its own travel rate; same-state show gets none; blank location gets none; a show with flagged travel legs uses the flags and does NOT also assume (the double-count guard); PM adds exactly 4 × pm_rate once regardless of day count; `pm_role` false adds nothing; `pm_role` with a $0 PM rate adds nothing and is not excluded; a full example — 5-day out-of-state PM show — matching hand arithmetic; every client uses terms_days now (no learning path remains); `showProjections` ordering and `landsMonth`; the existing suite still passes with `payLagFor` gone.

- [ ] TDD red → implement → green · cold tsc · commit `feat: forecast — Net 30 for all, assumed travel legs, PM hours, per-show breakdown`.

---

## Task 3: PM flag on shows + home state in Settings

**Files:** Modify `app/shows/actions.ts` (`createShow`, `updateShow`), `components/NewShowForm.tsx`, `components/ShowSettings.tsx`, `app/settings/actions.ts`, `components/SettingsEditor.tsx`, `app/settings/page.tsx`, and the show page's select list.

- `createShow`/`updateShow` accept `pmRole: boolean`; persist to `shows.pm_role`. Follow each function's existing validation/guard shape exactly (including `updateShow`'s billed-lock behavior — a billed show's PM flag is forecast-only and no longer affects anything, so it may still be edited; match whatever the neighboring fields do and say why in a comment).
- `NewShowForm` and `ShowSettings` get a PM checkbox near the PM rate field, labeled `I'm PM on this show`, with a one-line note that it forecasts 4 hours. Use the house checkbox idiom (find an existing checkbox in these forms — e.g. the travel/half-day checkboxes on the show page — and match it).
- `app/shows/[id]/page.tsx` (and any other page selecting show columns for `ShowSettings`) adds `pm_role` to its explicit select list.
- Settings: `home_state` text field in the Forecast section, 2 letters, uppercased on save, validated `/^[A-Z]{2}$/`; add to the explicit select list. Label `Home state`, note `Shows outside it forecast two travel days.`
- [ ] Gates · commit `feat: mark PM shows; home state setting`.

---

## Task 4: Forecast page — Net 30 note, booked-shows list

**Files:** Modify `app/money/forecast/page.tsx`, `components/ForecastTable.tsx` (only if needed)

- Fetch `pm_role`, `pm_rate_cents`, `location` on shows; `home_state` on settings; pass `homeState` into `buildForecast`.
- **Remove** the "Pay lag by client" assumptions section entirely.
- Assumptions gains a plain `Payment terms — Net 30 (each client's terms)` row and a `Travel — two legs assumed outside <home state>` row; the PM assumption is stated in the booked-shows list rather than as its own row.
- **New "Booked shows" section** below the month table: one row per `ShowProjection` — show name (linking to `/shows/{id}`), its date span, the month its cash lands, and its total. Money `tabular`, right-aligned. Under the name, a muted breakdown line naming only the parts that are non-zero: `5 days · 2 travel · 4h PM`. A row whose travel was assumed rather than flagged gets a quiet marker so Dan can tell the difference. Section total at the bottom.
- Keep the `notProjected` list.
- [ ] Gates · commit `feat: forecast shows expected pay per show`.

---

## Task 5: Docs, review, walkthrough, ship

- [ ] **Docs:** update the design spec with a dated postscript recording all four changes and WHY the pay-lag learner was removed (Dan's mail, not client behavior — so the whole 365-day-window rationale is superseded); CLAUDE.md's forecast entry rewritten to match; BACKLOG note that per-client pay-lag learning was built and deliberately removed, so nobody rebuilds it.
- [ ] **Final review** (top model, whole-branch): lens = Global Constraints; especially the travel double-count guard, `stateOf` parsing edge cases, PM once-per-show, that removing the learner left no dead code or stale docs, and that per-show totals reconcile exactly with the month table's income.
- [ ] **Walkthrough** (browser, sandbox): PM checkbox saves and persists; home state saves; an out-of-state sandbox show shows two travel legs and the assumed marker; booked-shows totals sum to the table.
- [ ] **Ship:** `npm run db:migrate -- --prod` (0035) FIRST → merge → push → prod smoke → then read Dan the refreshed BMS example and his new runway.

## Verification
Task 5's walkthrough + prod smoke. Automated: `npm test`, cold `npx tsc --noEmit`, `npm run build` green before every commit.
