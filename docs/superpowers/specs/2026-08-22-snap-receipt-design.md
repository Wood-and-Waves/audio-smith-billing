# Snap a receipt — design

*Dan, on the road: "Snap a receipt would be very helpful right now. I am
finding myself digging for the receipt capture. It all works well, its just
quite low in the page." (2026-08-22)*

Nothing about receipt capture is broken. The pipeline — corner detection,
flattening, enhancement, the original-plus-enhanced upload pair, OCR — works
and Dan trusts it. The problem is purely reach: the control that starts it
lives inside the add-expense form at the bottom of `ExpenseLog`, which is
itself below the day rows, punch clocks, PM log and the whole expense list.
On a phone, on a show floor, that is a lot of scrolling to photograph a
dinner receipt.

This wave shortens the path. It changes nothing about what happens to the
image once it is taken.

## Decisions (Dan, 2026-08-22)

1. **The button lives in the mobile header**, so opening the web app on his
   phone puts it under his thumb without scrolling anything. His words: *"I
   would like this on the header of the mobile version. So when I click my
   web app button on my phone it is at the top."*
2. **The show is inferred from today**, not asked for. If today falls inside
   exactly one booked show's dates, that is the show. He is almost always
   photographing a receipt *while on the gig*.
3. **The photo lands on a confirm screen**, OCR-filled, and nothing is saved
   until he taps Add. A misread amount must never reach an invoice silently.

## Choosing the show

In order:

1. **On a show page** (`/shows/{id}`) → that show. No question.
2. **Anywhere else** → the show with a `show_days` row for today. Today is
   resolved in Chicago (`todayInChicago()`), matching the shows-list
   precedent, not in each show's own zone: this is a list-grade decision
   across many shows, and the detail page's zone-exact treatment does not
   generalise to "which of my shows am I on right now."
3. **No match, or more than one** → a picker: shows with a day within ±7
   days of today first, then the rest by most recent day, capped at a
   readable number with the full list one tap away.

**The chosen show is always named on the confirm screen, with a control to
change it.** The inference is a default, never a commitment — a wrong guess
must be visible before anything is written, because a misfiled receipt lands
on the wrong client's invoice.

Shows that are `billed` are excluded everywhere: their expenses are frozen
and `addExpense` would refuse anyway. If the ONLY candidate for today is
billed, that counts as no match and the picker opens.

## The flow

```
[header camera button]
        │
        ├── on a show page ────────────────► that show
        ├── today inside exactly one show ─► that show
        └── otherwise ─────────────────────► show picker
                                                │
                                                ▼
                                    native camera (capture="environment")
                                                │
                                                ▼
                        the existing pipeline: components/receiptCapture.ts
                        (corners → flatten → enhance → upload pair) + extractReceipt
                                                │
                                                ▼
                                        confirm screen
                     show name (tappable to change) · flattened image ·
                     vendor · amount · date · category · non-reimbursable
                                                │
                                     ┌──────────┴──────────┐
                                  [Add]              [Add + another]
                                     │                     │
                              back where he was      camera again, same show
```

## What the confirm screen shows

- **The show name**, prominent, with a change control. This is the guess
  being made visible.
- **The flattened image**, large enough to read the total — the whole point
  of corner detection is that the total is legible, and it is what tells him
  the OCR figure is right.
- **Vendor, amount, date, category**, pre-filled from `extractReceipt`,
  every one editable. Category defaults to the app's existing default rather
  than an OCR guess.
- **Non-reimbursable** checkbox, so a per-diem meal is marked in the same
  pass instead of needing a later edit.
- **Add** and **Add + another**. The second returns to the camera for the
  same show — trips generate receipts in clusters (dinner, bags, car) and
  re-navigating between each is the same digging this wave exists to remove.

On **Add**, it calls the same `addExpense` path the form uses today, then
returns Dan where he was. Nothing new is written to the database; no new
table, no new column.

## What this does NOT do

- **No offline queue and no pending tray.** Both create a place receipts pile
  up unseen, and an uncompleted receipt is one that cannot be billed. Dan
  said the current pipeline works; this wave is about reaching it faster.
- **No change to the capture pipeline.** `components/receiptCapture.ts`
  stays the ONE implementation both `ExpenseLog` and `MoneyRegister` consume
  (a house rule — never re-inline it into a screen).
- **No desktop button.** Receipts are not photographed at a desk.
- **The existing in-form picker stays.** It is still the right control for a
  batch of receipts scanned later, and for PDFs emailed after a trip.

## Guards

- Every write goes through the existing `addExpense` server action:
  owner-scoped, storage paths prefix-checked `{owner_id}/{show_id}/`, billed
  shows refused. Nothing here bypasses it.
- The show picker lists only the signed-in owner's shows (RLS plus the
  explicit filter every show read in this app carries).
- A non-reimbursable expense still never reaches an invoice — the existing
  `expenseLines` / `buildBackupSnapshot` chokepoints are untouched.
- The confirm screen never auto-submits, on any path.

## Testing

The show-choosing rule is the only new logic worth pinning, and it is pure:
`lib/showPicker.ts` (or an addition to an existing lib if one fits), tested
in `scripts/test/`:
- today inside exactly one show's dates → that show
- today inside two shows → no automatic pick (picker)
- today inside none → no automatic pick
- a billed show is never picked automatically and never offered
- boundary: today equal to a show's first day, and to its last day, both
  count as inside
- ordering of picker candidates: within ±7 days first, then most recent

UI and server actions stay untested by convention.

## Ship

No migration. Merge when green.
