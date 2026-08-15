# Retiring receipt originals, and getting them out first

**Status:** approved 2026-08-15

## Context

Every receipt is stored twice: `receipt_path`, the enhanced copy — downscaled,
greyscaled, contrast-stretched — and `receipt_original`, the untouched upload.
The enhanced copy is 150–350KB. The original is 3–5MB straight off the phone, so
the original is roughly **95% of what receipts cost**.

Supabase's free tier, which is what this project runs on, gives 1GB. At ~4MB a
receipt that is about 250 receipts, or a dozen shows — under a year of work.

Dan's argument for deleting the originals, which is the right one:

> *"If the invoice and expenses are paid, why do I need to keep the original?
> They've already approved what is there and paid it."*

Payment is the evidence. The client received the enhanced copy, checked it
against the amount, and paid; if that image had been too degraded to read, it
would have come back before the money did. The billing cycle already tests the
enhanced copy on every receipt, long before anything gets deleted.

Two facts found while scoping, both of which shape the design:

- **`receipt_original` is never displayed.** It is written on upload and read
  only by the two cleanup paths. Nothing in the UI or the invoice PDF reaches
  it. It is insurance that is not currently reachable — so removing it changes
  nothing a user can see, and needs no UI work.
- **Storing them elsewhere buys nothing.** Moving receipts to Dropbox was
  considered and rejected: it costs an OAuth app, token rotation, a new secret,
  and a live dependency on Dropbox at the moment the invoice PDF is rendered —
  in exchange for headroom the sweep already provides. What survived from that
  conversation is the export below, which gets the archive without the
  integration.

## Decisions

| Question | Decision |
|---|---|
| When | Invoice `paid`, **and** the payment at least 30 days old |
| What | `receipt_original` only — `receipt_path` is never touched |
| Where it runs | The existing daily reminders cron |
| Schema | **No migration** — the column is already nullable |
| Keeping a copy | A per-show **export** of the originals, run before the sweep |
| Compression | **STORE** (none) — JPEG and PDF are already compressed |

### Why the export exists

The originals are insurance against one specific failure: the contrast stretch
mangling a faint thermal receipt. That has happened — enhancement was flattening
pale totals to white until the `MIN_SPAN` guard went in. Deleting the originals
gives that insurance up.

The export gets it back for the price of one manual step: download a show's
originals as a zip, drop it in Dropbox, then let the sweep reclaim the space.
Dan already pays for Dropbox, so the archive costs nothing, and this way the app
never holds a credential for it.

**The intended workflow:** bill the show → get paid → export the originals →
the sweep removes them 30 days later.

## The sweep

Runs inside `app/api/cron/reminders/route.ts`, which already holds the
service-role key and is the only file permitted to.

**Selection.** An invoice qualifies when `status = 'paid'` and its payment date
is 30 or more days ago. Payments are a table rather than a column, because
partial payments work, so the date is `max(payments.paid_on)` for that invoice.
An invoice hand-marked paid with no payment row has no such date; those fall
back to `invoices.updated_at::date`.

From there: qualifying invoices → the shows carrying `invoice_id` → their
expenses with a non-null `receipt_original`.

**Never touched:**

- `void` invoices. Voiding frees the show to be rebilled, so those expenses are
  live again.
- `draft` and `sent` invoices, and shows never billed.
- `receipt_path`, under any circumstance. It is the billing evidence and the
  thing the client was sent.

**Order of operations: delete the file, then null the column.** Not the reverse.
Nulling first and then failing the delete would leave a file with no record of
its path anywhere — an orphan that can never be found again. Doing it in this
order means a failed null is retried on the next run, where the delete is a
harmless no-op against an already-missing object.

**Idempotent.** A missing object is not an error, and a nulled column is never
revisited.

**Reported, never silent.** The cron already returns a JSON summary; the count
of originals removed and bytes reclaimed joins it.

## The export

**`lib/zipStore.ts`** — a zip writer, pure and tested. STORE method only: JPEG
and PDF are already compressed, so deflate would cost CPU on a phone to save
nothing. No zip64; a show's originals will not approach 4GB.

Needs local file headers, a central directory, an end-of-central-directory
record, and CRC-32 per entry. All pure: bytes in, bytes out, no clock. Entry
timestamps come from the expense's `spent_on` date, passed in.

**Naming inside the zip.** Storage names are `{stamp}-original.jpg`, which is
meaningless in an archive. Entries are named from the expense —
`2026-08-22 HMS Host 19.98.jpg` — so the folder is readable years later without
the database. Sanitising and de-duplicating those names is pure logic and gets
tests: characters illegal in a filename, empty vendors, and two identical
receipts on one day.

**Client-side.** The browser already mints signed URLs for receipts; it fetches
each original, assembles the zip in memory, and saves it. Nothing passes through
the server, which keeps a 100MB archive out of a serverless function.

**Placement.** On the show page beside the expenses, showing how many originals
are still held: *"12 originals — removed 30 days after payment."* That count is
the only visibility Dan has into what the sweep will take, so it belongs next to
the button that saves them. A show with none shows nothing.

**This is a desktop action.** An 80MB zip on a phone over hotel wifi is not the
intent, and the button does not pretend otherwise.

## Testing

Pure logic, tested:

- **Zip structure** — a written archive unzips with the system `unzip`, with the
  right entries, byte-identical contents, and no warnings. This is the test that
  matters; a hand-rolled zip that only this code can read is worthless.
- CRC-32 against known vectors.
- Empty input produces a valid empty archive rather than a corrupt one.
- Entry naming: illegal characters removed, a missing vendor still produces a
  usable name, two receipts from one vendor on one day do not collide.
- Sweep selection: paid-and-aged qualifies; paid-but-recent does not; `void`,
  `draft` and `sent` never do; an invoice with no payment row falls back to
  `updated_at`.

**No test deletes from the live bucket, writes to the database, or calls the
Anthropic API.** Sweep selection is tested as a pure function over rows, not
against Supabase.

## Out of scope

- **Storing receipts in Dropbox.** Rejected above.
- **Automatic upload of the archive anywhere.** The manual step is the whole
  reason this needs no credential.
- **Re-enhancing from an original.** If a receipt is unreadable the fix is to
  re-photograph it, not to reprocess.
- **Emailing a warning before the sweep runs.** The count on the show page is
  the visibility; a second channel for it is not earned yet.
