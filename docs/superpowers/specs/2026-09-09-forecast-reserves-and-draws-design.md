# Forecast: reserved money and planned draws

**Status:** design agreed 2026-09-09, not built.

## The problem

Dan asked how the forecast works and whether it reflects what he has spent and
budgeted. Reading it against live data found two things.

**1. The forecast counts reserved money as runway.** Its starting balance is
the account's working balance, full stop. `app/money/forecast/page.tsx` already
documents this as a known gap:

> "it does NOT subtract money the real budget has already assigned to a
> category this month — so this figure can present money Dan already gave a
> job as still free to spend. That's a real gap ... closing it (making the
> forecast budget-aware) is deliberately deferred, not fixed here."

(`availableToAllocate` subtracts `ledger_envelope_moves`, a table the 0030
envelope feature shipped empty and which nothing can write to any more, so the
subtraction is permanently zero.)

Measured 2026-09-09: bank **$18,350.27**, of which **$15,802.47** is reserved
in categories other than owner pay — including **$13,000 held for taxes**. The
forecast was treating the taxman's money as available runway.

**2. The current month's draw is pro-rated by calendar day, and his draws are
nothing like even:**

```
March  $5,912   April  $6,070   May    $9,501   June $8,712
July  $14,936   August     $0   September $925 (so far)
```

Dan: *"Proration is just flat out incorrect for how this should be
calculated."* August was zero and July was nearly $15,000; a calendar fraction
cannot describe that.

## What we are building

### 1. Starting balance = bank minus reserved money

Dan: *"All saving money except for any in owner investment, pay, and personal
expenses, should be off limits. They are saved for a purpose and not a
payout."*

    startingBalance = workingBalance
                    − Σ max(0, availableCents) for every category
                        EXCEPT OWNER_PAY_CATEGORY_NAME

**Owner pay is the one exception, and the reason is structural, not a
preference.** Its balance is reserved for the very thing the forecast already
subtracts — the draw. Taxes and Retained Earnings are reserved for things the
forecast does NOT model, so leaving them in inflates the runway. Dan: *"That
available is set aside for the next time I pay myself ... it needs to remain
on the forecast."*

`max(0, …)` per category: an overspent category must not quietly hand runway
back. (None are overspent today; this is a guard, not a fix.)

The category is identified by `OWNER_PAY_CATEGORY_NAME`
(`lib/ledgerCategories.ts`), the same constant `deriveKind` already matches on
— not by a new string literal.

### 2. Planned draw per month

A new per-month figure, defaulting to `settings.monthly_take_home_cents`
($7,500), editable for any month the forecast displays.

**Why not derive it from the budget:** the owner-pay category's monthly
assignment looks like a draw plan and is not one. September assigns
**$3,784.65** while Dan intended to take **$925** — because the envelope
accumulates toward future draws and also carries personal expenses. Checked
before proposing; it cannot answer this question.

**Schema** (migration `0051`):

```sql
create table forecast_draw_plans (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references auth.users(id) on delete cascade,
  month        date not null,          -- first of the month
  amount_cents integer not null check (amount_cents >= 0),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (owner_id, month)
);
```

Owner-scoped RLS matching the project's existing tables. Additive only.

### 3. The current month charges what is LEFT to draw

    drawCents(month 0) = max(0, plannedDraw − ownerPayAlreadyDrawnThisMonth)

`ownerPayAlreadyDrawnThisMonth` = sum of outflows on `kind = 'owner_pay'` dated
in the current month. Verified against prod: every transaction in that category
is `kind = owner_pay`, all outflows, no inflows — so no netting problem.

September: $925 planned − $925 drawn = **$0 more to take**, which is correct
and which neither pro-ration nor a flat monthly figure can express.

### 4. Overhead: full month, no pro-ration

Pro-ration comes out of month 0 for overhead too, but overhead is NOT given
the "what's left" treatment. With Dan's manual override in force, "overhead
spent so far this month" has no clean definition, and most of a month's actual
spend is reimbursable gig cost that is not overhead at all. Charging the full
month is simple, errs conservative, and bounds the error at $800.

Tax set-aside is unchanged: it already follows `incomeCents − overheadCents`.

## Consequences, stated up front

- Every forecast line drops by the reserved total (**~$15,800** today).
  Dan: *"The runway doesn't get shorter. It gets more accurate and more
  conservative which is important."*
- **The current-month draw reads imported bank data.** If Dan pays himself and
  has not imported, that line runs OPTIMISTIC until he does. Every other change
  here errs pessimistic; this one does not, and it is the only one that can
  flatter him.
- Runway now moves when Dan re-budgets even though the bank has not changed
  (money into Retained Earnings shortens it). Correct, but new behaviour.

## Deliberately NOT doing

- **Overhead derived from budgeted targets.** Discussed at length; his groups
  cannot express it (Savings holds Tax Prep, which is a real future payment,
  beside Taxes, which the forecast already models, and Retained Earnings, which
  is not a cost). Doing it properly needs a per-category "counts as overhead"
  flag. He is keeping the manual override instead, which is defensible: his
  true non-reimbursable overhead measured **$657.60/month** against an $800
  override, and a flat figure survives lumpy annual bills better than a
  trailing average does.
- **A one-off planned purchase with a date.** Only if he asks.

## Verification

- `lib/forecast.ts` is pure and already has tests; every rule above gets one,
  including the floor at zero and the owner-pay exception.
- After deploy, the starting balance must equal
  `bank − Σ max(0, available) + ownerPayAvailable` — checkable against
  `/money/budget` on the same day.
- September's draw line must read $0 remaining while `owner_pay` for September
  totals $925.
- Gates per commit: `npm test`, cold `npx tsc --noEmit`, `npm run build`.
- **Prod migration FIRST, then merge** — the ship order is non-negotiable.
