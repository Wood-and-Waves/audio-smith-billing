# Expenses and receipts

**Status:** approved 2026-08-13

## Context

Expenses are the largest manual step left in billing. They live in a second
Google Sheet — "Gig Expense Calc" — one tab per trip, and every tab has the same
shape: an Hours block (now redundant, the punch tracker replaced it) and three
expense blocks, each a list of *where · amount · Rcpt*, each totalled.

Those totals are the invoice lines. The sheet's `Food Total $52.68` is the
database's `Meal Expenses @ $52.68`; `Ride Total $241.90` is `Ride Expenses @
$241.90`. Retyping that rollup by hand is why the same expense has four names in
five years of invoices — `Baggage`, `Baggage Fees`, `Baggage Expenses`,
`Baggage Fee` — which is also why the data cannot currently be reported on.

Roughly **$10,400 of expenses across ~60 invoice lines**, on the trips that
matter most.

### The correction that shaped this design

An early reading of the sheet's `Rcpt TRUE/FALSE` column suggested some expenses
are receiptless by nature. **That is wrong.** Dan: *"Every expense has to have a
receipt to bill."* The FALSE rows are simply unticked boxes.

That single fact reshapes the feature. Receipts are not an enhancement to add
later — an expense without one cannot be invoiced, so storage and capture belong
in the first version. It also turns a rule Dan currently holds in his head into
one the app can enforce.

## Decisions

| Question | Decision |
|---|---|
| Categories | Four, fixed: meals, rides, baggage, other |
| On the invoice | One rolled line per non-empty category |
| Receipt | **Required to bill.** An expense may be logged without one; the show cannot be billed until every expense has one. |
| Itemisation | A page in the invoice PDF, then the receipt images |
| Delivery | **One PDF** — invoice, itemisation, receipts. Not separate attachments. |
| Image handling | Downscale, grayscale, auto-contrast on upload. **Original always retained.** |
| Upload path | Browser → Supabase Storage directly |

### Categories, and why they are fixed

Each category owns its invoice-line label. That is the whole point: the label
stops being typed, so it stops drifting.

| Category | Bills as | From the sheet |
|---|---|---|
| `meals` | Meal Expenses | HMS Host, Starbucks, hotel restaurants |
| `rides` | Ride Expenses | Uber, taxi, and the flat "To O'Hare $100" |
| `baggage` | Baggage Expenses | United $50 per leg |
| `other` | Expenses | Home Depot, Amazon, FedEx, parking, flight changes |

`other` is not an afterthought — two tabs already head that column "Expenses
Total", and Home Depot at $129.78 and Amazon at $85.12 sit in it.

Per diem is deliberately **not** a category. Some clients are billed a per-diem
rate instead of actual meals; that is a rate-card matter, not an expense, and
mixing them would let an invoice bill both.

## Data model

```
expenses
  id              uuid pk
  owner_id        uuid not null   -> auth.users
  show_id         uuid not null   -> shows (on delete cascade)
  category        text not null   check in (meals, rides, baggage, other)
  where_spent     text not null   -- "HMS Host", "To O'Hare"
  amount_cents    bigint not null check (amount_cents > 0)
  spent_on        date not null
  receipt_path        text        -- storage key, enhanced image
  receipt_original    text        -- storage key, untouched upload
  note            text
  created_at      timestamptz not null default now()
```

**There is no `has_receipt` boolean.** The file is the flag: a receipt exists iff
`receipt_path` is set. A boolean beside a file is a second source of truth, and
the sheet's own `Rcpt` column is the evidence that it drifts.

`where_spent`, not `where` — `where` is a SQL reserved word and quoting it
forever is a tax on every query.

RLS on, owner policy, `revoke all from anon`, grants to `authenticated` and
`service_role` — matching every other table.

### Storage

A **private** bucket, `receipts`. Owner-only read and write via storage RLS. No
public URLs, ever: a receipt carries a vendor, a date and an amount, and the
bucket must not be enumerable.

Path: `{owner_id}/{show_id}/{stamp}-{enhanced|original}.jpg`, where `stamp` is a
timestamp and a short random suffix. Owner first, so a storage policy can match
on the leading path segment.

The name deliberately does **not** contain the expense id: the files are
uploaded before the row exists, so no id has been assigned yet. That ordering is
the point — see below.

The PDF reads receipts through **signed URLs, valid one hour**, generated at
render time. This is what keeps the service-role key out of it: the browser
download and the server-side email send both hold Dan's session, and a signed
URL works for either. An hour is far longer than a render and far shorter than
anything worth leaking.

**The images are fetched to buffers before rendering, in parallel, and handed to
the builder as data.** Letting the PDF renderer fetch twelve remote URLs itself
would serialise twelve round trips inside a serverless function that has a
timeout — the send would work on a two-receipt invoice and fail on a Napa-sized
one. Fetching first also means a failed image is a handled error rather than a
half-rendered document.

## Capture

On the show page, beside the PM log: category, where, amount, date (defaulting
to today), and the photo. On a phone the file input opens the camera, so at an
airport it is photograph → amount → done.

**The browser processes the image before upload, then uploads directly to
Supabase Storage.** Both halves matter:

- *Processes* — a phone photo is 3–5MB. Twelve of them make an attachment mail
  servers reject. Downscaled to 1600px on the long edge, grayscaled and
  contrast-normalised, a receipt is a few hundred KB and reads better than the
  original.
- *Directly* — Next caps a server action's body at 1MB by default, which one
  photo exceeds. Uploading straight to Storage sidesteps the limit rather than
  raising it, and is how Supabase is meant to be used. The server action then
  only records a row.

**The original is uploaded too, untouched.** Thermal receipts fade, and hard
contrast can erase a faint total — the exact number a client would query. The
enhanced copy is what gets shown and sent; the original is the record, and it is
what a future OCR or perspective-correction pass will re-process without anyone
re-photographing anything.

Both are JPEG. Order matters: **upload both files first, then record the row.**
An expense row pointing at a file that failed to upload is a receipt that
appears to exist and cannot be opened — and since a receipt is what makes an
expense billable, that would let a show bill with a broken attachment. If either
upload fails, nothing is recorded and the entry can simply be retried; an
orphaned file in the bucket costs nothing.

## The billing guard

`billShows` already refuses a show with an unfinished punch, and the Bill button
predicts that refusal and names the dates. Receipts get the same treatment:

- A show with any expense lacking `receipt_path` **cannot be billed**.
- The button says which — "2 expenses need receipts: Starbucks, United" — rather
  than failing after the click.

This is Dan's rule, enforced instead of remembered.

## Billing

At bill time, expenses on the show group by category. Each non-empty category
emits **one line**, appended after the labour lines, in the fixed order meals,
rides, baggage, other:

```
Meal Expenses     × 1  @ $266.21
Baggage Expenses  × 1  @ $120.00
```

Quantity is always 1 — the amount is a sum of stored cents, never a rate times a
quantity. A category with no expenses emits no line, matching how empty labour
buckets already behave.

## The PDF

The document gains two things, both only when the invoice has expenses:

1. **An itemisation page** — grouped by category, each row `where · date ·
   amount`, a subtotal per category, and a grand total.
2. **The receipt images**, after it.

**The itemisation's grand total must equal the sum of the expense lines on page
one.** That is a test, not an intention — two views of the same money that could
silently disagree is the failure mode this whole project keeps finding.

An invoice not generated from a show has no expenses and gains no pages.

Because the email attaches the PDF this same builder produces, receipts reach the
client with no separate plumbing.

## Testing

The rollup is a pure function over expenses, so:

- Four categories with amounts produce four lines, labelled exactly, in order.
- An empty category produces no line.
- Real figures from the Napa trip — $266.21 meals, $120.00 baggage, no rides —
  produce exactly two lines, not three.
- The rolled totals sum to the itemisation's grand total.
- Amounts are stored cents, summed, never recomputed from a rate.

The billing guard: a show with an expense lacking a receipt is refused, and the
message names the offenders. A show whose expenses all have receipts bills.

The image pipeline: a wide photo and a tall photo both come out within the size
cap with their aspect ratio intact.

**No test uploads to the live bucket** or sends mail.

## Out of scope

- **OCR, and forwarded-email ingest.** Phase 2. Both are much easier to design
  against a filled-in expense record than in the abstract, and the inbound path
  is half-built already — Resend's "Enable Receiving" on `mail.theaudiosmith.com`
  is switched off, waiting.
- **Perspective correction** — finding a receipt's corners and warping them
  square, the part that makes a photo look like a flatbed scan. It needs
  edge detection and it is the same pipeline OCR wants, so it goes with Phase 2
  and runs over the retained originals.
- **A billable/non-billable flag.** Every expense in five years of the sheet was
  billed. It belongs with bookkeeping, when there is something to distinguish.
- **Mileage, or any computed expense.** Everything here is a receipt for money
  already spent.
