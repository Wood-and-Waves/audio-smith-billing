# Editable client reminder email — design

## Problem

The manual **"Send reminder"** button (`sendClientReminder`) chases a client
about one unpaid invoice. Today it fires immediately with a fixed subject and
body to the client's single `billing_email` — no chance to change the wording,
the subject, or who it goes to. Dan wants the same editing he just got on the
invoice send: multiple recipients, editable subject, editable body.

## Goal

Make the "Send reminder" button open a small editable form — **To** (multiple),
**Subject**, **Body** — prefilled with the current reminder wording, sending a
link-only nudge (no PDF), reusing the machinery from the editable invoice email.

## Scope

- **In:** the manual client reminder — `components/SendReminderButton.tsx`,
  `sendClientReminder` in `app/invoices/actions.ts`, the reminder body defaults,
  and widening `sendReminderEmail` to accept several recipients.
- **Out / unchanged:** the automated cron reminders (`buildDigestEmail`,
  `buildOverdueAlertEmail`) — those go to **Dan**, not clients, with no human in
  the loop, so there is nothing to edit before sending. They keep calling
  `sendReminderEmail` unchanged.
- **No PDF** is attached to a reminder (unchanged — a reminder is a link nudge).

## What becomes editable

The button, when the invoice is `sent`, opens a panel identical in shape to the
invoice send panel:

- **To** — one input taking several comma-separated addresses, prefilled with
  the client's `billing_email`. Add/remove freely.
- **Subject** — prefilled with `Reminder: invoice #<n> from <legal name>`.
- **Body** — prefilled with the current reminder message (friendly reminder +
  amount due + due date + thank-you), **without** the link.

## What stays automatic

On send the server always:
- **Appends the read-only link** (`View it online: <link>`) at the end of the
  body — token minted server-side, exactly as `sendInvoice` does. No PDF line
  (nothing is attached).
- Keeps **reply-to** = settings email, **From** = legal name.
- Keeps the **"only a sent invoice is chased"** guard and the second-send-allowed
  behavior.
- **Logs** the reminder to `reminder_log` (`kind: 'client_reminder'`) after a
  successful send, unchanged except `sent_to` now records the joined recipient
  list.

## Architecture

### 1. Shared link-footer assembly — `lib/invoiceEmailBody.ts`

The invoice path already has `assembleInvoiceEmail({ subject, body, publicUrl })`
which appends `View it online: <url>` + `A PDF copy is attached.`. Generalize the
footer so the reminder can share it without the PDF line:

```
assembleEmail(input: { subject: string; body: string; publicUrl: string; pdfAttached: boolean }): { subject; text; html }
```

- Appends `View it online: <publicUrl>`; appends `A PDF copy is attached.` only
  when `pdfAttached` is true.
- `assembleInvoiceEmail` becomes a thin wrapper: `assembleEmail({ ...input, pdfAttached: true })` — so its existing callers and tests are unchanged.
- Pure; still no `server-only`/`@/`/JSX.

### 2. Reminder body defaults — `lib/reminderEmailBody.ts` (new, pure)

```
buildReminderDefaults(input: { number: number; total_cents: number; due_date: string; legalName: string }): { subject: string; body: string }
```

- `subject`: `Reminder: invoice #<number> from <legalName>`.
- `body` (plain text, **no** link — appended at send):
  ```
  A friendly reminder about invoice #<number>.

  Amount due: <formatUSD(total_cents)>
  Due: <formatDateLong(due_date)>

  Thank you!
  ```
- Pure: imports only `formatUSD` (`./money.ts`) and `formatDateLong`
  (`./dates.ts`). No `@/`, no `server-only`. Used by both the client panel
  (prefill) and — for the default when Dan doesn't edit — implicitly through
  the panel. The server does **not** regenerate defaults; it sends Dan's text.

### 3. Sender — `lib/reminderEmail.ts`

`sendReminderEmail`'s `to` widens from `string` to `string | string[]` (Resend
accepts either). No other change; the cron caller keeps passing a single string.

### 4. Server action — `app/invoices/actions.ts`

`sendClientReminder(invoiceId)` becomes:

```
sendClientReminder(invoiceId: string, draft: { to: string; subject: string; body: string })
```

- Auth + `APP_URL` check unchanged.
- Validate `draft` with `parseRecipients(draft.to)` (reused): reject invalid
  (named), zero recipients, blank subject — **before** the DB read/token mint.
- Re-read invoice + settings, enforce `status === 'sent'`, mint/reuse
  `public_token`, build `link` — all as today. The old `billing_email`-derived
  refusal is removed (Dan supplies recipients now).
- Build the email with `assembleEmail({ subject, body: draft.body, publicUrl: link, pdfAttached: false })` and send via `sendReminderEmail({ to: emails, subject, text, html, replyTo, fromName: legalName })`.
- Log to `reminder_log` with `sent_to: emails.join(', ')`; the error message on a
  failed log uses the joined list too.

### 5. Panel — `components/SendReminderButton.tsx` (`'use client'`)

Currently a one-click button. It becomes a collapsed button that opens an
editable panel (same structure as `SendInvoicePanel`):
- Prefill **To** from the `to` prop (client billing email, or empty), **Subject**
  and **Body** from `buildReminderDefaults(...)`.
- Live `parseRecipients` feedback; **Send** disabled with no valid recipient,
  any invalid address, or a blank subject.
- Keeps the "last sent <date>" hint on the collapsed button.
- Calls `sendClientReminder(invoiceId, { to, subject, body })`.
- New props needed for the prefill: `number`, `totalCents`, `dueDate`,
  `legalName` (the panel builds the defaults itself, mirroring how
  `SendInvoicePanel` builds its defaults from `data`).

### 6. Call site — `app/invoices/[id]/page.tsx`

Pass the four new props (`number`, `totalCents`, `dueDate`, `legalName`) to
`<SendReminderButton>`. The page already has `inv` (number, total_cents,
due_date) and the settings/`docData` legal name in scope.

## Data flow

```
Panel (prefill: billing_email + buildReminderDefaults)
  → Dan edits To / Subject / Body
  → sendClientReminder(id, { to, subject, body })
      → parseRecipients (authoritative) + subject check
      → re-read invoice/settings, status==sent guard, mint token, build link
      → assembleEmail({ subject, body, publicUrl: link, pdfAttached: false })
      → sendReminderEmail({ to: emails, ... })
      → on success: reminder_log insert (sent_to = emails joined)
```

## Error handling & invariants

- Invalid/empty recipients and blank subject caught before any side effect
  (no token mint, no send).
- `ach_details` never appears — the reminder settings query already selects only
  `legal_name, email`, and `buildReminderDefaults` emits neither remit nor bank
  detail. Unchanged.
- Reminder still only sent for a `sent` invoice; a second send still allowed.
- `sendReminderEmail` keeps its `{ error }`-never-throws contract.

## Testing (pure, `node --test`)

1. **`buildReminderDefaults`:** subject is `Reminder: invoice #386 from Smith Audio, LLC`; body carries the amount and the due date; body does **not** carry any link or `View it online` line.
2. **`assembleEmail`:** with `pdfAttached: false`, `text` ends with `View it online: <url>` and has **no** `A PDF copy is attached.` line; with `pdfAttached: true`, it matches the existing invoice output (the `assembleInvoiceEmail` wrapper still produces the PDF line). html escapes the body and links the url.
3. The existing `invoiceEmailBody` tests continue to pass through the
   `assembleInvoiceEmail` wrapper.

## Out of scope / backlog

- Download-PDF button on the public `/i/[token]` link (next feature).
