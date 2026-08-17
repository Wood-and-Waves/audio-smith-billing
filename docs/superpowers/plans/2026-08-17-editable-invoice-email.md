# Editable Invoice Email Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Dan edit the recipients (multiple), subject, and body of an invoice email before sending, instead of only appending an optional note.

**Architecture:** A new pure `parseRecipients` splits/validates a comma-separated To field. The existing pure email builder splits into `buildInvoiceEmailDefaults` (prefill: subject + body without the link) and `assembleInvoiceEmail` (final text/html with the public link appended as a footer). The send library, the `sendInvoice` server action, and the `SendInvoicePanel` are rewired so the panel prefills all three fields, validates recipients live, and passes `{ to, subject, body }` to the action, which re-parses authoritatively and always appends the server-minted link and the PDF.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, `@supabase/ssr`, Resend, `@react-pdf/renderer`. Tests run under `node --test` with native TypeScript stripping (`npm test`).

## Global Constraints

- **`ach_details` must never appear in system-generated email text.** The default body emits `remit_to` only — never `ach_details` — exactly as the current builder does.
- **The public link and the PDF attachment are always added by the server at send** and cannot be lost by editing. The link's token is minted server-side; it is never part of the editable body.
- **Recipients are validated server-side** in `sendInvoice` (authoritative); the client validation is a convenience only. The server never trusts a client-supplied recipient array.
- **Sending flips status to `sent` only AFTER the send succeeds** (unchanged ordering). Only `void` invoices are refused.
- **The pure email modules stay free of `server-only`, `resend`, `process.env`, JSX, and `@/` imports** — they are imported by a client component and exercised by `node --test`. Use relative `.ts` / `.tsx` imports.
- **Money is integer cents**, formatted with `formatUSD`. Dates format with `formatDateLong` (which throws `RangeError` on an unparseable date).
- Reminder emails (cron sweep + manual client nudge) are **out of scope** and unchanged.

---

### Task 1: Recipient parsing

A new pure module that turns a comma-separated To string into validated addresses. No dependencies on any other task.

**Files:**
- Create: `lib/invoiceRecipients.ts`
- Test: `scripts/test/invoiceRecipients.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `parseRecipients(raw: string): { emails: string[]; invalid: string[] }` — splits on commas, trims each segment, drops empty segments, de-duplicates case-insensitively (first occurrence's order and casing kept), and sorts each address into `emails` (matches the pattern) or `invalid` (does not).

- [ ] **Step 1: Write the failing test**

Create `scripts/test/invoiceRecipients.test.ts`:

```ts
// parseRecipients is pure: it turns the raw To field into validated
// addresses with no network and no state. The server calls it as the
// authoritative gate on who an invoice is sent to, so its edge cases —
// blank, duplicate, malformed — are all pinned here.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseRecipients } from '../../lib/invoiceRecipients.ts'

test('two good addresses parse to two emails and no invalids', () => {
  const { emails, invalid } = parseRecipients('a@x.com, b@y.com')
  assert.deepEqual(emails, ['a@x.com', 'b@y.com'])
  assert.deepEqual(invalid, [])
})

test('a malformed address is separated out, the good one still parses', () => {
  const { emails, invalid } = parseRecipients('a@x.com, nope')
  assert.deepEqual(emails, ['a@x.com'])
  assert.deepEqual(invalid, ['nope'])
})

test('an address with no dot in the domain is invalid', () => {
  const { emails, invalid } = parseRecipients('a@localhost')
  assert.deepEqual(emails, [])
  assert.deepEqual(invalid, ['a@localhost'])
})

test('blank and whitespace-only inputs yield no recipients', () => {
  assert.deepEqual(parseRecipients(''), { emails: [], invalid: [] })
  assert.deepEqual(parseRecipients('   ,  '), { emails: [], invalid: [] })
})

test('duplicates are removed case-insensitively, first casing kept', () => {
  const { emails } = parseRecipients('A@x.com, a@x.com, b@Y.com')
  assert.deepEqual(emails, ['A@x.com', 'b@Y.com'])
})

test('a trailing comma is tolerated', () => {
  const { emails, invalid } = parseRecipients('a@x.com,')
  assert.deepEqual(emails, ['a@x.com'])
  assert.deepEqual(invalid, [])
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../../lib/invoiceRecipients.ts'` (or "parseRecipients is not a function").

- [ ] **Step 3: Write the implementation**

Create `lib/invoiceRecipients.ts`:

```ts
// Turns the invoice email's To field — a comma-separated string Dan types —
// into validated addresses. Pure and dependency-free: the client panel uses
// it for live feedback and the server action uses it as the authoritative
// gate on who an invoice reaches, so both sides agree on exactly one parse.
//
// The pattern is deliberately loose: one "@", no whitespace on either side,
// and a dot-bearing domain. This is not RFC 5322 — it is the check that
// catches the mistakes a human actually makes (a name with no address, a
// missing domain) without rejecting valid addresses it doesn't understand.
// The real delivery verdict comes from Resend; this only stops the obvious.
//
// No '@/' imports and no server-only anything — it is exercised by
// node --test and imported into the browser bundle.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function parseRecipients(raw: string): { emails: string[]; invalid: string[] } {
  const seen = new Set<string>()
  const emails: string[] = []
  const invalid: string[] = []
  for (const part of raw.split(',')) {
    const addr = part.trim()
    if (!addr) continue
    const key = addr.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    if (EMAIL_RE.test(addr)) emails.push(addr)
    else invalid.push(addr)
  }
  return { emails, invalid }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS — all six `invoiceRecipients` tests pass; the rest of the suite is unchanged.

- [ ] **Step 5: Commit**

```bash
git add lib/invoiceRecipients.ts scripts/test/invoiceRecipients.test.ts
git commit -m "Add parseRecipients: validate a comma-separated To field"
```

---

### Task 2: Split the email body builder (additive)

Add the two new pure functions alongside the existing `buildInvoiceEmail` (which stays until Task 3 removes it, so nothing that imports it breaks yet). `buildInvoiceEmailDefaults` produces the prefill (subject + body, **no** link); `assembleInvoiceEmail` produces the final `{ subject, text, html }` with the link appended as a footer and the HTML built from the plain-text body.

**Files:**
- Modify: `lib/invoiceEmailBody.ts` (add two exports; leave `buildInvoiceEmail` and `InvoiceEmailInput` in place)
- Test: `scripts/test/invoiceEmailBody.test.ts` (new)

**Interfaces:**
- Consumes: `formatUSD` (`./money.ts`), `formatDateLong` (`./dates.ts`), `escapeHtml` (already exported from this module), `DocumentData` (`../components/InvoiceDocument.tsx`).
- Produces:
  - `buildInvoiceEmailDefaults(input: { invoice: DocumentData; status: 'draft' | 'sent' | 'paid' | 'void' }): { subject: string; body: string }` — `body` is plain text with no link/PDF footer.
  - `assembleInvoiceEmail(input: { subject: string; body: string; publicUrl: string }): { subject: string; text: string; html: string }` — appends `View it online: <publicUrl>` and `A PDF copy is attached.` to `text`; builds `html` from the escaped body plus a real `<a href>` link.

- [ ] **Step 1: Write the failing test**

Create `scripts/test/invoiceEmailBody.test.ts`:

```ts
// The prefill (buildInvoiceEmailDefaults) and the final assembly
// (assembleInvoiceEmail) are pure, so the wording, the figures, the
// ABSENCE of bank details, and the appended link are all testable here
// with no network and no API key.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildInvoiceEmailDefaults, assembleInvoiceEmail } from '../../lib/invoiceEmailBody.ts'
import { formatUSD } from '../../lib/money.ts'
import type { DocumentData } from '../../components/InvoiceDocument.tsx'

const SETTINGS: DocumentData['settings'] = {
  business_name: 'The Audio Smith',
  legal_name: 'Smith Audio, LLC',
  address_line1: '2610 Melbourne Lane',
  address_line2: 'Lake in the Hills, IL 60156',
  phone: '269.217.8400',
  email: 'dan@theaudiosmith.com',
  remit_to: 'Smith Audio, LLC\n2610 Melbourne Lane',
}

const INVOICE: DocumentData = {
  number: 386,
  issue_date: '2026-08-07',
  due_date: '2026-09-06',
  terms_days: 30,
  bill_to_snapshot: 'Journey Church',
  subtotal_cents: 50000,
  tax_bp: 0,
  tax_cents: 0,
  deposit_cents: 0,
  total_cents: 50000,
  notes: null,
  client: {
    name: 'Journey Church', address_line1: null, address_line2: null,
    city: null, state: null, postal_code: null,
  },
  lines: [{
    id: 'l1',
    description: 'Audio Training/Maintenance',
    qty_hundredths: 100,
    unit_price_cents: 50000,
    line_total_cents: 50000,
  }],
  settings: SETTINGS,
}

const URL = 'https://billing.theaudiosmith.com/i/11111111-2222-3333-4444-555555555555'

test('the default subject and body name the LEGAL entity, not the trading name', () => {
  const { subject, body } = buildInvoiceEmailDefaults({ invoice: INVOICE, status: 'sent' })
  assert.ok(subject.includes('386'), 'the invoice number is in the subject')
  assert.ok(subject.includes('Smith Audio, LLC'), 'the legal name is in the subject')
  assert.ok(!subject.includes('The Audio Smith'), 'and the trading name is not')
  assert.ok(body.includes('Smith Audio, LLC'), 'the legal name is in the body')
  assert.ok(!body.includes('The Audio Smith'), 'and the trading name is not')
})

test('the default body carries the amount and the due date but NOT the link', () => {
  const { body } = buildInvoiceEmailDefaults({ invoice: INVOICE, status: 'sent' })
  assert.ok(body.includes(formatUSD(50000)), 'carries $500.00')
  assert.ok(body.includes('9/6/2026'), 'carries the due date')
  assert.ok(!body.includes(URL), 'does not carry the link — that is appended at send')
  assert.ok(!body.includes('View it online'), 'and has no link line at all')
})

test('a paid invoice defaults to receipt wording, no demand and no due date', () => {
  const { subject, body } = buildInvoiceEmailDefaults({ invoice: INVOICE, status: 'paid' })
  assert.ok(subject.startsWith('Receipt for invoice'), 'the subject reads as a receipt')
  assert.ok(body.includes('Paid in full'), 'the body says Paid in full')
  assert.ok(body.includes(formatUSD(50000)), 'still carries the amount')
  assert.ok(!body.includes('Amount due'), 'does not demand payment')
  assert.ok(!body.includes('Due:'), 'has no due date line')
  assert.ok(!body.includes('Payment'), 'carries no Payment/remit-to block')
})

test('the default amount is the stored total, not a recomputed one', () => {
  const withDeposit: DocumentData = {
    ...INVOICE, subtotal_cents: 688394, deposit_cents: 585000, total_cents: 103394,
  }
  const { body } = buildInvoiceEmailDefaults({ invoice: withDeposit, status: 'sent' })
  assert.ok(body.includes(formatUSD(103394)), 'the amount is the stored total, $1,033.94')
  assert.ok(!body.includes(formatUSD(688394)), 'not the subtotal')
})

test('bank details can never reach the default body', () => {
  const leaky = {
    ...INVOICE,
    settings: { ...SETTINGS, ach_details: 'Routing 071000013 Account 1234567890' },
  } as unknown as DocumentData
  const { body } = buildInvoiceEmailDefaults({ invoice: leaky, status: 'sent' })
  // Positive control first: remit_to is the payment detail that DOES belong,
  // so the two absence checks below prove something only because this passes.
  assert.ok(body.includes(SETTINGS.remit_to as string), 'remit_to still prints')
  assert.ok(!body.includes('071000013'), 'no routing number')
  assert.ok(!body.includes('1234567890'), 'no account number')
})

test('assemble appends the link footer to the text and a real anchor to the html', () => {
  const { subject, text, html } = assembleInvoiceEmail({
    subject: 'Invoice #386 from Smith Audio, LLC',
    body: 'Amount due: $500.00',
    publicUrl: URL,
  })
  assert.equal(subject, 'Invoice #386 from Smith Audio, LLC', 'subject passes through')
  assert.ok(
    text.endsWith(`View it online: ${URL}\nA PDF copy is attached.`),
    'the text ends with the appended link and PDF note',
  )
  assert.ok(text.includes('Amount due: $500.00'), 'the body is above the footer')
  assert.ok(html.includes(`<a href="${URL}">`), 'the html link is a real anchor')
  assert.ok(html.includes('A PDF copy is attached.'), 'the html notes the attachment')
})

test('the html escapes whatever Dan typed into the body', () => {
  const { html } = assembleInvoiceEmail({
    subject: 'x', body: '<script>alert(1)</script>', publicUrl: URL,
  })
  assert.ok(!html.includes('<script>'), 'the raw tag never survives into the html')
  assert.ok(html.includes('&lt;script&gt;'), 'it is escaped instead')
})

test('an empty body still produces a footer-only email with no leading blank lines', () => {
  const { text, html } = assembleInvoiceEmail({ subject: 'x', body: '   ', publicUrl: URL })
  assert.equal(text, `View it online: ${URL}\nA PDF copy is attached.`, 'text is footer only')
  assert.ok(!text.startsWith('\n'), 'no leading blank line')
  assert.ok(!html.includes('<div style="margin:0 0 16px"></div>'), 'no empty body block')
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `buildInvoiceEmailDefaults is not a function` (and `assembleInvoiceEmail is not a function`).

- [ ] **Step 3: Add the two functions**

In `lib/invoiceEmailBody.ts`, **below** the existing `buildInvoiceEmail` function (leave `buildInvoiceEmail`, `escapeHtml`, `InvoiceEmailInput`, and all imports as they are), add:

```ts
// The PREFILL. Subject and a plain-text body Dan edits before sending. The
// body deliberately omits the public link: its token does not exist until
// the server mints it at send, so the link is appended by assembleInvoiceEmail
// (below), never typed. Everything else mirrors what the email used to say —
// amount, due date (or "Paid in full" for a receipt), the remit-to block, the
// thank-you — so an unedited send reads exactly as before, minus the link
// which now lands at the very bottom.
//
// remit_to only, NEVER ach_details — bank numbers on a forwarded email are
// the same exposure as on a forwarded PDF. Withheld entirely on a receipt: a
// document saying "paid in full" has no business printing where to send money.
export function buildInvoiceEmailDefaults(input: {
  invoice: DocumentData
  status: 'draft' | 'sent' | 'paid' | 'void'
}): { subject: string; body: string } {
  const { invoice, status } = input
  const business = invoice.settings?.legal_name ?? 'Smith Audio, LLC'
  const amount = formatUSD(invoice.total_cents)
  const isReceipt = status === 'paid'

  const subject = isReceipt
    ? `Receipt for invoice #${invoice.number} from ${business}`
    : `Invoice #${invoice.number} from ${business}`

  const remit = !isReceipt && (invoice.settings?.remit_to?.trim() || null)

  const parts = [`Invoice #${invoice.number} from ${business}`, '']
  if (isReceipt) {
    parts.push(`Paid in full: ${amount}`)
  } else {
    parts.push(`Amount due: ${amount}`, `Due: ${formatDateLong(invoice.due_date)}`)
  }
  if (remit) parts.push('', 'Payment', remit)
  parts.push('', 'Thank you for your business!')
  return { subject, body: parts.join('\n') }
}

// The FINAL assembly. Takes Dan's (possibly edited) subject and body and the
// server-minted public URL, and produces what actually gets sent. The link
// and the "PDF copy is attached" line are appended here — always, at the end,
// after whatever Dan wrote — so no edit can drop them. The html is built from
// the plain-text body: every line escaped, newlines to <br>, then the link as
// a real anchor. Pure string work; it cannot throw on a bad date because it
// never formats one (buildInvoiceEmailDefaults already did that at prefill).
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

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS — the new `invoiceEmailBody` tests pass; the existing `invoiceEmail.test.ts` tests still pass (they use the untouched `buildInvoiceEmail`).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add lib/invoiceEmailBody.ts scripts/test/invoiceEmailBody.test.ts
git commit -m "Add buildInvoiceEmailDefaults and assembleInvoiceEmail"
```

---

### Task 3: Wire the editable send end-to-end

Change the send input type, the sender, the server action, and the panel together (they are coupled by the `InvoiceEmailInput` type change and the `sendInvoice` signature change), remove the now-dead `buildInvoiceEmail`, and adapt its old test file. After this task the feature is live.

**Files:**
- Modify: `lib/invoiceEmailBody.ts` (rewrite `InvoiceEmailInput`; remove `buildInvoiceEmail`)
- Modify: `lib/invoiceEmail.ts` (import & use `assembleInvoiceEmail`)
- Modify: `app/invoices/actions.ts` (new `sendInvoice` signature + validation)
- Modify: `components/SendInvoicePanel.tsx` (editable fields, live validation)
- Modify: `app/invoices/[id]/page.tsx` (drop the removed `publicUrlBase` prop)
- Modify: `scripts/test/invoiceEmail.test.ts` (drop `buildInvoiceEmail` tests; adapt the never-throw contract test)

**Interfaces:**
- Consumes: `parseRecipients` (Task 1), `buildInvoiceEmailDefaults` + `assembleInvoiceEmail` (Task 2), `invoiceFilename` (`./invoicePdf.ts`), `DocumentData`.
- Produces:
  - `InvoiceEmailInput = { to: string[]; subject: string; body: string; invoice: DocumentData; publicUrl: string; replyTo: string }`.
  - `sendInvoice(invoiceId: string, draft: { to: string; subject: string; body: string }): Promise<{ error: string } | { ok: true }>`.

- [ ] **Step 1: Rewrite `InvoiceEmailInput` and remove `buildInvoiceEmail`**

In `lib/invoiceEmailBody.ts`:

Replace the whole `export type InvoiceEmailInput = { ... }` block with:

```ts
export type InvoiceEmailInput = {
  /** Validated recipients. Resend accepts several; parsed by the caller. */
  to: string[]
  /** Dan's (possibly edited) subject. */
  subject: string
  /** Dan's (possibly edited) plain-text body, WITHOUT the link footer. */
  body: string
  /** Carries the settings (From legal name) and number (attachment filename). */
  invoice: DocumentData
  /** Absolute URL of the public copy. Must be absolute — this is an email. */
  publicUrl: string
  replyTo: string
}
```

Then **delete the entire `export function buildInvoiceEmail(input: InvoiceEmailInput) { ... }` function** (all of it, through its closing brace and `return { subject, text, html }`). Keep `escapeHtml`, `buildInvoiceEmailDefaults`, and `assembleInvoiceEmail`. `formatDateLong` is still imported and used by `buildInvoiceEmailDefaults`, so leave the imports.

- [ ] **Step 2: Point `sendInvoiceEmail` at `assembleInvoiceEmail`**

In `lib/invoiceEmail.ts`:

Change the import line:

```ts
import { assembleInvoiceEmail, type InvoiceEmailInput } from './invoiceEmailBody.ts'
```

Inside `sendInvoiceEmail`, replace the body-building line

```ts
    const { subject, text, html } = buildInvoiceEmail(input)
```

with

```ts
    const { subject, text, html } = assembleInvoiceEmail({
      subject: input.subject,
      body: input.body,
      publicUrl: input.publicUrl,
    })
```

Leave everything else (the key/from guards, `business`, the `Resend` send with `to: input.to`, `attachments`, the try/catch) as it is — `input.to` is now a `string[]`, which Resend accepts directly.

- [ ] **Step 3: Typecheck to see the callers that must change**

Run: `npx tsc --noEmit`
Expected: FAIL — errors in `app/invoices/actions.ts` (constructs `InvoiceEmailInput` with the old `status`/`note`/string `to`) and in `scripts/test/invoiceEmail.test.ts` (imports the deleted `buildInvoiceEmail`). These are fixed in the next steps.

- [ ] **Step 4: Update the `sendInvoice` server action**

In `app/invoices/actions.ts`:

Add the import near the other `@/lib` imports at the top:

```ts
import { parseRecipients } from '@/lib/invoiceRecipients'
```

Change the signature and add validation. Replace:

```ts
export async function sendInvoice(
  invoiceId: string, note: string,
): Promise<{ error: string } | { ok: true }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  const appUrl = process.env.APP_URL
  if (!appUrl) return { error: 'Email is not configured yet (APP_URL is missing).' }
```

with:

```ts
export async function sendInvoice(
  invoiceId: string,
  draft: { to: string; subject: string; body: string },
): Promise<{ error: string } | { ok: true }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  const appUrl = process.env.APP_URL
  if (!appUrl) return { error: 'Email is not configured yet (APP_URL is missing).' }

  // Authoritative recipient + subject validation, before any DB read or token
  // mint. parseRecipients is the same function the panel uses for live
  // feedback, so what Dan saw accepted is what the server accepts. A bad
  // address is named rather than handed blindly to Resend.
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

Then remove the old billing-email-derived recipient block. Delete these lines:

```ts
  const to = inv.clients?.billing_email?.trim()
  if (!to) {
    return {
      error: `${inv.clients?.name ?? 'This client'} has no billing email on file, ` +
        'so there is nowhere to send it. Add one on the client screen.',
    }
  }
```

(The void check just above it stays. `billing_email` is still selected in the query and used only to prefill the panel now — leaving it in the select is harmless.)

Next, replace the `sendInvoiceEmail({ ... })` call:

```ts
  const result = await sendInvoiceEmail({
    to,
    invoice: data,
    status: inv.status,
    publicUrl: `${appUrl.replace(/\/+$/, '')}/i/${token}`,
    note,
    // From Settings, not hardcoded — it is already editable there, and a
    // second copy in code is one that goes stale silently. The fallback only
    // covers a settings row with no email at all.
    replyTo: settings?.email ?? 'dan@theaudiosmith.com',
    pdf,
  })
```

with:

```ts
  const result = await sendInvoiceEmail({
    to: emails,
    subject,
    body: draft.body,
    invoice: data,
    publicUrl: `${appUrl.replace(/\/+$/, '')}/i/${token}`,
    // From Settings, not hardcoded — it is already editable there, and a
    // second copy in code is one that goes stale silently. The fallback only
    // covers a settings row with no email at all.
    replyTo: settings?.email ?? 'dan@theaudiosmith.com',
    pdf,
  })
```

Finally, fix the stale-status error message that referenced the old single `to`. Replace:

```ts
      error: `Invoice #${inv.number} was emailed to ${to}, but recording that failed: ` +
```

with:

```ts
      error: `Invoice #${inv.number} was emailed to ${emails.join(', ')}, but recording that failed: ` +
```

- [ ] **Step 5: Rewrite the `SendInvoicePanel`**

Replace the entire contents of `components/SendInvoicePanel.tsx` with:

```tsx
'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { buildInvoiceEmailDefaults } from '@/lib/invoiceEmailBody'
import { parseRecipients } from '@/lib/invoiceRecipients'
import { sendInvoice } from '@/app/invoices/actions'
import type { DocumentData } from '@/components/InvoiceDocument'

// Sending is irreversible, so nothing goes until Dan has seen and can edit the
// recipients, the subject and the body. This panel is the only place a wrong
// address can be caught before it leaves.
//
// The three fields prefill from buildInvoiceEmailDefaults (pure, no network,
// no key) and the client's billing email; Dan edits any of them. The public
// link and the PDF are NOT shown here as editable text — the server mints the
// link's token at send and appends it, so it can never be edited away. What
// Dan types is exactly what is sent, above that appended footer.
//
// parseRecipients here is live feedback only; the server action re-parses the
// To field and is the authoritative gate.

export default function SendInvoicePanel({
  invoiceId, data, to, status,
}: {
  invoiceId: string
  data: DocumentData
  /** The client's billing email, trimmed, or null. Prefills the To field. */
  to: string | null
  status: 'draft' | 'sent' | 'paid' | 'void'
}) {
  const router = useRouter()
  const defaults = buildInvoiceEmailDefaults({ invoice: data, status })

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
      // sendInvoice's contract is to return { error }, never throw — but
      // nothing enforces that at the type level, and a throw here would reject
      // the transition and hand it to the nearest error boundary, replacing
      // this whole page and losing sent/error state. Belt and braces.
      try {
        const result = await sendInvoice(invoiceId, { to: toField, subject, body })
        if ('error' in result) { setError(result.error); return }
        setSent(true)
        setOpen(false)
        router.refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : 'The invoice could not be sent.')
      }
    })
  }

  if (!open) {
    return (
      <div className="flex items-center gap-3">
        {sent && <span className="text-xs text-good">Sent</span>}
        {error && <span role="alert" className="text-xs text-danger">{error}</span>}
        <button type="button" onClick={() => { setOpen(true); setSent(false) }}
                className="text-xs font-semibold uppercase tracking-wider text-accent hover:opacity-80">
          Email invoice
        </button>
      </div>
    )
  }

  const fieldClass =
    'w-full px-3 py-2 bg-bg border border-line rounded-field text-ink text-sm ' +
    'focus:border-accent focus:outline-none'

  return (
    <div className="w-full mt-4 border border-line rounded-card p-4 bg-surface">
      <p className="eyebrow mb-3">Send this invoice</p>

      <label className="eyebrow block mb-2" htmlFor="to">To</label>
      <input id="to" type="text" value={toField} onChange={(e) => setToField(e.target.value)}
             placeholder="name@example.com, second@example.com"
             className={`${fieldClass} mb-1`} />
      <p className="text-xs text-muted mb-4">
        Separate several addresses with commas.
        {invalid.length > 0 && (
          <span className="text-danger"> Not a valid email: {invalid.join(', ')}.</span>
        )}
      </p>

      <label className="eyebrow block mb-2" htmlFor="subject">Subject</label>
      <input id="subject" type="text" value={subject} onChange={(e) => setSubject(e.target.value)}
             className={`${fieldClass} mb-4`} />

      <label className="eyebrow block mb-2" htmlFor="body">Message</label>
      <textarea id="body" rows={10} value={body} onChange={(e) => setBody(e.target.value)}
                className={`${fieldClass} mb-2`} />

      <p className="text-xs text-muted mb-4">
        A link to a read-only copy and the PDF are added automatically at the end,
        so you don&rsquo;t need to include them.
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
          {pending ? 'Sending…' : emails.length > 1 ? `Send to ${emails.length} recipients` : 'Send'}
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

- [ ] **Step 6: Drop the removed `publicUrlBase` prop at the call site**

In `app/invoices/[id]/page.tsx`, in the `<SendInvoicePanel ... />` block (around line 216), delete the line:

```tsx
          publicUrlBase={process.env.APP_URL ?? ''}
```

Leave `invoiceId`, `data`, `to`, and `status` as they are.

- [ ] **Step 7: Adapt the old email test file**

Replace the entire contents of `scripts/test/invoiceEmail.test.ts` with a single test of the sender's never-throw contract (the `buildInvoiceEmail` wording/receipt/escaping cases now live in `invoiceEmailBody.test.ts`):

```ts
// sendInvoiceEmail promises to return { error } rather than throw, so a failed
// send never loses the record of what was being sent. The pure body building
// is tested in invoiceEmailBody.test.ts; this pins the network-failure
// contract of the server sender itself.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sendInvoiceEmail } from '../../lib/invoiceEmail.ts'
import type { InvoiceEmailInput } from '../../lib/invoiceEmailBody.ts'
import type { DocumentData } from '../../components/InvoiceDocument.tsx'

const INVOICE = {
  number: 386,
  due_date: '2026-09-06',
  total_cents: 50000,
  settings: { legal_name: 'Smith Audio, LLC' },
} as unknown as DocumentData

const BASE: InvoiceEmailInput & { pdf: Buffer } = {
  to: ['accounts@journey.example'],
  subject: 'Invoice #386 from Smith Audio, LLC',
  body: 'Amount due: $500.00',
  invoice: INVOICE,
  publicUrl: 'https://billing.theaudiosmith.com/i/11111111-2222-3333-4444-555555555555',
  replyTo: 'dan@theaudiosmith.com',
  pdf: Buffer.from(''),
}

test('a network failure makes the send return an error, never throw', async () => {
  // The send goes over fetch (Resend's SDK). We force fetch to throw, so this
  // exercises the try/catch's promise of { error } — with two guards that a
  // real POST is never made: a fetch that throws, and a fake key.
  const prevKey = process.env.RESEND_API_KEY
  const prevFrom = process.env.INVOICE_FROM_EMAIL
  const prevFetch = globalThis.fetch
  process.env.RESEND_API_KEY = 'dummy-test-key'
  process.env.INVOICE_FROM_EMAIL = 'test@example.invalid'
  globalThis.fetch = (() => {
    throw new Error('network call attempted in invoiceEmail.test.ts — this test must never reach the network')
  }) as typeof fetch
  try {
    const result = await sendInvoiceEmail(BASE)
    assert.ok(result.error, 'it returned an error instead of throwing')
  } finally {
    if (prevKey === undefined) delete process.env.RESEND_API_KEY
    else process.env.RESEND_API_KEY = prevKey
    if (prevFrom === undefined) delete process.env.INVOICE_FROM_EMAIL
    else process.env.INVOICE_FROM_EMAIL = prevFrom
    globalThis.fetch = prevFetch
  }
})

test('a missing RESEND_API_KEY is reported, not thrown', async () => {
  const prevKey = process.env.RESEND_API_KEY
  delete process.env.RESEND_API_KEY
  try {
    const result = await sendInvoiceEmail(BASE)
    assert.ok(result.error?.includes('RESEND_API_KEY'), 'the missing key is named')
  } finally {
    if (prevKey !== undefined) process.env.RESEND_API_KEY = prevKey
  }
})
```

- [ ] **Step 8: Run the full test suite**

Run: `npm test`
Expected: PASS — `invoiceRecipients`, `invoiceEmailBody`, and the adapted `invoiceEmail` tests all pass; no references to the removed `buildInvoiceEmail` remain.

- [ ] **Step 9: Typecheck and build**

Run: `npx tsc --noEmit && npm run build`
Expected: both clean — no errors about `buildInvoiceEmail`, `publicUrlBase`, `note`, or `status` on `InvoiceEmailInput`.

- [ ] **Step 10: Confirm nothing else imports the removed function**

Run: `grep -rn "buildInvoiceEmail\b" app components lib scripts | grep -v "buildInvoiceEmailDefaults"`
Expected: no output (every reference is now `buildInvoiceEmailDefaults` or `assembleInvoiceEmail`).

- [ ] **Step 11: Commit**

```bash
git add lib/invoiceEmailBody.ts lib/invoiceEmail.ts app/invoices/actions.ts \
        components/SendInvoicePanel.tsx app/invoices/[id]/page.tsx \
        scripts/test/invoiceEmail.test.ts
git commit -m "Make invoice email editable: recipients, subject, body"
```

---

## Verification

- `npm test` — all pass, including the three email-related files (`invoiceRecipients`, `invoiceEmailBody`, `invoiceEmail`). The suite count rises by the new tests; none of the pre-existing non-email tests change.
- `npx tsc --noEmit` and `npm run build` — clean.
- `grep -rn "buildInvoiceEmail\b" app components lib scripts | grep -v Defaults` — empty.
- Manual walk in the preview (dev server), on an invoice with a client that has a billing email and one without:
  - "Email invoice" opens the panel with **To** prefilled (empty when the client has no billing email), **Subject** and **Message** prefilled from the generated defaults, and the link/PDF **not** in the message.
  - Typing a bad address (`foo`) shows the inline "Not a valid email" note and disables **Send**; clearing the To field also disables it; clearing the Subject disables it.
  - Two comma-separated addresses enable **Send** and the button reads "Send to 2 recipients".
- Since a real send hits Resend, verify the send path only with a genuine test recipient Dan controls (or trust the unit tests + build for the pre-send logic). Do **not** send to a real client as part of verification.

## Blast radius

No schema, no migration. Touches only the invoice-send path: two pure libs (one new), the server sender, the `sendInvoice` action, the send panel, and one prop at the panel's single call site. The reminder emails and the public `/i/[token]` page are untouched. The one behavior change beyond "fields are editable" is that a client with **no** billing email no longer blocks the panel — Dan can now type a recipient — which is the intended new capability.

## Out of scope (backlog, recorded)

- Edit the reminder email the same way — will reuse `parseRecipients`, `assembleInvoiceEmail`, and this panel's editable-field pattern.
- Download-PDF button on the public `/i/[token]` link, expenses included — decide regenerate-on-demand vs store-the-emailed-bytes at build time.
