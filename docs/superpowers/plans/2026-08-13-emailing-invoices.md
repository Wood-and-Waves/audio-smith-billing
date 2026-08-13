# Emailing Invoices Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Email an invoice to a client with the PDF attached and a link to a read-only online copy.

**Architecture:** A nullable per-invoice token opens a public page at `/i/<token>`, which reads through a security-definer Postgres function rather than the service-role key, so `anon` keeps zero table privileges. Email is built by a pure function and sent by a thin wrapper that constructs its Resend client per call. Sending renders the PDF from the same builder the download button uses, and records `sent_at` only after the send succeeds.

**Tech Stack:** Next.js 16 App Router, React 19, Supabase Postgres with RLS, `resend`, `@react-pdf/renderer`, `node --test` with native type stripping.

**Spec:** `docs/superpowers/specs/2026-08-13-emailing-invoices-design.md`

**Task 1's SQL was executed before this plan was handed over.** It was applied
inside a transaction against the live database and rolled back, with the checks
in Steps 3 and 4 run against it as the `anon` role. It applied cleanly and
returned `anon`/`inv_select=false`/`number=386`/`leaks_ach=false`/`lines=1`/
`unknown_null=true`/`null_null=true`, and the rollback left no column, no
function and all 105 invoices and 19 clients untouched. It should apply on the
first try; if it does not, suspect the environment before the SQL.

## Blocked, and what that means

**Resend is not configured yet.** `RESEND_API_KEY`, `INVOICE_FROM_EMAIL` and
`NEXT_PUBLIC_APP_URL` do not exist. Every task below is buildable and testable
without them: the email body is built by a pure function, and the send path is
tested for its refusal when the key is absent.

**No task in this plan sends an email.** The live-send verification is a separate
checklist at the end, to be run by hand once Resend is set up, and its first
recipient is Dan's own address. **Never send to a client address during
implementation or testing.**

## Global Constraints

- **Money is integer cents**, rendered only through `formatUSD(cents)` from `lib/money.ts`. **Never recompute a money value** — the imported history holds both $106.36 and $106.37 for the same computed rate.
- **Dates go through `lib/dates.ts`** (`formatDateLong`). **Never `new Date()`** for a calendar date; it prints a day early west of UTC.
- **`settings.ach_details` must never leave the server.** Not in the email, not in the PDF, not in the public function's select list, not in any payload sent to a browser. `remit_to` prints; ACH is sent only when a client asks.
- **`anon` must keep ZERO table privileges.** The only thing it gains in this plan is `EXECUTE` on one function. Verify, don't assume.
- **`new Resend(key)` is constructed per call, never at module scope.** A module-scope client throws during `next build` wherever the key is absent.
- **Every environment variable is read at call time, not module scope**, for the same reason: a missing value must produce a message, not a failed build.
- **Any route answering without a session must be added to `PUBLIC_PREFIXES` in `proxy.ts`**, or it silently 307s to `/login`.
- **`lib/` modules import relatively with explicit extensions** (`'./money.ts'`); tests run under plain `node --test` with no alias loader. **No JSX in `lib/`** — Node strips types but not JSX.
- The live database holds **105 real invoices, 19 real clients, $196,267.42**. Migrations are additive. No destructive SQL.
- Every task ends with `npm test`, `npx tsc --noEmit` and `npm run build` clean.

---

### Task 1: The token and the public read function

Adds the per-invoice token and the one function the public page reads through. This is the security-critical task: it is the first time anything in this database answers without a session.

**Files:**
- Create: `scripts/sql/migrations/0006_public_invoice_link.sql`

**Interfaces:**
- Produces: `invoices.public_token uuid null unique`, and
  `public.public_invoice(p_token uuid) returns jsonb`, executable by `anon` and
  `authenticated`. Its JSON shape matches `DocumentData` in
  `components/InvoiceDocument.tsx` plus a `status` field.

- [ ] **Step 1: Write the migration**

Create `scripts/sql/migrations/0006_public_invoice_link.sql`:

```sql
-- 0006 — a public, read-only link to one invoice
--
-- Clients receive the PDF as an attachment, but corporate mail filters strip
-- attachments, so each sent invoice also gets a link to an online copy.
--
-- The token is NULLABLE on purpose. The 105 imported invoices never had a link
-- and must not silently acquire one; a token is minted on first send. Clearing
-- it revokes the link, which is the whole of revocation — there is no expiry,
-- because an invoice link that dies is worse than one that lives, and the token
-- is unguessable and the page read-only.
alter table invoices
  add column public_token uuid unique;

-- How the public page reads.
--
-- The alternative was the service-role key, which is deliberately absent from
-- Vercel and bypasses every policy in this database — one careless select in
-- page code would become total exposure. This function is the narrow version of
-- the same capability: it can only ever return the row whose token matches,
-- there is no filter for a caller to widen, and ach_details is not in its select
-- list, so bank details are unreachable from the public side by construction
-- rather than by remembering.
--
-- security definer + a pinned search_path: the function runs as its owner, so
-- search_path must not be attacker-influenced.
--
-- A void invoice is excluded. Voiding an invoice must take it away from the
-- client too, not merely hide it in the app.
create function public.public_invoice(p_token uuid)
returns jsonb
language sql
security definer
set search_path = public
stable
as $fn$
  select jsonb_build_object(
    'number',           i.number,
    'issue_date',       i.issue_date,
    'due_date',         i.due_date,
    'terms_days',       i.terms_days,
    'status',           i.status,
    'bill_to_snapshot', i.bill_to_snapshot,
    'subtotal_cents',   i.subtotal_cents,
    'tax_bp',           i.tax_bp,
    'tax_cents',        i.tax_cents,
    'deposit_cents',    i.deposit_cents,
    'total_cents',      i.total_cents,
    -- Mirrors app/invoices/[id]/page.tsx: an imported invoice's note is an
    -- internal remark about the import, not something a client should read.
    'notes',            case when i.imported then null else i.notes end,
    'client', jsonb_build_object(
      'name',          c.name,
      'address_line1', c.address_line1,
      'address_line2', c.address_line2
    ),
    'lines', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id',               l.id,
          'description',      l.description,
          'qty_hundredths',   l.qty_hundredths,
          'unit_price_cents', l.unit_price_cents,
          'line_total_cents', l.line_total_cents
        ) order by l.position
      )
      from invoice_lines l
      where l.invoice_id = i.id
    ), '[]'::jsonb),
    -- Exactly the seven columns InvoiceDocument consumes. ach_details is not
    -- among them and must never be added.
    'settings', (
      select jsonb_build_object(
        'business_name', s.business_name,
        'legal_name',    s.legal_name,
        'address_line1', s.address_line1,
        'address_line2', s.address_line2,
        'phone',         s.phone,
        'email',         s.email,
        'remit_to',      s.remit_to
      )
      from settings s where s.id = 1
    )
  )
  from invoices i
  left join clients c on c.id = i.client_id
  where i.public_token = p_token
    and i.status <> 'void';
$fn$;

-- create function grants EXECUTE to PUBLIC by default, so the revoke is not
-- redundant — without it, every role would get this.
revoke all on function public.public_invoice(uuid) from public;
grant execute on function public.public_invoice(uuid) to anon, authenticated;
```

- [ ] **Step 2: Apply it**

Run:

```bash
npm run db:migrate
```

Expected: reports `0006_public_invoice_link.sql` applied. If it reports drift on
an earlier file, STOP and report — an applied migration has been edited.

- [ ] **Step 3: Prove `anon` gained no table access**

Create `/tmp/verify-anon.sql`:

```sql
set local role anon;
select current_user as who,
       has_table_privilege('public.invoices','select')      as inv_select,
       has_table_privilege('public.clients','select')       as cli_select,
       has_table_privilege('public.settings','select')      as set_select,
       has_table_privilege('public.invoice_lines','select') as lines_select,
       has_function_privilege('public.public_invoice(uuid)','execute') as can_execute;
```

Run:

```bash
npm run db:sql -- /tmp/verify-anon.sql
```

Expected: `who = anon`, all four `*_select` columns **false**, `can_execute`
**true**. Any `true` in a select column is a STOP — report it, do not proceed.

- [ ] **Step 4: Prove the function returns one invoice, and only the safe fields**

This runs inside a transaction that is rolled back, so no real invoice keeps a
token. Create `/tmp/verify-fn.sql`:

```sql
begin;

-- Give one real invoice a token for the length of this transaction only.
update invoices set public_token = '11111111-2222-3333-4444-555555555555'
 where number = 386;

set local role anon;

-- A valid token returns exactly that invoice.
select (public_invoice('11111111-2222-3333-4444-555555555555')->>'number') as number,
       (public_invoice('11111111-2222-3333-4444-555555555555')->'settings' ? 'ach_details') as leaks_ach,
       jsonb_array_length(public_invoice('11111111-2222-3333-4444-555555555555')->'lines') as line_count;

-- An unknown token returns null.
select public_invoice('99999999-9999-9999-9999-999999999999') is null as unknown_is_null;

-- A null token returns null.
select public_invoice(null) is null as null_is_null;

rollback;
```

Run:

```bash
npm run db:sql -- /tmp/verify-fn.sql
```

Expected: `number = 386`, `leaks_ach = false`, `line_count >= 1`,
`unknown_is_null = true`, `null_is_null = true`.

**`leaks_ach = true` is a STOP.** Report it and change nothing else.

- [ ] **Step 5: Confirm the rollback left no token behind**

Run:

```bash
npm run db:sql -- /dev/stdin <<'EOF'
select count(*) as invoices_with_token from invoices where public_token is not null;
EOF
```

Expected: `0`. If it is not zero, the transaction did not roll back — report
immediately.

- [ ] **Step 6: Commit**

```bash
git add scripts/sql/migrations/0006_public_invoice_link.sql
git commit -m "Add a public invoice token and the function that reads it."
```

---

### Task 2: The email itself

A pure builder and a thin sender. No task in this plan calls the sender against the real API.

**Files:**
- Create: `lib/invoiceEmail.ts`
- Create: `scripts/test/invoiceEmail.test.ts`
- Modify: `package.json` (adds `resend`)

**Interfaces:**
- Consumes: `formatUSD` from `lib/money.ts`, `formatDateLong` from `lib/dates.ts`, the `DocumentData` type from `components/InvoiceDocument.tsx`.
- Produces:
  - `export type InvoiceEmailInput = { to: string; invoice: DocumentData; publicUrl: string; note: string | null; replyTo: string }`
  - `export function buildInvoiceEmail(input: InvoiceEmailInput): { subject: string; text: string; html: string }`
  - `export async function sendInvoiceEmail(input: InvoiceEmailInput & { pdf: Buffer }): Promise<{ error?: string }>`

- [ ] **Step 1: Install resend**

Run:

```bash
npm install resend
```

- [ ] **Step 2: Write the failing test**

Create `scripts/test/invoiceEmail.test.ts`:

```ts
// buildInvoiceEmail is pure, so the wording, the figures and — most
// importantly — the ABSENCE of bank details are all testable here without a
// network, an API key, or any risk of a message actually leaving.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildInvoiceEmail, type InvoiceEmailInput } from '../../lib/invoiceEmail.ts'
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
  client: { name: 'Journey Church', address_line1: null, address_line2: null },
  lines: [{
    id: 'l1',
    description: 'Audio Training/Maintenance',
    qty_hundredths: 100,
    unit_price_cents: 50000,
    line_total_cents: 50000,
  }],
  settings: SETTINGS,
}

const BASE: InvoiceEmailInput = {
  to: 'accounts@journey.example',
  invoice: INVOICE,
  publicUrl: 'https://billing.theaudiosmith.com/i/11111111-2222-3333-4444-555555555555',
  note: null,
  replyTo: 'dan@theaudiosmith.com',
}

test('the subject names the invoice and the business', () => {
  const { subject } = buildInvoiceEmail(BASE)
  assert.ok(subject.includes('386'), 'the invoice number is in the subject')
  assert.ok(subject.includes('The Audio Smith'), 'the business is in the subject')
})

test('both bodies carry the amount, the due date and the link', () => {
  const { text, html } = buildInvoiceEmail(BASE)
  for (const [name, body] of [['text', text], ['html', html]] as const) {
    assert.ok(body.includes(formatUSD(50000)), `${name} carries $500.00`)
    assert.ok(body.includes('9/6/2026'), `${name} carries the due date`)
    assert.ok(body.includes(BASE.publicUrl), `${name} carries the link`)
  }
})

test('the amount is formatUSD of the stored total, not a recomputed one', () => {
  // A total that disagrees with its own lines, the way a deposit invoice does.
  const withDeposit: InvoiceEmailInput = {
    ...BASE,
    invoice: { ...INVOICE, subtotal_cents: 688394, deposit_cents: 585000, total_cents: 103394 },
  }
  const { text } = buildInvoiceEmail(withDeposit)
  assert.ok(text.includes(formatUSD(103394)), 'the amount due is the stored total, $1,033.94')
  assert.ok(!text.includes(formatUSD(688394)), 'not the subtotal')
})

test("Dan's note appears when given", () => {
  const { text, html } = buildInvoiceEmail({ ...BASE, note: 'Invoice for the last two visits.' })
  assert.ok(text.includes('Invoice for the last two visits.'))
  assert.ok(html.includes('Invoice for the last two visits.'))
})

test('an empty note leaves no empty paragraph or dangling label behind', () => {
  const withEmpty = buildInvoiceEmail({ ...BASE, note: '   ' })
  const withNull = buildInvoiceEmail({ ...BASE, note: null })
  assert.equal(withEmpty.text, withNull.text, 'whitespace-only reads the same as none')
  assert.equal(withEmpty.html, withNull.html)
  assert.ok(!withNull.html.includes('<p></p>'), 'no empty paragraph')
  assert.ok(!/\n\n\n/.test(withNull.text), 'no triple blank line')
})

test('bank details can never reach either body', () => {
  // ach_details is not part of DocumentData. This attaches it the way a
  // careless widening of the type would, and proves the builder still does not
  // print it. The type is the real guard; this catches its removal.
  const leaky: InvoiceEmailInput = {
    ...BASE,
    invoice: {
      ...INVOICE,
      settings: { ...SETTINGS, ach_details: 'Routing 071000013 Account 1234567890' },
    } as unknown as DocumentData,
  }
  const { text, html } = buildInvoiceEmail(leaky)
  for (const body of [text, html]) {
    assert.ok(!body.includes('071000013'), 'no routing number')
    assert.ok(!body.includes('1234567890'), 'no account number')
  }
})

test('the html body escapes anything a client name could carry', () => {
  const nasty: InvoiceEmailInput = {
    ...BASE,
    note: '<script>alert(1)</script>',
  }
  const { html } = buildInvoiceEmail(nasty)
  assert.ok(!html.includes('<script>'), 'the raw tag never survives into the html')
  assert.ok(html.includes('&lt;script&gt;'), 'it is escaped instead')
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run:

```bash
npm test 2>&1 | tail -20
```

Expected: FAIL — `Cannot find module '../../lib/invoiceEmail.ts'`.

- [ ] **Step 4: Write the module**

Create `lib/invoiceEmail.ts`:

```ts
// The invoice email.
//
// SERVER ONLY — sendInvoiceEmail reads RESEND_API_KEY. Never import this from a
// client component.
//
// Build and send are separate so the wording, the figures and the absence of
// bank details are unit-testable without a network or an API key. The send
// returns { error } rather than throwing, so a failed email never destroys the
// record of what was being sent.
//
// The Resend client is constructed PER CALL, never at module scope: a top-level
// `new Resend(...)` throws during `next build` wherever the key is absent, which
// broke every CrewTracker preview deployment until 2026-07-27. Environment
// variables are read at call time for the same reason.
//
// No JSX and no '@/' imports — this module is exercised by node --test.

import { formatUSD } from './money.ts'
import { formatDateLong } from './dates.ts'
import type { DocumentData } from '../components/InvoiceDocument.tsx'

export type InvoiceEmailInput = {
  to: string
  invoice: DocumentData
  /** Absolute URL of the public copy. Must be absolute — this is an email. */
  publicUrl: string
  /** Dan's per-send message. May be null, empty, or whitespace. */
  note: string | null
  replyTo: string
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function buildInvoiceEmail(input: InvoiceEmailInput) {
  const { invoice, publicUrl } = input
  const business = invoice.settings?.business_name ?? 'The Audio Smith'
  const amount = formatUSD(invoice.total_cents)
  const due = formatDateLong(invoice.due_date)
  const note = input.note?.trim() || null

  const subject = `Invoice #${invoice.number} from ${business}`

  // Deliberately NOT settings.ach_details. Bank numbers on a forwarded email
  // are the same exposure as bank numbers on a forwarded PDF; a client who
  // wants to pay by transfer asks, and gets them in a reply.
  const remit = invoice.settings?.remit_to?.trim() || null

  const textParts = [
    `Invoice #${invoice.number} from ${business}`,
    '',
    `Amount due: ${amount}`,
    `Due: ${due}`,
  ]
  if (note) textParts.push('', note)
  textParts.push('', `View it online: ${publicUrl}`, 'A PDF copy is attached.')
  if (remit) textParts.push('', 'Payment', remit)
  textParts.push('', 'Thank you for your business!')
  const text = textParts.join('\n')

  const htmlParts = [
    `<p style="margin:0 0 16px"><strong>Invoice #${invoice.number}</strong> from ${escapeHtml(business)}</p>`,
    `<p style="margin:0 0 4px">Amount due: <strong>${amount}</strong></p>`,
    `<p style="margin:0 0 16px">Due: ${due}</p>`,
  ]
  if (note) {
    htmlParts.push(
      `<p style="margin:0 0 16px;white-space:pre-line">${escapeHtml(note)}</p>`,
    )
  }
  htmlParts.push(
    `<p style="margin:0 0 16px"><a href="${escapeHtml(publicUrl)}">View this invoice online</a></p>`,
    '<p style="margin:0 0 16px">A PDF copy is attached.</p>',
  )
  if (remit) {
    htmlParts.push(
      '<p style="margin:0 0 4px;font-size:12px;color:#525252">Payment</p>',
      `<p style="margin:0 0 16px;font-size:12px;color:#525252;white-space:pre-line">${escapeHtml(remit)}</p>`,
    )
  }
  htmlParts.push(
    '<p style="margin:0;font-size:12px;color:#737373">Thank you for your business!</p>',
  )
  const html =
    `<div style="font-family:system-ui,-apple-system,sans-serif;font-size:14px;color:#121212;line-height:1.5">` +
    htmlParts.join('') +
    '</div>'

  return { subject, text, html }
}

export async function sendInvoiceEmail(
  input: InvoiceEmailInput & { pdf: Buffer },
): Promise<{ error?: string }> {
  const key = process.env.RESEND_API_KEY
  if (!key) return { error: 'Email is not configured yet (RESEND_API_KEY is missing).' }

  const from = process.env.INVOICE_FROM_EMAIL
  if (!from) return { error: 'Email is not configured yet (INVOICE_FROM_EMAIL is missing).' }

  const business = input.invoice.settings?.business_name ?? 'The Audio Smith'
  const { subject, text, html } = buildInvoiceEmail(input)

  try {
    const { Resend } = await import('resend')
    const { error } = await new Resend(key).emails.send({
      from: `${business} <${from}>`,
      to: input.to,
      replyTo: input.replyTo,
      subject,
      text,
      html,
      attachments: [{
        filename: `Invoice-${input.invoice.number}.pdf`,
        content: input.pdf,
      }],
    })
    if (error) return { error: error.message }
    return {}
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'The email could not be sent.' }
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run:

```bash
npm test 2>&1 | tail -20
```

Expected: PASS — 54 existing plus 7 new = **61 passing**.

- [ ] **Step 6: Confirm the missing-key path returns rather than throws**

Run:

```bash
node --input-type=module -e "
import { sendInvoiceEmail } from './lib/invoiceEmail.ts'
const r = await sendInvoiceEmail({
  to: 'nobody@example.com', publicUrl: 'https://x/i/y', note: null,
  replyTo: 'dan@theaudiosmith.com', pdf: Buffer.from(''),
  invoice: { number: 1, issue_date: '2026-01-01', due_date: '2026-01-31', terms_days: 30,
    bill_to_snapshot: null, subtotal_cents: 0, tax_bp: 0, tax_cents: 0, deposit_cents: 0,
    total_cents: 0, notes: null, client: null, lines: [], settings: null },
})
console.log('result:', JSON.stringify(r))
"
```

Expected: `result: {"error":"Email is not configured yet (RESEND_API_KEY is missing)."}`
— an error object, not a thrown exception, and no network call.

- [ ] **Step 7: Typecheck, build, commit**

Run:

```bash
npx tsc --noEmit && npm run build 2>&1 | grep -E "Compiled|Failed"
```

Expected: no type errors, `✓ Compiled successfully`.

```bash
git add lib/invoiceEmail.ts scripts/test/invoiceEmail.test.ts package.json package-lock.json
git commit -m "Build the invoice email, and refuse to send without a key."
```

---

### Task 3: The public page

The read-only copy a client opens. The first route in this app that answers without a session.

**Files:**
- Create: `app/i/[token]/page.tsx`
- Modify: `proxy.ts`

**Interfaces:**
- Consumes: `public_invoice(p_token uuid)` from Task 1; `InvoiceDocument` and its `DocumentData` type; `displayStatus`, `daysUntilDue`, `todayInChicago` from `lib/status.ts`.
- Produces: a page at `/i/<token>`.

- [ ] **Step 1: Allowlist the route**

In `proxy.ts`, change:

```ts
const PUBLIC_PREFIXES = ['/login', '/auth', '/api/dev']
```

to:

```ts
// /i is the public invoice link. It is a single page that reads through the
// public_invoice() function (migration 0006), which returns one invoice by
// unguessable token and nothing else — anon holds no table privileges.
const PUBLIC_PREFIXES = ['/login', '/auth', '/api/dev', '/i']
```

- [ ] **Step 2: Write the page**

Create `app/i/[token]/page.tsx`:

```tsx
import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { displayStatus, daysUntilDue, todayInChicago } from '@/lib/status'
import InvoiceDocument, { type DocumentData } from '@/components/InvoiceDocument'

// The public copy of one invoice.
//
// PUBLIC — this answers without a session, so /i is allowlisted in proxy.ts.
// It reads through public_invoice() (migration 0006), a security-definer
// function that returns exactly the invoice matching an unguessable token, with
// only the seven settings columns the document needs. anon has no table
// privileges, so nothing else in the database is reachable from here.
//
// It renders the same InvoiceDocument as the app and the PDF, so a client
// looking at this page and a client looking at the attachment see one document.

export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default async function PublicInvoicePage(
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params

  // Guard the shape before it reaches Postgres: a malformed uuid is an error
  // from the driver, not a null result, and a 500 would tell a prober that the
  // parameter is a uuid. A bad token is simply "not found".
  if (!UUID.test(token)) notFound()

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('public_invoice', { p_token: token })
  if (error || !data) notFound()

  const invoice = data as DocumentData & { status: 'draft' | 'sent' | 'paid' | 'void' }
  const today = todayInChicago()
  const shown = displayStatus(
    { status: invoice.status, due_date: invoice.due_date, total_cents: invoice.total_cents },
    today,
  )
  const days = daysUntilDue(invoice.due_date, today)

  return (
    <main className="min-h-screen bg-bg px-4 py-10">
      <div className="mx-auto max-w-3xl">
        <p className="eyebrow mb-3 text-center">
          {shown === 'paid'
            ? 'Paid — thank you'
            : shown === 'overdue'
              ? `Overdue by ${Math.abs(days)} ${Math.abs(days) === 1 ? 'day' : 'days'}`
              : `Due in ${days} ${days === 1 ? 'day' : 'days'}`}
        </p>
        <InvoiceDocument data={invoice} />
        <p className="mt-6 text-center text-xs text-muted">
          Questions about this invoice? Reply to the email it came with.
        </p>
      </div>
    </main>
  )
}
```

- [ ] **Step 3: Typecheck and build**

Run:

```bash
npx tsc --noEmit && npm run build 2>&1 | grep -E "Compiled|Failed|/i/"
```

Expected: no type errors, `✓ Compiled successfully`, and `/i/[token]` listed
among the routes.

- [ ] **Step 4: Prove the route is reachable without a session and 404s on a bad token**

Start the dev server in one shell:

```bash
npm run dev
```

In another, request a well-formed but unknown token and a malformed one:

```bash
curl -s -o /dev/null -w "unknown token: %{http_code}\n" \
  http://localhost:3000/i/11111111-2222-3333-4444-555555555555
curl -s -o /dev/null -w "malformed:     %{http_code}\n" \
  http://localhost:3000/i/not-a-uuid
```

Expected: **404** for both. A **307** means `proxy.ts` is redirecting to
`/login` and Step 1 did not take effect. A **500** on the malformed one means
the UUID guard is not working.

Stop the dev server.

- [ ] **Step 5: Prove a real token renders the invoice**

This mints a token, checks the page, then removes the token again — leaving the
database as it was found.

```bash
npm run db:sql -- /dev/stdin <<'EOF'
update invoices set public_token = '11111111-2222-3333-4444-555555555555' where number = 386;
EOF
```

Start `npm run dev`, then:

```bash
curl -s http://localhost:3000/i/11111111-2222-3333-4444-555555555555 \
  | grep -o "Journey Church\|\$500.00\|Thank you for your business" | sort -u
```

Expected: all three strings present.

Then confirm the bank details are NOT in the response:

```bash
curl -s http://localhost:3000/i/11111111-2222-3333-4444-555555555555 \
  | grep -ci "ach_details\|routing" || echo "0 — clean"
```

Expected: `0 — clean`.

**Now remove the token** — this is not optional:

```bash
npm run db:sql -- /dev/stdin <<'EOF'
update invoices set public_token = null where number = 386;
select count(*) as still_tokened from invoices where public_token is not null;
EOF
```

Expected: `still_tokened = 0`. Stop the dev server.

- [ ] **Step 6: Commit**

```bash
git add "app/i/[token]/page.tsx" proxy.ts
git commit -m "Serve a read-only invoice at a public link."
```

---

### Task 4: Sending

The panel and the action. Nothing here sends during implementation — the key is absent, so the action's own error path is what gets exercised.

**Files:**
- Create: `components/SendInvoicePanel.tsx`
- Modify: `app/invoices/actions.ts`
- Modify: `app/invoices/[id]/page.tsx`
- Modify: `next.config.ts`

**Interfaces:**
- Consumes: `buildInvoiceEmail`, `sendInvoiceEmail` from `lib/invoiceEmail.ts`; `buildInvoicePdf` from `lib/invoicePdf.ts`; the `docData` object already built in `app/invoices/[id]/page.tsx`.
- Produces: `sendInvoice(invoiceId: string, note: string): Promise<{ error: string } | { ok: true }>`, and `<SendInvoicePanel invoiceId={...} data={docData} to={...} />`.

- [ ] **Step 1: Write the action**

Append to `app/invoices/actions.ts`:

```ts
/**
 * Emails an invoice: PDF attached, plus a link to the public copy.
 *
 * ORDERING IS DELIBERATE. The status and sent_at are written only AFTER the
 * send succeeds. If that write then fails, Dan has an invoice a client received
 * that the app still calls a draft — visible, and correctable by hand. The
 * reverse order would mark an invoice sent that never left, which nobody would
 * ever notice.
 *
 * draft, sent and paid are all sendable: a draft is the normal case, sending a
 * sent invoice again is a resend, and a paid one is occasionally wanted as a
 * receipt. Only void is refused — a voided invoice must never reach a client.
 */
export async function sendInvoice(
  invoiceId: string, note: string,
): Promise<{ error: string } | { ok: true }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL
  if (!appUrl) return { error: 'Email is not configured yet (NEXT_PUBLIC_APP_URL is missing).' }

  const [{ data: invoice }, { data: settings }] = await Promise.all([
    supabase
      .from('invoices')
      .select(
        `id, number, issue_date, due_date, terms_days, status, bill_to_snapshot,
         subtotal_cents, tax_bp, tax_cents, deposit_cents, total_cents, notes, imported,
         public_token,
         clients(name, address_line1, address_line2, billing_email),
         invoice_lines(id, position, description, qty_hundredths, unit_price_cents, line_total_cents)`,
      )
      .eq('id', invoiceId)
      .maybeSingle(),
    supabase
      .from('settings')
      // Explicit columns. ach_details must never join this list — it would then
      // travel into the email builder and, from there, to a client.
      .select('business_name, legal_name, address_line1, address_line2, phone, email, remit_to')
      .eq('id', 1)
      .maybeSingle(),
  ])

  if (!invoice) return { error: 'That invoice no longer exists.' }

  const inv = invoice as unknown as {
    id: string; number: number; issue_date: string; due_date: string; terms_days: number
    status: 'draft' | 'sent' | 'paid' | 'void'; bill_to_snapshot: string | null
    subtotal_cents: number; tax_bp: number; tax_cents: number; deposit_cents: number
    total_cents: number; notes: string | null; imported: boolean
    public_token: string | null
    clients: { name: string; address_line1: string | null; address_line2: string | null; billing_email: string | null } | null
    invoice_lines: { id: string; position: number; description: string; qty_hundredths: number; unit_price_cents: number; line_total_cents: number }[]
  }

  if (inv.status === 'void') {
    return { error: `Invoice #${inv.number} is void. Voided invoices are not sent.` }
  }

  const to = inv.clients?.billing_email?.trim()
  if (!to) {
    return {
      error: `${inv.clients?.name ?? 'This client'} has no billing email on file, ` +
        'so there is nowhere to send it. Add one on the client screen.',
    }
  }

  // Mint the link on first send. Historical invoices stay tokenless until they
  // are actually sent from here.
  let token = inv.public_token
  if (!token) {
    token = crypto.randomUUID()
    const { error: tokErr } = await supabase
      .from('invoices').update({ public_token: token }).eq('id', invoiceId)
    if (tokErr) return { error: tokErr.message }
  }

  const lines = [...(inv.invoice_lines ?? [])].sort((a, b) => a.position - b.position)

  const data: DocumentData = {
    number: inv.number,
    issue_date: inv.issue_date,
    due_date: inv.due_date,
    terms_days: inv.terms_days,
    bill_to_snapshot: inv.bill_to_snapshot,
    subtotal_cents: inv.subtotal_cents,
    tax_bp: inv.tax_bp,
    tax_cents: inv.tax_cents,
    deposit_cents: inv.deposit_cents,
    total_cents: inv.total_cents,
    notes: inv.imported ? null : inv.notes,
    client: inv.clients
      ? {
          name: inv.clients.name,
          address_line1: inv.clients.address_line1,
          address_line2: inv.clients.address_line2,
        }
      : null,
    lines,
    settings: settings ?? null,
  }

  // Rendered from the SAME builder as the download button, so the attachment
  // cannot differ from what was approved on screen.
  //
  // Absolute paths from process.cwd(), NOT relative ones. The browser fetches
  // these over HTTP; here they are read off the serverless filesystem, and a
  // relative path depends on a working directory nobody controls. next.config
  // must also trace them into this route's bundle — Vercel serves public/ from
  // the CDN and does not otherwise put it in the function.
  const { join } = await import('node:path')
  const { Document, Page, Text, View, Image, Font, renderToBuffer } =
    await import('@react-pdf/renderer')
  Font.register({
    family: 'Oswald',
    src: join(process.cwd(), 'public', 'fonts', 'Oswald-Bold.ttf'),
    fontWeight: 700,
  })
  const pdf = await renderToBuffer(
    buildInvoicePdf(
      { Document, Page, Text, View, Image },
      data,
      { logoSrc: join(process.cwd(), 'public', 'logo.png') },
    ),
  )

  const result = await sendInvoiceEmail({
    to,
    invoice: data,
    publicUrl: `${appUrl.replace(/\/+$/, '')}/i/${token}`,
    note,
    // From Settings, not hardcoded — it is already editable there, and a
    // second copy in code is one that goes stale silently. The fallback only
    // covers a settings row with no email at all.
    replyTo: settings?.email ?? 'dan@theaudiosmith.com',
    pdf,
  })
  if (result.error) return { error: result.error }

  // Only now. See the note above about ordering.
  const { error: markErr } = await supabase
    .from('invoices')
    .update({
      sent_at: new Date().toISOString(),
      ...(inv.status === 'draft' ? { status: 'sent' } : {}),
    })
    .eq('id', invoiceId)
  if (markErr) {
    return {
      error: `Invoice #${inv.number} was emailed to ${to}, but recording that failed: ` +
        `${markErr.message}. The client has it; the status here is stale.`,
    }
  }

  revalidatePath(`/invoices/${invoiceId}`)
  revalidatePath('/invoices')
  return { ok: true }
}
```

Add these imports at the top of `app/invoices/actions.ts`:

```ts
import { buildInvoicePdf } from '@/lib/invoicePdf'
import { sendInvoiceEmail } from '@/lib/invoiceEmail'
import type { DocumentData } from '@/components/InvoiceDocument'
```

**Note:** `new Date().toISOString()` here is correct and is NOT a violation of
the plain-date rule — `sent_at` is a timestamptz recording an instant, not a
calendar date.

- [ ] **Step 1b: Trace the font and logo into the route's bundle**

The action reads `public/fonts/Oswald-Bold.ttf` and `public/logo.png` off the
filesystem at runtime. Vercel serves `public/` from the CDN and does **not**
otherwise include it in a serverless function, so without this the send would
work locally and fail in production with a file-not-found — the worst possible
place to discover it.

Replace the contents of `next.config.ts` with:

```ts
import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // The invoice PDF is rendered server-side when an invoice is emailed, which
  // reads the font and the logo off the filesystem. public/ is a CDN concern
  // to Vercel and is not bundled into a function unless it is traced here.
  outputFileTracingIncludes: {
    '/invoices/[id]': ['./public/fonts/Oswald-Bold.ttf', './public/logo.png'],
  },
}

export default nextConfig
```

- [ ] **Step 2: Write the panel**

Create `components/SendInvoicePanel.tsx`:

```tsx
'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { buildInvoiceEmail } from '@/lib/invoiceEmail'
import { sendInvoice } from '@/app/invoices/actions'
import type { DocumentData } from '@/components/InvoiceDocument'

// Sending is irreversible, so nothing goes until Dan has seen the actual
// recipient, subject and body. This panel is the only place a wrong address can
// be caught.
//
// buildInvoiceEmail is imported for the PREVIEW only — it is a pure function
// with no key and no network. The send itself happens in the server action.

export default function SendInvoicePanel({
  invoiceId, data, to, publicUrlBase,
}: {
  invoiceId: string
  data: DocumentData
  to: string | null
  publicUrlBase: string
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)
  const [pending, start] = useTransition()

  if (!to) {
    return (
      <span className="text-xs text-muted">
        No billing email for this client — add one to send.
      </span>
    )
  }

  // The token is minted by the server on first send, so the preview shows the
  // shape of the link rather than the link itself. Deliberate: inventing a
  // token here would either be wrong or would have to be persisted before Dan
  // has agreed to send anything.
  const preview = buildInvoiceEmail({
    to,
    invoice: data,
    publicUrl: `${publicUrlBase}/i/[link generated when you send]`,
    note,
    replyTo: data.settings?.email ?? 'dan@theaudiosmith.com',
  })

  function send() {
    setError(null)
    start(async () => {
      const result = await sendInvoice(invoiceId, note)
      if ('error' in result) { setError(result.error); return }
      setSent(true)
      setOpen(false)
      router.refresh()
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

  return (
    <div className="w-full mt-4 border border-line rounded-card p-4 bg-surface">
      <p className="eyebrow mb-3">Send this invoice</p>

      <dl className="text-sm mb-4">
        <div className="flex gap-3 py-1">
          <dt className="text-muted w-20 shrink-0">To</dt>
          <dd className="tabular">{to}</dd>
        </div>
        <div className="flex gap-3 py-1">
          <dt className="text-muted w-20 shrink-0">Subject</dt>
          <dd>{preview.subject}</dd>
        </div>
      </dl>

      <label className="eyebrow block mb-2" htmlFor="note">Add a message (optional)</label>
      <textarea id="note" rows={3} value={note} onChange={(e) => setNote(e.target.value)}
                placeholder="e.g. Invoice for the last two visits."
                className="w-full px-3 py-2 bg-bg border border-line rounded-field text-ink text-sm
                           focus:border-accent focus:outline-none mb-4" />

      <p className="eyebrow mb-2">They will receive</p>
      <pre className="text-xs text-muted whitespace-pre-wrap border-l-2 border-line pl-3 mb-4">
        {preview.text}
      </pre>

      <p className="text-xs text-muted mb-4">
        The PDF is attached, and the link goes to a read-only copy they can open in a browser.
      </p>

      {error && (
        <p role="alert" className="mb-3 text-sm text-danger border-l-2 border-danger pl-3 py-1">
          {error}
        </p>
      )}

      <div className="flex items-center gap-3">
        <button type="button" onClick={send} disabled={pending}
                className="px-5 py-2.5 bg-accent-surface text-accent-ink font-bold uppercase tracking-wider
                           text-sm rounded-field cursor-pointer hover:opacity-90 transition-opacity
                           disabled:opacity-50 disabled:cursor-not-allowed">
          {pending ? 'Sending…' : `Send to ${to}`}
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

- [ ] **Step 3: Wire it into the invoice page**

In `app/invoices/[id]/page.tsx`, add to the imports:

```tsx
import SendInvoicePanel from '@/components/SendInvoicePanel'
```

The page's invoice query must also fetch the client's billing email. Change the
`clients(...)` fragment in that query from:

```
clients(name, address_line1, address_line2),
```

to:

```
clients(name, address_line1, address_line2, billing_email),
```

Then, in the action row that currently holds `<DownloadInvoiceButton …/>` and the
Edit link, add the panel's trigger alongside them:

```tsx
        <div className="flex items-center gap-5">
          <SendInvoicePanel
            invoiceId={inv.id}
            data={docData}
            to={(inv.clients as { billing_email?: string | null } | null)?.billing_email ?? null}
            publicUrlBase={process.env.NEXT_PUBLIC_APP_URL ?? ''}
          />
          <DownloadInvoiceButton data={docData} />
          <Link
            href={`/invoices/${inv.id}/edit`}
            className="text-xs font-semibold uppercase tracking-wider text-accent hover:opacity-80"
          >
            Edit
          </Link>
        </div>
```

**`docData.client` must keep exactly the three fields it has** — `name`,
`address_line1`, `address_line2`. Do not let `billing_email` into `docData`; it
is fetched for the panel's recipient display, not for the document.

- [ ] **Step 4: Typecheck and build**

Run:

```bash
npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)" && npx tsc --noEmit && npm run build 2>&1 | grep -E "Compiled|Failed"
```

Expected: 61 passing, no type errors, `✓ Compiled successfully`.

- [ ] **Step 5: Confirm sending refuses cleanly with no key configured**

`RESEND_API_KEY` is absent, so pressing Send must produce a readable message and
change nothing. Verify the ordering guarantee holds by checking that no invoice
was marked sent:

```bash
npm run db:sql -- /dev/stdin <<'EOF'
select count(*) as sent_or_tokened
  from invoices
 where sent_at is not null or public_token is not null;
EOF
```

Expected: `0`. Record this number before and after any manual UI poking; it must
not change while the key is absent.

- [ ] **Step 6: Commit**

```bash
git add components/SendInvoicePanel.tsx app/invoices/actions.ts "app/invoices/[id]/page.tsx"
git commit -m "Preview and send an invoice by email."
```

---

## Verification when Resend is configured

**Not part of any task.** Run this by hand once `RESEND_API_KEY`,
`INVOICE_FROM_EMAIL` and `NEXT_PUBLIC_APP_URL` exist in Vercel.

1. **Temporarily point a client's billing email at Dan's own address** — or use
   an invoice for a client whose billing email is already his. **The first live
   send must not go to a client.**
2. Open that invoice, press Email invoice, check the recipient and subject, add
   a note, send.
3. Confirm in the received mail:
   - it did not land in spam
   - the PDF attachment opens and matches the on-screen invoice
   - the link opens the public page and shows the same document
   - replying goes to `dan@theaudiosmith.com`
4. Confirm the invoice now shows as sent, with `sent_at` set.
5. Confirm the public link still works after the invoice is marked paid, and
   that the page then reads "Paid — thank you".
6. Void a test invoice and confirm its public link 404s.
7. **Restore the client's real billing email** if it was changed in step 1.

## Verification

- `npm test` — 61 passing.
- `npx tsc --noEmit` — clean.
- `npm run build` — compiles, `/i/[token]` listed.
- `anon` holds zero table privileges and `EXECUTE` on exactly one function.
- `public_invoice` returns one invoice for a valid token, null for an unknown or
  null one, and never `ach_details`.
- No invoice carries a `public_token` or a `sent_at` at the end of
  implementation — nothing was actually sent.

## Blast radius

Additive. One nullable column, one function, one new route, one new module. The
migration touches no existing row and no existing policy. `anon` gains exactly
one `EXECUTE` grant and no table access.

The genuinely new exposure is the `/i/<token>` route: it is the first thing in
this app that answers without a session. It can return one invoice, chosen by a
122-bit token, with seven settings columns and no bank details — and Task 1
proves that against the database rather than asserting it.
