# Download PDF on the live invoice link — design

## Problem

The public invoice link (`/i/[token]`) shows the invoice as a web page but
offers no file to save. A client who wants a PDF has to dig the original
attachment out of the email. Dan wants a **Download PDF** button on that page
that produces the same document the email sends — including the expense
breakdown — **but without the receipt photos** (his explicit choice, so the
public route needs no access to private receipt storage).

## Goal

Add a `/i/[token]/pdf` route that regenerates the invoice PDF on demand —
invoice + the frozen hours/expense itemization, receipt images omitted — and a
**Download PDF** button on the public page that points at it.

## Scope

- **In:** a new public PDF route, a shared PDF-render helper (extracted from
  `sendInvoice` so the email and the link render identically), a security-definer
  DB function to read the frozen backup by token, a button on the public page,
  and a file-tracing entry so the fonts/logo ship with the new route.
- **Out:** receipt images in the public PDF (Dan's choice — omitted). Storing the
  sent PDF (rejected in favor of regenerate-on-demand). The emailed PDF and the
  authenticated in-app download are unchanged in output.

## Key facts this design leans on

- `buildInvoicePdf(parts, data, assets)` already renders the expense itemization
  and the hours backup pages from `data.backup`, and **skips the image** for any
  expense whose `receiptDataUri` is `null` (that is exactly how the email path
  degrades a missing receipt today). So "itemization without photos" = the
  emailed `data` with every `receiptDataUri` set to `null`.
- The public page reads through `public_invoice(p_token)` — a security-definer
  function returning only the document columns (no `ach_details`, no backup).
  `anon` has zero table privileges. This stays the page's only reader, unchanged.
- The frozen backup lives in `invoices.backup_snapshot` (jsonb): `show_hours`,
  `shows[]`, hour totals, and `expenses[]` (with `receipt_path`, **no** image
  bytes). The client already received all of this in the emailed PDF.

## Architecture

### 1. Shared PDF render — `lib/renderInvoicePdf.ts` (new, server-only)

Extract the render block currently inline in `sendInvoice` into one function so
the email and the link cannot drift:

```
renderInvoicePdf(data: DocumentData): Promise<Buffer>
```

- Dynamically imports `@react-pdf/renderer`, registers the Oswald font from
  `process.cwd()/public/fonts`, calls `buildInvoicePdf({ Document, Page, Text, View, Image }, data, { logoSrc: process.cwd()/public/logo.png })`, and `renderToBuffer`s it.
- `'server-only'`; it reads the serverless filesystem for the font/logo.
- `sendInvoice` is refactored to build its `data` (with receipt images, as now)
  and call `renderInvoicePdf(data)` instead of its inline block — **identical
  output**, just relocated. Its existing try/catch that turns a render failure
  into `{ error }` stays in `sendInvoice`, wrapping the call.

### 2. Backup reader — migration `0023_public_invoice_backup.sql`

A second security-definer function, so the existing `public_invoice` (and thus
the public page) is untouched and the backup is exposed only to the PDF route:

```sql
create function public.public_invoice_backup(p_token uuid)
returns jsonb
language sql security definer set search_path = public stable
as $fn$
  select i.backup_snapshot
  from invoices i
  where i.public_token = p_token and i.status <> 'void'
$fn$;
grant execute on function public.public_invoice_backup(uuid) to anon, authenticated;
```

- Returns the raw `backup_snapshot` (or `null`) for the non-void invoice matching
  the token. Same trust model and void-exclusion as `public_invoice`. Contains no
  `ach_details`. `receipt_path` strings ride along but never reach the browser
  (see route). Applied via `db:sql` (transaction pooler) with the checksum
  recorded in `schema_migrations`, per this repo's migration workflow.

### 3. Public PDF route — `app/i/[token]/pdf/route.ts` (new)

`export const runtime = 'nodejs'` and `export const dynamic = 'force-dynamic'`
(the render needs the Node runtime + filesystem).

`GET(req, { params })`:
1. Validate `token` against the same UUID regex the page uses; a bad shape →
   404 (never let a malformed uuid reach Postgres).
2. `createClient()` (anon server client, as the page uses). Call
   `public_invoice(p_token)` → document, and `public_invoice_backup(p_token)` →
   backup. On RPC error → 500 (generic body, no `error.message`). On a null
   document → 404 (same not-found-vs-error split the page draws).
3. Assemble `data: DocumentData`: the document fields from `public_invoice`, plus
   `backup` from `public_invoice_backup` with **every expense mapped to
   `receiptDataUri: null` and `receipt_path` dropped** — so no image is fetched
   and no storage path is carried further. If the backup is null, `data.backup`
   is `undefined` (an invoice with no frozen backup renders no backup pages,
   exactly as the email does).
4. `renderInvoicePdf(data)` → `Buffer`. On throw → 500 (generic).
5. Return the buffer with `Content-Type: application/pdf` and
   `Content-Disposition: attachment; filename="<invoiceFilename(data)>"`.

The route is gated only by the unguessable token — the same capability model as
the page. It never uses the service role and never touches receipt storage.

### 4. Download button — `app/i/[token]/page.tsx`

Add a **Download PDF** link near the invoice: `<a href={`/i/${token}/pdf`}>` (a
plain link — the browser downloads via the route's `Content-Disposition`). Styled
as a button, placed under or beside the status line. The page's data read is
otherwise unchanged.

### 5. File tracing — `next.config.ts`

Add the new route to `outputFileTracingIncludes` so the font and logo ship in
its serverless bundle (the invoices route already has this):

```
'/i/[token]/pdf': ['./public/fonts/Oswald-Bold.ttf', './public/logo.png'],
```

## Data flow

```
Public page  ── href──▶  GET /i/[token]/pdf
                           token UUID guard
                           public_invoice(token)          → document
                           public_invoice_backup(token)   → backup (images nulled)
                           renderInvoicePdf(data)          → Buffer
                           200 application/pdf; attachment; filename
```

## Error handling

- Malformed / non-matching token → 404 (indistinguishable real-vs-fake, as the
  page already ensures).
- RPC or render failure → 500 with a generic body; never leak `error.message`.
- An invoice with no backup snapshot → a valid PDF with no backup pages.

## Security / invariants

- **No receipt images, no storage access, no service role** on the public route.
- `ach_details` is unreachable — neither `public_invoice` nor
  `public_invoice_backup` selects it; `buildInvoicePdf` does not render it.
- `receipt_path` strings from the snapshot are stripped in the route and never
  serialized to the browser (the browser receives only PDF bytes).
- Void invoices are excluded from both functions.
- The emailed PDF and the in-app authenticated download are byte-for-byte
  unchanged — `sendInvoice` still builds `data` with receipt images and calls the
  shared `renderInvoicePdf`.

## Testing

- **Pure/unit (`node --test`):** a small helper that maps a raw backup snapshot to
  a `DocumentData.backup` with `receiptDataUri: null` and no `receipt_path` — assert
  images are nulled, paths dropped, and hour/expense itemization fields preserved.
  (Keep the mapping in a pure function so it is testable without a DB or the PDF
  renderer.)
- **Render smoke:** extend `npm run pdf:sample` (or a follow to it) to render a
  sample through `renderInvoicePdf` and confirm a non-empty PDF — proving the
  extraction still renders.
- **Manual:** open a real invoice's public link, click Download PDF, confirm the
  file opens with the invoice + itemization and **no** receipt photos. Confirm the
  emailed PDF is unchanged (send a test to Dan's own address, or trust the
  unchanged `sendInvoice` data + shared render).

## Deployment notes

- Migration 0023 is additive (a new function); apply via `db:sql` and record the
  checksum, since the session pooler is blocked on Dan's network.
- Verify the font/logo tracing after build — a missing font in the deployed
  bundle is the classic failure for this render path.

## Out of scope / backlog

- Receipt photos in the public PDF (would need private-storage access on a public
  route — declined).
- Storing the emitted PDF bytes.
