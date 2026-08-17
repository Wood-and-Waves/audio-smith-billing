# Editable invoice email — design

## Problem

Sending an invoice today offers exactly one editable field: an optional
**note** that gets appended into an otherwise machine-generated email. Dan
cannot change who it goes to (always the client's single `billing_email`),
cannot change the subject, and cannot rewrite the body. He needs to send the
same invoice to more than one person (an engineer plus the venue's
accounts-payable address, say), to adjust the subject (a PO number, a
reference), and to write the whole message himself when the generated wording
isn't what he wants.

## Goal

Turn the send panel into a small form where **To (multiple addresses),
Subject, and Body are all editable**, each prefilled with what the system
generates today — while the two machine-critical pieces (the public invoice
link and the PDF attachment) are always added automatically at send and can
never be lost by editing.

## Scope

- **In:** the invoice *send* flow — `components/SendInvoicePanel.tsx`,
  `sendInvoice` in `app/invoices/actions.ts`, and the email-body library.
- **Out (separate later specs, already on the backlog):**
  - Editing the *reminder* email the same way (will reuse this machinery).
  - A Download-PDF button on the public `/i/[token]` link.
- **Unchanged:** the cron reminder emails and the manual "Send reminder"
  button stay fully auto-generated. Only the invoice send becomes editable.

## What becomes editable

The panel shows three prefilled fields:

- **To** — a single text input accepting several comma-separated addresses,
  prefilled with the client's `billing_email` (if any). Dan adds or removes
  freely. No CC/BCC.
- **Subject** — prefilled with the generated subject
  (`Invoice #391 from Smith Audio, LLC`, or the receipt variant for a paid
  invoice). Fully editable.
- **Body** — a textarea prefilled with the generated message body. Fully
  editable plain text.

## What stays automatic (can't be lost by editing)

On send, regardless of what Dan typed, the server always:

- **Attaches the PDF**, regenerated server-side from the invoice's frozen
  snapshot exactly as today (expense receipt images embedded when present).
- **Appends the public link footer** to the end of the body:
  `View it online: <link>` and `A PDF copy is attached.` The link's token is
  minted server-side at that moment, so it is always valid. Because the
  footer is appended, the **prefilled body no longer contains the link in the
  middle** — it is always the last block, after whatever Dan wrote. This is
  the whole reason the link is not part of the editable text: its token does
  not exist until send.
- Keeps **reply-to** as the settings email and the **From** name as the
  legal name, exactly as today.

The emailed PDF reflects the live snapshot at send; the body is Dan's literal
text. (This removes today's "preview built at page load" caveat for the body
— Dan now sees and sends the exact text — while the PDF stays authoritative.)

## Architecture

### 1. Recipient parsing — `lib/invoiceRecipients.ts` (new, pure)

```
parseRecipients(raw: string): { emails: string[]; invalid: string[] }
```

- Splits on commas, trims, drops empty segments.
- De-duplicates case-insensitively, preserving first-seen order and the
  original casing of the first occurrence.
- Validates each against a basic single-`@` email pattern (non-empty local
  part, a dot-bearing domain). Anything that fails goes to `invalid`.
- Pure, no imports beyond none — exercised by `node --test`. Imported by
  **both** the client panel (live feedback) and the server action
  (authoritative check).

### 2. Email body library — `lib/invoiceEmailBody.ts` (split in two)

Today `buildInvoiceEmail(input)` returns `{ subject, text, html }` with the
link baked into the middle. It splits into two pure functions:

```
buildInvoiceEmailDefaults(input: { invoice; status }): { subject: string; body: string }
```
- `subject`: the same receipt-vs-invoice logic as today.
- `body`: the plain-text message **without** the link/PDF footer — header
  line, `Amount due` + `Due` (or `Paid in full` for a receipt), the
  `Payment` + `remit_to` block when present and not a receipt, and the
  `Thank you for your business!` line. This is the textarea prefill.
- Still **never** emits `ach_details` — only `remit_to`, exactly as today.

```
assembleInvoiceEmail(input: { subject: string; body: string; publicUrl: string }): { subject; text; html }
```
- `text` = `body` + a blank line + `View it online: <publicUrl>` +
  `A PDF copy is attached.`
- `html` = Dan's `body` rendered from plain text (escape each line, blank
  lines separate paragraphs, single newlines become `<br>`), wrapped in the
  existing email `<div>`, then the link as a real `<a href>` and the
  "PDF copy is attached" line appended.
- `subject` passes through unchanged.
- Pure; reuses the existing `escapeHtml`.

`buildInvoiceEmail` (the old combined function) is removed; its two callers
(the client preview and `sendInvoiceEmail`) move to the split functions.

### 3. Send library — `lib/invoiceEmail.ts` (server-only)

`InvoiceEmailInput` changes:
- `to: string` → `to: string[]` (already parsed & validated by the caller).
- Drop `note` and `status`.
- Add `subject: string` and `body: string` (Dan's edited values).
- Keep `invoice` (for the From legal name and the attachment filename),
  `publicUrl`, `replyTo`.

`sendInvoiceEmail` calls `assembleInvoiceEmail({ subject, body, publicUrl })`
instead of `buildInvoiceEmail`, and passes `to: input.to` (the array) to
Resend, which accepts multiple recipients natively. Everything else
(per-call Resend client, `{ error }` never throws, PDF attachment) is
unchanged.

### 4. Server action — `app/invoices/actions.ts`

`sendInvoice(invoiceId: string, note: string)` becomes:

```
sendInvoice(invoiceId: string, draft: { to: string; subject: string; body: string })
```

Order of operations (the existing auth, re-read, token-mint, PDF-build steps
are unchanged — only the input handling and the email-input assembly change):

1. `getUser()` / auth as today.
2. Parse & validate `draft`:
   - `parseRecipients(draft.to)` → if `emails.length === 0`, return
     `{ error: 'Add at least one recipient.' }`; if `invalid.length > 0`,
     return `{ error: 'Not a valid email: <joined invalid list>.' }`.
   - `draft.subject.trim()` empty → `{ error: "Subject can't be empty." }`.
   - `draft.body` may be empty (the appended footer still carries the link
     and PDF note).
3. Re-read invoice + settings, mint/reuse `public_token`, build `publicUrl`,
   render the PDF — all exactly as today.
4. Build `InvoiceEmailInput` with `to: emails`, `subject: draft.subject`,
   `body: draft.body`, `publicUrl`, `replyTo`, `invoice`, and send.
5. On success, flip status to `sent` and stamp — exactly as today, only
   after the send succeeds.

The server re-parses `to` itself and is authoritative; it never trusts a
client-supplied array.

### 5. Panel — `components/SendInvoicePanel.tsx` (`'use client'`)

- Import `buildInvoiceEmailDefaults` (replacing the old `buildInvoiceEmail`
  preview import) and `parseRecipients`.
- State: `to` (string, prefilled from the client's `billing_email` prop, or
  empty), `subject` and `body` (prefilled from `buildInvoiceEmailDefaults`
  computed from the `DocumentData` + status the panel already has).
- Live validation: run `parseRecipients(to)` on change; if there are invalid
  addresses, show them inline; disable **Send** when there is no valid
  recipient or the subject is blank.
- On Send: call `sendInvoice(invoiceId, { to, subject, body })`; existing
  pending/error/redirect handling stays.
- Remove the old read-only To display and the "preview built at page load"
  caveat.

## Data flow

```
Panel (prefill from buildInvoiceEmailDefaults + billing_email)
  → Dan edits To / Subject / Body
  → sendInvoice(id, { to, subject, body })
      → parseRecipients (authoritative) + subject check
      → re-read invoice/settings, mint token, build publicUrl, render PDF
      → sendInvoiceEmail({ to: emails, subject, body, publicUrl, replyTo, invoice })
          → assembleInvoiceEmail  (body + link footer, html from text)
          → Resend.send(to: string[], attachments: [pdf])
      → on success: status → sent
```

## Error handling

- Missing/invalid recipients and blank subject are caught **before** any
  send or status change, with a message that names the problem.
- `sendInvoiceEmail` keeps its `{ error }`-never-throws contract, so a Resend
  failure leaves the invoice as-is (still a draft) with the error surfaced.
- Degraded-settings refusal (empty/failed settings → no letterhead) is
  unchanged.

## Security / invariants

- **`ach_details` is never auto-inserted** — `buildInvoiceEmailDefaults`
  emits only `remit_to`, exactly as the current builder. What Dan types into
  his own body is his choice; the system-generated text never contains bank
  numbers.
- Recipients are now arbitrary (Dan types them). This is intended — it is his
  tool sending his invoices. Format is validated server-side to avoid opaque
  Resend errors, but there is no allow-list.
- Reply-to stays the settings email; From stays the legal name.

## Testing (pure, `node --test`)

1. **`parseRecipients`:** `"a@x.com, b@y.com"` → 2 valid, 0 invalid;
   `"a@x.com, nope"` → 1 valid + `["nope"]`; `""` and `"  ,  "` → 0 valid;
   `"A@x.com, a@x.com"` → 1 valid (case-insensitive dedupe, first casing
   kept); trailing comma tolerated.
2. **`buildInvoiceEmailDefaults`:** subject uses the invoice wording for an
   open invoice and the receipt wording for a paid one; body contains the
   amount and due date; body contains the `remit_to` block when settings
   carry one and it is not a receipt; body contains **neither** the public
   URL/`View it online` line **nor** `ach_details`.
3. **`assembleInvoiceEmail`:** `text` ends with `View it online: <url>` then
   `A PDF copy is attached.`; `html` contains an `<a href="<url>">` and the
   PDF line; a body line containing `<` / `&` is escaped in the html;
   `subject` passes through unchanged.

Existing "no bank details in the email body" coverage moves to point 2
(pointed at `buildInvoiceEmailDefaults`).

## Out of scope / backlog (recorded, not built here)

- Edit the reminder email the same way — reuses `parseRecipients`,
  `assembleInvoiceEmail`, and the editable-field pattern.
- Download-PDF button on the public `/i/[token]` link, expenses included —
  decide regenerate-on-demand vs store-the-emailed-bytes at build time
  (receipt images are purged from Supabase 30 days after paid).
