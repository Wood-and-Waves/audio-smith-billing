# YNAB-style per-month budgeting — design

**Status:** approved by Dan, 2026-08-22.
**Supersedes:** the `ledger_envelopes` / `ledger_envelope_moves` model from migration 0030,
which shipped empty and was never used (zero moves in production).

## Goal

Give `/money/budget` the budget screen Dan already knows: months you can walk
between, an amount assigned to each category each month, activity from the real
ledger, and a rolled-forward available balance — matching YNAB closely enough
that his own numbers reconcile row for row.

## Why now

Dan filed this himself (`docs/BACKLOG.md`, 2026-08-22): *"I want to be able to
budget per month and move between the months. My plan is to go back to January
and set the budgets the same as YNAB to prove how they work."*

The intent is **prove parity, then switch**: build the core, backfill January
onward, check it against YNAB side by side, and if it reconciles the business
budget moves into the app and YNAB goes back to being personal-only.

## What already exists

- `ledger_categories` — name, group, sort, hidden, `deductible`, `is_equipment`.
  Already YNAB-shaped (a category inside a group heading).
- `ledger_transactions` — signed integer cents, `kind` in
  (`income`, `expense`, `owner_pay`, `transfer`), optional `category_id`.
  322 of 325 rows are categorised. **Activity per category per month is
  computable from real data today.**
- `ledger_envelopes` / `ledger_envelope_moves` — three envelopes, zero moves.
  The right instinct, never wired to transactions. Retired by this design.
- One account: Chase Checking. No credit card, so YNAB's hardest feature
  (credit-card payment categories) is out of scope by circumstance.

## Reconciliation performed before designing

Against Dan's YNAB export of 2026-08-22 22:30 (`Plan.csv`, 1,421 rows;
`Register.csv`, 1,532 rows). Recorded here because the numbers explain several
figures the screen will show.

**The books agree.** App Chase balance $7,252.91 (through 8/18) versus YNAB's
$6,660.81 (through 8/20). The difference is a single **$592.10 Fairmont Hotel
Chicago** charge on 8/20, still uncategorised in YNAB and not yet imported:
`7,252.91 − 592.10 = 6,660.81` exactly.

**The $1.01.** YNAB carries a second account, **Novo Checking**, dormant since
August 2024, holding **−$1.01**. YNAB's "$7,251.90 available" is the app's Chase
balance plus that penny. The app does not carry Novo and will not.

**Per-category, 10 of 13 match to the penny.** The three that do not:

| Category | App | YNAB | Gap | Cause |
|---|---|---|---|---|
| Owner pay | −45,930.80 | −45,530.80 | $400.00 | A 3/5 "Online Realtime Transfer" YNAB split two ways (Temporary Transfer + Owner Pay); the app recorded it whole. The only split in all of 2026. |
| Insurance | −427.00 | −392.00 | $35.00 | A refund YNAB records as an inflow against the category; the row is absent from the app ledger. |
| Audio Tools | −3,186.60 | −3,074.09 | $112.51 | Same — refunds netting activity down. |

Two incidental confirmations: the app's `Subscriptions` maps to YNAB's
Spotify + Clear **exactly** ($270.92 = $101.92 + $169.00), and the app's three
uncategorised expenses total **exactly $45.00**, which is YNAB's 2026 Retained
Earnings activity.

## Arithmetic (validated, not assumed)

Both formulas were run against the full export before any code was designed.

**Carryover — 0 mismatches across all 1,421 rows:**

```
available(c, m) = max(0, available(c, m-1)) + assigned(c, m) + activity(c, m)
```

A positive balance rolls forward. A negative one — cash overspending — does
**not**; it is absorbed by the next month's Ready to Assign and the category
restarts at zero. The alternative rule (negatives rolling forward) produces 23
mismatches, so this is settled by evidence.

**Ready to Assign — lands on exactly $0.00 for August 2026, matching Dan's
screenshot ("All Money Assigned"):**

```
rta(m) = rta(m-1) + income(m) - SUM_c assigned(c, m) + SUM_c min(0, available(c, m-1))
```

`income(m)` is **the signed sum of every transaction in the month that does not
land in a spending category** — that is, transactions carrying an income-role
category (Show Income, Other Income) plus transactions carrying no category at
all, whatever their `kind`. This mirrors YNAB, where uncategorised money sits in
Ready to Assign until it is given a job, and it is what makes the three
uncategorised bank fees and the $400 transfer inflow behave correctly without a
special case. Once Dan works the punch list below, those rows move out of Ready
to Assign and into categories on their own.

Both formulas are pure and live in `lib/budget.ts` under the existing lib rules:
no `@/` imports, no JSX, relative `.ts` imports, and no clock reads — the month
under view is always a parameter.

**Activity is a signed sum over all transactions carrying the category**,
regardless of `kind`. This is what makes refunds net activity down without a
special case, and it is why the Insurance and Audio Tools gaps above resolve
themselves once those rows exist in the ledger.

## Decisions

| Question | Decision |
|---|---|
| Relationship to YNAB | Prove parity, then switch |
| Owner pay | A real budget category — it is the largest line in the budget ($45,774 assigned in 2026) |
| Targets | Yes, on most categories — **monthly amount** and **save $X by a date** only; no weekly or custom repeats |
| History depth | **2026 only** — Jan 2026 onward, matching the ledger's range |
| Category list | Match YNAB's 2026 set exactly, so parity is row against row |
| Look | The app's skin (charcoal/amber, existing light+dark themes), YNAB's structure |
| Device | Desk-first, phone-readable |
| Storage | Every assignment is an immutable recorded move |
| Included | Move money between categories, Undo/Redo, Recent Moves, filter chips |
| Excluded | Auto-assign, month notes, target snoozing, Cost to Be Me / expected income, density toggle, bulk-select |

## Data model

### Categories

The list converges on YNAB's 17 live 2026 categories:

| Group | Categories |
|---|---|
| Bills | Insurance, Workers Comp, Spotify, Clear, Software |
| Expenses | Mileage Reimbursement, Meals and Entertainment, Gig Expenses, Transportation, Flights |
| Purchases | Audio Tools, Misc Business Expenses |
| Owner Transactions | Owner Investment, Pay, and Personal Expenses |
| Savings | Tax Prep, State License Fee, Taxes, Retained Earnings |

- `Subscriptions` splits into **Spotify** and **Clear**; its 9 transactions are
  reassigned by payee, which separates them unambiguously.
- `Bank Fees` and `Lodging` are **hidden, not deleted** — their history survives.
- The `Taxes` group is renamed **Savings** and gains State License Fee and
  Retained Earnings.
- `Income` (Show Income, Other Income) stays for the accountant export but is
  **never** a budget row. Income flows to Ready to Assign, exactly as YNAB does.

`ledger_categories` gains one column to carry that last distinction explicitly
rather than matching on the group name, which is user-editable text:

```sql
budget_role text not null default 'spending'
  check (budget_role in ('spending', 'income'))
```

### Assignments

One new table. Null on either side means Ready to Assign; the pattern and its
constraints follow `ledger_envelope_moves` (0030) deliberately.

```sql
create table ledger_budget_moves (
  id                 uuid primary key default gen_random_uuid(),
  owner_id           uuid not null references auth.users(id) on delete cascade,
  -- The budgeted month, always the first of the month.
  month              date not null,
  from_category_id   uuid references ledger_categories(id) on delete restrict,
  to_category_id     uuid references ledger_categories(id) on delete restrict,
  amount_cents       bigint not null check (amount_cents > 0),
  note               text,
  -- Undo marks; it never deletes. Redo clears it again.
  undone_at          timestamptz,
  created_at         timestamptz not null default now()
);
```

Both new tables carry the same row-level security and grants pattern as 0030:
owner-scoped `for all to authenticated` policies keyed on `auth.uid()`, all
privileges revoked from `anon`.

`assigned(c, m)` is the sum of moves into `c` for `m` minus the sum out, ignoring
undone rows. This makes the three requested features fall out of the model
rather than needing machinery: **moving money between categories is one row**,
**Recent Moves is the table read back**, and **Undo is a flag**. It also matches
the doctrine already stated in 0030 — balances are sums over moves, with no
mutable column that can drift.

Typing a value into the Assigned box writes the **difference** between the
current total and the typed value, so the box behaves like a number while the
history stays append-only.

### Targets

```sql
create table ledger_category_targets (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references auth.users(id) on delete cascade,
  category_id  uuid not null unique references ledger_categories(id) on delete cascade,
  kind         text not null check (kind in ('monthly', 'by_date')),
  amount_cents bigint not null check (amount_cents > 0),
  -- Required for 'by_date', null for 'monthly'.
  due_date     date,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint target_date_matches_kind
    check ((kind = 'by_date') = (due_date is not null))
);
```

- `monthly` — refill to `amount_cents` each month.
- `by_date` — reach `amount_cents` by `due_date`; the monthly need is what is
  still missing divided across the months remaining.

### One constraint relaxes

`lt_nocat_for_owner_or_transfer` currently forbids a category on both
`owner_pay` and `transfer`. It is replaced by a narrower constraint that
forbids it on `transfer` only. Owner pay is the largest budget line and the
screen cannot add up without it.

This is a relaxation, not a removal: no column is dropped and no row is lost, so
it does not repeat the failure that produced the ADDITIVE ONLY rule (0015 dropped
a column that running code still read). The accountant export is unchanged
because the Owner Pay category is marked `deductible = false`, the same flag the
Income categories already use.

The `ledger_envelopes` tables are left in place, empty and unused. Nothing is
dropped.

## The screen

`/money/budget`, replacing the current envelope panel, on the wide canvas the
register already uses.

**Top bar.** `‹ Aug 2026 ›`. Centred Ready to Assign: green with an amount when
there is money to give a job, a check and "All Money Assigned" at zero, red when
negative. Below it the filter chips — All, Overspent, Underfunded, Overfunded,
Money Available — then Undo, Redo, Recent Moves.

Navigation back-stops at **January 2026**; earlier months have no ledger behind
them. Forward months are open, and the arithmetic already handles assigning ahead.

**Table.** Category, Assigned, Activity, Available. Groups collapse and carry
roll-up totals. Each category row shows its name with the target status
right-aligned on the same line and a target progress bar beneath, using YNAB's
own wording:

> Funded · Funded. Spent $308.80 of $343.80 · Fully Spent · On Track ·
> Overspent. $64.98 of $18.99 · $65.25 more needed eventually

**The Available pill**, five states: green with a check (funded), green with a
half-circle (on track), grey with a check (spent to zero), plain grey (no target,
nothing there), red (overspent). Green and red map onto the existing
contrast-checked `--good` and `--danger` tokens, which already carry AA figures
for both themes.

**Interactions.** Click Assigned to type a number. Click the Available pill to
move money to or from another category.

**Right panel.** Left Over from Last Month, Assigned in `<month>`, Activity,
Available, plus the Underfunded total.

**Phone.** Each category becomes a card: name and target status, progress bar,
then Assigned / Activity / Available in a row. The summary becomes a strip at the
top. Assigning and moving money still work; it is not built for long sessions.

## Import

A script reads the YNAB `Plan.csv` export and writes one move per category per
month for January through August 2026.

January's carry-in comes from December 2025's closing balances, which are clean
and contain no negatives:

| Category | Carry-in |
|---|---|
| Tax Prep | $104.29 |
| Retained Earnings | $480.45 |
| **Total** | **$584.74** |

These are written as opening moves in a December 2025 month that navigation never
reaches.

**Expect $1.01 in Ready to Assign in January.** The app's Chase opening balance
is $585.75; YNAB's carry-in of $584.74 spans Chase *and* the dormant Novo
account. The difference is the stranded penny. It is correct, not a defect.

## Sequencing

Two phases, split on a deliberate line: **phase one never moves money, phase two
does.** Because the goal is proving parity before trusting the screen, every
figure should be verifiable before any path exists that can change one.

Targets are the one write path in phase one, and deliberately so: the YNAB export
carries no target data — YNAB simply does not export it — so Dan re-enters all of
them by hand. A target display with no editor behind it would be dead weight, and
targets are goals rather than money, so editing one cannot move a dollar or
disturb the parity check.

**Phase one — the numbers.** Migration, category convergence, `lib/budget.ts`
with its tests, the import script, and the screen: month navigation, the Ready to
Assign banner, groups and roll-ups, the three columns, target bars and Available
pills, the summary panel, filter chips, and the phone cards — plus setting a
category's target. Nothing here moves money except the one-off import. Ends with
Dan walking January to August against YNAB.

**Targets must be re-entered by hand**, all 17 of them. There is no import path
because there is no export to import.

**Phase two — the hands.** Assigning by typing, moving money between categories,
Undo/Redo, and Recent Moves. Built once the arithmetic underneath is known to be
right, so a wrong number can never be blamed on a write path.

Each phase ships on its own; phase one is useful by itself, since a budget you
can read but not edit still proves the case.

## Testing

- **Committed tests use synthetic fixtures**, covering: positive rollover,
  overspending absorbed by the next month's Ready to Assign, refunds netting
  activity down, a month with no assignment at all, a `by_date` target as its
  deadline approaches, and a category with no target. Dan's real financial data
  stays out of the repository.
- **A one-off verification** runs the app's own math over the real export and
  requires zero mismatches on Available across all 1,421 rows, plus Ready to
  Assign landing on $0.00 for August 2026. Reported, not committed.
- Standard gates unchanged: `npm test`, cold `npx tsc --noEmit`, `npm run build`.

## Accepted limitations

- **Targets have no history.** YNAB stores only a target's current state, and so
  does this. Looking back at March judges March against today's target, so the
  status wording on closed months can read oddly. Assigned, Activity and
  Available remain exactly right. Versioning targets by month is real work for a
  cosmetic gain; backlogged instead.
- **No split transactions.** One occurred in all of 2026.
- **No credit-card handling.** There is no card in the books.
- **Novo Checking is not imported**, which is the whole of the $1.01.

## Out of scope

Auto-assign, month notes, target snoozing, Cost to Be Me and expected income, the
view-density toggle, bulk-select checkboxes, importing budget history before 2026,
and importing the pre-2026 register.

## Dan's ledger punch list

Independent of the build; doing these makes the two books agree to the penny.

1. Import the **$592.10** Fairmont Hotel Chicago charge (8/20).
2. Add the missing **$35.00** Insurance refund.
3. Add the missing **$112.51** of Audio Tools refunds.
4. **The $400 round trip — accept it as a known variance for now.** YNAB splits
   the 3/5 owner-pay row two ways, $400 of it to "Temporary Transfer"; the app
   records it whole. Its counterpart is already in the ledger: a **+$400.00**
   inflow on 3/2 from Smith Checking, sitting as an uncategorised `transfer`.
   **This one cannot be fixed in the app as it stands** — there is no split UI
   (deliberately out of scope, one split in all of 2026), there is no "Temporary
   Transfer" category in the converged chart, and `lt_nocat_for_transfer` still
   forbids a category on a transfer row. So Owner Pay will read $400 heavier
   than YNAB for March, and the inflow sits in Ready to Assign. Both are
   explainable and neither is a defect; closing the gap needs either split
   support or a decision to record the round trip differently.
5. Categorise the three **$15.00 Monthly Service Fee** rows (1/30, 2/27, 3/31)
   to **Retained Earnings**, which is where YNAB books them. This is also why
   `Bank Fees` can be retired — YNAB has never used it.
