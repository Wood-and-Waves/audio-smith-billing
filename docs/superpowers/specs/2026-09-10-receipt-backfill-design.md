# Receipt backfill — design

**Status:** approved 2026-09-10. Supersedes nothing.

## The problem

317 of Dan's 323 2026 expense rows carry no receipt ($13,667). The 2026 show
backfill (2026-09-10) gave those rows shows to belong to; this gives them
documents.

The machinery to file ONE emailed receipt already exists and is live:
`receipt_inbox` (0050), `readReceiptFromEmail`, `proposeReceiptMatches`, and the
`/money/receipts` UI. What is missing is **bulk**, and the shape of the bulk is
not what the existing pipeline assumes.

## What the source data actually is (measured, do not re-derive)

Dan invoices a client and attaches his expenses. Thirteen such emails cover
Jan–July 2026. Their attachments come in two shapes, and **both are text — there
are no scans to OCR.**

**Shape A, the expense spreadsheet** (his Streamline shows). A table listing
every expense with vendor and amount, in three columns — Food, Ride, Baggage —
with a total per column. Page 1 or 2 of the bundle; the remaining pages are the
receipt images.

```
Food Total   Ride Total   Baggage Total   Total
$266.21      $0.00        $120.00         $386.21
Where                Amount    Where     Amount
The Well             $19.98    United    $60.00
Auntie Anne's        $12.28    United    $60.00
...
```

**The column totals foot exactly** on both bundles examined, and match the
invoice's expense line to the penny. That is the design's self-check.

**Shape B, forwarded email receipts printed to PDF** (his Signature show). No
table; prose. Text is present because it is a printed email, not a scan.

## What matching actually achieves (measured against prod)

Two real bundles, 27 manifest lines, matching on exact amount within 4 days of
the show window:

| | auto-file | ambiguous | no bank row |
|---|---|---|---|
| Praxis | 10 | 3 | 0 |
| IllumiNations | 6 | 2 | 6 |

**The six "no bank row" results are correct, not failures.** Five are Starbucks
receipts of $4.76–$12.14 with no matching charge, because 2026-05-04 carries a
single **Starbucks $25.00 card reload** — the receipts are spend off a prepaid
balance and never hit the bank individually. Hudson is the same story.

This is the rule the design turns on: **a receipt with no bank row is a normal
outcome and must never be forced onto a near-miss.**

The ambiguous cases are genuine ties — two Auntie Anne's charges four days
apart, two United bag fees at $60.00. Dan's decision (2026-09-10): **auto-file
exact matches, queue the rest.**

## The window is 4 days, everywhere

Dan chose 4 over the existing `RECEIPT_MATCH_DAYS = 10`. Measured on his 323
2026 expense rows, the share with no same-amount neighbour inside the window:

| window | unambiguous |
|---|---|
| ±10 days | 83.0% |
| ±4 days | **87.3%** |

**This changes the live `/money/receipts` page too**, not only the backfill.
That is intended — it is one rule, not two — and it is called out here because
`scripts/test/receiptMatch.test.ts` pins the 10/11-day boundary and must change
with it.

## Architecture

A thin imperative script around pure, tested modules — the
`scripts/import/ynab-backfill.mjs` shape.

```
Gmail attachment  ->  PDF text (pdfjs)  ->  manifest lines
                                              |
                   pdf-lib page split  ->  page -> vendor/amount map
                                              |
                              proposeReceiptMatches (4 days)
                                              |
                    exactly one candidate?  --yes-->  file to the bank row
                                              |
                                             no  -->  receipt_inbox, status 'new'
```

### Modules

**`lib/expenseManifest.ts` (pure, new)**
`parseExpenseManifest(textLines: string[]): ManifestParse` — takes the text
lines of one page, returns `{ items: ManifestItem[], totals, foots: boolean }`.
`ManifestItem` is `{ vendor: string, amountCents: number, column: 'food' |
'ride' | 'baggage' }`. `foots` is whether the items sum to the stated totals.
Reading the PDF stays outside; this sees strings only.

**`lib/receiptAutoFile.ts` (pure, new)**
`decideReceiptFiling(matches: ReceiptMatch[]): FilingDecision` — the whole
auto-file rule in one testable place:
- exactly one candidate, and it carries no receipt → `{ action: 'file', txnId }`
- no candidate → `{ action: 'queue', reason: 'no-charge' }`
- more than one → `{ action: 'queue', reason: 'ambiguous' }`
- one candidate that already has a receipt → `{ action: 'queue', reason: 'taken' }`

**`lib/receiptPageMap.ts` (pure, new)**
The schema for the page-identification pass and the validator for what comes
back: `readPageMap(raw, { pageCount }): { pages: PageEntry[] } | { error }`.
Rejects a page number out of range or a duplicate. No network — the model call
lives in the script, as `ynab-backfill.mjs` keeps its I/O in the shell.

**`lib/receiptMatch.ts` (existing, changed)**
`RECEIPT_MATCH_DAYS` 10 → 4. Nothing else.

**`scripts/import/receipt-backfill.mjs` (new)**
Dry run by default, `--commit` to write, `--prod` with the target printed first.
Single-owner detection, one transaction per bundle, and a per-bundle guard: a
bundle whose manifest does not foot is skipped whole, never partially filed.

### Storage and filing

A split page is uploaded to the existing private `receipts` bucket under
`{owner_id}/backfill/`, then written to the bank row exactly as
`fileReceiptToTransaction` does — `receipt_original` always, `receipt_path` only
for images — so a backfilled receipt is indistinguishable from an emailed one.

### Migration 0052 — `receipt_inbox.part`

Queued items belong in `/money/receipts`, where Dan already files by hand, not
in a separate report he would have to learn. But `receipt_inbox_msg_uniq` is
`unique (owner_id, gmail_message_id)`, so one email cannot yield many rows.

0052 adds `part int not null default 0` and replaces that index with
`unique (owner_id, gmail_message_id, part)`. Existing rows keep part 0 and their
uniqueness is unchanged. This is also exactly what the future "an emailed
receipt bundle explodes into many" feature needs, so it is not backfill-only
scaffolding.

## Error handling

- **A bundle whose manifest does not foot is skipped entirely**, reported by
  name. Partial filing of a bundle we cannot verify is worse than none.
- **A page map that disagrees with the manifest item count** queues the whole
  bundle rather than guessing an alignment.
- **A bank row that already carries a receipt is never overwritten** — it
  queues as `taken`.
- A model or network failure fails that bundle, not the run.

## Testing

Pure modules under `node --test`, per house rule; the script is deliberately
untested and kept thin.

- `expenseManifest`: both real bundle shapes as fixtures; a table that does not
  foot; a Ride column that is empty; the `United $10.00` line that sits in the
  Food column, not Baggage.
- `receiptAutoFile`: all four branches, including one-candidate-already-taken.
- `receiptPageMap`: out-of-range page, duplicate page, count mismatch.
- `receiptMatch`: the existing boundary tests move from 10/11 to 4/5.

## Out of scope

- Shape B (forwarded-email bundles) is **read but not itemised** in this pass:
  its receipts queue for hand filing. Only the spreadsheet shape auto-files.
  One client, one show, and the prose has no totals to check against.
- The `/money/receipts` UI does not change. Queued items simply appear in it.
- Reconciling prepaid balances (the Starbucks card) — noted, not modelled.
- The CSV export still carries neither the deductible flag nor reimbursed
  status. Offered, unapproved, unchanged here.
