# Travel legs and bulk day entry

**Status:** approved 2026-08-10
**Supersedes:** the `day_type = 'travel'` decision in `2026-08-10-show-time-tracking-design.md`

## Context

Two problems surfaced the first time the show tracker was used for real.

**Adding days is one at a time.** A Streamline trip runs eight days. Building it means eight
separate actions.

**A day can only be one thing.** `show_days.day_type` is a single value — `show | travel | pm` —
so a day where Dan flies in and then works cannot be expressed. He bills both on such a day.

The second is a modelling error, and the invoice history says so plainly. Across every multi-day
trip, travel bills as **exactly two legs**, never one and never three, while day rates range from
one to six:

```
#385  PM Pre/Post Show work x8 | Day Rate x6 | Travel Rate x2 | Overtime Rate x1
#384  PM Hours x4             | Travel Rate x2 | Day Rate x1  | Overtime x7
#367  Travel Day Rate x2      | Day Rate x5    | Overtime x19
```

Travel is not a *day*. It is a *leg* — one out, one back — which may or may not share a calendar
date with work. Modelling it as a day type forces a choice the real world does not.

Load-out needed no modelling at all: #388 bills *"Lighting Tech Load-in/Load-out ×3 @ $780"* as
plain day rates. Load-out is punched work like any other.

## Decisions

| Question | Decision |
|---|---|
| How a travel leg is recorded | A flag on a day, not a day type |
| Billing on a hybrid day | Travel leg **and** full day rate — additive, never a substitute |
| Bulk entry | A plain date range. Travel legs are ticked deliberately afterwards. |
| A date carrying both PM and show work | Allowed. Constraint unchanged; a guard prevents double travel legs. |

## Data model

`show_days` changes:

```
day_type     text   -- 'show' | 'pm'          ('travel' removed)
travel_in    boolean not null default false   -- new
travel_out   boolean not null default false   -- new
```

Three states fall out of this without special cases:

| Day | Row |
|---|---|
| Flew in, did nothing else | `travel_in`, no punches |
| Flew in, worked the show | `travel_in`, punches |
| Worked the show | punches |

A pure travel day bills its leg and nothing else, because straight time, overtime and double time
are all zero without punches. That is existing behaviour in `lib/payroll.ts`, not new logic.

**Migration.** Production holds zero shows, so this is a no-op in practice — but it must still be
correct if a show exists by the time it runs. Convert any `day_type = 'travel'` row to
`day_type = 'show'` with `travel_in = true`, then tighten the check constraint to the two
remaining values.

**The unique constraint stays `(show_id, date, day_type)`.** A date may carry a show row and a PM
row — two hours of prep in the morning at the straight-time rate, the show that evening at the day
rate. Narrowing it to `(show_id, date)` would be tidier and would remove a capability that might be
needed, so it stays.

**The guard that replaces it:** setting a travel leg checks that no other row on that date already
carries the same leg, and refuses with a message naming the date. One arrival cannot bill two legs.

## Billing

`computeShowLines` loses a branch rather than gaining one. Today it counts travel *days*; it will
count travel *legs*:

```ts
travelLegs += (d.travel_in ? 1 : 0) + (d.travel_out ? 1 : 0)
```

and emit `Travel Rate × travelLegs @ travel_rate_cents`. The `day_type === 'travel'` branch is
deleted.

This reproduces `Travel Rate ×2` on every trip in the history without the tracker needing to know
that a trip has two ends — it emerges from the two flags being ticked.

Nothing else in the calculation changes. `lib/payroll.ts` already treats a day with no punches as
zero hours, and its `isWorkDay` check keys on `day_type === 'show'`, which still holds.

## Bulk day entry

One control replaces the current single-day add:

- **Start date** — defaults to the day after the show's last day, or today if the show is empty
- **End date** — defaults to the start date
- **Day type** — `show` or `pm`
- Creates one row per date in the range, `travel_in` and `travel_out` both false

Travel legs are ticked afterwards, per day, on the rows the control creates. They are deliberately
**not** pre-ticked: a local job has none, and unticking something that was assumed is a worse
default than ticking something that was not.

Because the start date follows the show's last day, extending a run and setting one up are the same
control rather than two.

**Behaviour that is not negotiable:**
- A date that already has a row of that type is **skipped, not an error** — re-running a range that
  overlaps must not fail halfway and leave a partial trip.
- An end date before the start date is refused.
- A range longer than 60 days is refused, as a fat-finger guard.
- The whole thing refuses when the show is billed, like every other write path.

## Edge cases

- **A day with a travel leg and an unfinished punch** is still incomplete and still blocks billing.
  The travel leg does not make an incomplete day billable.
- **Both legs on one day** is legitimate — fly in, work, fly home — and bills two legs plus the day
  rate. That is invoice #384's shape.
- **A travel leg on a PM day** is allowed. Nothing forbids travelling to do prep work.
- **Deleting a day** deletes its travel legs with it, which is correct: the leg belonged to that day.

## Testing

- Two shows' worth of days where the first and last carry the legs: assert `Travel Rate ×2`
  regardless of how many days sit between them.
- A single day with both legs and punches: assert one day rate **and** two travel legs, proving the
  additive rule from invoice #384.
- A day with a leg and no punches: assert a travel leg and **no** day rate.
- Bulk add over a range that overlaps existing days: assert the existing ones are untouched and the
  new ones are created.
- The double-leg guard: adding `travel_in` to a second row on a date that already has it is refused.
- Migration: a pre-existing `day_type = 'travel'` row becomes a `show` row with `travel_in = true`.

## Out of scope

- Pre-ticking travel legs on a bulk add. Considered and rejected above.
- Recording travel times or flight details. A leg is a flat half-day rate; nothing bills by the hour.
- Cross-show short-turnaround detection, still out from the original spec.
