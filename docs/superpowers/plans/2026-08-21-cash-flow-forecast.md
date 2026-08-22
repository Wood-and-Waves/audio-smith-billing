# Cash-Flow Forecast Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** `/money/forecast` — a headline runway sentence ("Covered through March 2027") over a month-by-month table, from booked work only, with editable assumptions.

**Architecture:** Migration 0034 (three additive settings columns). One pure lib `lib/forecast.ts` holding all the math (show projection, learned pay lags, the month walk). A server page that loads, calls the lib, and renders; assumptions edited through the existing settings action plus a small forecast-settings action.

**Design doc:** `docs/superpowers/specs/2026-08-21-cash-flow-forecast-design.md` (1858d86, plus the projection correction). Dan's four decisions: booked-only-but-labeled; trailing-3-month overhead, overridable; taxes at the existing 15% rate on projected profit; headline + month table.

## Global Constraints

- Pure logic in `lib/forecast.ts`: no `@/` imports, no JSX, relative `.ts` imports, tested in `scripts/test/forecast.test.ts`. **No clock reads inside the lib** — `today` is a parameter, as `lib/status.ts` and `lib/zonedTime.ts` both insist.
- Money is integer cents throughout; `parseUSD('')` returns 0, so every new settings input guards on `trim()` first.
- Migration ADDITIVE ONLY: `scripts/sql/migrations/0034_forecast_settings.sql`. **SHIP ORDER: prod migration FIRST, then merge.**
- All date math UTC-pinned (`lib/dates.ts` doctrine).
- Owner-scoped reads; page is Dan-only (not a public prefix). Reads that could exceed 1000 rows page with `.range()`.
- **The forecast writes nothing** — no ledger rows, no envelope moves, no invoice changes. It is derived on every render.
- **Never reaches a client-facing surface**: not in invoices, PDFs, emails, `/i/[token]`, or the calendar feed.
- **Estimates, never advice.** The tax set-aside is Dan's own configured rate; no wording anywhere implies tax guidance.
- UI copy minimal; house idioms (eyebrow headers, FIELD_FULL, list-row border, `tabular` for money, useTransition + router.refresh + `{error}`).

## Model tiering

Task 1 cheapest · Task 2 mid (the math — the wave's real content) · Tasks 3–4 mid · final review top model (money math Dan will make decisions from).

---

## Task 1: Migration 0034 — forecast settings

**Files:** Create `scripts/sql/migrations/0034_forecast_settings.sql`

```sql
-- 0034 — the three numbers the cash-flow forecast needs from Dan.
--
-- tax_setaside_bp (0026) already carries the set-aside rate; these join it.
-- All nullable-or-defaulted and additive: every existing read keeps working.
alter table settings
  -- What Dan needs to draw each month. 0 = not set yet; the forecast asks
  -- for it rather than guessing.
  add column monthly_take_home_cents bigint not null default 0,
  -- An override for computed overhead. NULL = use the trailing 3-month
  -- average, which is the intended default; a number wins over the average.
  add column monthly_overhead_cents bigint,
  -- Days from a show's last day to the invoice going out.
  add column billing_lag_days int not null default 7;

comment on column settings.monthly_take_home_cents is
  'Dan''s monthly take-home need, integer cents. 0 = unset (forecast prompts).';
comment on column settings.monthly_overhead_cents is
  'Override for projected monthly overhead, integer cents. NULL = use the trailing 3-month average.';
comment on column settings.billing_lag_days is
  'Assumed days from last show day to invoice sent, for projecting when money lands.';
```

- [ ] Write file · `npm run db:migrate` (DEV) · verify columns via `npm run db:sql` information_schema check (delete the check file) · commit `0034: forecast settings`. **Prod applied at ship (Task 5), FIRST.**

---

## Task 2: `lib/forecast.ts` — all the math (TDD)

**Files:** Create `lib/forecast.ts`, `scripts/test/forecast.test.ts`

**Exact interfaces (Tasks 3–4 consume verbatim):**

```ts
// ---- inputs (DB-shaped, snake_case where they come from rows) ----
export type ForecastShowDay = { date: string; travel_in: boolean; travel_out: boolean; pay_as_half_day: boolean }
export type ForecastShow = {
  id: string; name: string; client_id: string; status: 'open' | 'billed'
  day_rate_cents: number; travel_rate_cents: number
  days: ForecastShowDay[]
}
export type ForecastInvoice = {
  id: string; number: number; client_id: string
  status: 'draft' | 'sent' | 'paid' | 'void'
  total_cents: number
  sent_at: string | null        // ISO; null on drafts
  paid_at: string | null        // YYYY-MM-DD
  linked: boolean               // has a ledger_transaction_invoices row
}
export type ForecastClient = { id: string; name: string; terms_days: number }
export type ForecastAssumptions = {
  takeHomeCents: number
  overheadCents: number          // resolved: override ?? computed
  taxRateBp: number
  billingLagDays: number
}

// ---- outputs ----
export type PayLag = { clientId: string; days: number; source: 'learned' | 'terms'; sampleSize: number }
export type ExpectedInflow = {
  month: string                  // YYYY-MM
  amountCents: number
  label: string                  // "#391 Clinique" | "Willow Creek (projected)"
  overdue: boolean               // expected date already passed
}
export type ForecastMonth = {
  month: string                  // YYYY-MM
  incomeCents: number
  overheadCents: number
  taxCents: number
  drawCents: number
  endingBalanceCents: number
  covered: boolean               // endingBalance >= 0
}
export type Forecast = {
  months: ForecastMonth[]
  coveredThrough: string | null   // YYYY-MM; null = not even this month
  beyondHorizon: boolean          // never went negative within 24 months
  bookedThrough: string | null    // last month carrying booked work
  inflows: ExpectedInflow[]       // for the table's detail + overdue flags
  payLags: PayLag[]
}

export const HORIZON_MONTHS = 24

/** Every scheduled day is a work day (migration 0005); travel flags add legs. */
export function projectedShowCents(show: ForecastShow): number

/** Median lag, learned ONLY from linked invoices sent within 365 days of `today`,
 *  minimum 2 samples; otherwise the client's terms_days. */
export function payLagFor(clientId: string, invoices: ForecastInvoice[], clients: ForecastClient[], today: string): PayLag

/** Trailing 3 COMPLETE calendar months of spend, excluding owner_pay and transfer. */
export function computeOverheadCents(txns: { date: string; amount_cents: number; kind: string }[], today: string): number

export function buildForecast(input: {
  today: string                  // YYYY-MM-DD
  startingBalanceCents: number   // available-to-allocate
  shows: ForecastShow[]
  invoices: ForecastInvoice[]
  clients: ForecastClient[]
  assumptions: ForecastAssumptions
}): Forecast
```

**Pinned rules:**
- `projectedShowCents`: `fullDays × day_rate + halfDays × round(day_rate/2) + legs × travel_rate`, where a day is half iff `pay_as_half_day`, and legs = count of `travel_in` + `travel_out` across all days. Zero rates → 0, no crash.
- Inflows: `sent` invoice → `sent_at` date + payLag; `draft` invoice → today + billingLag + payLag; `paid`/`void` excluded. Unbilled (`status: 'open'`) shows → last day + billingLag + payLag; billed shows excluded (their invoice covers them). An expected date `< today` lands in today's month with `overdue: true`.
- `payLagFor`: median over `paid_at − sent_at` for invoices of that client where `linked === true`, `sent_at` within 365 days of `today`, both dates present; needs ≥2 → `source: 'learned'`; else `terms_days` → `source: 'terms'`.
- Month walk exactly as the spec: `taxes = max(0, income − overhead) × taxRateBp / 10000`, `balance += income − overhead − taxes − draw`, first month with `balance < 0` is uncovered; `coveredThrough` = the month before it (null if the current month is already uncovered); stop at `HORIZON_MONTHS` with `beyondHorizon: true`.
- `bookedThrough` = the latest month containing a projected show inflow or an unpaid invoice inflow; null when there is none.
- Deterministic ordering: months ascending; inflows by month then label.

**Required tests (minimum):** plain 2-day show; half day; travel legs added on top; zero rates → 0; hourly show bills the same as day-rate (day_rate/threshold identity); pay lag learned from 3 linked invoices; ancient settlement outside 365 days excluded (the Journey case — assert it falls back to terms); one sample falls back to terms; unlinked `paid_at` ignored; draft invoice counted once and its show not double-counted; overdue invoice lands in the current month flagged; past unbilled show lands in the current month flagged; surplus carries forward; first uncovered month exact; balance exactly zero counts as covered; beyond-horizon reported; overhead excludes owner_pay and transfer; overhead uses complete months only.

- [ ] TDD: failing tests → red → implement → green · cold tsc · commit `feat: forecast math — show projection, learned pay lags, month walk`.

---

## Task 3: Settings — the three new fields

**Files:** Modify `app/settings/actions.ts`, `components/SettingsEditor.tsx`, `app/settings/page.tsx`

- Extend `SettingsInput` + the update patch with `monthly_take_home_cents`, `monthly_overhead_cents` (nullable), `billing_lag_days`; validate: take-home ≥ 0 integer; overhead null or ≥ 0 integer; lag integer 0–120. Follow the existing `tax_setaside_bp` validation shape exactly.
- Editor: three fields in a "Forecast" section, dollars↔cents converted the way `taxSetasidePct` converts (blank → 0 / null). Overhead's placeholder shows the computed average when available; blank means "use the average."
- Page: add the three columns to the explicit select list (never widen to `*`).
- [ ] Gates (`npm test`, cold tsc, `npm run build`) · commit `feat: forecast settings fields`.

---

## Task 4: `/money/forecast` page

**Files:** Create `app/money/forecast/page.tsx`, `components/ForecastTable.tsx`; modify `app/money/page.tsx` (header link)

- Page (server, `force-dynamic`, `<AppShell current="money">`): load the open account; all ledger txns (paged) → `workingBalance` and `computeOverheadCents`; envelope moves (paged) → `netAllocated` → starting balance = working − allocated; open shows with their days + rates; invoices `.in('status', ['draft','sent'])` with client + `ledger_transaction_invoices(transaction_id)` for the `linked` flag; clients' `terms_days`; settings (explicit columns). Call `buildForecast`. Render.
- Headline: "Covered through <Month YYYY>" (`monthLabel` from `lib/dates.ts`); when `beyondHorizon`, "Covered beyond the next two years"; when `coveredThrough === null`, "This month is short." Second line: "Booked work runs out after <Month>." — omitted when `bookedThrough` is null.
- `ForecastTable`: one row per month — month, in, overhead, tax, draw, ending balance; money `tabular` right-aligned; the first uncovered month flagged (`text-danger` + a label); the `bookedThrough` month marked with a muted note. Overdue inflows surface as a short list above the table ("Expected now: #391 Clinique $2,400 — overdue").
- Assumptions block below: take-home, overhead (computed shown beside any override), tax rate (read-only, links to Settings), billing lag, and the per-client pay-lag list with `learned from N` / `Net 30 (terms)`.
- Empty state: no shows and no unpaid invoices → a muted line saying the forecast needs booked work; no take-home set → prompt to set it in Settings (with a link), and render the table without the draw row rather than pretending.
- `/money` header gains a `Forecast` link beside Budget/Reports (same idiom).
- [ ] Gates · commit `feat: /money/forecast — runway headline and month table`.

---

## Task 5: Docs, review, walkthrough, ship

- [ ] **Docs:** CLAUDE.md (forecast entry: derived-never-written; pay-lag 365-day window and why; overhead definition; estimates-not-advice). BACKLOG: mark the forecast item shipped, carry the deferred list (per-show profit on the show page, scenarios, assumed bookings, seasonality, envelope auto-funding).
- [ ] **Final review** (top model, whole-branch package): lens = Global Constraints; especially double-counting between invoices and shows, the 365-day window, month-boundary arithmetic, the tax formula on profit not gross, integer-cents rounding, no writes anywhere, no client-facing leakage, and that no wording reads as tax advice. ONE fix subagent.
- [ ] **Dev walkthrough** (browser, sandbox): forecast renders; headline and booked-through line correct against the sandbox shows; change take-home in Settings → runway moves; override overhead → table changes; overdue invoice appears in the expected-now list; empty-state path.
- [ ] **Ship:** `npm run db:migrate -- --prod` (0034) FIRST → merge → push → prod smoke, then read Dan his real runway number.

## Verification

Task 5's walkthrough + prod smoke. Automated: `npm test` (new forecast suite), cold `npx tsc --noEmit`, `npm run build` — green before every commit.
