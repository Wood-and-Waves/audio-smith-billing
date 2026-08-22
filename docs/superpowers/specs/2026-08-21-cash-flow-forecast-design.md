> **Postscript (2026-08-22) — five changes after Dan used it.**
> (1) **Learned pay lags are GONE.** Dan: *"The billing lags are usually
> because I am not home when the check comes."* The lag the model learned was
> an artifact of his mail, not client behaviour — so learning it taught the
> forecast the wrong thing. Every client is now simply their `terms_days`
> (Net 30 across the board today). `payLagFor`, the 365-day window and the
> Journey-anomaly reasoning below are all superseded; the section is kept for
> the record of WHY it existed, not as a description of the code.
> (2) **Out-of-state shows assume two travel DAYS** — not two legs added on
> top of every scheduled day. Dan: *"The standard practice is to have for a 6
> day show, 2 travel days and 4 working days. That is the most
> conservative. Sometimes we travel and work the same day which would be more
> money. For the forecast, lets plan the more conservative."* Travel days are
> part of the scheduled block: a day flagged `travel_in`/`travel_out` (either
> or both) IS a travel day, and a day that's a travel day is never also a
> work day. With nothing flagged, an out-of-state show (its location naming a
> different state than `settings.home_state`, default IL — same-state shows
> are drives, which is exactly the case a city-name test got wrong for South
> Barrington) that runs MORE THAN ONE DAY is assumed to need its FIRST and
> LAST scheduled day as travel — a single-day out-of-town gig is flown in and
> out the same day, so it never gets the assumption. Every remaining
> scheduled day is a work day. Explicitly flagged travel days always win over
> the assumption. Literal consequence, deliberate: a 2-day out-of-state show
> with nothing flagged is 2 travel days and ZERO work days — not
> special-cased. An earlier version of this model added two travel legs ON
> TOP of every scheduled day (a 6-day show billing 6 work days + 2 travel),
> overstating every out-of-state show by two day-rates; that was a bug, now
> fixed.
> (3) **PM shows** carry `shows.pm_role`; when set, the projection adds a
> flat 4 hours at the show's PM rate, once per show. Actual PM work still
> bills from `pm_entries` — this is forecast-only.
> (4) The forecast screen now lists **expected pay per show** with a
> `4 days · 2 travel` breakdown (work days and travel days, which together
> sum to the scheduled block) and marks travel that was assumed rather than
> flagged.
> (5) `ShowProjection.travelLegs` is renamed `travelDays`, and `dayCount` now
> counts WORK days only (not every scheduled day) — `dayCount + travelDays`
> always equals the show's scheduled day count.
> Migration 0035 carries `shows.pm_role` and `settings.home_state`.

# Cash-flow forecast and runway — design

*"I am putting all shows in. This should be able to give me a calculation of
what each show could make and do some cash flow predictions." — and then,
sharper: "I know what I need to take home each month. The cash flow calc
should be able to tell me how far in the future my finances will hold me. If
I make more in one month than I need, it would calculate as for the next
month." (Dan, 2026-08-21)*

The answer is one sentence: **covered through <month>**. Everything below
exists to make that sentence trustworthy.

## Decisions (Dan, 2026-08-21)

1. **Booked work only.** The forecast counts shows actually in the app and
   invoices actually sent. Nothing is invented about future bookings. Because
   a calendar thins out the further ahead you look, the runway line is paired
   with a second line naming the month booked work runs out — so a short
   number reads as "my calendar is thin past November," not "I am going
   broke."
2. **Overhead is the trailing 3-month average**, shown as one number and
   overridable. Self-updating; a one-off purchase inflates it for three
   months, which is precisely when Dan overrides it.
3. **Taxes are modelled** at the `settings.tax_setaside_bp` rate already on
   file (1500 bp = 15% as of 2026-08-21), applied to projected *profit*, not
   gross. The rate is Dan's and his CPA's to set; this app never advises on
   it and never treats the figure as anything but an estimate.
4. **Headline plus a month table.** Dan reads the register as a spreadsheet;
   the forecast shows its arithmetic so he can argue with it.

## The model

A pure function walks months forward from today. Nothing is written; the
forecast is derived on every render.

### Starting balance

`workingBalance − net allocated to envelopes` — the same
"available to allocate" figure `/money/budget` already computes
(`lib/envelopes.ts`). Envelope money is spoken for; counting it as runway
would overstate coverage. Today the envelopes are empty and the two numbers
agree, but the moment Dan funds Taxes the forecast tightens on its own.

### Money in

Two sources, both dated to the month the cash is expected to *land*.

**Unpaid invoices.** For a `sent` invoice, expected payment = `sent_at` +
that client's pay lag (below). A **`draft`** invoice counts too, at its
total, expected to be sent in `billing_lag_days` and paid a pay-lag after
that — otherwise money would vanish in the gap between "show billed" and
"invoice sent," because the show is excluded as billed while its invoice is
not yet sent. `paid` and `void` invoices are excluded.

An invoice whose expected payment date has already passed is assumed to land
in the current month and is flagged in the table — never silently spread
forward, never dropped.

**Booked, unbilled shows.** Projected revenue from the show's own frozen
rate columns. Note it does **not** run through `computeShowLines`: that
function earns the day rate from straight-time hours (`st > 0`), so a booked
show with no punches yet projects $0 through it, and synthesizing punches to
work around that would drag in meal-penalty and short-turnaround rules a
projection must not assume. The projection is its own explicit arithmetic
over the same frozen rates — migration 0005's rule that *every `show_days`
row is a work day* is what makes it simple:
- every scheduled day → one day at `day_rate_cents`, halved when
  `pay_as_half_day`
- each `travel_in`/`travel_out` flag → one leg at `travel_rate_cents`, added
  on top of that day (which is how the real engine bills them)
- **no overtime, no double time, no meal penalties, no PM hours** — a
  projection assumes the day goes as planned
- an **hourly** show (`bill_hourly`) needs no special case: its hourly rate
  is derived as `day_rate_cents / ot_after_hours`, so a full standard day
  bills the identical amount either way. This is the ONE place the
  projection can be optimistic rather than conservative — `bill_hourly`
  exists precisely to divert a day that comes in under the day-rate
  threshold to hourly billing, and the projection has no punches yet to
  know that will happen, so it always assumes the full day. Every other gap
  in this model (overtime, meal penalties, reimbursable overhead above)
  understates what Dan will actually make; this one can overstate it.

Expected invoice date = last show day + the **billing lag** (default 7 days,
adjustable). Expected payment = that + the client's pay lag.

Shows already billed are excluded — their money is an invoice now, counted
above. Shows with no rate card and no rates project $0 and are listed as
such, so a silent zero is never mistaken for "this show earns nothing."

A show whose days are already in the **past** but which was never billed
projects normally; its expected dates land in the past, so it falls into the
same current-month bucket as an overdue invoice and is flagged the same way.
That flag is doing real work — an unbilled finished show is money Dan has
earned and not asked for.

### Pay lag, learned per client

Median days from `sent_at` to `paid_at`, computed **only** over invoices that
carry a `ledger_transaction_invoices` link — a `paid_at` from Mark Paid is
"today," which is a bookkeeping artifact, not a payment date — and **only**
over invoices sent within the last 365 days. At least two qualifying
invoices are required; otherwise the client's `terms_days` is used.

> **Why the 365-day window exists.** On 2026-08-21 Dan's freshly bridged
> books showed Streamline, SPG, Orchard, Payton and Crescent all paying in
> 27–37 days — a genuinely useful signal — alongside four Journey Church
> invoices from 2024–25 that were settled this spring, with lags of 393, 492,
> 649 and 752 days. Learning across all history would model Journey as a
> two-year payer and push its future work off the end of the forecast. The
> window excludes those settlements as the anomalies they are.

Each client's lag is shown in the assumptions with its source — *learned from
N invoices* or *Net 30 (terms)* — so a surprising month can always be traced
to the number that caused it.

### Money out

- **Overhead**: mean of the last three complete calendar months of ledger
  spending, excluding `owner_pay` (paying yourself is not overhead) and
  excluding `transfer`. Overridable; the override is stored, and the computed
  value stays visible beside it. This total includes billable show expenses
  Dan fronts (a flight, a hotel, per diem he pays out of pocket and bills
  back to the client) — the projection has no way to net a later
  reimbursement out of a past month's spend, so those dollars are counted as
  overhead and never earned back here. Conservative and deliberate: it means
  the forecast is quietly harder on Dan than his real cash flow, never
  softer.
- **Tax set-aside**: `max(0, projected income − overhead) × tax_setaside_bp`
  for that month. Profit-based, per the module reference's original intent.
- **Take-home draw**: a flat monthly figure Dan sets (new setting). Seeded
  from history on first use: his owner-pay draws Feb–Jul 2026 total roughly
  $7,600/month.

### The walk

```
balance = startingBalance
for each month M, starting this month:
  income   = invoices expected in M + projected show revenue expected in M
  overhead = monthlyOverhead
  taxes    = max(0, income − overhead) × rate
  draw     = monthlyTakeHome
  balance  = balance + income − overhead − taxes − draw
  if balance < 0 → M is the first uncovered month; stop
```

`coveredThrough` = the month before the first uncovered one. The walk runs a
bounded horizon (24 months) and reports "covered beyond the horizon" rather
than looping forever when income comfortably exceeds costs.

## Screens

**`/money/forecast`** — linked from `/money`'s header row beside Budget and
Reports.

- **Headline**: "Covered through March 2027." Second line: "Booked work runs
  out after November." When the first uncovered month is the current one, the
  headline says so plainly instead of naming a past month.
- **Month table**: one row per month — expected in, overhead, tax set-aside,
  draw, ending balance. The first uncovered month is flagged; the
  booked-work-ends month is marked. Money right-aligned and `tabular`, the
  register's idiom.
- **Assumptions**, below the table: take-home need, overhead (computed value
  shown beside any override), tax rate (read-only here — it lives in
  Settings), billing lag, and the per-client pay-lag list with sources.
  Editing any of them re-renders the forecast.
- **Empty states**: no shows and no unpaid invoices → the page says the
  forecast needs booked work rather than rendering a table of zeros.

**Settings** gains `monthly_take_home_cents` and `monthly_overhead_cents`
(override; null = use computed) and `billing_lag_days`, alongside the
existing `tax_setaside_bp`.

## Guards

- Every projection input is owner-scoped; the page is Dan-only, not a public
  prefix.
- **This is an estimate and says so.** No projection ever writes to the
  ledger, creates a transaction, or funds an envelope. Nothing here is tax
  advice; the set-aside rate is Dan's own figure.
- Money stays integer cents throughout; `parseUSD('')` returns 0, so the new
  settings inputs guard on `trim()` first.
- Reads that could exceed 1000 rows page with `.range()`.
- The forecast never reaches a client-facing surface — it is not in any
  invoice, PDF, email, public page, or the calendar feed.

## Testing

Pure lib `lib/forecast.ts`, tested in `scripts/test/forecast.test.ts`:
projected show revenue for a plain 2-day show, a half day, a travel leg, an
hourly show; pay-lag median with the 365-day window excluding an ancient
settlement; the two-invoice minimum falling back to terms; unlinked `paid_at`
ignored; an overdue invoice landing in the current month; the month walk
carrying surplus forward; the first uncovered month identified exactly;
income exactly equal to costs (balance zero) counting as covered; the
24-month horizon reporting "beyond horizon"; zero-rate shows projecting zero
without crashing; a draft invoice counted once and its show not double-
counted; a past unbilled show landing in the current month flagged.

## Out of scope

Per-show profit display on the show page (the projection lib makes it easy
later, but this wave is the forecast). Scenario comparison ("what if I book
two more Streamline weeks"). Assumed future bookings of any kind. Automatic
envelope funding from projected taxes. Seasonality.

## Ship

Migration 0034 (three additive settings columns) to prod FIRST, then merge.
