# Batch receipts, and catching duplicates

**Status:** approved 2026-08-15

## Context

Receipt capture handles one photo at a time: pick, wait, confirm, Add. That is
the right shape at an airport gate. It is the wrong shape for what Dan actually
does most — coming home from a six-day trip with a dozen receipts sitting in his
camera roll, and adding them one at a time.

Dan: *"having a bunch of receipts in the photo roll in my phone and sending them
at once."* This is a **phone** flow, not a desktop one. Twelve 3–5MB photos being
decoded on an iPhone is the constraint the design has to respect.

He also asked for something that had not come up: *"We should also add a
duplicate receipt checker. That does happen sometimes where I'll scan the same
receipt twice."*

## Decisions

| Question | Decision |
|---|---|
| One photo | **Unchanged** — fields fill in place, one tap to Add |
| Several photos | A **review list**, one row per receipt |
| While it runs | Rows **fill in as each finishes**, a few at a time |
| Exact duplicates | Dropped **before upload**, from the file bytes |
| Probable duplicates | **Flagged and unticked**, never dropped |

### Why one photo keeps its own path

The inline flow is what gets used standing at a gate holding a coffee, and it is
two taps. Routing a single receipt through a review table to save one code path
would make the common travelling case worse to protect the code. Two paths, each
suited to its case — and they share every piece of machinery below the UI:
`enhance`, the upload pair, `extractReceipt`, the validator.

### Two kinds of duplicate, caught differently

**The same file, selected twice.** Certain, and knowable from the bytes before
anything is uploaded. Hash each file client-side, drop the repeat, and it never
costs an upload or an API call. Silent — there is nothing to decide.

**Two photographs of one receipt.** Only knowable after OCR, by vendor, amount
and date agreeing. This is a *probability*, not a fact: two $6 coffees at the
same Starbucks on the same day are two real expenses, and Dan is exactly the
person that happens to. So a suspected duplicate is **flagged and unticked, with
the row it matched named** — never dropped, never auto-merged.

**The comparison includes expenses already on the show**, not just others in the
batch. Photographing the same receipt a week apart is the case he described, and
a batch-only check would miss it entirely.

## How it behaves

```
pick 12 photos
   ↓
hash them, drop exact repeats          ← no upload, no API call
   ↓
review list opens with a row each
   ↓
each row: enhance → upload pair → read → fill      (a few at a time)
   ↓
suspected duplicates unticked, with a reason
   ↓
correct anything wrong, tick or untick
   ↓
[ Add all ]
```

**Nothing is saved until Add.** Same rule the single flow follows: OCR proposes,
a human confirms. A row whose receipt could not be read appears with blank fields
rather than being hidden — an unreadable receipt is still an expense, it just
needs typing.

**Unticked rows have their uploads removed** when Add runs. The files had to
exist for OCR to read them, so an unticked row leaves two objects behind; a
best-effort delete is cheap and keeps the bucket honest. A failed delete is
ignored — an orphaned file costs nothing, which is this project's established
direction.

**Concurrency is bounded.** Twelve 5MB photos decoded at once will exhaust a
phone. A small number in flight at a time, so early rows are correctable while
the rest are still going.

## Data model

**No schema change.** Every row becomes an ordinary `expenses` insert through the
existing `addExpense`, with the same guards: the show not billed, category in the
fixed four, a positive integer amount, a valid plain date, and receipt paths
prefixed `{user.id}/{showId}/`.

Duplicate detection is computed, never stored. A hash exists only for the life of
the picker.

## Testing

The duplicate rules are pure and get tests:

- Two files with identical bytes: the second is dropped, and the survivor keeps
  its place in the list.
- Two files with different bytes are both kept, even when their OCR agrees —
  the exact check is bytes only.
- Same vendor, amount and date as another row: flagged, **not** removed.
- Same vendor and amount but a different date: not flagged.
- Same vendor and date but a different amount: not flagged.
- A match against an expense **already on the show** is flagged the same way.
- Vendor comparison is case- and whitespace-insensitive: `HMS Host` matches
  `hms  host`. It comes off a photograph, so it will not be typed identically.
- A row with no amount cannot be a duplicate of anything — there is nothing to
  compare, and flagging every unreadable receipt as a repeat of the last one
  would be worse than not checking.

**No test uploads to the live bucket, calls the API, or writes to the database.**

## Out of scope

- **Merging duplicates.** Flagging is enough; Dan decides.
- **Detecting duplicates across shows.** A receipt belongs to the trip it was
  spent on, and the same vendor and amount on two different trips is a
  coincidence, not a repeat.
- **Reordering the review list.** It arrives in the order the files were picked.
