# Hourly billing, below the overtime threshold

**Status:** approved 2026-08-16

## Context

Dan does some work — a church, Willow Creek — that pays by the hour, not by the
day. The billing engine has no way to express that. `computeShowLines` is
anchored entirely on a day rate: a worked day bills one flat `day_rate_cents`
(or half, if toggled), and overtime and double-time are derived as fractions of
that day rate against hour thresholds. A six-hour day bills a full day.

The arrangement, in Dan's words:

> *"When I am hourly, it is sub 10 hour day. If it is 10 hour or more then
> standard dayrate + OT applies. I am $60/hour or $600/day."*

The key fact that makes this small: **the hourly rate is always the day rate
divided by the overtime threshold.** $600 ÷ 10 = $60. So the day rate is simply
"ten hours' worth," and the crossover at ten hours is seamless — a ten-hour day
bills $600 whether you compute it hourly or as a day rate. There is no minimum
call: a two-hour day bills 2 × $60 = $120, linear to zero.

This is therefore not a separate "hourly billing" subsystem. It is one rule
change on the day-rate line, gated behind a switch, for shows that want it.

## Decisions

| Question | Decision |
|---|---|
| The rule | A sub-threshold worked day bills `net hours × hourly rate` instead of a flat day rate |
| Hourly rate | **Derived, never stored**: `round(day_rate_cents ÷ ot_after_hours)` |
| The switch | `bill_hourly` boolean on the rate card and the show (freeze-at-creation, like every rate) |
| 10h+ days | Unchanged — day rate + overtime exactly as today |
| Minimum call | None — linear down to zero hours |
| Short-turnaround | **Disabled** whenever `bill_hourly` is on |
| Half-day toggle | Ignored (hidden) in hourly mode |
| Travel / PM / meal | Unaffected; absent lines simply don't appear when their card rates are zero |

### Why derive the hourly rate rather than store it

Dan confirmed the hourly rate is *always* day ÷ threshold. Storing a separate
`hourly_rate_cents` would be a second number to maintain that could silently
drift out of agreement with the day rate — flexibility for a case that does not
exist. Deriving it means the two can never disagree, and there is no new rate
field to fill in. A rate card with a $600 day and a 10-hour threshold *is* a
$60 hourly card.

### Why short-turnaround turns off

Short-turnaround double-time is a rest penalty for corporate/Streamline work
where two calls are scheduled too close together. A church paying by the hour
has no such concept. Leaving it on would let a short-rest church day bill
double-time at the ten-hour minimum — over-billing a client who just wanted
hours. `isShortTurnaround` already returns false when
`short_turn_penalty_enabled` is off (`lib/payroll.ts:108`), so this is one flag,
and it flows correctly through the straight-time and double-time functions with
no special-casing.

## Data model

**One additive migration.** `bill_hourly boolean not null default false` on both
`client_rate_cards` and `shows`. Default false means every existing show and
card is unaffected; Dan flips it on for Willow Creek. Nothing is dropped or
altered.

`rulesetAndRatesFor` (`lib/showBuckets.ts`) already turns a show's frozen
columns into a `ShowRuleset` and `ShowRates`. It gains:

- `ShowRates.bill_hourly: boolean` — from `show.bill_hourly`.
- `ShowRates.hourly_rate_cents: number` — `round(day_rate_cents / ot_after_hours)`.
- `ShowRuleset.short_turn_penalty_enabled: !show.bill_hourly` (was hardcoded `true`).

## The calculation

In `computeShowLines`, the per-day loop currently does, for a worked day
(`st > 0`, which already excludes short-turnaround days because their straight
time is zeroed):

```
if (st > 0) {
  if (d.pay_as_half_day) halfDays += 1
  else dayRateDays += 1
}
```

It becomes:

```
if (st > 0) {
  if (rates.bill_hourly && st < rules.overtime_after_hours) hourlyHours += st
  else if (d.pay_as_half_day) halfDays += 1
  else dayRateDays += 1
}
```

- `st < overtime_after_hours` is exactly "under ten hours." For such a day,
  overtime and double-time are already zero, so the existing `otHours += ot` /
  `dtHours += dt` lines add nothing — no double-billing.
- A ten-hour-or-more day has `st == overtime_after_hours`, fails the `<`, and
  bills a full day rate plus its overtime as today.
- With `bill_hourly` on, short-turnaround is disabled, so no day takes the
  double-time-penalty path; `st > 0` holds for every worked day.
- `pay_as_half_day` is simply never consulted in hourly mode.

A new line is pushed, carrying the card name like every other line:

```
push(label('Hourly'), hourlyHours, rates.hourly_rate_cents)
```

`hourlyHours` sums each sub-threshold day's straight-time hours across the show,
then rounds once via the existing `toHundredths`, the same way the other buckets
round. `push` already drops a zero-quantity line, so a show with no
sub-threshold days emits no Hourly line.

### How an invoice reads

A church show — day 1 worked 6h, day 2 worked 11h, threshold 10h, day rate $600:

```
Hourly — Willow Creek        6.00 × $60.00   = $360.00
Day Rate — Willow Creek         1 × $600.00  = $600.00
Overtime — Willow Creek      1.00 × $90.00   =  $90.00
```

(The overtime rate is whatever the card already derives; hourly billing does not
change it.)

### Rounding

**Hours round UP to the next whole hour, per day.** 6.25 hours bills 7 hours;
5h20m bills 6. This is not a new rule — `paidNetHours` already ceilings each
day's net hours (`Math.ceil`, `lib/payroll.ts`), the figure Dan validated
against his spreadsheet, and hourly billing reads that same `st` value. So a
6.25-hour day bills 7 × $60 = $420, and the day-rate world's overtime is figured
on the identical whole-hour number — the two can never round differently.

The rate itself: `hourly_rate_cents = round(day_rate_cents / ot_after_hours)`.
For $600 ÷ 10 it is exactly 6000. A non-divisible pairing (say $600 ÷ 9) rounds
to the nearest cent per hour; the line total is `hours × rounded_rate`, a few
cents off a "true" division at most. Dan's numbers divide cleanly, and the
invoice is his to eyeball before it sends.

## UI

**Rate card editor and show settings** (`components/ShowSettings.tsx` and the
rate-card editor): a toggle — *"Bill by the hour below the overtime threshold"* —
with a live derived note: *"Days under 10h bill at $60.00/hr ($600 ÷ 10). 10h+
days bill the day rate plus overtime."* The two numbers in the note recompute
from the day rate and threshold on screen, so it always tells the truth.

**Show page per-day breakdown** (`app/shows/[id]/page.tsx`): the breakdown line
added recently shows `net · ST · OT · DT`. In hourly mode a sub-threshold day
should read as hourly instead — `6.00 hrs → $360.00 hourly` — so it never implies
a day rate it will not bill. A 10h+ day in an hourly show reads normally
(day/ST/OT).

**Half-day toggle** (`components/HalfDayToggle.tsx`, rendered from the show
page): hidden when the show is `bill_hourly`, since hourly billing is already
finer-grained than a half day.

## Testing

`computeShowLines` is the billing core — it produces every invoice line — so the
gate is the important thing. Tests:

- **Regression: `bill_hourly = false` is byte-identical to today.** The existing
  suite already covers day-rate behaviour; add an explicit assertion that a
  representative multi-day show produces the same lines with the flag off.
- A single sub-threshold day (6h) → one Hourly line, 6.00 × derived rate, no Day
  Rate line.
- A day at exactly the threshold (10h) → one Day Rate line, no Hourly line, no
  overtime — the seamless crossover.
- A day over the threshold (11h) → Day Rate + Overtime, no Hourly line.
- A mixed show (a 6h day and an 11h day) → Hourly line for 6h, Day Rate for the
  11h day, Overtime for the 1h over.
- A short-turnaround-shaped pair of days in hourly mode → no double-time penalty;
  each day bills hourly or day+OT on its own hours.
- `rulesetAndRatesFor`: `hourly_rate_cents` derives correctly, and
  `short_turn_penalty_enabled` is the negation of `bill_hourly`.

Pure-function tests only; no database, network, Storage, or API.

## Blast radius

`computeShowLines` and `rulesetAndRatesFor` touch every invoice the app
produces. The entire behaviour change is behind `if (rates.bill_hourly && …)`,
and the migration defaults the flag off, so every existing show and card bills
exactly as before — proven by the regression test, not assumed. One additive
migration. No existing column changes type or meaning.

## Out of scope

- **A stored, decoupled hourly rate.** Derived only, per the decision above.
- **A minimum call / guaranteed hours.** None today; a separate setting if ever
  needed.
- **Per-day choice of hourly vs day-rate.** The switch is per show; the
  threshold decides each day automatically.
- **Hourly overtime at a different multiplier.** 10h+ days use the existing day
  rate + overtime machinery unchanged.
