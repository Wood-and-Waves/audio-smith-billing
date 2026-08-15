# Rate Cards Hold Every Rule — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A rate card holds the complete rate agreement — every rate and every rule a show freezes — so creating a show from a card produces a correctly configured show with nothing left to set by hand.

**Architecture:** `client_rate_cards` grows to mirror the frozen columns on `shows`. `travel_full_day` is replaced by an explicit `travel_rate_cents`, and `pm_rate_cents` becomes explicit too; the old derivations survive as *pre-fill* when editing a card, not as logic at show-creation. `createShow` copies rather than derives.

**Tech Stack:** Next.js 16 App Router, Supabase Postgres + RLS, `node --test` with native type stripping.

## Why

Dan: *"The rate card should hold all of the rate rules."* He is right, and it is the same argument that created cards. Today a card holds a day rate, an overtime threshold and a full/half travel switch — everything else takes the SQL default on the `shows` row and is edited per show, every time. So a client who pays meal penalties and one who does not are indistinguishable on their cards.

His three Streamline arrangements are already set up and prove the point: the default at $780/OT-after-10, `PwC A1` at $780/**OT-after-12**, and `PwC PM` at $900/OT-after-12. The first two differ *only* by a rule.

**Travel and PM become explicit numbers.** A full/half switch cannot express a flat arrangement — $200 a leg regardless of the day rate — and Dan chose the explicit form. The derivations remain, as the values a new card pre-fills with.

**Per-show editing stays exactly as it is.** The card sets the show up; "Rates and rules" still overrides it for the one-off. Nothing about the freeze changes.

## Global Constraints

- **Money is integer cents.** `parseUSD` returns `null` on junk and **`0` on empty string** — that asymmetry has already produced one Critical on this screen (a cleared day rate stored a $0 travel rate). Never guard it with a truthiness check.
- **Existing behaviour must not move.** The 13 live cards backfill so every show created from them comes out exactly as it would today. The new rule columns take the same defaults the `shows` table already uses.
- **`createShow` stays the only `shows` insert.**
- **A card's frozen values are copied, never recomputed on read.** `rate_card_name` continues to name the arrangement, not the numbers.
- **`anon` keeps ZERO privileges.** New columns inherit the existing RLS.
- Migrations additive and numbered; **0014 is the highest applied** — never edit one that has run.
- The live database holds **106 invoices / $186,790.49, 20 clients, 13 rate cards, 3 shows**.
- `lib/` imports relative with `.ts`, no JSX; `app/` uses `@/`.
- Every task ends with `npm test`, `npx tsc --noEmit`, `npm run build` clean. Baseline **177 passing**.

---

### Task 1: The card grows

**Files:** Create `scripts/sql/migrations/0015_cards_hold_the_rules.sql`

**This SQL has been validated against the live database in a rolled-back transaction.** All 13 cards backfilled with no nulls; the rollback left 13.

- [ ] **Step 1: Write the migration**

```sql
-- 0015 — a rate card holds the whole rate agreement
--
-- Dan: "The rate card should hold all of the rate rules." A card held a day
-- rate, an overtime threshold and a full/half travel switch; everything else
-- took the shows-table default and was set by hand on every show. So a client
-- who pays meal penalties and one who does not looked identical on their cards.
--
-- His three Streamline arrangements make the case: the default at $780 with
-- overtime after 10 hours, "PwC A1" at $780 with overtime after 12, and
-- "PwC PM" at $900 after 12. The first two differ ONLY by a rule.
alter table client_rate_cards
  add column travel_rate_cents          bigint,
  add column pm_rate_cents              bigint,
  -- null = no double time, matching shows.dt_after_hours
  add column dt_after_hours             numeric(4,1),
  add column minimum_meal_break_minutes int          not null default 60,
  add column meal_break_deduction_cap   int          not null default 60,
  add column meal_penalty_grace_hours   numeric(4,1) not null default 6,
  add column meal_penalty_cents         bigint       not null default 0,
  add column short_turn_rest_hours      numeric(4,1) not null default 10,
  add column continuous_time_enabled    boolean      not null default false;

-- The defaults above are exactly the shows-table defaults, so a show created
-- from an existing card comes out identical to one created yesterday.

-- Backfill the two that used to be derived at show-creation time.
update client_rate_cards
   set travel_rate_cents = case when travel_full_day then day_rate_cents
                                else round(day_rate_cents / 2.0) end,
       pm_rate_cents     = case when ot_after_hours > 0
                                then round(day_rate_cents / ot_after_hours) else 0 end;

alter table client_rate_cards
  alter column travel_rate_cents set not null,
  alter column pm_rate_cents     set not null,
  add constraint card_travel_nonneg check (travel_rate_cents >= 0),
  add constraint card_pm_nonneg     check (pm_rate_cents >= 0);

```

**The drop is NOT in this migration.** It was, and it broke the live app: the
plan claimed `travel_full_day` was referenced in two files when it is in
**eight**, and this repo has no generated database types, so nothing failed at
compile time — `/clients`, `/clients/new`, `/clients/[id]` and `/shows/new`
simply started erroring at request time against a column that no longer existed.
Migration 0016 restored it.

A schema change that removes something the running code still reads has to ship
**after** that code, never with it. The drop is now the last step of this plan,
after Tasks 2 and 3 are deployed.

- [ ] **Step 2: Apply and verify**

```bash
npm run db:migrate
```

Then, with the anon check:

```sql
set local role anon;
select current_user as who,
       has_column_privilege('public.client_rate_cards','travel_rate_cents','select') as can_read;
reset role;
select count(*) as cards,
       count(*) filter (where travel_rate_cents is null or pm_rate_cents is null) as nulls,
       (select count(*) from invoices) as invoices,
       (select sum(total_cents) from invoices) as cents,
       (select count(*) from shows) as shows
  from client_rate_cards;
```

Expected: `who = anon`, `can_read = false`; **13 cards, 0 nulls**, 106 invoices, 18679049 cents, 3 shows. Anything else is a STOP.

- [ ] **Step 3: Commit**

```bash
npm test && npx tsc --noEmit && npm run build 2>&1 | grep -E "Compiled|Failed"
git add scripts/sql/migrations/0015_cards_hold_the_rules.sql
git commit -m "Let a rate card hold every rate and rule a show freezes."
```

---

### Task 2: Copy the card instead of deriving from it

**Files:** Modify `app/shows/actions.ts` (`createShow`), `lib/rateCards.ts`, `components/NewShowForm.tsx`, `app/shows/new/page.tsx`

- [ ] **Step 1: `createShow` copies**

It currently derives `travel_rate_cents` and `pm_rate_cents` from the day rate and reads `card.travel_full_day`, which **no longer exists** — `tsc` will point at every line. Replace the derivation with a straight copy of all eleven values:

`day_rate_cents`, `travel_rate_cents`, `pm_rate_cents`, `ot_after_hours`, `dt_after_hours`, `minimum_meal_break_minutes`, `meal_break_deduction_cap`, `meal_penalty_grace_hours`, `meal_penalty_cents`, `short_turn_rest_hours`, `continuous_time_enabled` — plus `rate_card_name`.

The four rate **overrides** on the New Show form keep working exactly as they do, applied on top of the copied values. The rules are not overridable at creation; they are edited afterwards in "Rates and rules", which is unchanged.

- [ ] **Step 2: `deriveFromDayRate` changes job, and keeps its guard**

It stops being show-creation logic and becomes the **pre-fill** used when editing a card and when overriding a rate on New Show. Keep `isDerivableDayRate` and keep both callers pointed at one implementation — the guard exists because `parseUSD('')` returns `0`, and dropping it re-creates a Critical that stored `Travel Rate ×2 @ $0.00` on a real invoice.

Its signature loses `travelFullDay`: pre-fill travel at half the day rate and let the user type the rest.

- [ ] **Step 3: Verify**

```bash
npm test 2>&1 | grep -E "^ℹ (pass|fail)" && npx tsc --noEmit && npm run build 2>&1 | grep -E "Compiled|Failed"
npm run db:sql -- /dev/stdin <<'EOF'
select count(*) as shows from shows;
EOF
```

Expected: 177 passing, and **3 shows** — `createShow` must not have run.

---

### Task 3: Edit the whole card

**Files:** Modify `components/ClientEditor.tsx`, `app/clients/actions.ts`, `app/clients/[id]/page.tsx`

- [ ] **Step 1: The fields**

Each card — the unnamed default and every named one — gains the full set. Follow the vocabulary and grouping `components/ShowSettings.tsx` already uses for the same values, so the two screens teach each other: **Rates** (day, travel, PM, OT after, DT after) then **Rules** (minimum meal break, deduction cap, meal penalty grace, meal penalty, short-turn rest, continuous time).

The travel checkbox is **gone** — it is a number now. When the day rate changes and travel or PM have not been typed in, re-derive them, using the same `deriveFromDayRate` and the same dirty-tracking the New Show form uses. Do not write a second implementation of that behaviour.

**Say what the numbers mean** where it is not obvious, as `ShowSettings` does: leaving DT-after blank means no double time, and a meal penalty of zero disables meal penalties.

- [ ] **Step 2: Save them**

`saveClient` writes the full set. Keep every existing guard: one unnamed default, no duplicate names, a default required when any card exists, and the card update scoped by `client_id`.

**Reject a zero or negative day rate**, as now. A zero travel or PM rate is legitimate — a client who does not pay travel at all — so those may be zero but not negative.

- [ ] **Step 3: Verify and commit**

```bash
npm test 2>&1 | grep -E "^ℹ (pass|fail)" && npx tsc --noEmit && npm run build 2>&1 | grep -E "Compiled|Failed"
npm run db:sql -- /dev/stdin <<'EOF'
select count(*) as cards, count(*) filter (where meal_penalty_cents > 0) as with_penalty
  from client_rate_cards;
EOF
```

Expected: **13 cards** — the editor must not have written anything.

---

## Verification

- `npm test` — 177 passing; `tsc` clean; build compiles.
- 13 cards, 0 null rates, 106 invoices / $186,790.49, 3 shows, all unchanged.
- `anon` holds no privilege on the new columns.

## Manual verification

1. Open Streamline. All three cards show the full rate and rule set.
2. Put a meal penalty on `PwC PM` and leave the default at zero.
3. Create a show from `PwC PM` and open Rates and rules — the penalty is there, without being typed.
4. Create one from the default — no penalty.
5. Change a card's day rate and watch travel and PM follow; type a travel rate and watch it stop following.

---

### Task 4: Drop the column — ONLY after Tasks 2 and 3 are deployed

**Files:** Create `scripts/sql/migrations/0017_drop_travel_full_day.sql`

Do not start this task until the code from Tasks 2 and 3 is **pushed and live**.
Nothing running may still select `travel_full_day`.

- [ ] **Step 1: Prove nothing reads it**

```bash
grep -rn "travel_full_day" app components lib scripts --include=*.ts --include=*.tsx | grep -v migrations
```

Expected: **no output**. Any hit is a STOP — that file would break the moment
the column goes, exactly as before.

- [ ] **Step 2: Drop it**

```sql
-- 0017 — travel_full_day, finally
--
-- 0015 tried to drop this alongside the travel_rate_cents that replaced it, and
-- took four pages of the live app down until 0016 put it back: eight files were
-- still selecting it, and with no generated database types nothing caught that
-- at compile time. Every one of those files has since stopped reading it.
alter table client_rate_cards drop column travel_full_day;
```

## Blast radius

Nine columns added to one table, one dropped that shipped today and is used in exactly two files. Every existing card backfills to the values it already produced, so a show created from one is identical to a show created yesterday. No invoice, no PDF, no billing arithmetic is touched.
