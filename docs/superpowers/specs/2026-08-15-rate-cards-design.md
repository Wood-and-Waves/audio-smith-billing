# Rate cards, travel, client addresses, and naming the work

**Status:** approved 2026-08-15

## Context

Four requests that all land in the same place — what a client's rate agreement
actually is, and what the invoice says about it.

The one that forces the change: **Streamline Pictures pays two day rates.**
$900 for PwC PM work, $780 for everything else. Today a client has exactly one
`day_rate_cents`, frozen onto each show at creation. Dan can already get a $900
show by creating it and editing the rate afterwards — but `travel_rate_cents`
and `pm_rate_cents` were derived from $780 at creation and are left behind,
silently, which is the trap that prompted the ask.

## Decisions

| Question | Decision |
|---|---|
| Two rates for one client | **Named rate cards**, chosen when a show is created |
| The existing single rate | Becomes an **unnamed default card** |
| Where the name shows | On the invoice line, **only for named cards** |
| Travel full or half day | **On the card**, not the client |
| Client address | Structured `city` / `state` / `postal_code` |
| Show name on the invoice | A **`FOR:` heading** above the line items |

### Why the default card is unnamed

Every existing client has one rate. If that card were named — "Standard" — then
`Day Rate — Standard` would appear on every invoice for every client, including
the many who will only ever have one rate. That is noise added to documents that
currently read cleanly.

An unnamed card decorates nothing. Streamline gets an unnamed $780 card and a
named `PM` card at $900, and only their invoices gain the distinction:

```
Day Rate — PM   × 3  @ $900.00
Day Rate        × 2  @ $780.00
```

Every other client, and all 105 historical invoices, are untouched.

### Why travel sits on the card

A card is the whole rate agreement, not just a number: day rate, overtime
threshold, and how travel is paid. Putting travel there also means Streamline's
PM work could pay travel differently from their standard work without anything
being moved later.

**Travel bills per leg**, and that does not change. So "full day" means a
fly-in/fly-out trip bills **two** day rates where it currently bills one. That
is the intended reading — some companies pay a full day for each travel day —
but it is a doubling, so the client editor should state it plainly.

## Data model

```sql
client_rate_cards
  id               uuid pk
  owner_id         uuid not null   -> auth.users
  client_id        uuid not null   -> clients (on delete cascade)
  name             text            -- NULL = the default card
  day_rate_cents   bigint not null check (day_rate_cents > 0)
  ot_after_hours   numeric(4,1) not null default 10
  travel_full_day  boolean not null default false
  created_at       timestamptz not null default now()

-- Exactly one default per client. A second unnamed card would make "which rate
-- does a new show get" ambiguous, and the answer would be whichever row came
-- back first.
create unique index client_rate_cards_default_once
  on client_rate_cards (client_id) where name is null;
```

**Backfilled from the existing column**: every client with a `day_rate_cents`
gets an unnamed card carrying it and their `ot_after_hours`. Nothing is invented.

**Verified against the live database, in a rolled-back transaction: that is 11
cards from 20 clients.** Nine clients have no day rate at all — including
Journey Church, the highest-volume client in the book at 24 invoices, and
Harvest Bible Chapel at 8. Those invoices were written by hand through
`InvoiceEditor` rather than billed from shows, which is why no rate was ever
needed. They will simply have no card, and `createShow` continues to refuse them
with the message it already gives: *"has no billable day rate on file, so there
is no rate card to freeze onto this show."* Nothing regresses; they gain nothing
until a rate is entered. **The client editor should make an empty rate card
visible rather than silent**, so it is obvious why a show cannot be created.

`clients.day_rate_cents` and `clients.ot_after_hours` **stay in place but stop
being read**, marked superseded with a `comment on column`. Dropping them in the
same migration would be irreversible on a live database holding 20 real clients;
a later migration can remove them once the cards are proven. Every read moves —
`createShow`, the client list's rate summary, and `InvoiceEditor`'s price hints —
so there is one source of truth even while two columns exist.

### The show freezes the card, as it already freezes the rates

```sql
alter table shows add column rate_card_name text;  -- NULL = the default card
```

Consistent with the existing design: *"The rate card is COPIED onto the show, not
referenced. Raising a client's day rate next year must not retroactively change
a show already billed."* The name is frozen for the same reason the numbers are —
renaming a card later must not rewrite an invoice already sent.

At creation, `travel_rate_cents` becomes `day` when the card says full day and
`travelRateFrom(day)` when it does not; `pm_rate_cents` derives from the chosen
card's day rate and threshold.

That is the actual fix for the trap Dan described. Editing a show's day rate to
$900 after creating it from a $780 client leaves `travel_rate_cents` and
`pm_rate_cents` derived from $780, because `updateShow` takes all three as
independent raw inputs and re-derives nothing. Picking the right card at
creation makes all three correct at once.

### Naming the work

```sql
alter table invoices add column work_for text;   -- NULL on everything existing
```

Set by `billShows` to the comma-joined show names, and rendered as a `FOR:` line
under `BILL TO` on both the PDF and the on-screen invoice.

Show names already reach the invoice — `billShows` puts them in `notes` — but
`notes` prints in the small muted footer beside the payment block, and **hand-
editing an invoice through `InvoiceEditor` overwrites it**, because the textarea
is the source of truth for that field. `work_for` is separate precisely so it
cannot be lost that way: `InvoiceEditor` never sends it, and `saveInvoice` must
leave it alone on update, exactly as it now leaves `backup_snapshot` alone.

Null renders nothing, so hand-written and historical invoices are unchanged.

### Client address

```sql
alter table clients add column city text;
alter table clients add column state text;
alter table clients add column postal_code text;
```

`bill_to_snapshot` is a newline-joined string that both renderers simply split,
so the only change is what goes into the join: name, line 1, line 2, then
`City, ST ZIP` assembled from whichever parts are present.

**Existing addresses are not migrated.** Today the convention is that line 2
carries "Lake in the Hills, IL 60156" as free text, and 20 real clients follow
it. Parsing that automatically would be a guess applied to live billing
addresses. The fields are added empty and Dan moves them across as he edits each
client — but that creates a real footgun, because filling in the city while
leaving it in line 2 prints it twice on the next invoice. **The client editor
must say so where it is visible**, not in a doc nobody reads.

## Invoice lines

`computeShowLines` takes `ShowRates`; that type gains `rate_card_name: string |
null`. When it is set, **every line whose price derives from the card** carries
the suffix — Day Rate, Day Rate (half), Travel Rate, Overtime, Double Time, PM
Hours.

Decorating only the day rate would be worse than decorating none: a PM card with
a $900 day rate also has a $135 overtime rate against the standard $117, so an
invoice mixing them would show two `Overtime` lines at different prices with
nothing to tell them apart — the exact confusion this feature exists to remove.

`mergeLines` keys on description **and** price, so a decorated line and an
undecorated one at different prices already stay separate; the suffix makes the
separation legible rather than creating it.

## Testing

The rate lines are pure, so:

- A null card name produces exactly today's descriptions — asserted against the
  existing expected strings, because 105 historical invoices depend on them.
- A named card suffixes every rate-derived line, and no others (expense lines
  are unaffected).
- Two shows on one invoice, one PM and one standard, merge into separate
  labelled lines whose quantities and prices are each correct.
- `travel_full_day` yields a travel rate equal to the day rate; false yields
  half. A two-leg trip bills two day rates in the first case and one in the
  second — the doubling stated as a test, since it is the surprising part.
- `bill_to_snapshot` includes `City, ST ZIP` when present and omits the line
  entirely when all three are blank.

**No test writes to the live database or sends mail.**

## Out of scope

- **Dropping `clients.day_rate_cents`.** A later migration, once cards are proven.
- **Parsing existing addresses** out of `address_line2`.
- **Per-show rate card changes after creation.** The show's rates remain editable
  individually, as they are today; switching a billed show to another card is not
  a thing.
- **Rate cards for anything but shows.** `InvoiceEditor`'s hand-written invoices
  read the default card for their price hints and stop there.
