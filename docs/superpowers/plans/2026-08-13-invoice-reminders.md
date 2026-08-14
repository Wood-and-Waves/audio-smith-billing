# Invoice Reminders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A weekly Monday digest of what is due and overdue, a one-off note the first morning an invoice goes overdue, and a one-click reminder to a client.

**Architecture:** A pure `sweep()` decides what is due-soon, overdue and newly-overdue with no I/O, delegating the definition of "overdue" to `lib/status.ts` rather than restating it. A daily Vercel cron calls a secret-guarded route that runs the sweep — that daily query is also the Supabase keepalive — and sends mail only on Mondays or when something first goes overdue.

**Tech Stack:** Next.js 16 App Router, Supabase (service-role client, server-only), Resend, Vercel Cron, `node --test` with native type stripping.

**Spec:** `docs/superpowers/specs/2026-08-13-invoice-reminders-design.md`

**No migration.** `reminder_log` has existed since 0001 with `id, owner_id, invoice_id, kind, sent_to, sent_at`, RLS on, an owner policy for `authenticated`, and full grants for `service_role`. `anon` has none. Verified against the live database before this plan shipped — do not write a migration.

**Task 1 was executed before this plan was handed over.** Its module and its nine tests were extracted and run: all nine pass. That run is what found the `lib/status.ts` import defect in Step 0 — without it every test in Task 1 fails with `ERR_MODULE_NOT_FOUND` pointing at a file the task does not otherwise touch. The probe was then reverted and the tree left clean at 66 passing.

## Blocked, and what that means

`CRON_SECRET` and `SUPABASE_SERVICE_ROLE_KEY` are not set yet. Every task below is buildable and testable without them: the sweep and both email bodies are pure functions, and the route is tested for its **refusal** when the secret is absent or wrong.

**No task in this plan sends an email or writes to `reminder_log` in the live database.** A live run is a hand-verification checklist at the end.

## Global Constraints

- **Money is integer cents**, rendered only through `formatUSD(cents)` from `lib/money.ts`. **Never recompute a money value.**
- **Dates are plain `YYYY-MM-DD` strings** handled through `lib/dates.ts`. **Never `new Date()` for a calendar date.** `new Date()` for a timestamp instant (a `sent_at`) is correct and is not a violation.
- **"Overdue" is defined once, in `lib/status.ts`** (`due_date < today`, so an invoice due *today* is not overdue). `sweep` must call `displayStatus`/`daysUntilDue`, never write its own comparison. A second definition would eventually disagree with what the invoice list and the public page show.
- **`settings.ach_details` must never appear in any email.**
- **`SUPABASE_SERVICE_ROLE_KEY` may be read in exactly one file** — `app/api/cron/reminders/route.ts`. Never in a page, component, or server action. It bypasses every RLS policy in the database.
- **Neither secret may take a `NEXT_PUBLIC_` prefix**, which would inline it into the browser bundle at build time.
- **`new Resend(key)` per call, never at module scope**; every environment variable read at call time. A module-scope client throws during `next build` where the key is absent.
- **`/api/cron` must be added to `PUBLIC_PREFIXES` in `proxy.ts`** or it silently 307s to `/login`.
- **`lib/` modules import relatively with explicit extensions** (`'./status.ts'`), never `'@/lib/…'`; tests run under plain `node --test` with no alias loader. **No JSX in `lib/`.**
- The live database holds **105 real invoices, 19 real clients, 4 open worth $9,993.14**.
- Every task ends with `npm test`, `npx tsc --noEmit` and `npm run build` clean.

---

### Task 1: The sweep

The whole decision, with no database, no email and no clock. Everything else in this plan is plumbing around it.

**Files:**
- Create: `lib/reminders.ts`
- Create: `scripts/test/reminders.test.ts`
- Modify: `lib/status.ts:46` — see Step 0, which is not optional

**Interfaces:**
- Consumes: `displayStatus`, `daysUntilDue`, `type StoredStatus` from `lib/status.ts`.

- [ ] **Step 0: Make `lib/status.ts` importable under `node --test`**

`lib/status.ts` line 46 reads:

```ts
export { todayInChicago } from './dates'
```

It is the **only** relative import anywhere in `lib/` without an explicit `.ts`
extension, and no test has ever imported that file, so nothing has caught it.
Node's resolver needs the extension: importing `status.ts` under `node --test`
today fails with `ERR_MODULE_NOT_FOUND … /lib/dates`. Every test in this task
imports it transitively, so they would all fail with an error pointing at a file
you did not touch.

Change it to:

```ts
export { todayInChicago } from './dates.ts'
```

Verify it now imports at all:

```bash
node --input-type=module -e "
import { displayStatus, daysUntilDue } from './lib/status.ts'
console.log('sent ->', displayStatus({status:'sent',due_date:'2026-08-25',total_cents:1}, '2026-08-20'))
console.log('overdue ->', displayStatus({status:'sent',due_date:'2026-08-19',total_cents:1}, '2026-08-20'))
console.log('daysUntilDue ->', daysUntilDue('2026-08-27','2026-08-20'))
"
```

Expected: `sent -> sent`, `overdue -> overdue`, `daysUntilDue -> 7`.
- Produces:
  - `export const DUE_SOON_DAYS = 7`
  - `export type ReminderInvoice = { id, number, due_date, total_cents, status, client_name, alerted_overdue }`
  - `export type Sweep = { dueSoon, overdue, newlyOverdue, totalOutstandingCents }`
  - `export function sweep(invoices: ReminderInvoice[], today: string): Sweep`
  - `export function isDigestDay(today: string): boolean`

- [ ] **Step 1: Write the failing test**

Create `scripts/test/reminders.test.ts`:

```ts
// The sweep is pure, so every boundary is pinned here exactly — no database,
// no clock, no email. "Today" is always injected.
//
// Reference dates, checked against a calendar before this was written:
//   2026-08-16 Sunday   2026-08-17 Monday   2026-08-18 Tuesday
//   2026-08-24 Monday   2026-08-20 Thursday

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sweep, isDigestDay, DUE_SOON_DAYS, type ReminderInvoice } from '../../lib/reminders.ts'

const TODAY = '2026-08-20'   // a Thursday

const inv = (over: Partial<ReminderInvoice> = {}): ReminderInvoice => ({
  id: 'i1',
  number: 400,
  due_date: TODAY,
  total_cents: 50000,
  status: 'sent',
  client_name: 'Journey Church',
  alerted_overdue: false,
  ...over,
})

test('due in 8 days is not yet due-soon; 7 days is', () => {
  const far = sweep([inv({ due_date: '2026-08-28' })], TODAY)
  assert.equal(far.dueSoon.length, 0, '8 days out is quiet')
  assert.equal(far.overdue.length, 0)

  const edge = sweep([inv({ due_date: '2026-08-27' })], TODAY)
  assert.equal(edge.dueSoon.length, 1, `${DUE_SOON_DAYS} days out is due soon`)
})

test('due today is due-soon, NOT overdue', () => {
  const s = sweep([inv({ due_date: TODAY })], TODAY)
  assert.equal(s.dueSoon.length, 1, 'due today still counts as due soon')
  assert.equal(s.overdue.length, 0, 'and is not yet overdue — lib/status.ts owns this rule')
})

test('due yesterday and never alerted is overdue AND newly overdue', () => {
  const s = sweep([inv({ due_date: '2026-08-19', alerted_overdue: false })], TODAY)
  assert.equal(s.overdue.length, 1)
  assert.equal(s.newlyOverdue.length, 1)
  assert.equal(s.dueSoon.length, 0)
})

test('already alerted is overdue but NOT newly overdue', () => {
  // This is what stops the same invoice emailing every single morning.
  const s = sweep([inv({ due_date: '2026-08-01', alerted_overdue: true })], TODAY)
  assert.equal(s.overdue.length, 1)
  assert.equal(s.newlyOverdue.length, 0)
})

test('draft, paid and void never appear, at any date', () => {
  for (const status of ['draft', 'paid', 'void'] as const) {
    for (const due of ['2026-08-01', TODAY, '2026-08-25']) {
      const s = sweep([inv({ status, due_date: due })], TODAY)
      assert.equal(s.dueSoon.length, 0, `${status} due ${due} is not due-soon`)
      assert.equal(s.overdue.length, 0, `${status} due ${due} is not overdue`)
      assert.equal(s.newlyOverdue.length, 0, `${status} due ${due} is not newly overdue`)
      assert.equal(s.totalOutstandingCents, 0, `${status} owes nothing`)
    }
  }
})

test('outstanding sums stored cents across every chaseable invoice', () => {
  // Including one due far in the future, which is owed but not yet chased.
  const s = sweep([
    inv({ id: 'a', total_cents: 655314, due_date: '2026-08-01' }),   // overdue
    inv({ id: 'b', total_cents: 50000, due_date: '2026-08-22' }),    // due soon
    inv({ id: 'c', total_cents: 234000, due_date: '2026-12-01' }),   // neither
    inv({ id: 'd', total_cents: 999900, status: 'paid' }),           // ignored
  ], TODAY)
  assert.equal(s.totalOutstandingCents, 655314 + 50000 + 234000)
  assert.equal(s.overdue.length, 1)
  assert.equal(s.dueSoon.length, 1)
})

test('each bucket is ordered soonest first', () => {
  const s = sweep([
    inv({ id: 'late', due_date: '2026-08-19' }),
    inv({ id: 'later', due_date: '2026-08-05' }),
  ], TODAY)
  assert.deepEqual(s.overdue.map((i) => i.id), ['later', 'late'], 'oldest overdue leads')
})

test('isDigestDay is true only on Monday, in Chicago', () => {
  assert.equal(isDigestDay('2026-08-17'), true, 'Monday')
  assert.equal(isDigestDay('2026-08-24'), true, 'the next Monday')
  assert.equal(isDigestDay('2026-08-16'), false, 'Sunday')
  assert.equal(isDigestDay('2026-08-18'), false, 'Tuesday')
  assert.equal(isDigestDay('2026-08-20'), false, 'Thursday')
})

test('a Chicago Sunday that is already Monday in UTC is NOT a digest day', () => {
  // 2026-08-16 is a Sunday in Chicago. At 8pm Chicago it is already 01:00
  // Monday in UTC. todayInChicago() correctly returns the Sunday, and
  // isDigestDay must agree with it — a naive UTC weekday check would fire the
  // weekly digest a day early, every week.
  assert.equal(isDigestDay('2026-08-16'), false)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
npm test 2>&1 | tail -20
```

Expected: FAIL — `Cannot find module '../../lib/reminders.ts'`.

- [ ] **Step 3: Write the module**

Create `lib/reminders.ts`:

```ts
// What is due, what is late, and what has just gone late.
//
// Pure: no database, no email, no clock. "Today" is injected, which is what
// makes every boundary below testable and what keeps a timezone bug out of a
// decision about money.
//
// It does NOT define "overdue". lib/status.ts already does, and that is what
// the invoice list and the public invoice page display. A second definition
// here would eventually disagree with what a client is looking at.
//
// No '@/' imports and no JSX — this module runs under plain node --test.

import { displayStatus, daysUntilDue, type StoredStatus } from './status.ts'

/** An invoice due within this many days is worth mentioning. */
export const DUE_SOON_DAYS = 7

export type ReminderInvoice = {
  id: string
  number: number
  due_date: string          // YYYY-MM-DD
  total_cents: number
  status: StoredStatus
  client_name: string
  /** Whether a reminder_log row of kind 'overdue_alert' already exists. */
  alerted_overdue: boolean
}

export type Sweep = {
  /** Not yet due, due within DUE_SOON_DAYS. Soonest first. */
  dueSoon: ReminderInvoice[]
  /** Past due. Oldest first. */
  overdue: ReminderInvoice[]
  /** Past due and never alerted about. A subset of overdue. */
  newlyOverdue: ReminderInvoice[]
  /** Every chaseable invoice, including ones due far off. Stored cents. */
  totalOutstandingCents: number
}

export function sweep(invoices: ReminderInvoice[], today: string): Sweep {
  const dueSoon: ReminderInvoice[] = []
  const overdue: ReminderInvoice[] = []
  const newlyOverdue: ReminderInvoice[] = []
  let totalOutstandingCents = 0

  for (const inv of invoices) {
    const shown = displayStatus(
      { status: inv.status, due_date: inv.due_date, total_cents: inv.total_cents },
      today,
    )

    // draft has never been sent to anyone; paid and void are settled.
    if (shown !== 'sent' && shown !== 'overdue') continue

    totalOutstandingCents += inv.total_cents

    if (shown === 'overdue') {
      overdue.push(inv)
      if (!inv.alerted_overdue) newlyOverdue.push(inv)
    } else if (daysUntilDue(inv.due_date, today) <= DUE_SOON_DAYS) {
      dueSoon.push(inv)
    }
  }

  // Soonest first in every bucket: the thing needing attention leads.
  const byDueDate = (a: ReminderInvoice, b: ReminderInvoice) =>
    a.due_date.localeCompare(b.due_date)

  return {
    dueSoon: dueSoon.sort(byDueDate),
    overdue: overdue.sort(byDueDate),
    newlyOverdue: newlyOverdue.sort(byDueDate),
    totalOutstandingCents,
  }
}

/**
 * Is this plain date a Monday?
 *
 * `today` is already a Chicago calendar date from todayInChicago(), so the
 * weekday is a property of that string and must not be re-derived from the
 * current instant. Anchoring at noon UTC keeps the arithmetic clear of both
 * midnight boundaries — a Chicago Sunday evening is already Monday in UTC, and
 * reading the weekday off `new Date()` would fire the weekly digest a day
 * early, every week.
 */
export function isDigestDay(today: string): boolean {
  return new Date(today + 'T12:00:00Z').getUTCDay() === 1
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"
```

Expected: 66 existing plus 9 new = **75 passing**, 0 failing.

- [ ] **Step 5: Typecheck, build, commit**

```bash
npx tsc --noEmit && npm run build 2>&1 | grep -E "Compiled|Failed"
```

Expected: no type errors, `✓ Compiled successfully`.

```bash
git add lib/reminders.ts scripts/test/reminders.test.ts lib/status.ts
git commit -m "Decide what is due, late, and newly late.

lib/status.ts re-exported from './dates' with no extension — the only
such import in lib/, and unnoticed because no test had ever imported
that file. Node cannot resolve it, so every test here failed on a file
this change does not otherwise touch."
```

---

### Task 2: The two emails

The digest and the overdue alert. Both go to Dan, never to a client.

**Files:**
- Create: `lib/reminderEmail.ts`
- Create: `scripts/test/reminderEmail.test.ts`

**Interfaces:**
- Consumes: `type Sweep`, `type ReminderInvoice` from `lib/reminders.ts`; `formatUSD` from `lib/money.ts`; `formatDateLong` from `lib/dates.ts`; `escapeHtml` from `lib/invoiceEmailBody.ts`.
- Produces:
  - `export function buildDigestEmail(s: Sweep, appUrl: string): { subject, text, html }`
  - `export function buildOverdueAlertEmail(inv: ReminderInvoice, appUrl: string): { subject, text, html }`
  - `export async function sendReminderEmail(input: { to, subject, text, html }): Promise<{ error?: string }>`

- [ ] **Step 1: Write the failing test**

Create `scripts/test/reminderEmail.test.ts`:

```ts
// Both builders are pure, so the wording and the figures are testable with no
// network and no key. These emails go to Dan, so they link to the
// authenticated invoice screen, never to a client's public link.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildDigestEmail, buildOverdueAlertEmail } from '../../lib/reminderEmail.ts'
import { sweep, type ReminderInvoice } from '../../lib/reminders.ts'
import { formatUSD } from '../../lib/money.ts'

const APP = 'https://billing.theaudiosmith.com'
const TODAY = '2026-08-20'

const inv = (over: Partial<ReminderInvoice> = {}): ReminderInvoice => ({
  id: 'aaaa-1111', number: 385, due_date: '2026-08-18', total_cents: 655314,
  status: 'sent', client_name: 'Streamline Pictures', alerted_overdue: false, ...over,
})

test('a busy digest names each invoice, its client and its stored total', () => {
  const s = sweep([
    inv(),
    inv({ id: 'bbbb-2222', number: 386, due_date: '2026-08-22', total_cents: 50000, client_name: 'Journey Church' }),
  ], TODAY)
  const { subject, text, html } = buildDigestEmail(s, APP)

  assert.ok(subject.includes('1 overdue'), 'the subject leads with the overdue count')
  for (const body of [text, html]) {
    assert.ok(body.includes('#385'), 'names the overdue invoice')
    assert.ok(body.includes('Streamline Pictures'))
    assert.ok(body.includes(formatUSD(655314)), 'the stored total, $6,553.14')
    assert.ok(body.includes('#386'), 'names the due-soon invoice')
    assert.ok(body.includes(formatUSD(50000)))
    assert.ok(body.includes(`${APP}/invoices/aaaa-1111`), 'links to the authenticated screen')
  }
})

test('a quiet week still sends, and says so plainly', () => {
  const { subject, text } = buildDigestEmail(sweep([], TODAY), APP)
  assert.ok(/nothing outstanding/i.test(text), 'says there is nothing to do')
  assert.ok(!/undefined|NaN/.test(text), 'no leaked placeholders')
  assert.ok(!/undefined|NaN/.test(subject))
})

test('the digest total is the stored sum, never recomputed', () => {
  const s = sweep([inv({ total_cents: 655314 }), inv({ id: 'x', total_cents: 234000 })], TODAY)
  const { text } = buildDigestEmail(s, APP)
  assert.ok(text.includes(formatUSD(655314 + 234000)), 'outstanding is $8,893.14')
})

test('the overdue alert names one invoice and how late it is', () => {
  const { subject, text, html } = buildOverdueAlertEmail(inv(), APP)
  assert.ok(subject.includes('385'), 'the number is in the subject')
  for (const body of [text, html]) {
    assert.ok(body.includes('Streamline Pictures'))
    assert.ok(body.includes(formatUSD(655314)))
    assert.ok(body.includes(`${APP}/invoices/aaaa-1111`))
  }
})

test('neither email can carry bank details', () => {
  // No path passes settings into these builders at all. This asserts the
  // shape stays that way — if someone threads settings in later to print a
  // remit-to block, this is what should stop them adding ach_details with it.
  const s = sweep([inv()], TODAY)
  const bodies = [
    buildDigestEmail(s, APP).text, buildDigestEmail(s, APP).html,
    buildOverdueAlertEmail(inv(), APP).text, buildOverdueAlertEmail(inv(), APP).html,
  ]
  for (const b of bodies) {
    assert.ok(!/routing/i.test(b), 'no routing number')
    assert.ok(!/ach/i.test(b), 'no ACH block — these go to Dan, not a client')
  }
})

test('a client name containing markup is escaped in the html', () => {
  const { html } = buildDigestEmail(sweep([inv({ client_name: '<script>x</script>' })], TODAY), APP)
  assert.ok(!html.includes('<script>'), 'the raw tag never survives')
  assert.ok(html.includes('&lt;script&gt;'), 'it is escaped')
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
npm test 2>&1 | tail -20
```

Expected: FAIL — `Cannot find module '../../lib/reminderEmail.ts'`.

- [ ] **Step 3: Write the module**

Create `lib/reminderEmail.ts`:

```ts
// The two emails Dan gets: a weekly digest, and a one-off note the first
// morning an invoice goes late.
//
// SERVER ONLY — sendReminderEmail reads RESEND_API_KEY. Never import that from
// a client component. The two BUILDERS are pure and safe anywhere.
//
// These go to Dan, so every link points at the authenticated invoice screen.
// The public /i/<token> link is for clients and has no business here.
//
// The Resend client is constructed per call and the environment is read at call
// time, for the reason recorded in lib/invoiceEmail.ts: a module-scope client
// throws during next build wherever the key is absent.

import { formatUSD } from './money.ts'
import { formatDateLong } from './dates.ts'
import { escapeHtml } from './invoiceEmailBody.ts'
import type { Sweep, ReminderInvoice } from './reminders.ts'

const line = (inv: ReminderInvoice, appUrl: string) =>
  `#${inv.number} · ${inv.client_name} · ${formatUSD(inv.total_cents)} · due ${formatDateLong(inv.due_date)}\n` +
  `  ${appUrl}/invoices/${inv.id}`

const htmlLine = (inv: ReminderInvoice, appUrl: string) =>
  `<li style="margin:0 0 8px">` +
  `<a href="${escapeHtml(appUrl)}/invoices/${escapeHtml(inv.id)}"><strong>#${inv.number}</strong></a> · ` +
  `${escapeHtml(inv.client_name)} · <strong>${formatUSD(inv.total_cents)}</strong> · ` +
  `due ${formatDateLong(inv.due_date)}</li>`

export function buildDigestEmail(s: Sweep, appUrl: string) {
  const quiet = s.overdue.length === 0 && s.dueSoon.length === 0

  const subject = quiet
    ? 'Invoices: nothing outstanding'
    : `Invoices: ${s.overdue.length} overdue, ${s.dueSoon.length} due soon`

  const textParts: string[] = []
  const htmlParts: string[] = []

  if (quiet) {
    textParts.push('Nothing outstanding — 0 open invoices.')
    htmlParts.push('<p style="margin:0 0 16px">Nothing outstanding — 0 open invoices.</p>')
  } else {
    if (s.overdue.length) {
      textParts.push('OVERDUE', ...s.overdue.map((i) => line(i, appUrl)), '')
      htmlParts.push(
        '<p style="margin:0 0 4px;font-weight:bold">Overdue</p>',
        `<ul style="margin:0 0 16px;padding-left:18px">${s.overdue.map((i) => htmlLine(i, appUrl)).join('')}</ul>`,
      )
    }
    if (s.dueSoon.length) {
      textParts.push('DUE SOON', ...s.dueSoon.map((i) => line(i, appUrl)), '')
      htmlParts.push(
        '<p style="margin:0 0 4px;font-weight:bold">Due soon</p>',
        `<ul style="margin:0 0 16px;padding-left:18px">${s.dueSoon.map((i) => htmlLine(i, appUrl)).join('')}</ul>`,
      )
    }
    textParts.push(`Outstanding: ${formatUSD(s.totalOutstandingCents)}`)
    htmlParts.push(
      `<p style="margin:0">Outstanding: <strong>${formatUSD(s.totalOutstandingCents)}</strong></p>`,
    )
  }

  return {
    subject,
    text: textParts.join('\n'),
    html:
      '<div style="font-family:system-ui,-apple-system,sans-serif;font-size:14px;color:#121212;line-height:1.5">' +
      htmlParts.join('') +
      '</div>',
  }
}

export function buildOverdueAlertEmail(inv: ReminderInvoice, appUrl: string) {
  const subject = `Invoice #${inv.number} is now overdue`
  const text = [
    `#${inv.number} · ${inv.client_name} · ${formatUSD(inv.total_cents)}`,
    `Was due ${formatDateLong(inv.due_date)}.`,
    '',
    `${appUrl}/invoices/${inv.id}`,
  ].join('\n')
  const html =
    '<div style="font-family:system-ui,-apple-system,sans-serif;font-size:14px;color:#121212;line-height:1.5">' +
    `<p style="margin:0 0 8px"><strong>#${inv.number}</strong> · ${escapeHtml(inv.client_name)} · ` +
    `<strong>${formatUSD(inv.total_cents)}</strong></p>` +
    `<p style="margin:0 0 16px">Was due ${formatDateLong(inv.due_date)}.</p>` +
    `<p style="margin:0"><a href="${escapeHtml(appUrl)}/invoices/${escapeHtml(inv.id)}">Open the invoice</a></p>` +
    '</div>'
  return { subject, text, html }
}

export async function sendReminderEmail(
  input: { to: string; subject: string; text: string; html: string },
): Promise<{ error?: string }> {
  const key = process.env.RESEND_API_KEY
  if (!key) return { error: 'Email is not configured yet (RESEND_API_KEY is missing).' }

  const from = process.env.INVOICE_FROM_EMAIL
  if (!from) return { error: 'Email is not configured yet (INVOICE_FROM_EMAIL is missing).' }

  try {
    const { Resend } = await import('resend')
    const { error } = await new Resend(key).emails.send({
      from: `The Audio Smith <${from}>`,
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html,
    })
    if (error) return { error: error.message }
    return {}
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'The reminder could not be sent.' }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"
```

Expected: 75 plus 6 new = **81 passing**, 0 failing.

- [ ] **Step 5: Confirm the missing-key path returns rather than throws**

Run:

```bash
node --input-type=module -e "
import { sendReminderEmail } from './lib/reminderEmail.ts'
console.log(JSON.stringify(await sendReminderEmail({
  to: 'nobody@example.com', subject: 's', text: 't', html: '<p>h</p>',
})))
"
```

Expected: `{"error":"Email is not configured yet (RESEND_API_KEY is missing)."}` — an object, not a thrown exception, and no network call.

- [ ] **Step 6: Typecheck, build, commit**

```bash
npx tsc --noEmit && npm run build 2>&1 | grep -E "Compiled|Failed"
git add lib/reminderEmail.ts scripts/test/reminderEmail.test.ts
git commit -m "Write the reminder digest and the overdue alert."
```

---

### Task 3: The cron endpoint

The one place the service-role key is read. Runs daily; sends weekly.

**Files:**
- Create: `app/api/cron/reminders/route.ts`
- Create: `vercel.json`
- Modify: `proxy.ts`

**Interfaces:**
- Consumes: `sweep`, `isDigestDay`, `type ReminderInvoice` from `lib/reminders.ts`; `buildDigestEmail`, `buildOverdueAlertEmail`, `sendReminderEmail` from `lib/reminderEmail.ts`; `todayInChicago` from `lib/dates.ts`.
- Produces: `GET /api/cron/reminders`.

- [ ] **Step 1: Allowlist the route**

In `proxy.ts`, change:

```ts
const PUBLIC_PREFIXES = ['/login', '/auth', '/api/dev', '/i']
```

to:

```ts
// /api/cron is the reminder sweep. Vercel calls it with no session, so it has
// to be allowlisted here; it guards itself with CRON_SECRET.
const PUBLIC_PREFIXES = ['/login', '/auth', '/api/dev', '/i', '/api/cron']
```

- [ ] **Step 2: Add the schedule**

Create `vercel.json`:

```json
{
  "crons": [
    { "path": "/api/cron/reminders", "schedule": "0 13 * * *" }
  ]
}
```

13:00 UTC is 8am Chicago in summer and 7am in winter — Monday in both, so the weekday test never straddles a boundary. Vercel's Hobby plan permits one run per day, which is exactly this.

- [ ] **Step 3: Write the route**

Create `app/api/cron/reminders/route.ts`:

```ts
import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { todayInChicago } from '@/lib/dates'
import { sweep, isDigestDay, type ReminderInvoice } from '@/lib/reminders'
import {
  buildDigestEmail, buildOverdueAlertEmail, sendReminderEmail,
} from '@/lib/reminderEmail'

// The reminder sweep, called by Vercel Cron once a morning.
//
// THIS IS THE ONLY FILE PERMITTED TO READ SUPABASE_SERVICE_ROLE_KEY. That key
// bypasses every RLS policy in the database. It is here because the sweep has
// no user session and must read across all invoices; it is acceptable here
// because this route refuses anything without CRON_SECRET. Never move this
// read into a page, a component, or a server action.
//
// The route runs EVERY DAY even though the digest is weekly. Supabase pauses a
// free project after 7 days of inactivity, and a weekly cron has no margin —
// the query below is the keepalive.
//
// /api/cron is allowlisted in proxy.ts. Without that it would 307 to /login and
// the cron would look like it was working while doing nothing.

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  // Bare 404, never 401: a prober learns nothing about whether this exists.
  const secret = process.env.CRON_SECRET
  if (!secret) return new NextResponse(null, { status: 404 })
  if (request.headers.get('authorization') !== `Bearer ${secret}`) {
    return new NextResponse(null, { status: 404 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const appUrl = process.env.APP_URL
  if (!url || !serviceKey || !appUrl) {
    return NextResponse.json({ error: 'Reminders are not configured.' }, { status: 500 })
  }

  const db = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  // This query is the keepalive. It runs whatever today is.
  const { data: rows, error } = await db
    .from('invoices')
    .select(`id, number, due_date, total_cents, status, owner_id,
             clients(name),
             reminder_log(kind)`)
    .eq('status', 'sent')
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const { data: settings } = await db
    .from('settings').select('email').eq('id', 1).maybeSingle()
  const to = settings?.email
  if (!to) return NextResponse.json({ error: 'No settings email to send to.' }, { status: 500 })

  const invoices: ReminderInvoice[] = (rows ?? []).map((r) => {
    const row = r as unknown as {
      id: string; number: number; due_date: string; total_cents: number
      status: 'draft' | 'sent' | 'paid' | 'void'; owner_id: string
      clients: { name: string } | null
      reminder_log: { kind: string }[] | null
    }
    return {
      id: row.id,
      number: row.number,
      due_date: row.due_date,
      total_cents: Number(row.total_cents),
      status: row.status,
      client_name: row.clients?.name ?? 'Unknown client',
      alerted_overdue: (row.reminder_log ?? []).some((l) => l.kind === 'overdue_alert'),
    }
  })

  const ownerById = new Map((rows ?? []).map((r) => {
    const row = r as unknown as { id: string; owner_id: string }
    return [row.id, row.owner_id]
  }))

  const today = todayInChicago()
  const s = sweep(invoices, today)

  const sent: string[] = []
  const failed: string[] = []

  if (isDigestDay(today)) {
    const { subject, text, html } = buildDigestEmail(s, appUrl)
    const r = await sendReminderEmail({ to, subject, text, html })
    if (r.error) failed.push(`digest: ${r.error}`)
    else sent.push('digest')
  }

  for (const inv of s.newlyOverdue) {
    const { subject, text, html } = buildOverdueAlertEmail(inv, appUrl)
    const r = await sendReminderEmail({ to, subject, text, html })
    if (r.error) { failed.push(`#${inv.number}: ${r.error}`); continue }

    // Only after the send succeeds. Recording first would silence a future
    // alert for a message that never went — the same ordering rule the
    // invoice send follows.
    const { error: logErr } = await db.from('reminder_log').insert({
      owner_id: ownerById.get(inv.id),
      invoice_id: inv.id,
      kind: 'overdue_alert',
      sent_to: to,
    })
    if (logErr) failed.push(`#${inv.number} logged: ${logErr.message}`)
    else sent.push(`overdue #${inv.number}`)
  }

  return NextResponse.json({
    today,
    digestDay: isDigestDay(today),
    dueSoon: s.dueSoon.length,
    overdue: s.overdue.length,
    newlyOverdue: s.newlyOverdue.length,
    outstandingCents: s.totalOutstandingCents,
    sent,
    failed,
  })
}
```

- [ ] **Step 4: Typecheck and build**

Run:

```bash
npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)" && npx tsc --noEmit && npm run build 2>&1 | grep -E "Compiled|Failed|/api/cron"
```

Expected: 81 passing, no type errors, `✓ Compiled successfully`, and `/api/cron/reminders` listed among the routes.

- [ ] **Step 5: Prove the guard refuses, and that the route is reachable**

`CRON_SECRET` is not set, so every request must 404. Start the dev server:

```bash
npm run dev
```

In another shell:

```bash
curl -s -o /dev/null -w "no secret set:   %{http_code}\n" http://localhost:3000/api/cron/reminders
curl -s -o /dev/null -w "wrong bearer:    %{http_code}\n" -H "Authorization: Bearer wrong" http://localhost:3000/api/cron/reminders
```

Expected: **404** for both. A **307** means `proxy.ts` is redirecting and Step 1 did not take effect — that is the failure this whole step exists to catch.

Stop the dev server.

- [ ] **Step 6: Prove the secret gate opens, still without sending**

Add a temporary secret to `.env.local` **only** — never to Vercel in this step, and never a real Supabase key:

```bash
echo 'CRON_SECRET=local-test-only' >> .env.local
```

Restart `npm run dev`, then:

```bash
curl -s -o /dev/null -w "correct bearer:  %{http_code}\n" \
  -H "Authorization: Bearer local-test-only" http://localhost:3000/api/cron/reminders
```

Expected: **500**, with a JSON body reading `Reminders are not configured.` — the secret gate opened and the *next* guard stopped it, because `SUPABASE_SERVICE_ROLE_KEY` is absent. That is the correct end state for this task: no database was touched and no email was sent.

Then remove the temporary line from `.env.local`:

```bash
grep -v '^CRON_SECRET=local-test-only$' .env.local > .env.local.tmp && mv .env.local.tmp .env.local
grep -c CRON_SECRET .env.local || echo "removed"
```

Stop the dev server.

- [ ] **Step 7: Commit**

```bash
git add app/api/cron/reminders/route.ts vercel.json proxy.ts
git commit -m "Sweep for reminders daily, send the digest on Mondays."
```

---

### Task 4: The client nudge

A button that emails one client about one invoice. Manual, never automatic.

**Files:**
- Create: `components/SendReminderButton.tsx`
- Modify: `app/invoices/actions.ts`
- Modify: `app/invoices/[id]/page.tsx`

**Interfaces:**
- Consumes: `sendReminderEmail` from `lib/reminderEmail.ts`; `formatUSD` from `lib/money.ts`; `formatDateLong`, `escapeHtml` as needed.
- Produces: `sendClientReminder(invoiceId: string): Promise<{ error: string } | { ok: true }>`, and `<SendReminderButton invoiceId={...} to={...} lastSentISO={...} />`.

- [ ] **Step 1: Write the action**

Append to `app/invoices/actions.ts`:

```ts
/**
 * Nudges one client about one unpaid invoice.
 *
 * Deliberately manual. An automatic chase eventually reaches somebody who has
 * already paid an invoice that has not been marked paid yet, and that email
 * cannot be recalled.
 *
 * A second send is NOT blocked — chasing twice is legitimate. The button shows
 * when the last one went instead.
 */
export async function sendClientReminder(
  invoiceId: string,
): Promise<{ error: string } | { ok: true }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  const appUrl = process.env.APP_URL
  if (!appUrl) return { error: 'Email is not configured yet (APP_URL is missing).' }

  const { data: invoice, error } = await supabase
    .from('invoices')
    .select(`id, number, due_date, total_cents, status, public_token,
             clients(name, billing_email)`)
    .eq('id', invoiceId)
    .maybeSingle()
  if (error) return { error: error.message }
  if (!invoice) return { error: 'That invoice no longer exists.' }

  const inv = invoice as unknown as {
    id: string; number: number; due_date: string; total_cents: number
    status: 'draft' | 'sent' | 'paid' | 'void'; public_token: string | null
    clients: { name: string; billing_email: string | null } | null
  }

  if (inv.status !== 'sent') {
    return { error: `Invoice #${inv.number} is ${inv.status}. Only a sent invoice is chased.` }
  }
  const to = inv.clients?.billing_email?.trim()
  if (!to) {
    return {
      error: `${inv.clients?.name ?? 'This client'} has no billing email on file. ` +
        'Add one on the client screen.',
    }
  }

  const link = inv.public_token ? `${appUrl.replace(/\/+$/, '')}/i/${inv.public_token}` : null
  const subject = `Reminder: invoice #${inv.number} from The Audio Smith`
  const text = [
    `A friendly reminder about invoice #${inv.number}.`,
    '',
    `Amount due: ${formatUSD(inv.total_cents)}`,
    `Due: ${formatDateLong(inv.due_date)}`,
    ...(link ? ['', `View it online: ${link}`] : []),
    '',
    'Thank you!',
  ].join('\n')
  const html =
    '<div style="font-family:system-ui,-apple-system,sans-serif;font-size:14px;color:#121212;line-height:1.5">' +
    `<p style="margin:0 0 16px">A friendly reminder about invoice <strong>#${inv.number}</strong>.</p>` +
    `<p style="margin:0 0 4px">Amount due: <strong>${formatUSD(inv.total_cents)}</strong></p>` +
    `<p style="margin:0 0 16px">Due: ${formatDateLong(inv.due_date)}</p>` +
    (link ? `<p style="margin:0 0 16px"><a href="${link}">View this invoice online</a></p>` : '') +
    '<p style="margin:0">Thank you!</p>' +
    '</div>'

  const result = await sendReminderEmail({ to, subject, text, html })
  if (result.error) return { error: result.error }

  // Only after the send succeeded.
  const { error: logErr } = await supabase.from('reminder_log').insert({
    owner_id: user.id,
    invoice_id: inv.id,
    kind: 'client_reminder',
    sent_to: to,
  })
  if (logErr) {
    return {
      error: `The reminder went to ${to}, but recording it failed: ${logErr.message}.`,
    }
  }

  revalidatePath(`/invoices/${invoiceId}`)
  return { ok: true }
}
```

Add these imports at the top of `app/invoices/actions.ts` if not already present:

```ts
import { formatUSD } from '@/lib/money'
import { formatDateLong } from '@/lib/dates'
import { sendReminderEmail } from '@/lib/reminderEmail'
```

- [ ] **Step 2: Write the button**

Create `components/SendReminderButton.tsx`:

```tsx
'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { formatDateShort } from '@/lib/dates'
import { sendClientReminder } from '@/app/invoices/actions'

// Chasing a client twice is legitimate, so a second send is never blocked.
// The date of the last one is shown instead — informative, never in the way.

export default function SendReminderButton({
  invoiceId, to, lastSentDate,
}: {
  invoiceId: string
  to: string | null
  /** YYYY-MM-DD of the most recent client reminder, or null. */
  lastSentDate: string | null
}) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)
  const [pending, start] = useTransition()

  if (!to) return null

  function send() {
    setError(null)
    start(async () => {
      try {
        const result = await sendClientReminder(invoiceId)
        if ('error' in result) { setError(result.error); return }
        setSent(true)
        router.refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : 'The reminder could not be sent.')
      }
    })
  }

  return (
    <div className="flex items-center gap-3">
      {error && <span role="alert" className="text-xs text-danger">{error}</span>}
      {sent && !error && <span className="text-xs text-good">Reminder sent</span>}
      <button type="button" onClick={send} disabled={pending}
              className="text-xs font-semibold uppercase tracking-wider text-muted
                         hover:text-ink transition-colors disabled:opacity-50
                         disabled:cursor-not-allowed">
        {pending
          ? 'Sending…'
          : lastSentDate
            ? `Send reminder · last ${formatDateShort(lastSentDate)}`
            : 'Send reminder'}
      </button>
    </div>
  )
}
```

- [ ] **Step 3: Wire it into the invoice page**

In `app/invoices/[id]/page.tsx`, add the import:

```tsx
import SendReminderButton from '@/components/SendReminderButton'
```

Add `reminder_log(kind, sent_at)` to the invoice query's select list, alongside the existing `clients(...)` and `invoice_lines(...)` fragments.

Then, just above `return (`, derive the last reminder date:

```tsx
  // Most recent client reminder, as a plain date for display. reminder_log
  // stores an instant; formatDateShort takes a calendar date.
  const lastReminder = ((inv as unknown as {
    reminder_log?: { kind: string; sent_at: string }[]
  }).reminder_log ?? [])
    .filter((r) => r.kind === 'client_reminder')
    .map((r) => r.sent_at)
    .sort()
    .pop() ?? null
  const lastReminderDate = lastReminder ? lastReminder.slice(0, 10) : null
```

Then add the button to the action row, before `<DownloadInvoiceButton …/>`:

```tsx
          {/* `sent` covers overdue too — overdue is derived from a sent
              invoice being past due, never a separate stored status. */}
          {inv.status === 'sent' ? (
            <SendReminderButton
              invoiceId={inv.id}
              to={(inv.clients as { billing_email?: string | null } | null)?.billing_email?.trim() || null}
              lastSentDate={lastReminderDate}
            />
          ) : null}
```

**Do not let `reminder_log` into `docData`.** It is fetched for this button only; `docData.client` keeps exactly `name`, `address_line1`, `address_line2`, as it does today.

- [ ] **Step 4: Verify**

Run:

```bash
npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)" && npx tsc --noEmit && npm run build 2>&1 | grep -E "Compiled|Failed"
```

Expected: 81 passing, no type errors, `✓ Compiled successfully`.

- [ ] **Step 5: Confirm nothing was sent or logged**

`RESEND_API_KEY` is empty, so pressing the button can only produce a message.

```bash
npm run db:sql -- /dev/stdin <<'EOF'
select count(*) as reminder_rows from reminder_log;
EOF
```

Expected: `0`.

- [ ] **Step 6: Commit**

```bash
git add components/SendReminderButton.tsx app/invoices/actions.ts "app/invoices/[id]/page.tsx"
git commit -m "Nudge a client about one invoice, by hand."
```

---

## Verification once the secrets exist

**Not part of any task.** Run by hand after `CRON_SECRET` and
`SUPABASE_SERVICE_ROLE_KEY` are set in Vercel **and the project is redeployed** —
environment variables only reach a build when it runs.

1. Call the endpoint by hand and read the JSON:
   ```
   curl -s -H "Authorization: Bearer $CRON_SECRET" \
     https://billing.theaudiosmith.com/api/cron/reminders
   ```
   Expect counts matching the invoice list: 4 open, and `outstandingCents`
   equal to 999314 unless something has been paid since.
2. Confirm `digestDay` is `false` on any day but Monday, and that no digest
   arrived.
3. Confirm an overdue alert arrived for anything genuinely past due, and that
   calling the endpoint a second time does **not** send it again — that is
   `reminder_log` doing its job.
4. Check `select kind, invoice_id, sent_at from reminder_log` shows one row per
   alert and no duplicates.
5. On the following Monday, confirm the digest arrives.
6. Confirm the Vercel dashboard shows the cron running daily.

## Verification

- `npm test` — 81 passing.
- `npx tsc --noEmit` — clean.
- `npm run build` — compiles, `/api/cron/reminders` listed.
- The route 404s with no secret and with a wrong bearer; it reaches the
  "not configured" branch with the right one.
- `reminder_log` is still empty at the end of implementation.

## Blast radius

Additive. No migration, no schema change, no change to any existing invoice.
Two new pure modules, one new route, one new button.

The genuinely new exposure is `SUPABASE_SERVICE_ROLE_KEY` reaching Vercel, which
the spec records as a deliberate decision. It is read in exactly one file, that
file refuses everything without `CRON_SECRET`, and it has no `NEXT_PUBLIC_`
prefix so it cannot be inlined into the browser bundle. A grep for
`SUPABASE_SERVICE_ROLE_KEY` outside `app/api/cron/reminders/route.ts` and
`app/api/dev/login/route.ts` should return nothing, now and later.
