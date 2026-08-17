# Editable Client Reminder Email Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the manual "Send reminder" button open an editable To (multiple) / Subject / Body form, sending a link-only nudge, reusing the editable-invoice-email machinery.

**Architecture:** Generalize the invoice email's link-footer into a shared pure `assembleEmail({ subject, body, publicUrl, pdfAttached })` (with `assembleInvoiceEmail` kept as a thin wrapper). Add a pure `buildReminderDefaults` for the reminder's prefill subject+body (no link). Widen `sendReminderEmail` to accept several recipients. Rewrite `sendClientReminder` to take an edited `{ to, subject, body }`, validate recipients server-side with the existing `parseRecipients`, append the link with `assembleEmail(..., pdfAttached: false)`, and log the joined recipients. Turn `SendReminderButton` into an editable panel like `SendInvoicePanel`.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, `@supabase/ssr`, Resend. Tests run under `node --test` (`npm test`).

## Global Constraints

- **No PDF is attached to a reminder** — it is a link-only nudge (unchanged). `assembleEmail` is called with `pdfAttached: false` for reminders.
- **`ach_details` never appears** — the reminder settings query selects only `legal_name, email`; `buildReminderDefaults` emits no remit or bank detail.
- **The link's token is minted server-side and appended by the server** — never part of the editable body.
- **Recipients validated server-side** in `sendClientReminder` via `parseRecipients` before any side effect (token mint / send). Reject invalid (named), zero recipients, blank subject.
- **Only a `sent` invoice is chased**; a second send stays allowed. The `reminder_log` insert (`kind: 'client_reminder'`) still happens only after a successful send.
- **`assembleInvoiceEmail` output must not change** — the existing `scripts/test/invoiceEmailBody.test.ts` and `scripts/test/invoiceEmail.test.ts` must stay green. `assembleInvoiceEmail` becomes `assembleEmail({ ...input, pdfAttached: true })`.
- **Pure modules** (`lib/invoiceEmailBody.ts`, `lib/reminderEmailBody.ts`) stay free of `server-only`/`resend`/`process.env`/JSX/`@/`. Test files use relative `.ts`/`.tsx` imports. Client/server files use `@/` as they already do.
- **The automated cron reminders are out of scope and unchanged** — `sendReminderEmail`'s single-string caller in the cron route keeps working (the `to` type widens to `string | string[]`).

---

### Task 1: Shared `assembleEmail` + reminder defaults (pure)

Generalize the link footer so a reminder can reuse it without the PDF line, and add the reminder's prefill builder. Both pure, both tested. `assembleInvoiceEmail` stays as a wrapper so nothing downstream changes.

**Files:**
- Modify: `lib/invoiceEmailBody.ts` (add `assembleEmail`; make `assembleInvoiceEmail` a wrapper)
- Create: `lib/reminderEmailBody.ts`
- Test: `scripts/test/reminderEmailBody.test.ts` (new)

**Interfaces:**
- Consumes: `escapeHtml` (already in `invoiceEmailBody.ts`), `formatUSD` (`./money.ts`), `formatDateLong` (`./dates.ts`).
- Produces:
  - `assembleEmail(input: { subject: string; body: string; publicUrl: string; pdfAttached: boolean }): { subject: string; text: string; html: string }`
  - `assembleInvoiceEmail(input: { subject: string; body: string; publicUrl: string }): { subject: string; text: string; html: string }` (unchanged signature; now delegates)
  - `buildReminderDefaults(input: { number: number; total_cents: number; due_date: string; legalName: string }): { subject: string; body: string }`

- [ ] **Step 1: Write the failing test**

Create `scripts/test/reminderEmailBody.test.ts`:

```ts
// buildReminderDefaults and the shared assembleEmail are pure — the reminder
// wording, the figures, the absence of a PDF line, and the appended link are
// all testable here with no network and no key.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assembleEmail, assembleInvoiceEmail } from '../../lib/invoiceEmailBody.ts'
import { buildReminderDefaults } from '../../lib/reminderEmailBody.ts'
import { formatUSD } from '../../lib/money.ts'

const URL = 'https://billing.theaudiosmith.com/i/11111111-2222-3333-4444-555555555555'

test('reminder defaults: subject names the invoice and legal entity', () => {
  const { subject } = buildReminderDefaults({
    number: 386, total_cents: 50000, due_date: '2026-09-06', legalName: 'Smith Audio, LLC',
  })
  assert.equal(subject, 'Reminder: invoice #386 from Smith Audio, LLC')
})

test('reminder defaults: body carries the amount and due date, but no link', () => {
  const { body } = buildReminderDefaults({
    number: 386, total_cents: 50000, due_date: '2026-09-06', legalName: 'Smith Audio, LLC',
  })
  assert.ok(body.includes('A friendly reminder about invoice #386.'), 'the nudge line')
  assert.ok(body.includes(formatUSD(50000)), 'carries $500.00')
  assert.ok(body.includes('9/6/2026'), 'carries the due date')
  assert.ok(!body.includes('View it online'), 'no link line — appended at send')
  assert.ok(!body.includes(URL), 'no url')
})

test('assembleEmail without a PDF appends only the link, no attachment line', () => {
  const { text, html } = assembleEmail({
    subject: 'Reminder: invoice #386 from Smith Audio, LLC',
    body: 'A friendly reminder about invoice #386.',
    publicUrl: URL,
    pdfAttached: false,
  })
  assert.ok(text.endsWith(`View it online: ${URL}`), 'text ends with the link, nothing after')
  assert.ok(!text.includes('A PDF copy is attached.'), 'no PDF line in text')
  assert.ok(html.includes(`<a href="${URL}">`), 'html links the url')
  assert.ok(!html.includes('A PDF copy is attached.'), 'no PDF line in html')
})

test('assembleEmail with a PDF still emits the attachment line', () => {
  const { text, html } = assembleEmail({
    subject: 'x', body: 'Amount due: $500.00', publicUrl: URL, pdfAttached: true,
  })
  assert.ok(text.endsWith(`View it online: ${URL}\nA PDF copy is attached.`), 'text keeps the PDF line')
  assert.ok(html.includes('A PDF copy is attached.'), 'html keeps the PDF line')
})

test('assembleInvoiceEmail is assembleEmail with pdfAttached true — identical output', () => {
  const input = { subject: 's', body: 'b', publicUrl: URL }
  assert.deepEqual(
    assembleInvoiceEmail(input),
    assembleEmail({ ...input, pdfAttached: true }),
    'the wrapper must match the pdfAttached:true path exactly',
  )
})

test('assembleEmail escapes the body it is given', () => {
  const { html } = assembleEmail({
    subject: 'x', body: '<script>alert(1)</script>', publicUrl: URL, pdfAttached: false,
  })
  assert.ok(!html.includes('<script>'), 'raw tag never survives')
  assert.ok(html.includes('&lt;script&gt;'), 'escaped instead')
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `assembleEmail is not a function` and `buildReminderDefaults`/module not found.

- [ ] **Step 3: Generalize `assembleEmail` in `lib/invoiceEmailBody.ts`**

Replace the existing `assembleInvoiceEmail` function with the generalized `assembleEmail` plus a thin wrapper. Find:

```ts
export function assembleInvoiceEmail(input: {
  subject: string
  body: string
  publicUrl: string
}): { subject: string; text: string; html: string } {
  const { subject, body, publicUrl } = input
  const trimmed = body.replace(/\s+$/, '')

  const footerText = `View it online: ${publicUrl}\nA PDF copy is attached.`
  const text = trimmed ? `${trimmed}\n\n${footerText}` : footerText

  const safeBody = escapeHtml(trimmed).replace(/\n/g, '<br>')
  const html =
    `<div style="font-family:system-ui,-apple-system,sans-serif;font-size:14px;color:#121212;line-height:1.5">` +
    (trimmed ? `<div style="margin:0 0 16px">${safeBody}</div>` : '') +
    `<p style="margin:0 0 16px"><a href="${escapeHtml(publicUrl)}">View this invoice online</a></p>` +
    `<p style="margin:0">A PDF copy is attached.</p>` +
    `</div>`
  return { subject, text, html }
}
```

Replace it with:

```ts
// The FINAL assembly, shared by the invoice send and the client reminder. Takes
// the (possibly edited) subject and body plus the server-minted public URL, and
// appends the link footer — always, at the end, after whatever the sender wrote,
// so no edit can drop it. The "A PDF copy is attached." line is emitted only
// when pdfAttached is true (the invoice attaches one; a reminder does not). The
// html is built from the plain-text body: every line escaped, newlines to <br>,
// then the link as a real anchor. Pure string work; it never formats a date.
export function assembleEmail(input: {
  subject: string
  body: string
  publicUrl: string
  pdfAttached: boolean
}): { subject: string; text: string; html: string } {
  const { subject, body, publicUrl, pdfAttached } = input
  const trimmed = body.replace(/\s+$/, '')

  const footerLines = [`View it online: ${publicUrl}`]
  if (pdfAttached) footerLines.push('A PDF copy is attached.')
  const footerText = footerLines.join('\n')
  const text = trimmed ? `${trimmed}\n\n${footerText}` : footerText

  const safeBody = escapeHtml(trimmed).replace(/\n/g, '<br>')
  const html =
    `<div style="font-family:system-ui,-apple-system,sans-serif;font-size:14px;color:#121212;line-height:1.5">` +
    (trimmed ? `<div style="margin:0 0 16px">${safeBody}</div>` : '') +
    `<p style="margin:0 0 16px"><a href="${escapeHtml(publicUrl)}">View this invoice online</a></p>` +
    (pdfAttached ? `<p style="margin:0">A PDF copy is attached.</p>` : '') +
    `</div>`
  return { subject, text, html }
}

// The invoice send always attaches a PDF. Kept as a named wrapper so its
// callers (lib/invoiceEmail.ts) and tests read as before.
export function assembleInvoiceEmail(input: {
  subject: string
  body: string
  publicUrl: string
}): { subject: string; text: string; html: string } {
  return assembleEmail({ ...input, pdfAttached: true })
}
```

- [ ] **Step 4: Create `lib/reminderEmailBody.ts`**

```ts
// The PREFILL for the client reminder. Subject and a plain-text body Dan edits
// before sending. Like the invoice defaults, the body deliberately omits the
// public link — the server mints its token at send and appends it via
// assembleEmail. Emits no remit and no bank detail: a reminder is a nudge with
// a link, nothing more.
//
// No '@/' imports and no server-only anything — exercised by node --test and
// importable by a client component.

import { formatUSD } from './money.ts'
import { formatDateLong } from './dates.ts'

export function buildReminderDefaults(input: {
  number: number
  total_cents: number
  due_date: string
  legalName: string
}): { subject: string; body: string } {
  const { number, total_cents, due_date, legalName } = input
  const subject = `Reminder: invoice #${number} from ${legalName}`
  const body = [
    `A friendly reminder about invoice #${number}.`,
    '',
    `Amount due: ${formatUSD(total_cents)}`,
    `Due: ${formatDateLong(due_date)}`,
    '',
    'Thank you!',
  ].join('\n')
  return { subject, body }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test`
Expected: PASS — the new `reminderEmailBody` tests pass, and the existing `invoiceEmailBody`/`invoiceEmail` tests still pass (the `assembleInvoiceEmail` wrapper produces byte-identical output).

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add lib/invoiceEmailBody.ts lib/reminderEmailBody.ts scripts/test/reminderEmailBody.test.ts
git commit -m "Share assembleEmail footer; add reminder email defaults"
```

---

### Task 2: Wire the editable reminder end-to-end

Widen the sender to several recipients, rewrite `sendClientReminder` to take the edited draft and validate it, turn the button into an editable panel, and pass the prefill props from the invoice page.

**Files:**
- Modify: `lib/reminderEmail.ts` (`to: string | string[]`)
- Modify: `app/invoices/actions.ts` (`sendClientReminder` new signature)
- Modify: `components/SendReminderButton.tsx` (editable panel)
- Modify: `app/invoices/[id]/page.tsx` (pass prefill props)

**Interfaces:**
- Consumes: `parseRecipients` (already imported in `actions.ts`), `assembleEmail` (Task 1), `buildReminderDefaults` (Task 1), `sendReminderEmail` (widened).
- Produces: `sendClientReminder(invoiceId: string, draft: { to: string; subject: string; body: string }): Promise<{ error: string } | { ok: true }>`.

- [ ] **Step 1: Widen `sendReminderEmail`'s recipient type**

In `lib/reminderEmail.ts`, in the `sendReminderEmail` input type, change:

```ts
    to: string; subject: string; text: string; html: string
```

to:

```ts
    to: string | string[]; subject: string; text: string; html: string
```

Nothing else in that function changes — `to: input.to` already passes straight to Resend, which accepts a string or an array.

- [ ] **Step 2: Add the `assembleEmail` import to `app/invoices/actions.ts`**

Near the top with the other `@/lib` imports, add:

```ts
import { assembleEmail } from '@/lib/invoiceEmailBody'
```

- [ ] **Step 3: Rewrite `sendClientReminder`**

In `app/invoices/actions.ts`, change the signature. Replace:

```ts
export async function sendClientReminder(
  invoiceId: string,
): Promise<{ error: string } | { ok: true }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  const appUrl = process.env.APP_URL
  if (!appUrl) return { error: 'Email is not configured yet (APP_URL is missing).' }
```

with:

```ts
export async function sendClientReminder(
  invoiceId: string,
  draft: { to: string; subject: string; body: string },
): Promise<{ error: string } | { ok: true }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  const appUrl = process.env.APP_URL
  if (!appUrl) return { error: 'Email is not configured yet (APP_URL is missing).' }

  // Authoritative recipient + subject validation, before the DB read or token
  // mint. Same parseRecipients the panel uses for live feedback.
  const { emails, invalid } = parseRecipients(draft.to)
  if (invalid.length > 0) {
    return { error: `Not a valid email: ${invalid.join(', ')}.` }
  }
  if (emails.length === 0) {
    return { error: 'Add at least one recipient.' }
  }
  const subject = draft.subject.trim()
  if (!subject) {
    return { error: "Subject can't be empty." }
  }
```

Then remove the old `billing_email`-derived recipient block. Delete:

```ts
  const to = inv.clients?.billing_email?.trim()
  if (!to) {
    return {
      error: `${inv.clients?.name ?? 'This client'} has no billing email on file. ` +
        'Add one on the client screen.',
    }
  }
```

(The `status === 'sent'` guard just above it stays. `billing_email` is still selected — harmless; it prefills the panel now.)

Next, replace the inline subject/text/html construction and the send call. Replace:

```ts
  const link = `${appUrl.replace(/\/+$/, '')}/i/${token}`
  // The legal name, not the trading name — this reaches a client's accounts
  // payable, who have "Smith Audio, LLC" on file. Was hardcoded; now it follows
  // Settings like everything else.
  const legalName = settings?.legal_name ?? 'Smith Audio, LLC'
  const subject = `Reminder: invoice #${inv.number} from ${legalName}`
  const text = [
    `A friendly reminder about invoice #${inv.number}.`,
    '',
    `Amount due: ${formatUSD(inv.total_cents)}`,
    `Due: ${formatDateLong(inv.due_date)}`,
    '',
    `View it online: ${link}`,
    '',
    'Thank you!',
  ].join('\n')
  const html =
    '<div style="font-family:system-ui,-apple-system,sans-serif;font-size:14px;color:#121212;line-height:1.5">' +
    `<p style="margin:0 0 16px">A friendly reminder about invoice <strong>#${inv.number}</strong>.</p>` +
    `<p style="margin:0 0 4px">Amount due: <strong>${formatUSD(inv.total_cents)}</strong></p>` +
    `<p style="margin:0 0 16px">Due: ${formatDateLong(inv.due_date)}</p>` +
    `<p style="margin:0 0 16px"><a href="${link}">View this invoice online</a></p>` +
    '<p style="margin:0">Thank you!</p>' +
    '</div>'

  const result = await sendReminderEmail({
    to,
    subject,
    text,
    html,
    // From Settings, same reasoning as sendInvoice: a reply from the client
    // must reach Dan, not INVOICE_FROM_EMAIL, which receives nothing.
    replyTo: settings?.email ?? 'dan@theaudiosmith.com',
    fromName: legalName,
  })
  if (result.error) return { error: result.error }
```

with:

```ts
  const link = `${appUrl.replace(/\/+$/, '')}/i/${token}`
  // The legal name, not the trading name — this reaches a client's accounts
  // payable, who have "Smith Audio, LLC" on file. Follows Settings.
  const legalName = settings?.legal_name ?? 'Smith Audio, LLC'

  // Dan's edited subject/body, with the read-only link appended server-side.
  // pdfAttached: false — a reminder is a link nudge, nothing attached.
  const { text, html } = assembleEmail({
    subject,
    body: draft.body,
    publicUrl: link,
    pdfAttached: false,
  })

  const result = await sendReminderEmail({
    to: emails,
    subject,
    text,
    html,
    // From Settings, same reasoning as sendInvoice: a reply from the client
    // must reach Dan, not INVOICE_FROM_EMAIL, which receives nothing.
    replyTo: settings?.email ?? 'dan@theaudiosmith.com',
    fromName: legalName,
  })
  if (result.error) return { error: result.error }
```

Finally, update the `reminder_log` insert and its failure message to use the joined recipients. Replace:

```ts
    sent_to: to,
```

with:

```ts
    sent_to: emails.join(', '),
```

and replace:

```ts
      error: `The reminder went to ${to}, but recording it failed: ${logErr.message}.`,
```

with:

```ts
      error: `The reminder went to ${emails.join(', ')}, but recording it failed: ${logErr.message}.`,
```

- [ ] **Step 4: Typecheck to see the callers that must change**

Run: `npx tsc --noEmit`
Expected: FAIL — `components/SendReminderButton.tsx` calls `sendClientReminder(invoiceId)` with one argument. Fixed next.

- [ ] **Step 5: Rewrite `SendReminderButton` as an editable panel**

Replace the entire contents of `components/SendReminderButton.tsx` with:

```tsx
'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { formatDateShort } from '@/lib/dates'
import { buildReminderDefaults } from '@/lib/reminderEmailBody'
import { parseRecipients } from '@/lib/invoiceRecipients'
import { sendClientReminder } from '@/app/invoices/actions'

// Chasing a client is a manual, editable nudge. The button opens a form —
// recipients (several allowed), subject and body — prefilled from the current
// reminder wording and the client's billing email. The read-only link is
// appended by the server at send, so it is not part of the editable body.
// A second send is never blocked; the date of the last one is shown instead.

export default function SendReminderButton({
  invoiceId, to, lastSentDate, number, totalCents, dueDate, legalName,
}: {
  invoiceId: string
  /** The client's billing email, trimmed, or null. Prefills the To field. */
  to: string | null
  /** YYYY-MM-DD of the most recent client reminder, or null. */
  lastSentDate: string | null
  number: number
  totalCents: number
  dueDate: string
  legalName: string
}) {
  const router = useRouter()
  const defaults = buildReminderDefaults({
    number, total_cents: totalCents, due_date: dueDate, legalName,
  })

  const [open, setOpen] = useState(false)
  const [toField, setToField] = useState(to ?? '')
  const [subject, setSubject] = useState(defaults.subject)
  const [body, setBody] = useState(defaults.body)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)
  const [pending, start] = useTransition()

  const { emails, invalid } = parseRecipients(toField)
  const canSend = emails.length > 0 && subject.trim().length > 0 && invalid.length === 0

  function send() {
    setError(null)
    start(async () => {
      try {
        const result = await sendClientReminder(invoiceId, { to: toField, subject, body })
        if ('error' in result) { setError(result.error); return }
        setSent(true)
        setOpen(false)
        router.refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : 'The reminder could not be sent.')
      }
    })
  }

  if (!open) {
    return (
      <div className="flex items-center gap-3">
        {error && <span role="alert" className="text-xs text-danger">{error}</span>}
        {sent && !error && <span className="text-xs text-good">Reminder sent</span>}
        <button type="button" onClick={() => { setOpen(true); setSent(false) }}
                className="text-xs font-semibold uppercase tracking-wider text-muted
                           hover:text-ink transition-colors disabled:opacity-50">
          {lastSentDate ? `Send reminder · last ${formatDateShort(lastSentDate)}` : 'Send reminder'}
        </button>
      </div>
    )
  }

  const fieldClass =
    'w-full px-3 py-2 bg-bg border border-line rounded-field text-ink text-sm ' +
    'focus:border-accent focus:outline-none'

  return (
    <div className="w-full mt-4 border border-line rounded-card p-4 bg-surface text-left">
      <p className="eyebrow mb-3">Send a reminder</p>

      <label className="eyebrow block mb-2" htmlFor="reminder-to">To</label>
      <input id="reminder-to" type="text" value={toField} onChange={(e) => setToField(e.target.value)}
             placeholder="name@example.com, second@example.com"
             className={`${fieldClass} mb-1`} />
      <p className="text-xs text-muted mb-4">
        Separate several addresses with commas.
        {invalid.length > 0 && (
          <span className="text-danger"> Not a valid email: {invalid.join(', ')}.</span>
        )}
      </p>

      <label className="eyebrow block mb-2" htmlFor="reminder-subject">Subject</label>
      <input id="reminder-subject" type="text" value={subject} onChange={(e) => setSubject(e.target.value)}
             className={`${fieldClass} mb-4`} />

      <label className="eyebrow block mb-2" htmlFor="reminder-body">Message</label>
      <textarea id="reminder-body" rows={8} value={body} onChange={(e) => setBody(e.target.value)}
                className={`${fieldClass} mb-2`} />

      <p className="text-xs text-muted mb-4">
        A link to a read-only copy is added automatically at the end.
      </p>

      {error && (
        <p role="alert" className="mb-3 text-sm text-danger border-l-2 border-danger pl-3 py-1">
          {error}
        </p>
      )}

      <div className="flex items-center gap-3">
        <button type="button" onClick={send} disabled={pending || !canSend}
                className="px-5 py-2.5 bg-accent-surface text-accent-ink font-bold uppercase tracking-wider
                           text-sm rounded-field cursor-pointer hover:opacity-90 transition-opacity
                           disabled:opacity-50 disabled:cursor-not-allowed">
          {pending ? 'Sending…' : emails.length > 1 ? `Send to ${emails.length} recipients` : 'Send reminder'}
        </button>
        <button type="button" onClick={() => setOpen(false)} disabled={pending}
                className="px-5 py-2.5 border border-line text-muted font-bold uppercase tracking-wider
                           text-sm rounded-field cursor-pointer hover:text-ink transition-colors">
          Cancel
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 6: Pass the prefill props at the call site**

In `app/invoices/[id]/page.tsx`, update the `<SendReminderButton .../>` usage. Replace:

```tsx
            <SendReminderButton
              invoiceId={inv.id}
              to={(inv.clients as { billing_email?: string | null } | null)?.billing_email?.trim() || null}
              lastSentDate={lastReminderDate}
            />
```

with:

```tsx
            <SendReminderButton
              invoiceId={inv.id}
              to={(inv.clients as { billing_email?: string | null } | null)?.billing_email?.trim() || null}
              lastSentDate={lastReminderDate}
              number={docData.number}
              totalCents={docData.total_cents}
              dueDate={docData.due_date}
              legalName={docData.settings?.legal_name ?? 'Smith Audio, LLC'}
            />
```

(`docData` is the `DocumentData` already built on this page for the PDF/preview; it carries `number`, `total_cents`, `due_date`, and `settings.legal_name`.)

- [ ] **Step 7: Run the full suite, typecheck, build**

Run: `npm test && npx tsc --noEmit && npm run build`
Expected: all green — the reminder is now editable, `assembleInvoiceEmail` output unchanged, no type errors, build clean.

- [ ] **Step 8: Confirm the reminder no longer builds its body inline**

Run: `grep -n "A friendly reminder" app/invoices/actions.ts`
Expected: no output (the wording now lives only in `lib/reminderEmailBody.ts`).

- [ ] **Step 9: Commit**

```bash
git add lib/reminderEmail.ts app/invoices/actions.ts components/SendReminderButton.tsx app/invoices/[id]/page.tsx
git commit -m "Make client reminder editable: recipients, subject, body"
```

---

## Verification

- `npm test` — all pass, including new `reminderEmailBody` tests and the unchanged `invoiceEmailBody`/`invoiceEmail` tests (proving `assembleInvoiceEmail` output did not change).
- `npx tsc --noEmit` and `npm run build` — clean.
- `grep -n "A friendly reminder" app/invoices/actions.ts` — empty.
- Manual walk in preview on a **sent** invoice: "Send reminder" opens the panel with To prefilled from the client billing email, Subject `Reminder: invoice #… from …`, and the message prefilled without the link; a bad address disables Send and is named; two comma-separated addresses enable it. Do **not** send to a real client as verification — trust the unit tests + build for the pre-send logic.

## Blast radius

No schema, no migration. Touches the manual reminder path only: one shared pure helper (`assembleEmail`, with `assembleInvoiceEmail` preserved as a wrapper so the invoice email is untouched), one new pure module, the widened `sendReminderEmail` type, `sendClientReminder`, the reminder button, and one call site. The automated cron reminders keep working through the widened (still string-compatible) `sendReminderEmail`.

## Out of scope (backlog)

- Download-PDF button on the public `/i/[token]` link, expenses included — the next feature.
