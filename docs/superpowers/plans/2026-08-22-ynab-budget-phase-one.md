# YNAB Budget, Phase One — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the budget screen Dan can read — months he can walk between, with
Assigned / Activity / Available per category reproducing YNAB's own numbers
exactly — plus the ability to set a target on a category.

**Architecture:** One pure module (`lib/budget.ts`) owns all arithmetic and is
proven against synthetic fixtures; two new tables hold assignments (as immutable
moves) and targets; a one-off script imports Dan's YNAB plan export for Jan–Aug
2026; `/money/budget` renders it. **Nothing in this phase moves money** except
the one-off import — assigning and moving money between categories is phase two.

**Tech Stack:** Next.js 16 (App Router, server components), Supabase/Postgres
with RLS, TypeScript, `node --test` for tests, Tailwind v4 with the app's CSS
variable tokens.

**Design doc:** `docs/superpowers/specs/2026-08-22-ynab-budget-design.md` (5948d71).
Read its *Arithmetic* and *Reconciliation performed before designing* sections
before Task 3 — the formulas there were validated against 1,421 rows of Dan's
real export and are not open to reinterpretation.

## Global Constraints

- Migrations live at `scripts/sql/migrations/NNNN_*.sql`, are checksummed, and are
  **never edited once applied**. **ADDITIVE ONLY.** This plan adds `0038` (schema)
  and `0039` (category data).
- **The one approved exception**, and it is deliberate: 0038 drops the check
  constraint `lt_nocat_for_owner_or_transfer` and replaces it with the narrower
  `lt_nocat_for_transfer`. Dan approved this during spec review. It is a
  RELAXATION — no column dropped, no row lost, nothing that running code reads
  removed — so it does not repeat the incident behind the rule (0015 dropped a
  column live code still read). Widening what a table accepts cannot break a
  reader. Nothing else in this plan may drop anything.
- **SHIP ORDER (non-negotiable): migrate prod FIRST, then merge/push.** Code
  referencing a missing column 500s the live app.
- `lib/*.ts` are pure: **no `@/` imports, no JSX, relative `.ts` imports**, and
  **no clock reads** — the month under view is always a parameter.
- Money is **integer cents** everywhere. Never floats.
- Supabase selects silently cap at 1000 rows. **Every unbounded read must page
  with `.range()`** — see `app/money/budget/page.tsx`'s existing
  `fetchAllTransactionsForBalance` for the established pattern.
- Guard reads that gate writes must destructure `error` and return before any
  presence test, so a failed read fails CLOSED.
- Server actions check `user` for presence only; **RLS enforces ownership**. Do
  not add `.eq('owner_id', …)` — match `setDayHalfDay` in `app/shows/actions.ts`.
- The validated formulas, verbatim:
  - `available(c, m) = max(0, available(c, m-1)) + assigned(c, m) + activity(c, m)`
  - `rta(m) = rta(m-1) + income(m) - SUM_c assigned(c, m) + SUM_c min(0, available(c, m-1))`
  - `income(m)` = signed sum of every transaction in `m` that does **not** land in
    a spending category (income-role categories plus uncategorised rows, any `kind`).
  - `activity(c, m)` = **signed** sum over all transactions carrying category `c`,
    regardless of `kind`, so refunds net down without a special case.
- **Committed tests use synthetic fixtures only** — never Dan's real figures. The
  design doc and this plan do quote his real reconciliation numbers, deliberately
  and with his agreement, because the whole argument for the arithmetic rests on
  them; the constraint is about test data, not prose.
- Gates before every commit: `npm test`, cold `rm -f tsconfig.tsbuildinfo .next/cache/.tsbuildinfo && npx tsc --noEmit`, `npm run build`.

## Model tiering

Tasks 1, 2, 5 cheapest (transcription + a script). Tasks 3, 4, 6, 7, 8 mid-tier.
Task 9's final whole-branch review: top model — this is money math.

## File Structure

| File | Responsibility |
|---|---|
| `scripts/sql/migrations/0038_budget.sql` | Schema: `budget_role`, `ledger_budget_moves`, `ledger_category_targets`, relax the owner-pay constraint |
| `scripts/sql/migrations/0039_budget_categories.sql` | Data: converge the category list on YNAB's 2026 set |
| `lib/ledgerCategories.ts` | Seed chart — updated to the new list |
| `lib/ynabRegister.ts` | Export its private CSV reader; empty the now-wrong `ALIASES` |
| `lib/budget.ts` | **All** budget arithmetic. Pure, no I/O, no clock |
| `lib/ynabPlan.ts` | YNAB `Plan.csv` -> typed rows. Pure |
| `scripts/import/ynab-plan.mjs` | Reads the CSV, resolves names to ids, writes moves |
| `app/money/budget/page.tsx` | Data fetching + page shell; replaces the envelope panel |
| `components/BudgetTable.tsx` | Groups, roll-ups, the three columns |
| `components/BudgetRow.tsx` | One category: name, target status, progress bar, Available pill |
| `components/BudgetSummary.tsx` | Right-hand month summary panel |
| `components/TargetEditor.tsx` | Set/clear a category's target (the one write path) |
| `app/money/budget/actions.ts` | `setCategoryTarget`, `clearCategoryTarget` |

---

## Task 1: Migration 0038 — schema

**Files:**
- Create: `scripts/sql/migrations/0038_budget.sql`

**Interfaces:**
- Produces: table `ledger_budget_moves` (columns `id, owner_id, month, from_category_id, to_category_id, amount_cents, note, undone_at, created_at`); table `ledger_category_targets` (`id, owner_id, category_id, kind, amount_cents, due_date, created_at, updated_at`); column `ledger_categories.budget_role`.

Follow `0030_business_envelopes.sql`'s formatting exactly: an `-- NNNN — title`
em-dash header, a prose paragraph saying WHY, then the DDL, then the RLS `do $$`
block. Escape apostrophes in comments as `''`.

- [ ] **Step 1: Write the migration**

```sql
-- 0038 — the budget: assignments, targets, and a category''s budget role
--
-- YNAB''s Rule 1, done properly this time. 0030 built envelopes beside the
-- categories and they shipped empty — three rows, zero moves — because an
-- envelope that transactions never point at can show a balance but never an
-- activity. This wave puts the budget ON the categories transactions already
-- carry, so Activity is real from day one.
--
-- An assignment is an IMMUTABLE move between Ready to Assign (a null category
-- id) and a category, stamped with the month it belongs to. What a category has
-- assigned in a month is nothing but the sum of its moves — no mutable column to
-- drift, same doctrine as 0030. Undo marks; it never deletes.
--
-- The 0030 envelope tables are left in place, empty and unused. Nothing dropped.

alter table ledger_categories
  add column budget_role text not null default 'spending'
    check (budget_role in ('spending', 'income'));

comment on column ledger_categories.budget_role is
  'Whether this category is a budget row (''spending'') or an inflow that lands '
  'in Ready to Assign (''income''). Explicit rather than matching on the group '
  'name, which is user-editable text. Income categories keep their accountant '
  'meaning but never appear on the budget screen.';

create table ledger_budget_moves (
  id               uuid primary key default gen_random_uuid(),
  owner_id         uuid not null references auth.users(id) on delete cascade,
  -- The budgeted month, always the first of that month.
  month            date not null,
  -- null on either side = the Ready to Assign pool.
  from_category_id uuid references ledger_categories(id) on delete restrict,
  to_category_id   uuid references ledger_categories(id) on delete restrict,
  amount_cents     bigint not null check (amount_cents > 0),
  note             text,
  -- Undo marks, never deletes; redo clears it again.
  undone_at        timestamptz,
  created_at       timestamptz not null default now(),

  constraint lbm_somewhere check (from_category_id is not null or to_category_id is not null),
  constraint lbm_direction check (from_category_id is distinct from to_category_id),
  constraint lbm_month_is_first check (extract(day from month) = 1)
);

comment on table ledger_budget_moves is
  'One immutable assignment move. assigned(category, month) is the sum of moves '
  'in minus the sum out, ignoring rows with undone_at set. A move between two '
  'categories changes neither Ready to Assign nor the total — money just changes '
  'jobs.';

create index lbm_owner_month_idx on ledger_budget_moves (owner_id, month);
create index lbm_owner_created_idx on ledger_budget_moves (owner_id, created_at desc, id desc);

create table ledger_category_targets (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references auth.users(id) on delete cascade,
  category_id  uuid not null unique references ledger_categories(id) on delete cascade,
  kind         text not null check (kind in ('monthly', 'by_date')),
  amount_cents bigint not null check (amount_cents > 0),
  -- Required for by_date, null for monthly.
  due_date     date,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint target_date_matches_kind
    check ((kind = 'by_date') = (due_date is not null))
);

comment on table ledger_category_targets is
  'A category''s goal: ''monthly'' refills to amount_cents each month, ''by_date'' '
  'reaches amount_cents by due_date. One target per category. YNAB does not '
  'export targets, so these are entered by hand and have no history — looking '
  'back at a past month judges it against today''s target.';

-- Owner pay becomes a real budget category. It is Dan''s largest budget line
-- ($45,774 assigned in 2026) and the screen cannot add up without it. This is a
-- RELAXATION, not a removal: no column is dropped and no row is lost, so it does
-- not repeat 0015. Transfers still may not carry a category. The accountant
-- export is unaffected because the Owner Pay category carries deductible = false,
-- the same flag the Income categories already use.
alter table ledger_transactions
  drop constraint lt_nocat_for_owner_or_transfer;

alter table ledger_transactions
  add constraint lt_nocat_for_transfer
    check (kind <> 'transfer' or category_id is null);

do $$
declare t text;
begin
  foreach t in array array['ledger_budget_moves','ledger_category_targets']
  loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy %I on public.%I for all to authenticated
         using (owner_id = auth.uid()) with check (owner_id = auth.uid())',
      t || '_owner_all', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;
```

- [ ] **Step 2: Apply to DEV**

Run: `npm run db:migrate`
Expected: `0038_budget.sql` applied, no errors. The banner must say `dev`.

- [ ] **Step 3: Verify the schema landed**

Write `/tmp/check.sql`, run `npm run db:sql -- /tmp/check.sql`, then **delete the file**.

```sql
select column_name, data_type, is_nullable
  from information_schema.columns
 where table_name in ('ledger_budget_moves','ledger_category_targets')
 order by table_name, ordinal_position;

select conname from pg_constraint
 where conrelid = 'ledger_transactions'::regclass and conname like 'lt_nocat%';
```

Expected: both tables present with the columns above, and exactly one constraint
named `lt_nocat_for_transfer` (the old `lt_nocat_for_owner_or_transfer` gone).

- [ ] **Step 4: Prove the relaxation actually works**

Write `/tmp/probe.sql`, run it against DEV, then **delete the file**. This must be
run — a constraint you did not test is a constraint you are guessing about.

```sql
-- Should SUCCEED: owner_pay may now carry a category.
begin;
update ledger_transactions
   set category_id = (select id from ledger_categories limit 1)
 where kind = 'owner_pay';
rollback;

-- Should FAIL with a check violation: transfers still may not.
begin;
update ledger_transactions
   set category_id = (select id from ledger_categories limit 1)
 where kind = 'transfer';
rollback;
```

Expected: the first block succeeds; the second raises
`new row for relation "ledger_transactions" violates check constraint "lt_nocat_for_transfer"`.

- [ ] **Step 5: Commit**

```bash
git add scripts/sql/migrations/0038_budget.sql
git commit -m "0038: budget moves, category targets, owner pay may be categorised"
```

---

## Task 2: Migration 0039 — converge the category list

**Files:**
- Create: `scripts/sql/migrations/0039_budget_categories.sql`
- Modify: `lib/ledgerCategories.ts`
- Modify: `lib/ynabRegister.ts` (the `ALIASES` map)
- Modify: `scripts/test/ledgerCategories.test.ts`, `scripts/test/ynabRegister.test.ts`

**Interfaces:**
- Consumes: `ledger_categories.budget_role` from Task 1.
- Produces: a category list matching YNAB's 2026 set, with `Owner Investment, Pay, and Personal Expenses` present in group `Owner Transactions`.

The target list (17 spending rows + 2 income rows + 2 hidden):

| Group | Categories | sort |
|---|---|---|
| Income | Show Income, Other Income | 0, 1 |
| Bills | Insurance, Workers Comp, Spotify, Clear, Software | 10–14 |
| Expenses | Mileage Reimbursement, Meals and Entertainment, Gig Expenses, Transportation, Flights | 20–24 |
| Purchases | Audio Tools, Misc Business Expenses | 30, 31 |
| Owner Transactions | Owner Investment, Pay, and Personal Expenses | 40 |
| Savings | Tax Prep, State License Fee, Taxes, Retained Earnings | 50–53 |

Hidden, not deleted: `Bank Fees`, `Lodging`.

- [ ] **Step 1: Write the migration**

Every statement is written to be safe on an owner who does not have the old rows
(a fresh environment), because migrations run against dev, prod, and any future
sandbox alike.

```sql
-- 0039 — the category list converges on Dan''s YNAB budget
--
-- The budget screen only proves anything if its rows line up with the rows he
-- checks it against, so the chart becomes a copy of the 2026 categories his YNAB
-- actually uses. Nothing is deleted: Bank Fees and Lodging are hidden, keeping
-- their history and their place on any past transaction.
--
-- Subscriptions splits into Spotify and Clear, which is a split his own payees
-- resolve unambiguously. Owner pay gets the category 0038 just made legal, marked
-- non-deductible so the accountant export is unchanged.

-- Income categories are inflows, not budget rows.
update ledger_categories set budget_role = 'income' where grp = 'Income';

-- The Taxes group becomes Savings, matching YNAB.
update ledger_categories set grp = 'Savings' where grp = 'Taxes';

-- Retire, don''t delete.
update ledger_categories set hidden = true where name in ('Bank Fees', 'Lodging');

-- New categories, one row per owner who has any categories at all. deductible
-- and is_equipment mirror lib/ledgerCategories.ts.
insert into ledger_categories (owner_id, name, grp, sort, deductible, is_equipment, budget_role)
select o.owner_id, v.name, v.grp, v.sort, v.deductible, v.is_equipment, 'spending'
  from (select distinct owner_id from ledger_categories) o
 cross join (values
   ('Spotify',                                      'Bills',              12, true,  false),
   ('Clear',                                        'Bills',              13, true,  false),
   ('Owner Investment, Pay, and Personal Expenses', 'Owner Transactions', 40, false, false),
   ('State License Fee',                            'Savings',            51, true,  false),
   ('Retained Earnings',                            'Savings',            53, true,  false)
 ) as v(name, grp, sort, deductible, is_equipment)
 on conflict (owner_id, name) do nothing;

-- Re-sort the survivors so the screen''s group order matches YNAB''s.
update ledger_categories set sort = 10 where name = 'Insurance';
update ledger_categories set sort = 11 where name = 'Workers Comp';
update ledger_categories set sort = 14 where name = 'Software';
update ledger_categories set sort = 20 where name = 'Mileage Reimbursement';
update ledger_categories set sort = 21 where name = 'Meals and Entertainment';
update ledger_categories set sort = 22 where name = 'Gig Expenses';
update ledger_categories set sort = 23 where name = 'Transportation';
update ledger_categories set sort = 24 where name = 'Flights';
update ledger_categories set sort = 30 where name = 'Audio Tools';
update ledger_categories set sort = 31 where name = 'Misc Business Expenses';
update ledger_categories set sort = 50 where name = 'Tax Prep';
update ledger_categories set sort = 52 where name = 'Taxes';

-- Subscriptions'' transactions move to their real names, by payee. Anything that
-- is neither Spotify nor Clear stays on Subscriptions, which is then hidden only
-- if nothing is left pointing at it.
update ledger_transactions t
   set category_id = (select c.id from ledger_categories c
                       where c.owner_id = t.owner_id and c.name = 'Spotify')
 where t.category_id in (select id from ledger_categories where name = 'Subscriptions')
   and t.payee ilike '%spotify%';

update ledger_transactions t
   set category_id = (select c.id from ledger_categories c
                       where c.owner_id = t.owner_id and c.name = 'Clear')
 where t.category_id in (select id from ledger_categories where name = 'Subscriptions')
   and t.payee ilike '%clear%';

update ledger_categories c set hidden = true
 where c.name = 'Subscriptions'
   and not exists (select 1 from ledger_transactions t where t.category_id = c.id);
```

- [ ] **Step 2: Apply to DEV and check what moved**

Run: `npm run db:migrate`

Then write `/tmp/cats.sql`, run `npm run db:sql -- /tmp/cats.sql`, **delete the file**:

```sql
select grp, name, sort, hidden, budget_role,
       (select count(*) from ledger_transactions t where t.category_id = c.id) as txns
  from ledger_categories c order by sort, name;
```

Expected: the table above, `Income` rows carrying `budget_role = 'income'`,
`Bank Fees` and `Lodging` hidden, and no category left with a name that is not in
the target list unless it is hidden.

- [ ] **Step 3: Update the seed chart**

In `lib/ledgerCategories.ts`, `CategorySeed` gains `budget_role: 'spending' | 'income'`
and the `c()` helper gains a matching parameter defaulting to `'spending'`. Replace
`DEFAULT_CATEGORIES` with the target list above, preserving the existing comment
about why `Taxes` is non-deductible and adding one sentence explaining that the
list is a copy of Dan's YNAB 2026 categories so the budget screen reconciles.

```ts
export type CategorySeed = {
  name: string
  grp: string
  sort: number
  deductible: boolean
  is_equipment: boolean
  budget_role: 'spending' | 'income'
}

const c = (
  name: string, grp: string, sort: number,
  deductible = true, is_equipment = false,
  budget_role: 'spending' | 'income' = 'spending',
): CategorySeed => ({ name, grp, sort, deductible, is_equipment, budget_role })

export const DEFAULT_CATEGORIES: CategorySeed[] = [
  c('Show Income', 'Income', 0, false, false, 'income'),
  c('Other Income', 'Income', 1, false, false, 'income'),
  c('Insurance', 'Bills', 10),
  c('Workers Comp', 'Bills', 11),
  c('Spotify', 'Bills', 12),
  c('Clear', 'Bills', 13),
  c('Software', 'Bills', 14),
  c('Mileage Reimbursement', 'Expenses', 20),
  c('Meals and Entertainment', 'Expenses', 21),
  c('Gig Expenses', 'Expenses', 22),
  c('Transportation', 'Expenses', 23),
  c('Flights', 'Expenses', 24),
  c('Audio Tools', 'Purchases', 30, true, true),
  c('Misc Business Expenses', 'Purchases', 31),
  c('Owner Investment, Pay, and Personal Expenses', 'Owner Transactions', 40, false),
  c('Tax Prep', 'Savings', 50),
  c('State License Fee', 'Savings', 51),
  c('Taxes', 'Savings', 52, false),
  c('Retained Earnings', 'Savings', 53),
]
```

- [ ] **Step 4: Empty the now-wrong aliases**

`lib/ynabRegister.ts`'s `ALIASES` folded Spotify and Clear into Subscriptions.
Both are now real categories, so the map is empty — keep it exported and keep the
comment, since a future YNAB rename will want it back.

```ts
// YNAB spells category names exactly as Dan''s chart does since 0039 converged
// the two lists, so nothing needs rewriting today. Kept because the moment YNAB
// and the chart disagree again, this is where the rewrite belongs — and leaving
// an unlisted name uncategorised is still better than guessing.
export const ALIASES: Record<string, string> = {}
```

- [ ] **Step 5: Fix the tests those two changes break**

`scripts/test/ledgerCategories.test.ts` asserts on the old list; update its
expectations to the new one, and add:

```ts
test('income categories are inflows, never budget rows', () => {
  for (const cat of DEFAULT_CATEGORIES) {
    assert.equal(cat.budget_role === 'income', cat.grp === 'Income',
      `${cat.name} should be income-role exactly when it is in the Income group`)
  }
})

test('owner pay is a real category and is never deductible', () => {
  const owner = DEFAULT_CATEGORIES.find((c) => c.grp === 'Owner Transactions')
  assert.ok(owner, 'owner pay must have a category — the budget cannot add up without one')
  assert.equal(owner.deductible, false, 'paying yourself is not a deduction')
})
```

`scripts/test/ynabRegister.test.ts` asserts Spotify and Clear map to
Subscriptions; replace those cases with one asserting the names pass through
unchanged now that both are real categories.

- [ ] **Step 6: Gates and commit**

```bash
npm test && rm -f tsconfig.tsbuildinfo .next/cache/.tsbuildinfo && npx tsc --noEmit && npm run build
git add scripts/sql/migrations/0039_budget_categories.sql lib/ledgerCategories.ts lib/ynabRegister.ts scripts/test/
git commit -m "0039: the category list converges on Dan's YNAB budget"
```


---

## Task 2b: Migration 0040 — owner pay gets its category, retired rows get out of the way

**Files:**
- Create: `scripts/sql/migrations/0040_owner_pay_category.sql`
- Modify: `app/money/categories/page.tsx`

**Why this task exists:** two gaps found reviewing Task 2, neither fixable in
0039 (applied, checksummed, immutable).

1. **Owner pay has no activity.** 0038 made it legal for an `owner_pay`
   transaction to carry a category and 0039 created the category, but nothing
   connects them. The budget's largest row — $45,774 assigned in 2026 — would
   show against **zero** activity, and the parity check would fail on the biggest
   line in the budget.
2. **Sort collisions.** 0039 re-sorted the survivors and left the retired
   categories on their old numbers: Software ties with Bank Fees at 14, Flights
   ties with Lodging at 24, and Clear ties with Subscriptions at 13.
   `app/money/categories/page.tsx` orders by `(grp, sort)` with no tertiary key,
   so a tie renders in whatever order Postgres happens to return.

- [ ] **Step 1: Write the migration**

```sql
-- 0040 — owner pay gets its category, and retired categories get out of the way
--
-- Two gaps 0039 left, both caught in review.
--
-- First, owner pay. 0038 made it legal for an owner_pay row to carry a category
-- and 0039 created the category, but nothing ever put the two together — so the
-- budget''s largest row would have shown a real assignment against zero activity.
-- The whole point of this screen is that it reconciles against YNAB, and this is
-- the line that would have failed first.
--
-- Second, sort collisions. 0039 re-sorted the surviving categories and left the
-- retired ones on their old numbers, so Software tied with Bank Fees, Flights
-- with Lodging, and Clear with Subscriptions. The categories page orders by
-- (grp, sort) with no tie-break, which makes a tie render in whatever order
-- Postgres feels like that day. Retired rows move to 900+, where nothing active
-- can reach them.

update ledger_transactions t
   set category_id = (select c.id from ledger_categories c
                       where c.owner_id = t.owner_id
                         and c.name = 'Owner Investment, Pay, and Personal Expenses')
 where t.kind = 'owner_pay'
   and t.category_id is null
   and exists (select 1 from ledger_categories c
                where c.owner_id = t.owner_id
                  and c.name = 'Owner Investment, Pay, and Personal Expenses');

-- Unconditional, not gated on `hidden`: an owner whose Subscriptions row still
-- holds transactions keeps it visible, and it must still not tie with Clear.
-- Sorting last inside its group is the right place for a category being retired.
update ledger_categories set sort = 900 where name = 'Subscriptions';
update ledger_categories set sort = 901 where name = 'Bank Fees';
update ledger_categories set sort = 902 where name = 'Lodging';
```

- [ ] **Step 2: Apply to DEV and verify both halves**

Run: `npm run db:migrate` (banner must say `dev`).

Then write `/tmp/v40.sql`, run `npm run db:sql -- /tmp/v40.sql`, **delete the file**:

```sql
select kind, count(*) as n, count(*) filter (where category_id is null) as uncategorised
  from ledger_transactions group by kind order by kind;

select grp, count(*) as rows_in_group, count(distinct sort) as distinct_sorts
  from ledger_categories group by grp having count(*) <> count(distinct sort);
```

Expected: **zero** `owner_pay` rows uncategorised, `transfer` rows still fully
uncategorised (0038''s constraint forbids otherwise), and the second query
returning **no rows at all** — no group may contain two categories sharing a sort.

- [ ] **Step 3: Give the categories page a deterministic tie-break**

`app/money/categories/page.tsx` orders by `grp` then `sort`. Add `name` as a
tertiary key so the list can never reshuffle between renders even if a future
migration reintroduces a tie:

```ts
.order('grp').order('sort').order('name')
```

- [ ] **Step 4: Gates and commit**

```bash
npm test && rm -f tsconfig.tsbuildinfo .next/cache/.tsbuildinfo && npx tsc --noEmit && npm run build
git add scripts/sql/migrations/0040_owner_pay_category.sql app/money/categories/page.tsx
git commit -m "0040: owner pay carries its category; retired categories stop colliding"
```

---

## Task 3: `lib/budget.ts` — the arithmetic (TDD)

**Files:**
- Create: `lib/budget.ts`
- Test: `scripts/test/budget.test.ts`

**Interfaces:**
- Consumes: `addMonths` from `./dates.ts` (`lib/forecast.ts:59` uses the identical import form).
- Produces, for every later task:

```ts
export type BudgetCategory = { id: string; name: string; grp: string; sort: number; hidden: boolean; budgetRole: 'spending' | 'income' }
export type BudgetMove = { month: string; fromCategoryId: string | null; toCategoryId: string | null; amountCents: number }
export type BudgetTxn = { month: string; categoryId: string | null; amountCents: number }
export type CategoryTarget = { categoryId: string; kind: 'monthly' | 'by_date'; amountCents: number; dueDate: string | null }
export type TargetStatus =
  | { kind: 'none' }
  | { kind: 'overspent'; spentCents: number; assignedCents: number }
  | { kind: 'underfunded'; neededCents: number }
  | { kind: 'needed_eventually'; remainingCents: number }
  | { kind: 'fully_spent' }
  | { kind: 'on_track' }
  | { kind: 'funded'; spentCents: number; targetCents: number }
export type CategoryMonth = { categoryId: string; assignedCents: number; activityCents: number; availableCents: number; status: TargetStatus; neededCents: number; targetCents: number | null }
export type MonthBudget = { month: string; rows: CategoryMonth[]; readyToAssignCents: number; leftOverCents: number; assignedCents: number; activityCents: number; availableCents: number; underfundedCents: number }
export function buildBudget(input: { categories: BudgetCategory[]; moves: BudgetMove[]; txns: BudgetTxn[]; targets: CategoryTarget[]; fromMonth: string; toMonth: string }): Map<string, MonthBudget>
```

`month` is always `'YYYY-MM'`. All cents are integers.

- [ ] **Step 1: Write the failing tests**

Create `scripts/test/budget.test.ts`. Synthetic fixtures only — Dan's real
figures never enter the repository.

```ts
// The two formulas that run the budget screen, pinned.
//
// A wrong number here is a wrong number in Dan''s books, and the whole point of
// this screen is that it reconciles against YNAB — so the rollover rule and the
// Ready to Assign rule each get their own tests, including the cases that only
// show up once a year.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildBudget,
  type BudgetCategory, type BudgetMove, type BudgetTxn, type CategoryTarget,
} from '../../lib/budget.ts'

const cat = (id: string, over: Partial<BudgetCategory> = {}): BudgetCategory => ({
  id, name: id, grp: 'Bills', sort: 0, hidden: false, budgetRole: 'spending', ...over,
})

const assign = (month: string, to: string, amountCents: number): BudgetMove =>
  ({ month, fromCategoryId: null, toCategoryId: to, amountCents })

const spend = (month: string, categoryId: string | null, amountCents: number): BudgetTxn =>
  ({ month, categoryId, amountCents })

const build = (o: Partial<Parameters<typeof buildBudget>[0]> = {}) => buildBudget({
  categories: [cat('a')], moves: [], txns: [], targets: [],
  fromMonth: '2026-01', toMonth: '2026-03', ...o,
})

const row = (b: Map<string, ReturnType<typeof buildBudget> extends Map<string, infer M> ? M : never>, month: string, id: string) =>
  b.get(month)!.rows.find((r) => r.categoryId === id)!

test('assigned, activity and available for a single plain month', () => {
  const b = build({ moves: [assign('2026-01', 'a', 50_000)], txns: [spend('2026-01', 'a', -20_000)] })
  const r = row(b, '2026-01', 'a')
  assert.equal(r.assignedCents, 50_000)
  assert.equal(r.activityCents, -20_000)
  assert.equal(r.availableCents, 30_000)
})

test('a positive balance rolls forward into the next month', () => {
  const b = build({ moves: [assign('2026-01', 'a', 50_000)] })
  assert.equal(row(b, '2026-01', 'a').availableCents, 50_000)
  assert.equal(row(b, '2026-02', 'a').availableCents, 50_000)
  assert.equal(row(b, '2026-02', 'a').assignedCents, 0)
})

test('overspending does NOT roll forward — the category restarts at zero', () => {
  const b = build({ moves: [assign('2026-01', 'a', 10_000)], txns: [spend('2026-01', 'a', -15_000)] })
  assert.equal(row(b, '2026-01', 'a').availableCents, -5_000)
  assert.equal(row(b, '2026-02', 'a').availableCents, 0,
    'February starts clean; January''s overspend is Ready to Assign''s problem')
})

test('last month''s overspending is taken out of this month''s Ready to Assign', () => {
  const b = build({
    moves: [assign('2026-01', 'a', 10_000)],
    txns: [spend('2026-01', null, 100_000), spend('2026-01', 'a', -15_000)],
  })
  // January: 100,000 in, 10,000 assigned -> 90,000 left to assign.
  assert.equal(b.get('2026-01')!.readyToAssignCents, 90_000)
  // February inherits that, less January''s 5,000 of overspending.
  assert.equal(b.get('2026-02')!.readyToAssignCents, 85_000)
})

test('income is anything that does not land in a spending category', () => {
  const b = build({
    categories: [cat('a'), cat('inc', { budgetRole: 'income', grp: 'Income' })],
    txns: [spend('2026-01', 'inc', 200_000), spend('2026-01', null, -1_500)],
  })
  assert.equal(b.get('2026-01')!.readyToAssignCents, 198_500,
    'an uncategorised outflow reduces Ready to Assign, exactly as YNAB does it')
  assert.equal(b.get('2026-01')!.rows.length, 1, 'income categories are never budget rows')
})

test('a refund nets activity down instead of needing a special case', () => {
  const b = build({
    moves: [assign('2026-01', 'a', 50_000)],
    txns: [spend('2026-01', 'a', -20_000), spend('2026-01', 'a', 5_000)],
  })
  assert.equal(row(b, '2026-01', 'a').activityCents, -15_000)
  assert.equal(row(b, '2026-01', 'a').availableCents, 35_000)
})

test('moving money between categories changes neither total nor Ready to Assign', () => {
  const b = build({
    categories: [cat('a'), cat('b')],
    txns: [spend('2026-01', null, 100_000)],
    moves: [
      assign('2026-01', 'a', 50_000),
      { month: '2026-01', fromCategoryId: 'a', toCategoryId: 'b', amountCents: 20_000 },
    ],
  })
  assert.equal(row(b, '2026-01', 'a').availableCents, 30_000)
  assert.equal(row(b, '2026-01', 'b').availableCents, 20_000)
  assert.equal(b.get('2026-01')!.readyToAssignCents, 50_000, 'only the 50,000 left Ready to Assign')
})

test('an undone move does not count — undo marks, it never deletes', () => {
  const b = buildBudget({
    categories: [cat('a')], txns: [], targets: [], fromMonth: '2026-01', toMonth: '2026-01',
    moves: [{ ...assign('2026-01', 'a', 50_000), undoneAt: '2026-01-05T00:00:00Z' } as BudgetMove],
  })
  assert.equal(row(b, '2026-01', 'a').assignedCents, 0)
})

test('a month with no assignment at all still reports its carried balance', () => {
  const b = build({ moves: [assign('2026-01', 'a', 50_000)] })
  const m = b.get('2026-03')!
  assert.equal(m.assignedCents, 0)
  assert.equal(m.leftOverCents, 50_000)
  assert.equal(m.availableCents, 50_000)
})

// --- targets ---

const monthly = (id: string, amountCents: number): CategoryTarget =>
  ({ categoryId: id, kind: 'monthly', amountCents, dueDate: null })

test('a monthly target that is met reads as funded', () => {
  const b = build({ targets: [monthly('a', 20_000)], moves: [assign('2026-01', 'a', 20_000)] })
  assert.deepEqual(row(b, '2026-01', 'a').status, { kind: 'funded', spentCents: 0, targetCents: 20_000 })
  assert.equal(row(b, '2026-01', 'a').neededCents, 0)
})

test('a monthly target funded and then spent to zero reads as fully spent', () => {
  const b = build({
    targets: [monthly('a', 20_000)],
    moves: [assign('2026-01', 'a', 20_000)],
    txns: [spend('2026-01', 'a', -20_000)],
  })
  assert.deepEqual(row(b, '2026-01', 'a').status, { kind: 'fully_spent' })
})

test('an unfunded monthly target reports exactly what it still needs', () => {
  const b = build({ targets: [monthly('a', 20_000)], moves: [assign('2026-01', 'a', 5_000)] })
  assert.deepEqual(row(b, '2026-01', 'a').status, { kind: 'underfunded', neededCents: 15_000 })
  assert.equal(b.get('2026-01')!.underfundedCents, 15_000)
})

test('overspending beats every other status — red wins', () => {
  const b = build({
    targets: [monthly('a', 20_000)],
    moves: [assign('2026-01', 'a', 20_000)],
    txns: [spend('2026-01', 'a', -25_000)],
  })
  assert.deepEqual(row(b, '2026-01', 'a').status,
    { kind: 'overspent', spentCents: 25_000, assignedCents: 20_000 })
})

test('carried money counts towards a monthly target — you do not refund what is already there', () => {
  const b = build({ targets: [monthly('a', 20_000)], moves: [assign('2026-01', 'a', 20_000)] })
  assert.deepEqual(row(b, '2026-02', 'a').status, { kind: 'funded', spentCents: 0, targetCents: 20_000 })
  assert.equal(row(b, '2026-02', 'a').neededCents, 0, 'February needs nothing — January''s money carried')
})

test('a by-date target spreads what is missing across the months remaining', () => {
  // 30,000 wanted by the end of March; nothing saved. From January that is three
  // months, so 10,000 a month.
  const b = build({
    targets: [{ categoryId: 'a', kind: 'by_date', amountCents: 30_000, dueDate: '2026-03-31' }],
  })
  assert.equal(row(b, '2026-01', 'a').neededCents, 10_000)
  assert.deepEqual(row(b, '2026-01', 'a').status, { kind: 'needed_eventually', remainingCents: 30_000 })
})

test('a by-date target with this month''s share already in reads as on track', () => {
  const b = build({
    targets: [{ categoryId: 'a', kind: 'by_date', amountCents: 30_000, dueDate: '2026-03-31' }],
    moves: [assign('2026-01', 'a', 10_000)],
  })
  assert.equal(row(b, '2026-01', 'a').neededCents, 0)
  assert.deepEqual(row(b, '2026-01', 'a').status, { kind: 'on_track' })
})

test('a by-date target past its due date asks for the whole shortfall at once', () => {
  const b = build({
    targets: [{ categoryId: 'a', kind: 'by_date', amountCents: 30_000, dueDate: '2025-12-31' }],
  })
  assert.equal(row(b, '2026-01', 'a').neededCents, 30_000)
})

test('a category with no target has no status and never counts as underfunded', () => {
  const b = build({ moves: [assign('2026-01', 'a', 5_000)] })
  assert.deepEqual(row(b, '2026-01', 'a').status, { kind: 'none' })
  assert.equal(b.get('2026-01')!.underfundedCents, 0)
})

test('a row carries its target''s figure so the bar and the filters need not refetch', () => {
  const b = build({ targets: [monthly('a', 20_000)] })
  assert.equal(row(b, '2026-01', 'a').targetCents, 20_000)
  assert.equal(row(build(), '2026-01', 'a').targetCents, null)
})

test('hidden categories stay out of the budget entirely', () => {
  const b = build({ categories: [cat('a'), cat('gone', { hidden: true })] })
  assert.deepEqual(b.get('2026-01')!.rows.map((r) => r.categoryId), ['a'])
})

test('month totals are the sum of their rows', () => {
  const b = build({
    categories: [cat('a'), cat('b')],
    moves: [assign('2026-01', 'a', 50_000), assign('2026-01', 'b', 30_000)],
    txns: [spend('2026-01', 'a', -20_000)],
  })
  const m = b.get('2026-01')!
  assert.equal(m.assignedCents, 80_000)
  assert.equal(m.activityCents, -20_000)
  assert.equal(m.availableCents, 60_000)
})
```

Note the `undoneAt` field used in the undo test — add it to `BudgetMove` as
`undoneAt?: string | null`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- --test-name-pattern=budget` — or simply `npm test`.
Expected: FAIL, `Cannot find module '../../lib/budget.ts'`.

- [ ] **Step 3: Implement `lib/budget.ts`**

```ts
// Budget arithmetic — YNAB''s month grid.
//
// Two formulas run this screen, both validated against 1,421 rows of Dan''s own
// YNAB export before a line of this existed:
//
//   available(c, m) = max(0, available(c, m-1)) + assigned(c, m) + activity(c, m)
//   rta(m) = rta(m-1) + income(m) - SUM assigned(c, m) + SUM min(0, available(c, m-1))
//
// The max(0, ...) is the whole trick. A positive balance rolls forward; a
// negative one does not. Cash overspending is absorbed by the NEXT month''s Ready
// to Assign and the category restarts at zero. Letting negatives roll forward
// instead produces 23 mismatches against that same export, so this is settled by
// evidence rather than taste.
//
// Note what SUM assigned(c, m) quietly gets right: a move between two categories
// contributes +x and -x, so it nets to zero and never touches Ready to Assign.
// Only moves with a null on one side move the pool.
//
// No '@/' imports and no JSX — exercised by node --test. No clock reads: the
// month range is always a parameter.

import { addMonths } from './dates.ts'

/** Nothing before this has a ledger behind it, so nothing before it is honest. */
export const FIRST_BUDGET_MONTH = '2026-01'

/**
 * Where the opening seed lives. Navigation never reaches it: it exists so that
 * January''s carry-in is whatever YNAB was holding at the end of 2025, and so
 * that the account''s opening balance has a month to arrive in.
 */
export const OPENING_MONTH = '2025-12'

export type BudgetCategory = {
  id: string
  name: string
  grp: string
  sort: number
  hidden: boolean
  /** 'income' rows are inflows to Ready to Assign, never budget rows. */
  budgetRole: 'spending' | 'income'
}

export type BudgetMove = {
  /** 'YYYY-MM'. */
  month: string
  /** null = the Ready to Assign pool. */
  fromCategoryId: string | null
  /** null = the Ready to Assign pool. */
  toCategoryId: string | null
  /** Always positive; direction lives in from/to. */
  amountCents: number
  /** Set = undone, and the move stops counting. Undo marks, never deletes. */
  undoneAt?: string | null
}

export type BudgetTxn = {
  /** 'YYYY-MM'. */
  month: string
  categoryId: string | null
  /** Signed: + in, - out. */
  amountCents: number
}

export type CategoryTarget = {
  categoryId: string
  kind: 'monthly' | 'by_date'
  amountCents: number
  /** 'YYYY-MM-DD' for by_date, null for monthly. */
  dueDate: string | null
}

export type TargetStatus =
  | { kind: 'none' }
  | { kind: 'overspent'; spentCents: number; assignedCents: number }
  | { kind: 'underfunded'; neededCents: number }
  | { kind: 'needed_eventually'; remainingCents: number }
  | { kind: 'fully_spent' }
  | { kind: 'on_track' }
  | { kind: 'funded'; spentCents: number; targetCents: number }

export type CategoryMonth = {
  categoryId: string
  assignedCents: number
  activityCents: number
  availableCents: number
  status: TargetStatus
  /** What it would take to satisfy the target this month. Drives Underfunded. */
  neededCents: number
  /** The target''s figure, or null when the category has none. The progress bar
   *  and the Overfunded filter both need it, and neither should have to be
   *  handed the raw targets list a second time. */
  targetCents: number | null
}

export type MonthBudget = {
  month: string
  rows: CategoryMonth[]
  readyToAssignCents: number
  /** Sum of what carried in — the summary panel''s "Left Over from Last Month". */
  leftOverCents: number
  assignedCents: number
  activityCents: number
  availableCents: number
  underfundedCents: number
}

/** Inclusive month count from `month` to `dueDate`''s month; never below 1. */
function monthsUntil(month: string, dueDate: string): number {
  const [my, mm] = month.split('-').map(Number)
  const [dy, dm] = dueDate.slice(0, 7).split('-').map(Number)
  return Math.max(1, (dy - my) * 12 + (dm - mm) + 1)
}

function statusFor(
  target: CategoryTarget | undefined,
  carriedIn: number, assigned: number, activity: number, available: number,
  month: string,
): { status: TargetStatus; needed: number } {
  if (!target) return { status: { kind: 'none' }, needed: 0 }

  const funded = Math.max(0, carriedIn) + assigned
  const shortfall = Math.max(0, target.amountCents - funded)

  // What this month is being asked for. A monthly target wants topping up to its
  // figure; a by-date target wants its share of what is still missing, measured
  // before this month''s assignment so that assigning the share clears it.
  let needed: number
  if (target.kind === 'monthly') {
    needed = shortfall
  } else {
    const left = monthsUntil(month, target.dueDate ?? month)
    const missingBefore = Math.max(0, target.amountCents - Math.max(0, carriedIn))
    needed = Math.max(0, Math.ceil(missingBefore / left) - assigned)
  }

  // Red beats everything: an overspent category is the one thing Dan has to act on.
  if (available < 0) {
    return { status: { kind: 'overspent', spentCents: -activity, assignedCents: assigned }, needed }
  }
  if (needed > 0) {
    return target.kind === 'monthly'
      ? { status: { kind: 'underfunded', neededCents: needed }, needed }
      : { status: { kind: 'needed_eventually', remainingCents: shortfall }, needed }
  }
  if (available === 0) return { status: { kind: 'fully_spent' }, needed: 0 }
  if (target.kind === 'by_date' && funded < target.amountCents) {
    return { status: { kind: 'on_track' }, needed: 0 }
  }
  // "Funded" renders bare when nothing was spent, and as "Funded. Spent A of B"
  // when it was. Only THIS month''s spending is reported: YNAB shows a running
  // figure across the target''s whole window, which this does not model, and a
  // wrong cumulative number would be worse than an honest monthly one.
  return {
    status: { kind: 'funded', spentCents: -activity, targetCents: target.amountCents },
    needed: 0,
  }
}

export function buildBudget(input: {
  categories: BudgetCategory[]
  moves: BudgetMove[]
  txns: BudgetTxn[]
  targets: CategoryTarget[]
  fromMonth: string
  toMonth: string
}): Map<string, MonthBudget> {
  const { categories, moves, txns, targets, fromMonth, toMonth } = input

  const spending = categories
    .filter((c) => c.budgetRole === 'spending' && !c.hidden)
    .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name))
  const spendingIds = new Set(spending.map((c) => c.id))
  const targetOf = new Map(targets.map((t) => [t.categoryId, t]))

  // month -> categoryId -> cents
  const assignedBy = new Map<string, Map<string, number>>()
  const bump = (bag: Map<string, Map<string, number>>, m: string, id: string, cents: number) => {
    let inner = bag.get(m)
    if (!inner) { inner = new Map(); bag.set(m, inner) }
    inner.set(id, (inner.get(id) ?? 0) + cents)
  }

  for (const mv of moves) {
    if (mv.undoneAt) continue
    if (mv.toCategoryId && spendingIds.has(mv.toCategoryId)) {
      bump(assignedBy, mv.month, mv.toCategoryId, mv.amountCents)
    }
    if (mv.fromCategoryId && spendingIds.has(mv.fromCategoryId)) {
      bump(assignedBy, mv.month, mv.fromCategoryId, -mv.amountCents)
    }
  }

  const activityBy = new Map<string, Map<string, number>>()
  const incomeBy = new Map<string, number>()
  for (const t of txns) {
    if (t.categoryId && spendingIds.has(t.categoryId)) {
      bump(activityBy, t.month, t.categoryId, t.amountCents)
    } else {
      // Income-role categories AND uncategorised rows alike: money without a job
      // sits in Ready to Assign until it gets one.
      incomeBy.set(t.month, (incomeBy.get(t.month) ?? 0) + t.amountCents)
    }
  }

  const out = new Map<string, MonthBudget>()
  const carry = new Map<string, number>()
  let rta = 0
  let carriedOverspend = 0

  for (let m = fromMonth; ; m = addMonths(m, 1)) {
    const assigned = assignedBy.get(m) ?? new Map<string, number>()
    const activity = activityBy.get(m) ?? new Map<string, number>()

    const rows: CategoryMonth[] = []
    let tAssigned = 0, tActivity = 0, tAvailable = 0, tLeftOver = 0, tUnderfunded = 0
    let overspendThisMonth = 0

    for (const c of spending) {
      const carriedIn = carry.get(c.id) ?? 0
      const a = assigned.get(c.id) ?? 0
      const act = activity.get(c.id) ?? 0
      const available = carriedIn + a + act

      const { status, needed } = statusFor(targetOf.get(c.id), carriedIn, a, act, available, m)

      rows.push({
        categoryId: c.id, assignedCents: a, activityCents: act,
        availableCents: available, status, neededCents: needed,
        targetCents: targetOf.get(c.id)?.amountCents ?? null,
      })

      tAssigned += a
      tActivity += act
      tAvailable += available
      tLeftOver += carriedIn
      tUnderfunded += needed
      if (available < 0) overspendThisMonth += available

      carry.set(c.id, Math.max(0, available))
    }

    rta = rta + (incomeBy.get(m) ?? 0) - tAssigned + carriedOverspend
    carriedOverspend = overspendThisMonth

    out.set(m, {
      month: m, rows,
      readyToAssignCents: rta,
      leftOverCents: tLeftOver,
      assignedCents: tAssigned,
      activityCents: tActivity,
      availableCents: tAvailable,
      underfundedCents: tUnderfunded,
    })

    if (m === toMonth) break
  }

  return out
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, all budget cases green and no existing test broken.

- [ ] **Step 5: Commit**

```bash
npm test && rm -f tsconfig.tsbuildinfo .next/cache/.tsbuildinfo && npx tsc --noEmit
git add lib/budget.ts scripts/test/budget.test.ts
git commit -m "feat: budget arithmetic, with the rollover rule pinned by tests"
```

---

## Task 4: `lib/ynabPlan.ts` — read the YNAB plan export (TDD)

**Files:**
- Create: `lib/ynabPlan.ts`
- Modify: `lib/ynabRegister.ts` (export its CSV reader)
- Test: `scripts/test/ynabPlan.test.ts`

**Interfaces:**
- Consumes: `parseCsvRows` from `./ynabRegister.ts`.
- Produces: `parseYnabPlan(csv: string): YnabPlanRow[]` where
  `YnabPlanRow = { month: string; grp: string; category: string; assignedCents: number; activityCents: number; availableCents: number }` and `month` is `'YYYY-MM'`.

The real file's shape, for reference — header plus three rows. Money fields are
**unquoted**, and a negative carries its minus **before** the dollar sign:

```
"Month","Category Group/Category","Category Group","Category","Assigned","Activity","Available"
"Aug 2026","Bills: Insurance","Bills","Insurance",$0.00,$0.00,$35.00
"Aug 2026","Bills: Spotify","Bills","Spotify",$12.99,-$12.99,$0.00
```

- [ ] **Step 1: Export the CSV reader that already exists**

`lib/ynabRegister.ts` has a private `parseCsvRows(text: string): string[][]`
handling quoted fields, embedded newlines and `""` escapes. Add `export` to it and
extend its doc comment with one sentence: that `lib/ynabPlan.ts` shares it, so the
two YNAB importers cannot drift on CSV mechanics. Change nothing else in that file
beyond `ALIASES` (Task 2).

- [ ] **Step 2: Write the failing tests**

Create `scripts/test/ynabPlan.test.ts`.

```ts
// YNAB''s Plan export -> budget rows. Fixtures are invented; Dan''s real figures
// stay out of the repository.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseYnabPlan } from '../../lib/ynabPlan.ts'

const HEADER = '"Month","Category Group/Category","Category Group","Category","Assigned","Activity","Available"'
const csv = (...lines: string[]) => [HEADER, ...lines].join('\n') + '\n'

test('a plain row parses into cents and a YYYY-MM month', () => {
  const [row] = parseYnabPlan(csv('"Aug 2026","Bills: Insurance","Bills","Insurance",$427.00,$0.00,$35.00'))
  assert.deepEqual(row, {
    month: '2026-08', grp: 'Bills', category: 'Insurance',
    assignedCents: 42_700, activityCents: 0, availableCents: 3_500,
  })
})

test('a negative carries its minus before the dollar sign', () => {
  const [row] = parseYnabPlan(csv('"Aug 2026","Bills: Spotify","Bills","Spotify",$12.99,-$12.99,$0.00'))
  assert.equal(row.activityCents, -1_299)
})

test('thousands separators do not become a truncated amount', () => {
  const [row] = parseYnabPlan(csv('"Mar 2026","Savings: Taxes","Savings","Taxes","$6,682.19",$0.00,$0.00'))
  assert.equal(row.assignedCents, 668_219)
})

test('every month abbreviation maps to the right number', () => {
  const names = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  const rows = parseYnabPlan(csv(...names.map((n) =>
    `"${n} 2026","Bills: Insurance","Bills","Insurance",$0.00,$0.00,$0.00`)))
  assert.deepEqual(rows.map((r) => r.month),
    names.map((_, i) => `2026-${String(i + 1).padStart(2, '0')}`))
})

test('a blank trailing line is dropped, not parsed as a row', () => {
  const rows = parseYnabPlan(csv('"Aug 2026","Bills: Insurance","Bills","Insurance",$0.00,$0.00,$0.00') + '\n')
  assert.equal(rows.length, 1)
})

test('an unexpected header is refused rather than silently misread', () => {
  assert.throws(
    () => parseYnabPlan('"Month","Category","Assigned"\n"Aug 2026","Insurance",$0.00\n'),
    /header/i,
  )
})

test('an unparseable month is refused with its line number', () => {
  assert.throws(
    () => parseYnabPlan(csv('"Smarch 2026","Bills: Insurance","Bills","Insurance",$0.00,$0.00,$0.00')),
    /line 2/,
  )
})
```

- [ ] **Step 3: Run to verify they fail**

Run: `npm test`
Expected: FAIL, `Cannot find module '../../lib/ynabPlan.ts'`.

- [ ] **Step 4: Implement `lib/ynabPlan.ts`**

```ts
// YNAB "Plan" CSV export -> budget rows.
//
// The sibling of lib/ynabRegister.ts: that one reads transactions, this one reads
// what was budgeted. Both share parseCsvRows so the two importers can never drift
// on CSV mechanics.
//
// Pure: no database, no clock. scripts/import/ynab-plan.mjs resolves category
// NAMES to ids and does the writing. This module only says what the file says.
//
// No '@/' imports and no JSX — exercised by node --test.

import { parseCsvRows } from './ynabRegister.ts'

export type YnabPlanRow = {
  /** 'YYYY-MM'. */
  month: string
  grp: string
  category: string
  assignedCents: number
  activityCents: number
  availableCents: number
}

const EXPECTED_HEADER = [
  'Month', 'Category Group/Category', 'Category Group', 'Category',
  'Assigned', 'Activity', 'Available',
]

const MONTHS: Record<string, string> = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
}

/** 'Aug 2026' -> '2026-08'. */
function toMonth(raw: string, lineNo: number): string {
  const [name, year] = raw.trim().split(/\s+/)
  const mm = MONTHS[name]
  if (!mm || !/^\d{4}$/.test(year ?? '')) {
    throw new Error(`line ${lineNo}: cannot read "${raw}" as a month`)
  }
  return `${year}-${mm}`
}

/**
 * '$1,234.56' / '-$45.99' / '$0.00' -> integer cents. YNAB puts the minus BEFORE
 * the dollar sign and uses thousands separators, so a naive parseFloat would
 * silently truncate $6,682.19 to $6.
 */
function toCents(raw: string, lineNo: number, field: string): number {
  const cleaned = raw.trim().replace(/[$,]/g, '')
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) {
    throw new Error(`line ${lineNo}: cannot read "${raw}" as ${field}`)
  }
  return Math.round(Number(cleaned) * 100)
}

export function parseYnabPlan(csv: string): YnabPlanRow[] {
  const rows = parseCsvRows(csv)
  if (rows.length === 0) return []

  const header = rows[0].map((h) => h.trim())
  const matches = header.length === EXPECTED_HEADER.length
    && EXPECTED_HEADER.every((h, i) => header[i] === h)
  if (!matches) {
    throw new Error(
      `unexpected header: got ${header.join(', ')} — expected ${EXPECTED_HEADER.join(', ')}`,
    )
  }

  const out: YnabPlanRow[] = []
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]
    const lineNo = i + 1
    if (r.length !== EXPECTED_HEADER.length) {
      throw new Error(`line ${lineNo}: expected ${EXPECTED_HEADER.length} fields, got ${r.length}`)
    }
    out.push({
      month: toMonth(r[0], lineNo),
      grp: r[2].trim(),
      category: r[3].trim(),
      assignedCents: toCents(r[4], lineNo, 'Assigned'),
      activityCents: toCents(r[5], lineNo, 'Activity'),
      availableCents: toCents(r[6], lineNo, 'Available'),
    })
  }
  return out
}
```

- [ ] **Step 5: Run to verify they pass, then commit**

```bash
npm test && rm -f tsconfig.tsbuildinfo .next/cache/.tsbuildinfo && npx tsc --noEmit
git add lib/ynabPlan.ts lib/ynabRegister.ts scripts/test/ynabPlan.test.ts
git commit -m "feat: read YNAB's plan export"
```

---

## Task 5: The import script

**Files:**
- Create: `scripts/import/ynab-plan.mjs`
- Modify: `package.json` (add `import:plan`)

**Interfaces:**
- Consumes: `parseYnabPlan` from `lib/ynabPlan.ts`; the tables from Task 1; the categories from Task 2.
- Produces: rows in `ledger_budget_moves` for `2025-12` (the opening seed) through `2026-08`.

Model it on `scripts/import/ynab-backfill.mjs` — same argument handling, same
`--env-file=.env.local` invocation, same "print the project ref before writing
anything" discipline.

**What it writes.** For every plan row from `--start` onward whose `assignedCents`
is non-zero, one move in that row's month: to the category when positive, from the
category when negative, amount always positive. Plus, for the opening month, one
move per category carrying that month's `availableCents` — this is what makes
January's carry-in right.

- [ ] **Step 1: Write the script**

```js
// YNAB "Plan" export -> ledger_budget_moves.
//
//   npm run import:plan -- <plan.csv> --start 2026-01              -> DRY RUN, dev
//   npm run import:plan -- --commit <plan.csv> --start 2026-01     -> writes, dev
//   npm run import:plan -- --prod --commit <plan.csv> --start 2026-01
//
// Dry by default and writing only with --commit, matching
// scripts/import/ynab-backfill.mjs. Without --commit this connects, reads,
// reports and writes nothing, so it is safe to preview against production.
//
// One move per category per month, from Ready to Assign into the category. The
// month BEFORE --start is imported differently: its AVAILABLE column, not its
// Assigned, becomes a single opening move per category, because that is what
// carries into the first real month.
//
// Idempotent by deletion: a committing run first clears this owner''s moves from
// the opening month onward, then rewrites them. A budget import that half-applied
// would be worse than one that refused to run twice.

import { readFileSync } from 'node:fs'
import pg from 'pg'
import { parseYnabPlan } from '../../lib/ynabPlan.ts'

// Money arrives as integer cents and must stay that way; stop node-postgres
// handing back bigint as a JS number that could lose precision silently.
// (Copied from ynab-backfill.mjs, which needs it for the same reason.)
pg.types.setTypeParser(20, (v) => Number(v))
```

**Two things not to get wrong here.** Use `pg` and a `DATABASE_URL` /
`DATABASE_URL_PROD` connection string, exactly as `ynab-backfill.mjs` and
`run-sql.mjs` do — **not** `@supabase/supabase-js`, which no import script uses.
And the `.ts` import above works because this repo runs Node v24, which strips
TypeScript types natively without a flag; `npm test` already executes `.ts` files
the same way. Confirm it at Step 3 rather than assuming — a failed import shows up
immediately as a module error.

Note also that `ynab-backfill.mjs`'s header claims the CSV mechanics live in
`lib/ynabRegister.ts`, but that script imports nothing from `lib/`. Do not take
that comment as a pattern to copy; this script really does import its parser.

Required behaviour, in order:

1. Parse `--file`, `--start` (a `'YYYY-MM'`), `--prod`, `--dry`. Refuse to run
   without both `--file` and `--start`.
2. Print the target project ref and whether it is production, before any write —
   the `run-sql.mjs` banner discipline: the target is never something you have to
   infer from which terminal you are in.
3. Resolve the owner: the single row in `auth.users`, or fail loudly if there is
   more than one.
4. Load `ledger_categories` into a `name -> id` map. **Any plan category whose
   name is not in the map is a hard error listing every unmatched name** — a
   silently skipped category is a budget that quietly does not add up.
   Hidden categories still match; `Hidden Categories` group rows and any category
   with no rows from `--start` onward are skipped with a printed count.
5. `delete from ledger_budget_moves where owner_id = $1 and month >= <opening month>`.
6. Insert the opening moves (from the month before `--start`, using
   `availableCents`), then every non-zero `assignedCents` row from `--start` on.
7. Print a summary: months covered, moves written, total assigned per year, and
   the opening total. Without `--commit`, print all of that inside a transaction
   that is rolled back, so a dry run exercises the real inserts and still writes
   nothing.

- [ ] **Step 2: Add the npm script**

```json
"import:plan": "node --env-file=.env.local scripts/import/ynab-plan.mjs",
```

- [ ] **Step 3: Dry run against DEV**

```bash
npm run import:plan -- "$HOME/Downloads/YNAB Export - AudioSmith as of 2026-08-22 22-30/AudioSmith as of 2026-08-22 22-30 - Plan.csv" --start 2026-01
```

Expected: no unmatched category names, opening total **$584.74** across exactly
two categories (Tax Prep $104.29, Retained Earnings $480.45), and nine months
covered (2025-12 through 2026-08).

- [ ] **Step 4: Real run against DEV, then verify the numbers**

Run the same command with `--commit` added. Then write `/tmp/verify.sql`, run
`npm run db:sql -- /tmp/verify.sql`, and **delete the file**:

```sql
select to_char(month, 'YYYY-MM') as m, count(*) as moves, sum(amount_cents) as cents
  from ledger_budget_moves where undone_at is null group by 1 order by 1;
```

Expected: `2025-12` totalling `58474`, and one row per month through `2026-08`.

- [ ] **Step 5: Commit**

```bash
git add scripts/import/ynab-plan.mjs package.json
git commit -m "feat: import the YNAB plan export"
```

---

## Task 6: The page and the table

**Files:**
- Rewrite: `app/money/budget/page.tsx`
- Create: `components/BudgetTable.tsx`
- Modify: `app/shows/[id]/page.tsx:439` (the link text says "Taxes envelope")

**Interfaces:**
- Consumes: `buildBudget`, `MonthBudget`, `BudgetCategory` from `lib/budget.ts`; `monthLabel`, `addMonths`, `todayInChicago` from `lib/dates.ts`.
- Produces: `BudgetTable` taking `{ month: MonthBudget; categories: BudgetCategory[] }`.

`FIRST_BUDGET_MONTH` (`'2026-01'`) and `OPENING_MONTH` (`'2025-12'`) come from
`lib/budget.ts`, where Task 3 defined them.

- [ ] **Step 1: Rewrite the page's data layer**

Delete the envelope machinery: the `ensureDefaultEnvelopes` import and call,
`fetchAllEnvelopeMoves`, `RECENT_MOVES_CAP`, and the `BudgetPanel` render.
`components/BudgetPanel.tsx` is left on disk untouched — phase two decides its
fate; deleting it now is out of scope.

The page reads the month from `searchParams.m`, exactly as `app/calendar/page.tsx`
does:

```ts
const MONTH_KEY = /^\d{4}-\d{2}$/

export default async function BudgetPage({
  searchParams,
}: { searchParams: Promise<{ m?: string; f?: string }> }) {
  const params = await searchParams
  const today = todayInChicago()
  const requested = params.m && MONTH_KEY.test(params.m) ? params.m : today.slice(0, 7)
  // Below the first month there is no ledger, so there is nothing honest to show.
  const month = requested < FIRST_BUDGET_MONTH ? FIRST_BUDGET_MONTH : requested
  // ...
}
```

Fetch four things, each paged with `.range()` in `PAGE_SIZE` chunks following the
existing `fetchAllTransactionsForBalance` pattern in this same file:

1. `ledger_categories` — `id, name, grp, sort, hidden, budget_role`
2. `ledger_budget_moves` — `month, from_category_id, to_category_id, amount_cents, undone_at`
3. `ledger_transactions` — `date, category_id, amount_cents`, filtered `date >= '2026-01-01'`
4. `ledger_category_targets` — `category_id, kind, amount_cents, due_date`

Plus the account's `opening_balance_cents` and `opening_date`.

**The opening balance must be injected as income**, or Ready to Assign is wrong by
the whole opening balance:

```ts
// The account''s opening balance is not a transaction, but it is money that
// arrived and needs a job — so Ready to Assign has to see it. Injected in the
// month the account opened. This is precisely why January shows $1.01 to assign:
// the opening balance is $585.75 and YNAB''s carry-in is $584.74, the difference
// being a penny stranded in a Novo account this app does not carry.
const txns: BudgetTxn[] = [
  { month: account.opening_date.slice(0, 7), categoryId: null, amountCents: account.opening_balance_cents },
  ...rawTxns.map((t) => ({ month: t.date.slice(0, 7), categoryId: t.category_id, amountCents: t.amount_cents })),
]
```

Then build every month from the opening seed to whichever is later, today or the
month being viewed:

```ts
const last = month > today.slice(0, 7) ? month : today.slice(0, 7)
const budget = buildBudget({ categories, moves, txns, targets, fromMonth: OPENING_MONTH, toMonth: last })
const current = budget.get(month)!
```

- [ ] **Step 2: Build the header**

Month navigation copies `app/calendar/page.tsx:157-167` — `<Link>` arrows with
`aria-label="Previous month"` / `"Next month"` around an `<h1 className="eyebrow">`
carrying `monthLabel(month)`. The previous arrow is **omitted** (not disabled) when
`month === FIRST_BUDGET_MONTH`.

Ready to Assign sits centred beneath, in three states driven by
`current.readyToAssignCents`:

| Amount | Rendering |
|---|---|
| `> 0` | `formatUSD(n)` on `bg-good/15 text-good`, label "Ready to Assign" |
| `=== 0` | a check glyph and "All Money Assigned", on `bg-accent-wash text-muted` |
| `< 0` | `formatUSD(n)` on `bg-danger/15 text-danger`, label "More Assigned Than You Have" |

- [ ] **Step 3: Build `components/BudgetTable.tsx`**

A server component. Groups the month's rows by their category's `grp`, ordered by
the lowest `sort` in each group, and renders one section per group:

- A group header row: the group name, then that group's summed Assigned, Activity
  and Available. Plain figures, `class="tabular"`, no pill.
- One row per category, in `sort` order, rendered by `BudgetRow` (Task 7).

Columns are a CSS grid, not a `<table>`, so the phone layout in Task 8 can restack
without duplicating markup:
`grid grid-cols-[1fr_7rem_7rem_8rem] gap-x-4 items-center`.

Wrap the whole table in `overflow-x-auto` so a narrow desktop window scrolls the
table rather than the page.

- [ ] **Step 4: Fix the stale link**

`app/shows/[id]/page.tsx:439` reads `→ Taxes envelope`. Envelopes are gone from
this screen; change the text to `→ Taxes category`, leaving the href as
`/money/budget`.

- [ ] **Step 5: Gates and commit**

```bash
npm test && rm -f tsconfig.tsbuildinfo .next/cache/.tsbuildinfo && npx tsc --noEmit && npm run build
git add app/money/budget/page.tsx components/BudgetTable.tsx app/shows/
git commit -m "feat: the budget month grid"
```

---

## Task 7: Category rows and targets

**Files:**
- Create: `components/BudgetRow.tsx`, `components/TargetEditor.tsx`, `app/money/budget/actions.ts`

**Interfaces:**
- Consumes: `CategoryMonth`, `TargetStatus`, `CategoryTarget` from `lib/budget.ts`; `formatUSD` from `lib/money.ts`.
- Produces: `setCategoryTarget(categoryId: string, kind: 'monthly' | 'by_date', amountCents: number, dueDate: string | null): Promise<{ ok: true } | { ok: false; error: string }>` and `clearCategoryTarget(categoryId: string)` with the same return type.

- [ ] **Step 1: The status line**

`BudgetRow` renders the category name with the status right-aligned on the same
line. The wording is Dan's own, taken verbatim from his YNAB:

| `status.kind` | Text |
|---|---|
| `none` | *(nothing)* |
| `funded` with `spentCents === 0` | `Funded` |
| `funded` with `spentCents > 0` | `Funded. Spent {spent} of {target}` |
| `fully_spent` | `Fully Spent` |
| `on_track` | `On Track` |
| `underfunded` | `{needed} more needed` |
| `needed_eventually` | `{remaining} more needed eventually` |
| `overspent` | `Overspent. {spent} of {assigned}` |

All amounts through `formatUSD`. Status text is `text-xs text-muted`, except
`overspent` which is `text-xs text-danger`.

- [ ] **Step 2: The progress bar**

A 3px bar directly beneath the name, full width of the name column, only rendered
when the category has a target. Track `bg-accent-wash`, fill `bg-good`, and
`bg-danger` for the overspent portion. Width is
`min(100, round(100 * funded / target))`, where `funded` is
`availableCents + max(0, -activityCents)` — what went in, before what went out.
`aria-hidden` on the bar: the status line already says it in words.

- [ ] **Step 3: The Available pill**

`rounded-pill px-2.5 py-1 text-sm font-semibold tabular`, in five states:

| Condition | Classes | Glyph |
|---|---|---|
| `available < 0` | `bg-danger/15 text-danger` | none |
| `available > 0` and target met | `bg-good/15 text-good` | filled check |
| `available > 0` and target not met | `bg-good/15 text-good` | half circle |
| `available === 0` and has target | `bg-accent-wash text-muted` | check |
| `available === 0` and no target | `text-muted` | none |

Glyphs are inline SVG, `aria-hidden`, sized `h-3.5 w-3.5`. The pill carries an
`aria-label` restating the status in words so the colour is never the only signal.

- [ ] **Step 4: The target editor and its action**

`components/TargetEditor.tsx` is a client component behind a small pencil button
on the row. It offers: kind (`monthly` / `by_date`), an amount, a date shown only
for `by_date`, Save, and Clear.

`app/money/budget/actions.ts` follows `setDayHalfDay` (`app/shows/actions.ts:955-981`)
exactly — `'use server'`, auth checked for presence only, RLS enforcing ownership,
no `.eq('owner_id', …)`, `revalidatePath('/money/budget')` at the end. Validation:
amount must parse to a positive integer of cents via `parseUSD`; `by_date`
requires a `due_date` passing `isPlainDate`; `monthly` forces `due_date` to null.
Upsert on `category_id`, which Task 1 made unique.

- [ ] **Step 5: Gates and commit**

```bash
npm test && rm -f tsconfig.tsbuildinfo .next/cache/.tsbuildinfo && npx tsc --noEmit && npm run build
git add components/BudgetRow.tsx components/TargetEditor.tsx app/money/budget/
git commit -m "feat: category rows, target status, and setting a target"
```

---

## Task 8: Summary panel, filter chips, phone layout

**Files:**
- Create: `components/BudgetSummary.tsx`
- Modify: `app/money/budget/page.tsx`, `components/BudgetTable.tsx`, `components/BudgetRow.tsx`

- [ ] **Step 1: The summary panel**

`BudgetSummary` takes `{ month: MonthBudget }` and renders, in Dan's order:
Left Over from Last Month (`leftOverCents`), Assigned in `{monthLabel}`
(`assignedCents`), Activity (`activityCents`), Available (`availableCents`), then a
rule, then Underfunded (`underfundedCents`) — shown only when it is non-zero.
Figures `class="tabular"`, right-aligned, labels `text-muted`.

On desktop it sits in a right column: the page becomes
`grid lg:grid-cols-[1fr_20rem] gap-8`. Below `lg` it renders above the table.

- [ ] **Step 2: Filter chips**

Read from `searchParams.f`, one of `overspent`, `underfunded`, `overfunded`,
`available`; anything else means All. Each chip is a `<Link>` carrying both `m` and
`f`, so filtering never loses the month.

| Chip | Keeps a row when |
|---|---|
| All | always |
| Overspent | `availableCents < 0` |
| Underfunded | `neededCents > 0` |
| Overfunded | has a target and `availableCents > target.amountCents` |
| Money Available | `availableCents > 0` |

Filtering hides rows only — **group totals and the summary panel always describe
the whole month**, never the filtered subset. A filter that silently changed the
totals would make the parity check lie. Add a comment saying so.

The active chip carries `aria-current="true"` and `bg-accent-wash text-accent`;
the rest are `text-muted hover:text-ink`. The Overspent chip shows its count when
non-zero, matching Dan's "3 Overspent".

When a filter empties the table, render a line saying so rather than a bare grid.

- [ ] **Step 3: The phone layout**

Below `sm`, each row becomes a card instead of grid columns: name and status on
the first line, the progress bar beneath, then Assigned / Activity / Available in
a three-up row with small `text-muted` labels above each figure. The desktop
column headers are `hidden sm:grid`. Achieve this with responsive classes on the
existing markup — do not fork `BudgetRow` into two components.

- [ ] **Step 4: Verify in the browser**

Start the dev server through the preview tool (never `npm run dev` in Bash). Check:
month arrows move between January and August; the previous arrow is absent in
January; each filter chip narrows the rows while the summary figures hold still;
at 375px wide the cards stack with no horizontal page scroll; both light and dark
themes render the pills legibly.

- [ ] **Step 5: Gates and commit**

```bash
npm test && rm -f tsconfig.tsbuildinfo .next/cache/.tsbuildinfo && npx tsc --noEmit && npm run build
git add components/BudgetSummary.tsx components/Budget*.tsx app/money/budget/page.tsx
git commit -m "feat: budget summary, filters, and the phone layout"
```

---

## Task 9: Verification, docs, ship

- [ ] **Step 1: Prove it against Dan's real export**

Write a throwaway script in the scratch directory — **not** in the repository —
that runs `buildBudget` over the real `Plan.csv` and compares every row's computed
`availableCents` against YNAB's own `Available` column.

Required result: **0 mismatches across all 1,421 rows**, and
`readyToAssignCents === 0` for `2026-08` when the uncategorised Fairmont charge is
excluded. Anything else stops the ship. Report the figure; do not commit the script
or its output.

- [ ] **Step 2: Walkthrough in the browser**

Against the dev sandbox: walk January to August and confirm each month's Assigned,
Activity and Available match the export; set a monthly target on one category and
watch the status and pill change; set a by-date target and confirm the monthly
share is what it asks for; clear a target and confirm the row goes back to plain.

- [ ] **Step 3: Docs**

- `CLAUDE.md`: replace whatever describes envelopes as the budget model with the
  new one — categories carry the budget, assignments are immutable moves, the two
  validated formulas, and that `budget_role` decides which categories are rows.
  Note that `lt_nocat_for_owner_or_transfer` is now `lt_nocat_for_transfer`.
- `docs/BACKLOG.md`: mark the per-month budgeting entry **SHIPPED (phase one)**,
  and file what phase one deliberately left: assigning by hand, moving money
  between categories, Undo/Redo, Recent Moves, target history, split transactions,
  auto-assign, and retiring `components/BudgetPanel.tsx` and the 0030 envelope
  tables. Also file these three, all found while writing this plan:
  `app/money/forecast/page.tsx:401` still computes "available to allocate" from
  the empty envelope moves — harmless today, since the answer equals the working
  balance, but it is now a stale concept; `ensureDefaultEnvelopes` in
  `app/money/actions.ts` loses its only caller when this page is rewritten; and
  `scripts/import/ynab-backfill.mjs`'s header claims its CSV mechanics live in
  `lib/ynabRegister.ts`, which nothing outside that module''s test imports.

- [ ] **Step 4: Final whole-branch review**

Top model. Lens: the Global Constraints above, and especially — the two formulas
match the spec verbatim; `activity` is a signed sum so refunds net down; hidden and
income-role categories never become budget rows; every unbounded read pages with
`.range()`; guard reads fail closed; integer cents throughout with no float
arithmetic; filters never alter totals; and `budget_role` is never inferred from
the group name.

- [ ] **Step 5: Ship**

```bash
npm run db:migrate -- --prod     # 0038 and 0039, PROD FIRST
npm run import:plan -- --prod "<plan.csv>" --start 2026-01            # preview
npm run import:plan -- --prod --commit "<plan.csv>" --start 2026-01
git checkout main && git merge budget && git push
```

Then smoke-test production, and tell Dan the four-item ledger punch list from the
spec plus the reminder that his 17 targets need entering by hand.

## Verification

Automated: `npm test` (budget arithmetic, the plan parser, the updated category
tests), cold `npx tsc --noEmit`, `npm run build` — all green before every commit.
Manual: Task 9's real-export check at zero mismatches, the browser walkthrough, and
the production smoke test.
