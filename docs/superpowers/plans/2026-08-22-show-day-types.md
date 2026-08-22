# Show Day Types Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** Let Dan mark a travel day as also worked, so the forecast stops guessing whether a future travel day earns a day rate.

**Architecture:** One additive column (`show_days.travel_works`), one server action and toggle component mirroring the existing travel/half-day pair, and one rule change in `lib/forecast.ts`. Invoices are untouched.

**Design doc:** `docs/superpowers/specs/2026-08-22-show-day-types-design.md` (4ad935b). Dan chose the second-checkbox shape; show creation stays untouched (he had travel options removed from it deliberately on 2026-08-21).

## Context

The forecast currently guesses: on an out-of-state multi-day show it assumes the first and last day are travel-only. Dan usually knows in advance which days are travel and whether he'll also work them — *"Sometimes we travel and work the same day which would be more money."* This replaces the guess with knowledge where he has it, keeping the guess as a fallback for unmarked shows.

Half the obvious problem is already solved and must not be "fixed": **invoices are already correct.** `computeShowLines` counts travel legs outside its `st > 0` punch gate, so an unworked travel day bills its leg alone and a worked one bills both. This wave is forecasting only.

## Global Constraints

- Migration ADDITIVE ONLY: `scripts/sql/migrations/0036_travel_works.sql`. **SHIP ORDER: prod FIRST, then merge.**
- `lib/forecast.ts` stays pure (no `@/`, no JSX, relative `.ts` imports); `today`/`homeState` remain parameters.
- **`travel_works` must never reach billing** — not `computeShowLines`, `billShows`, an invoice line, PDF, email, `/i/[token]`, or the calendar feed. The final review checks this explicitly.
- Money integer cents; half-day keeps `Math.round(rate/2)`.
- Owner-scoping: the new action walks the day's own FKs for the billed lock (never trust a caller-supplied id for the lock decision — `setTravelLeg`'s stated rule).
- Meaningful only on a day carrying `travel_in` and/or `travel_out`; ignored elsewhere and not offered in the UI.
- Clearing the last travel flag from a day clears `travel_works` too — a stale `true` would silently change the forecast if travel were re-flagged later.
- UI copy minimal; match `TravelLegToggle`/`HalfDayToggle` exactly.

## Model tiering
Task 1 cheapest · Tasks 2–3 mid · final review top model (forecast money math).

---

## Resolved before implementing

- **"travel rate × legs" in the spec is wrong prose; the shipped code is right.** `computeShowBreakdown` builds `isTravel` with `travel_in || travel_out`, so a day carrying BOTH legs counts as ONE travel day at ONE travel rate — pinned by `scripts/test/forecast.test.ts:93`. That matches Dan's own "2 travel days" framing and is the conservative read. Do not change it; Task 4 fixes the spec's wording instead. (Billing does count two legs on such a day — a pre-existing forecast/invoice divergence, conservative in the forecast's direction. Backlog it, don't fix it here.)
- **Only TWO selects need the new column** (verified by exhaustive grep): `app/shows/[id]/page.tsx:75` and `app/money/forecast/page.tsx:104`. Every other `show_days` select is either invoice-side (must NOT get it), calendar (out of scope), or a lock-walk.

## Reuse (do not reinvent)

- `setDayHalfDay` (`app/shows/actions.ts:955-981`) is the exact template for the new action — same auth → FK-walk-for-lock → error strings → update → `revalidatePath(\`/shows/${show_id}\`)`. Note: these actions do NOT add `.eq('owner_id', …)`; RLS enforces it and `user` is only checked for presence. Match that; do not "improve" it.
- `components/HalfDayToggle.tsx` is the exact template for the new toggle (no `leg` prop variant).
- Show page day row: the toggles live in `<div className="flex flex-wrap items-center gap-x-4 gap-y-2">`, with the two `TravelLegToggle`s grouped in `<span className="flex flex-wrap items-center gap-3">` (`app/shows/[id]/page.tsx:299-338`). Conditional-render idiom: bare `{cond && (<Toggle …/>)}` with the reasoning in a JS comment inside the braces.

---

## Task 1: Migration 0036

**Files:** Create `scripts/sql/migrations/0036_travel_works.sql`

Follow `0025_expense_billable.sql`'s formatting exactly: `-- NNNN — title` em-dash header, a prose paragraph explaining WHY (forecast-only; invoices already bill travel legs outside the punch gate, so this changes no billing), the `alter table`, then `comment on column` (escape apostrophes as `''`).

```sql
alter table show_days add column travel_works boolean not null default false;
```

The comment should say: forecast-only — marks a travel day Dan also expects to work, so the projection adds a day rate on top of the travel rate. Never read by `computeShowLines` or any invoice path. Default false keeps every existing projection identical.

- [ ] Write · `npm run db:migrate` (DEV) · verify the column via a `db:sql` information_schema check (delete the check file) · commit `0036: travel_works`. **Prod at ship, FIRST.**

---

## Task 2: The forecast rule (TDD)

**Files:** Modify `lib/forecast.ts`, `scripts/test/forecast.test.ts`

- `ForecastShowDay` (`lib/forecast.ts:59-64`) gains `travel_works: boolean`.
- **The one behavioural line** is `lib/forecast.ts:296`:
  ```ts
  if (isTravel[i]) { travelDays += 1; continue } // a travel day is never also a work day
  ```
  becomes: count the travel day, then fall through to the work-day tally **only when** `show.days[i].travel_works` is true **and** `travelAssumed` is false. An assumed travel day is never worked — nothing was marked, so nothing is known. A worked travel day respects `pay_as_half_day` (half rate); an unworked one ignores it (the existing pinned behaviour).
- Correct every comment the change falsifies: `lib/forecast.ts:150-151` (the `ShowProjection` partition claim), `:214` (`dayCount` doc), `:31-46` (module header's "EITHER a travel day or a work day, never both"), `:220-244` (`computeShowBreakdown` doc, incl. the now-answerable 2-day case).
- **Test fixture:** `day()` (`scripts/test/forecast.test.ts:19-21`) gains `travel_works: false` — one line keeps all ~50 existing call sites compiling and behaviourally unchanged.
- **The partition invariant** is a section comment (`scripts/test/forecast.test.ts:126-130`) plus the same assertion in six tests (`:145, :159, :173, :255, :886, :978`). All six still pass unchanged (their fixtures never set the flag). Correct the section comment to state the new relationship, and ADD a test asserting `dayCount + travelDays === days.length + workedTravelDays` — it is the guard that catches a day counted in neither.
- **New tests:** travel day + `travel_works` adds a day rate on top of its travel rate; without it, unchanged; travel + works + half day gives travel rate + half rate; a both-legs day + `travel_works` gives ONE travel rate + ONE day rate; `travel_works` on a day with no travel flags is ignored entirely; an ASSUMED travel day is never worked even if `travel_works` is somehow true (defensive); a marked show still suppresses the assumption.
- [ ] TDD red → implement → green · cold tsc · commit `feat: a travel day can also be a work day`.

---

## Task 3: Action, toggle, and the two selects

**Files:** Modify `app/shows/actions.ts`; create `components/TravelWorksToggle.tsx`; modify `app/shows/[id]/page.tsx`, `app/money/forecast/page.tsx`

- **New action** `setDayTravelWorks(showDayId: string, value: boolean): Promise<Fail | { ok: true }>` — a copy of `setDayHalfDay` with `{ travel_works: value }`. Place it beside `setDayHalfDay`.
- **`setTravelLeg` gains clear-on-untravel** (`app/shows/actions.ts:368-397`): its select (`:383`) widens to `show_id, travel_in, travel_out, shows(status)`; when `value === false` and the OTHER leg is already false, the same update also writes `travel_works: false`. Comment why: a stale true would sit invisible and silently change the forecast if travel were re-flagged later.
- **`components/TravelWorksToggle.tsx`** — `HalfDayToggle` shape exactly, label `Also working`, calling `setDayTravelWorks`. Header comment: forecast-only; a travel day Dan also works bills both in reality, and this is how the projection learns it before punches exist.
- **Show page** (`app/shows/[id]/page.tsx`): add `travel_works` to the `show_days(...)` select (`:75`) and to `type Day` (`:29-33`); render `<TravelWorksToggle …/>` inside the travel `<span>` (`:317-320`), gated `{(d.travel_in || d.travel_out) && ( … )}` with the reasoning in a JS comment.
- **Forecast page** (`app/money/forecast/page.tsx`): add `travel_works` to the `show_days(...)` select (`:104`), to `RawShowRow.show_days` (`:87`), and to the day mapper (`:425`). Correct the stale `BookedShowRow` doc comment (`:249-251`) about the partition; its render logic needs no change (it gates on count AND cents independently).
- **Do NOT touch**: `app/shows/page.tsx`, `app/shows/actions.ts:600` (`billShows`), `app/calendar/page.tsx`, or any `lib/` invoice-side type. Show creation stays untouched.
- [ ] Gates (`npm test`, cold tsc, `npm run build`) · commit `feat: mark a travel day as also worked`.

---

## Task 4: Docs, review, walkthrough, ship

- [ ] **Docs:** correct `CLAUDE.md:151-152` ("EITHER a travel day or a work day, never both") to the new rule; fix the design spec's "travel rate × legs" prose to "one travel rate per travel day, even when both legs are flagged", and postscript that the shipped code was already right; BACKLOG: note the forecast/invoice divergence on a both-legs day (forecast prices one travel day, `computeShowLines` bills two legs — conservative in the forecast's direction, pre-existing, not fixed here).
- [ ] **Final review** (top model, whole-branch): lens = Global Constraints; especially that `travel_works` reaches NO billing path, the assumed-travel-day guard, the clear-on-untravel behaviour, that the six existing partition assertions still hold, and integer-cents arithmetic.
- [ ] **Walkthrough** (browser, sandbox): flag a day travelled-in → the "Also working" checkbox appears; tick it → forecast's per-show total rises by exactly one day rate and the breakdown shows the day in both counts; untick travel → the checkbox disappears AND the flag clears (re-flag to confirm it's off); a billed show refuses the toggle.
- [ ] **Ship:** `npm run db:migrate -- --prod` (0036) FIRST → merge → push → prod smoke → then tell Dan which of his six PM/travel shows change.

## Verification

Task 4's walkthrough + prod smoke. Automated: `npm test` (new forecast cases), cold `npx tsc --noEmit`, `npm run build` green before every commit.
