# Hours on the invoice, and freezing the backup

**Status:** approved 2026-08-14

## Context

Dan's invoices bill a day rate plus overtime. The day rate needs no defending —
it was agreed in advance — but the overtime is the line a production accountant
queries, because it is the one that varies. Today the invoice asserts
`Overtime x7 @ $117.00` and offers nothing behind it.

The punch tracker already holds what would answer that question: in and out
times, meal breaks, and the straight/overtime/double-time split for every day.
None of it reaches the client.

This adds an hours page to the invoice PDF, and — because the same flaw would
otherwise apply to it — freezes the PDF's backup pages onto the invoice at bill
time.

## Decisions

| Question | Decision |
|---|---|
| Detail | Clock times per day: in, meal, out, net, and the ST/OT/DT split |
| Where the option lives | `clients.show_hours_on_invoice`, off by default |
| Page order | Invoice, hours, expense itemisation, receipts |
| Data | **Frozen onto the invoice at bill time**, not derived live |
| Scope of the freeze | Hours *and* the existing expense itemisation |

### Why clock times, not totals

A daily total justifies the arithmetic; clock times justify the *claim*. A
production accountant holds a call sheet and wants to reconcile against it, and
"8:00 AM – 8:30 PM, 30m meal" answers that without a phone call. Totals alone
mean the client must take the overtime on trust, which is precisely what the
page exists to avoid.

The trade-off is real and accepted: this publishes when Dan arrived and left.

### Why per client

Some clients want backup and some do not — a production company does, a church
does not. It is a property of the client, like their rate card, so it is set
once on the client record rather than remembered per invoice. Forgetting a
per-invoice checkbox would mean the client chases Dan for hours he could have
attached.

## Freezing

Invoice **lines** are already a snapshot: `invoice_lines` is written at bill
time and never recomputed. The expense itemisation shipped without that
property, deriving live from `shows where invoice_id = …`. The consequence is a
known defect: unlink one show from a two-show invoice and page 1 still charges
`Meal Expenses $386.21` while the itemisation re-derives to `$266.21` — the same
document disagreeing with itself by $120.

Hours make that worse rather than equally bad. Hours are the *justification* for
money already charged, so backup that contradicts the charge is worse than no
backup: it converts a client's silent trust into an active dispute.

So the backup pages are frozen the way the lines are.

```
invoices
  backup_snapshot  jsonb        -- null on every invoice billed before this
```

Shape:

```json
{
  "show_hours": true,
  "shows": [{
    "name": "PwC Orlando",
    "zone_label": "Eastern",
    "days": [{
      "date": "2026-08-30",
      "in": "8:00 AM", "out": "8:30 PM",
      "meal_minutes": 30,
      "net_hours": 12.0, "st_hours": 10.0, "ot_hours": 2.0, "dt_hours": 0,
      "travel_in": false, "travel_out": false, "half_day": false,
      "meal_penalties": 0
    }]
  }],
  "expenses": [{
    "category": "meals", "where_spent": "HMS Host",
    "amount_cents": 1998, "spent_on": "2026-05-16",
    "receipt_path": "…/…-enhanced.jpg"
  }]
}
```

Three consequences worth stating plainly:

- **Clock times are frozen as formatted strings** in the 12-hour form
  `friendlyTime` already produces (`lib/zonedTime.ts`), already rendered in the
  show's zone. A punch is stored as an instant, so keeping the instant would let
  a later edit to the show's timezone retro-shift times a client has already
  received. The zone label is frozen beside them so the page says which clock it
  is quoting.
- **`show_hours` is frozen too**, so a sent invoice is a fixed document. Because
  that would otherwise be a dead end — bill an invoice, then learn the client
  wanted hours — the invoice page carries a toggle for a billed invoice that
  rewrites this one flag. An explicit act, not silent drift.
- **`receipt_path` is frozen, not the image.** The bucket is private and its
  signed URLs are short-lived, so the path is what can be stored; the image is
  fetched at render as it is today.

### No backfill

Every one of the 105 historical invoices was imported from the spreadsheet and
has no linked show, no punches and no expenses — verified, not assumed. Their
snapshot is null and they render no backup pages, which is exactly what they do
today. There is therefore one code path, not a frozen one and a live one.

## The page

Between the invoice and the expense itemisation — labour first, then costs,
matching the order of the lines on page one. Grouped by show, a row per day:

```
HOURS — INVOICE #391

PWC ORLANDO · Eastern
Fri  8/29   travel in
Sat  8/30   8:00 AM – 8:30 PM   meal 30m    12.0    10.0 ST   2.0 OT
Sun  8/31   9:00 AM – 7:00 PM   meal 30m     9.5     9.5 ST
Mon  9/01   8:00 AM – 9:00 PM   meal 60m    12.0    10.0 ST   2.0 OT   meal penalty
                                  TOTAL     33.5    29.5 ST   4.0 OT
```

Travel days and half-days are **labelled, not given hours**. A travel leg bills
a flat rate and carries no punches; showing it blank with no explanation invites
the question the page exists to prevent. Meal penalties are shown for the same
reason — they are a billed line the client would otherwise have to infer.

A show with no completed punches contributes a heading and its labelled days but
no hours rows.

### Prep time is deliberately absent

PM entries are **not** on this page. Dan's decision, and it makes the page
sharper: this is a record of days on site, which is what a client reconciles
against a call sheet. Prep is work done at home weeks earlier, it bills as its
own `PM Hours` line, and putting it here invited a complication rather than
answering a question — PM minutes are summed and rounded UP to the next whole
hour, so 90 minutes bills as two, and the page would have had to explain that
to avoid reading as an overcharge.

The snapshot therefore stores no PM data and the page has no prep rows.

### Rounding

Day hours are computed with **exactly the rounding billing uses** — the same
`roundingMinutes` argument `computeShowLines` passes to `calculateNetHours`. A
page derived from the same punches but rounded differently would disagree with
the invoice by a few minutes, which is worse than not showing it at all: it
invites a query about a discrepancy that is purely cosmetic.

## The invariant, as a test

`computeShowLines` emits `Overtime` with `qty_hundredths` equal to hours times
100 — `700` is seven hours. So the backup and the charge are checkable against
each other:

- **The OT hours summed across the snapshot must equal the `Overtime` line's
  quantity on the invoice**, and likewise double time against `Double Time`.
  PM hours are not on the page, so there is nothing to reconcile for them.

Two views of the same work that can silently disagree is the failure this
project keeps finding — a $1,560 overbill, a preview showing $5,850 against an
invoice of $6,226.21, an itemisation $120 adrift. This one is written as a test
rather than an intention.

Also tested:

- A client with the flag off produces no hours page, whatever the snapshot holds.
- An invoice with a null snapshot renders exactly as it does today.
- A travel-only day contributes a labelled row and zero hours.
- A show with prep entries still renders no prep rows.
- Frozen clock strings survive a later change to the show's timezone unchanged.

**No test writes to the live database or sends mail.**

## Out of scope

- **Editing punches after billing.** A billed show is locked; unlink it first.
  That is existing behaviour and this does not change it.
- **An hours view outside the PDF.** The show page already shows punches live.
- **Re-freezing a snapshot after unlinking.** Unlink releases a show for
  re-billing; the original invoice keeps the backup it was sent with, which is
  the entire point.
