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
columns, reusing `computeShowLines` (`lib/showBuckets.ts`) with a synthetic
"standard day" per scheduled date rather than real punches:
- a normal show day → one straight-time day at `day_rate_cents`
- `pay_as_half_day` → half
- a day flagged `travel_in`/`travel_out` with no other work → `travel_rate_cents`
- **no overtime, no double time, no meal penalties** — a projection assumes
  the day goes as planned
- an **hourly** show (`bill_hourly`) has no day rate to lean on, so it
  projects its own straight-time threshold (`ot_after_hours`) as the assumed
  day length at its hourly rate

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
  value stays visible beside it.
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
