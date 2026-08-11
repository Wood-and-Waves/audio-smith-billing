# Show time tracking

**Status:** approved 2026-08-10
**Scope:** time tracking only. Expense tracking with receipt capture is a separate spec.

## Context

Dan works multi-day shows for production companies and single visits for churches. Today he
works out what to bill in his head and types the result into an invoice. Invoice #385 reads:

```
PM Pre/Post Show work  x8   @ $78.00 = $624.00
Day Rate               x6   @ $780.00 = $4,680.00
Travel Rate            x2   @ $390.00 = $780.00
Overtime Rate          x1   @ $117.00 = $117.00
```

Every one of those quantities was worked out by hand, including the judgement of when a long
day crossed into overtime. He already built the machine that does this — CrewTracker's
`lib/payroll.ts`, a line-by-line verified port of his iOS `PayrollCalculator` — but it computes
what to *pay crew*, not what to *bill a client*.

This brings that math into the invoicing app, driven by punch in / punch out, and turns the
result into invoice lines.

It also answers a question the spreadsheet never could: **what have I worked that I haven't
billed for?** Across 105 invoices and 19 clients, a forgotten visit is silent lost money.

## Decisions

| Question | Decision |
|---|---|
| Granularity | Punch in / punch out, like CrewTracker |
| Payroll rules | All seven come across |
| Prep work | Punched like everything else, flagged as a PM day |
| Show → invoice | Many shows can go on one invoice |
| Invoice lines | Generated as an editable draft, not live-linked |
| Meal penalties | Built, default zero — never used to date |

## Data model

```
shows
  id, owner_id, client_id
  name                          -- "GLS 2026", "Sunday services"
  venue                         -- optional
  timezone                      -- default America/Chicago
  status                        -- open | billed
  invoice_id                    -- null until billed
  notes

  -- Rate card COPIED from the client at creation. See "Snapshots" below.
  -- Every value below is STORED, not computed on read. The "defaults" are what
  -- gets written at creation time; each is editable per show afterwards.
  day_rate_cents
  ot_after_hours                -- Streamline 11, everyone else 10
  dt_after_hours                -- null = no double time
  travel_rate_cents             -- written as half the day rate
  pm_rate_cents                 -- written as day_rate / ot_after_hours
  min_meal_break_minutes        -- default 60
  meal_break_deduction_cap_min  -- default 60
  meal_penalty_grace_hours      -- default 6
  meal_penalty_cents            -- default 0
  short_turnaround_rest_hours   -- default 10

show_days
  id, owner_id, show_id
  date                          -- plain date in the show's timezone
  day_type                      -- show | travel | pm
  pay_as_half_day               -- manual flag. The UI only offers it when the
                                -- day's net hours are under 5, but the column
                                -- is honoured whenever set: it is a negotiated
                                -- call, not a computed one.
  notes

punches
  id, owner_id, show_day_id
  punch_type                    -- start | meal_out | meal_in | meal2_out | meal2_in | end
  punched_at                    -- timestamptz
```

Punches hang directly off a day. CrewTracker needs a `timecards` layer between them because it
tracks many people across many rooms; this app only ever tracks Dan.

## Snapshots

Two places freeze data on purpose, for the same reason:

- **The show freezes the client's rate card at creation.** Raising Streamline's day rate next
  year must not retroactively change a show already billed. CrewTracker learned this with
  payroll presets: *"Never a live link — a live link would retroactively rewrite closed shows."*
- **The invoice freezes the computed lines.** Once generated they are ordinary invoice lines,
  editable, and no longer connected to the punches that produced them.

## The calculation

`lib/payroll.ts` ports across with all seven rules intact:

1. Day rate with a minimum guarantee
2. Overtime past `ot_after_hours` at 1.5×
3. Double time past `dt_after_hours` at 2×
4. Meal break deduction — breaks over the minimum are deducted, capped
5. Meal penalties past the grace period, max 2 per day
6. Short turnaround: under `short_turnaround_rest_hours` rest makes the next day double time
7. Travel days at half the day rate

**Floats stop at one boundary.** Hours stay floating point, because 11.5 hours is genuinely
fractional. The moment hours become money they convert to integer hundredths and go through
`lib/money.ts`, where everything is integer cents. CrewTracker computes money in floats; that is
tolerable for a payroll estimate and not for a document a client pays against.

**Per-day ceiling rounding survives.** Each day's net hours round up before summing across days,
so 0.25h of overtime on Monday and 0.25h on Tuesday bills as 2 hours, not 0.5. Dan validated
this convention against a real client payroll spreadsheet.

Day type decides the treatment:

| `day_type` | Bills as |
|---|---|
| `show` | Day rate, minimum guaranteed, plus OT and DT past the thresholds |
| `travel` | `travel_rate_cents`, half the day rate by default |
| `pm` | Actual hours × `pm_rate_cents`, **no** day-rate minimum |

The `pm` row is what makes punch-tracking prep work honest: an hour of email on a Tuesday bills
as an hour, not as a day.

## Output

The calculator returns buckets, which become invoice lines in the shape Dan already uses:

```
Day Rate     x6   @ $780.00
Travel Rate  x2   @ $390.00
Overtime     x7   @ $117.00
PM Hours     x8   @ $78.00
```

Double time, meal penalties and half-days appear only when non-zero — matching the invoice
document's existing rule that zero-value rows are noise.

## Billing flow

1. The shows list carries an **Unbilled** section.
2. Dan selects one or more unbilled shows for the same client and hits **Bill**.
3. A draft invoice is created, pre-filled with the combined lines, fully editable.
4. Each show gets `status = billed` and `invoice_id` set.

**A billed show is locked for editing.** To change punches, unlink it first, which returns it to
unbilled. Without the lock, editing punches would silently change the hours behind an invoice a
client already holds. This mirrors CrewTracker's `finalized_at` lock on a signed-off show.

Only shows for the same client can be combined onto one invoice.

## Edge cases

- **Overnight shifts.** A punch-out at 2am belongs to the previous show day. Which day a punch
  belongs to derives from the show's timezone, never from UTC or a raw `Date()`. This exact bug
  hit CrewTracker twice — once producing a 33.5-hour day.
- **Punch chronology.** Out-of-order punches are rejected on entry. Port the validation from
  CrewTracker's `lib/punches.ts`.
- **Incomplete days.** A day with a start and no end can't be billed. It is shown as incomplete
  and blocks billing that show until resolved.
- **Zero-hour days.** A travel day with no punches still bills its travel rate; that is the point
  of the day type.
- **Short turnaround looks within a show only.** A Streamline run ending at 11pm followed by a
  Journey Church visit at 8am is two shows and won't trigger the rule. Cross-show detection is
  deliberately out of scope.

## Testing

- Port CrewTracker's payroll tests, adapted to integer-cent output.
- Reconstruct invoice #385's buckets from synthetic punches and assert the calculator produces
  6 day rates, 2 travel days, 1 overtime hour and 8 PM hours.
- Overnight shift: a punch-out after midnight lands on the correct show day under
  `TZ=America/Chicago`.
- Ceiling rounding: two days with 0.25h of overtime each bill 2 hours.
- Snapshot: editing a client's day rate after a show is created does not change that show.
- Lock: attempting to edit punches on a billed show is refused.

## Out of scope

- Expense tracking and receipt capture — separate spec.
- Cross-show short-turnaround detection.
- Tracking anyone other than Dan.
- Rooms, positions, or crew scheduling. That is CrewTracker's job, and this app should not grow
  into a second copy of it.
