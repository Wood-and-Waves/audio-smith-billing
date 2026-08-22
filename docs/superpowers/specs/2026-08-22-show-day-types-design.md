> **Postscript (2026-08-22, from planning):** the table below originally said
> "travel rate × legs". That was loose prose, not the shipped rule — a day
> carrying BOTH `travel_in` and `travel_out` counts as ONE travel day at ONE
> travel rate (`isTravel` is a `||`), which is pinned by an existing test and
> matches Dan's own "2 travel days" framing. Corrected in place. Note this
> diverges from BILLING, where `computeShowLines` bills two legs on such a
> day — pre-existing, conservative in the forecast's direction, and recorded
> in docs/BACKLOG.md rather than changed here.
>
> Also: §Testing below claims "one existing test must change, deliberately."
> That did not happen — all six partition assertions from the earlier wave
> survived verbatim and pass unchanged; only the `day()` fixture line (which
> gained `travel_works`) and a section comment moved. Better than the spec
> prescribed (no test had to be rewritten to keep asserting a true thing),
> but the sentence below now misdescribes what shipped — left as a record of
> the gap, not corrected in place, since the code and tests are what ships.

# Show day types — travel that is also worked

*Dan: "It would be good for forecasting to allow day types for first and last
day. So travel + day rate or travel only. Most of the time I know this ahead
of time." (2026-08-22)*

The forecast currently GUESSES which days of a show are travel days. This
replaces the guess with knowledge for the case Dan usually has — he knows in
advance — while leaving the guess in place for shows he has not marked.

## The gap this closes (and the one it doesn't)

Worth stating precisely, because half the obvious problem turns out to be
already solved:

- **Invoices are already correct.** `computeShowLines` (`lib/showBuckets.ts`)
  counts `travel_in`/`travel_out` legs OUTSIDE its `st > 0` gate, so a
  flagged day with no punches bills its travel leg and no day rate, and a
  flagged day that WAS worked bills both. Billing already reflects reality.
- **The forecast is what cannot tell.** A show that has not happened has no
  punches, so `lib/forecast.ts` has no way to know whether a future travel
  day will also be worked. Today it assumes travel days are never worked
  (`a travel day is never also a work day`), which is conservative but wrong
  whenever Dan does both — his own words: *"Sometimes we travel and work the
  same day which would be more money."*

So this is a forecasting feature. It adds one fact the app could not infer.

## Data model — migration 0036 (additive)

```
alter table show_days add column travel_works boolean not null default false;
```

`travel_works` means: *this travel day is also a work day.* It is meaningful
only on a day that already carries `travel_in` and/or `travel_out`; on any
other day it is ignored (and the UI does not offer it).

Default `false` is the conservative choice and matches the forecast's
existing behaviour, so migrating changes no existing number.

**Why a flag and not a `day_type` enum.** Migration 0005 deliberately dropped
`day_type` and made travel a flag precisely because a day can be flown in
AND worked — an enum forces exclusivity that the real world does not have.
`travel_in` and `travel_out` are separately-billed legs and a single day can
carry both, so any enum would either lose that or need a fourth value. A
boolean alongside the existing flags keeps 0005's model intact and is purely
additive.

## Behaviour

### Forecast (`lib/forecast.ts`)

Today: travel days are determined by flags (or assumed on the first and last
day of an out-of-state multi-day show), and a travel day is never a work day.

After: a travel day contributes its leg(s) as now, and **additionally
contributes a work day when `travel_works` is set** — a full day, or a half
day when `pay_as_half_day` is also set.

| Day | Projects |
|---|---|
| No travel flags | day rate (half if `pay_as_half_day`) |
| Travel flag(s), `travel_works` false | one travel rate |
| Travel flag(s), `travel_works` true | one travel rate + day rate |
| Travel + works + half day | one travel rate + half day rate |

**The assumption remains a fallback only.** As today, if ANY day on a show
carries a travel flag, the out-of-state first/last-day assumption does not
run at all — Dan's marks govern the whole show. Assumed travel days are
never `travel_works` (nothing has been marked, so nothing is known), which
keeps the assumption the conservative one it was designed to be.

`ShowProjection` gains nothing new: `dayCount` already counts work days and
`travelDays` counts travel days, and a travel-and-worked day now correctly
appears in BOTH — so the invariant `dayCount + travelDays === days.length`
no longer holds and its comment must be corrected rather than preserved.

### Invoices

Unchanged. `travel_works` never reaches `computeShowLines`, `billShows`, an
invoice line, a PDF, or an email. A day marked travel-only that ends up
worked still bills its day rate from the punches — the forecast will simply
have under-promised, which is the direction it should err.

## Screens

**Show page day rows** (`app/shows/[id]/page.tsx`) gain a fourth control
beside `Travelled in` / `Travelled out` / `Half day`, rendered **only when
that day carries a travel flag**: a checkbox labelled `Also working`. A new
`components/TravelWorksToggle.tsx` mirrors `TravelLegToggle` exactly
(client component, `useTransition`, `router.refresh()`, inline `{error}`,
disabled when the show is locked).

When both travel flags are cleared from a day, its `travel_works` is cleared
too — a stale true would otherwise sit invisible and silently change the
forecast if travel were re-flagged later.

**Show creation is untouched.** Dan had travel-day options removed from the
create screen deliberately (2026-08-21); this does not reintroduce them. The
out-of-state assumption covers unmarked shows.

## Guards

- New action `setDayTravelWorks(showDayId, value)` in `app/shows/actions.ts`,
  modelled on `setTravelLeg`: auth, walk the day's own FKs to find the show
  for the billed lock (never trust a caller-supplied id for the lock
  decision), owner-scoped, `revalidatePath` on the show.
- Forecast still writes nothing and reaches no client-facing surface.
- Money stays integer cents; the half-day rate keeps `Math.round(rate/2)`.

## Testing

`scripts/test/forecast.test.ts`: a travel day with `travel_works` adds a day
rate on top of its leg; without it, unchanged; travel + works + half day
gives leg + half rate; a day with both `travel_in` and `travel_out` plus
`travel_works` gives two legs + one day rate; `travel_works` on a day with no
travel flags is ignored; an ASSUMED travel day is never treated as worked;
a show with marked days does not also get assumed days; `dayCount` and
`travelDays` both count a travel-and-worked day.

**One existing test must change, deliberately.** The travel-days wave pinned
`dayCount + travelDays === days.length` (the two partition the block). A
travel-and-worked day now counts in both, so the invariant becomes
`dayCount + travelDays === days.length + (worked travel days)`. Update that
test to assert the new relationship rather than deleting it — it is the
guard that catches a day being counted in neither.

## Out of scope

Marking day types at show creation. Any change to how travel days bill.
Rendering travel days differently on the calendar or in the ICS feed (already
a separate backlog item). The 2-day out-of-state case Dan deferred — explicit
marks now make it answerable, but the fallback assumption's own handling of
it is unchanged.

## Ship

Migration 0036 to prod FIRST, then merge.
