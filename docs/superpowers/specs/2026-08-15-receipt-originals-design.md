# Retiring receipt originals, and archiving them to Dropbox first

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

Two facts found while scoping:

- **`receipt_original` is never displayed.** It is written on upload and read
  only by the two cleanup paths. Nothing in the UI or the invoice PDF reaches
  it. Removing it changes nothing a user can see.
- **The originals still earn their keep as insurance.** The contrast stretch has
  mangled a faint thermal receipt before — enhancement was flattening pale
  totals to white until the `MIN_SPAN` guard went in. Deleting the only untouched
  copy gives that insurance up.

So the originals leave Supabase, but they do not stop existing: they are copied
to Dropbox, which Dan already pays for, and deleted only once that copy is
confirmed.

An earlier draft made the archive a manual per-show export. Dan's improvement:

> *"Can't you just copy the originals over to dropbox if we set up the
> authorization at 'deletion' time?"*

An archive you have to remember is one that eventually gets forgotten. Automatic
copying is strictly better, and the manual export survives as a fallback and for
handing one show's receipts to an accountant.

## Decisions

| Question | Decision |
|---|---|
| Archive to | Dropbox, an **App folder** app — never Full Dropbox |
| Layout | `receipts/{year}/{show name}/` — individual files, not a zip |
| Archive when | Continuously, bounded per run — not tied to payment |
| Delete when | Invoice `paid`, payment ≥30 days old, **and** archived |
| What is deleted | `receipt_original` only — `receipt_path` is never touched |
| Verified by | Size **and** Dropbox content hash, before any delete |
| Where it runs | The existing daily reminders cron |
| Also | A per-show zip **export**, working with zero setup |

### Ship order, which is not negotiable

**Export → archive → verify archiving is real → only then enable deletion.**

Migration 0015 dropped a column in the same migration that replaced it and took
the live app down. The rule learned there applies exactly: a change that REMOVES
something ships AFTER the thing that preserves it, never with it. Deletion is
the last stage and stays off until the archive is demonstrably working against
real data.

## Credentials

Three values: `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`, `DROPBOX_REFRESH_TOKEN`.

- **Dan creates the Dropbox app and obtains the refresh token himself**, and
  pastes all three directly into Vercel. They do not pass through a chat
  message, a file in this repo, or any tool. This is the same handling the
  service-role key and `ANTHROPIC_API_KEY` already get.
- **None may take a `NEXT_PUBLIC_` prefix.** They are read in exactly one file:
  `app/api/cron/reminders/route.ts`, the same file already permitted to read
  `SUPABASE_SERVICE_ROLE_KEY`.
- **App folder access type, not Full Dropbox.** The app's root becomes
  `/Apps/{app name}/` and it can see nothing else. Naming the app `smith-audio`
  produces `/Apps/smith-audio/receipts/…` while the code writes plain
  `receipts/…`.
- Access tokens are short-lived; the refresh token is exchanged for one at the
  start of each run. A missing or rejected credential means the archive stage is
  skipped and **nothing is deleted** — never a hard failure of the whole cron,
  which still has reminders to send.

## Schema

**One additive migration.** `expenses.receipt_archived_at timestamptz null` —
the record that a given original is safely in Dropbox. Nothing else changes, and
nothing is dropped.

Inferring archived state by listing Dropbox on every run was considered and
rejected: it is slow, it is rate-limited, and it makes deletion depend on a
listing being correct at that instant.

## The archive

Runs in the daily cron, before the deletion stage.

**Selection.** Any expense with a non-null `receipt_original` and a null
`receipt_archived_at`, oldest first. Deliberately **not** gated on payment:
archiving early spreads the work out, so by the time an invoice is 30 days paid
its originals have long since been copied.

**Bounded per run.** Vercel's Hobby plan caps a function at 60 seconds, and a
single 4MB original is a download from Supabase plus an upload to Dropbox. A
fixed small batch per night, draining over as many nights as it takes. The
30-day grace period means there is never a hurry.

**Naming.** `receipts/{year}/{show name}/{date} {vendor} {amount}.jpg` — for
example `receipts/2026/PwC Tax Start/2026-08-22 HMS Host 19.98.jpg`. The year
comes from the show's first day, so one trip never splits across two folders.
Storage names are `{stamp}-original.jpg`, which is meaningless in an archive;
these are readable years later without the database in front of you.

Sanitising and de-duplicating those names is pure logic and gets tests:
characters illegal in a path, a vendor OCR never read, a show name with a
slash in it, and two identical receipts from one vendor on one day.

**Verification, which is the whole basis for deleting.** Dropbox's upload
response carries the stored size and a content hash. Both are checked against
the bytes that were sent before `receipt_archived_at` is set. The content hash
is Dropbox's own scheme — SHA-256 over the concatenated SHA-256 of each 4MB
block — computed locally and compared. Size alone would catch a truncated
upload; the hash also catches a corrupted one, which matters when the other copy
is about to be destroyed.

**Failure is safe by construction.** Any failure — expired token, network,
mismatch — leaves `receipt_archived_at` null, so the file is retried tomorrow
and can never be deleted in the meantime. Failures are counted and reported;
they are not thrown.

## The deletion

Also in the cron, after the archive stage.

**An original is deleted only when all three hold:**

1. Its show's invoice has `status = 'paid'`.
2. The payment is at least 30 days old. Payments are a table rather than a
   column, because partial payments work, so the date is `max(payments.paid_on)`
   for that invoice. An invoice hand-marked paid with no payment row has no such
   date; those fall back to `invoices.updated_at::date`.
3. `receipt_archived_at` is not null.

**Never touched:**

- `void` invoices. Voiding frees the show to be rebilled, so those expenses are
  live again.
- `draft` and `sent` invoices, and shows never billed.
- `receipt_path`, under any circumstance. It is the billing evidence and the
  thing the client was sent.

**Order of operations: delete the file, then null the column.** Not the reverse.
Nulling first and then failing the delete would leave a file with no record of
its path anywhere — an orphan that can never be found again. This order means a
failed null is retried on the next run, where the delete is a harmless no-op
against an already-missing object.

**Idempotent.** A missing object is not an error, and a nulled column is never
revisited.

**Reported, never silent.** The cron already returns a JSON summary; archived
count, deleted count, bytes reclaimed and failures join it.

## The export

**`lib/zipStore.ts`** — a zip writer, pure and tested. STORE method only: JPEG
and PDF are already compressed, so deflate would cost CPU on a phone to save
nothing. No zip64; a show's originals will not approach 4GB. Local file headers,
a central directory, an end-of-central-directory record, and CRC-32 per entry.
Bytes in, bytes out, no clock — entry timestamps come from the expense's
`spent_on`.

Entries use the same names as the Dropbox archive, from the same sanitiser.

**Client-side.** The browser already mints signed URLs for receipts; it fetches
each original, assembles the zip in memory, and saves it. Nothing passes through
the server, which keeps a 100MB archive out of a serverless function.

**Placement.** On the show page beside the expenses, showing how many originals
are still held and how many are archived: *"12 originals — 12 archived."* That
line is Dan's only visibility into whether the archive is actually working, so
it belongs where he will see it. A show with none shows nothing.

**This is a desktop action.** An 80MB zip on a phone over hotel wifi is not the
intent, and the button does not pretend otherwise.

## Testing

Pure logic, tested:

- **Zip structure** — a written archive unzips with the system `unzip`, with the
  right entries, byte-identical contents, and no warnings. This is the test that
  matters; a hand-rolled zip only this code can read is worthless.
- CRC-32 against known vectors; an empty archive is valid rather than corrupt.
- **Dropbox content hash** against Dropbox's own published example, plus a file
  spanning exactly one block boundary and one just over it.
- Naming: illegal characters removed, a missing vendor still yields a usable
  name, a show name containing a slash cannot escape its folder, two receipts
  from one vendor on one day do not collide.
- Deletion eligibility as a pure function over rows: paid-and-aged-and-archived
  qualifies; paid-but-recent does not; **archived-null never does**, whatever
  else is true; `void`, `draft` and `sent` never do; no payment row falls back
  to `updated_at`.

**No test uploads to Dropbox, deletes from the live bucket, writes to the
database, or calls the Anthropic API.**

## Out of scope

- **Serving receipts from Dropbox.** The invoice PDF keeps reading the enhanced
  copy from Supabase; making a user-facing render depend on Dropbox being up is
  a bad trade.
- **Restoring an original from Dropbox back into the app.** If it is ever
  needed, it is in a browsable folder. Building a restore path for a case that
  has never come up is not earned.
- **Re-enhancing from an original.** If a receipt is unreadable the fix is to
  re-photograph it.
- **Emailing a warning before deletion.** The show-page counts are the
  visibility, and deletion now requires a verified archive anyway.
