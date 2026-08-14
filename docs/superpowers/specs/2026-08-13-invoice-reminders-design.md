# Invoice reminders

**Status:** approved 2026-08-13

## Context

This is the last item from the original ask — *"sending me reminders when a bill
is coming due and overdue"* — and the one thing the spreadsheet could never do
at all. It could not even hold the question: the sheet has no paid/unpaid column
and no due-date column.

Everything it needs now exists. Status is derived, never stored
(`lib/status.ts`). `reminder_log` has been in the schema since migration 0001,
unused, waiting for exactly this. Email sends, and an invoice has a public link.

Currently outstanding: **4 invoices, $9,993.14.**

## Decisions

| Question | Decision |
|---|---|
| Who is reminded | Dan gets a digest. Clients only when he presses a button. |
| Digest cadence | Weekly, Monday morning, **including quiet weeks** |
| Cron cadence | **Daily** — the digest is weekly, the keepalive cannot be |
| Exception | A one-off note the first time an invoice goes overdue |
| Database access | `SUPABASE_SERVICE_ROLE_KEY` on Vercel — see below |
| "Overdue" | Still derived from due date and status. Never stored. |

### Why the digest is weekly but the cron is daily

Supabase's free tier pauses a project after **7 days** of inactivity. A weekly
cron is exactly 7 days: no margin at all, and a single missed run puts the
database to sleep. So the route runs every morning and queries every morning —
that query *is* the keepalive — and only sends mail on Mondays.

Dan chose a fixed weekly email over a quieter "only when there's something"
schedule, deliberately: an email that always arrives is itself a monitoring
signal, and its absence is noticeable. Quiet weeks say so in one line.

### Why a newly-overdue exception

A Monday-only digest leaves an invoice that falls overdue on a Tuesday
unmentioned for six days. The largest open invoice is $6,553.14, which is worth
one extra email. So the first morning an invoice is past its due date, a short
note goes out regardless of the day.

"First" is defined by `reminder_log`, not by comparing against yesterday. An
invoice is newly overdue when it is past due and has **no** `reminder_log` row of
kind `overdue_alert`. That definition survives a missed cron run, a redeploy, or
a clock change — comparing to "yesterday" does not.

## The security posture change

Every table is behind RLS keyed to the owner. A request with no session sees
nothing, which is the point. The cron has no session.

**`SUPABASE_SERVICE_ROLE_KEY` will be set on Vercel.** Until now it has
deliberately been absent, and this spec is the record of that changing.

The alternative — a `security definer` function, as the public invoice page uses
— was considered and rejected. That function is safe because it returns exactly
one invoice to a caller holding an unguessable token. A sweep returns the whole
receivables list; granting `anon` permission to call it would let anyone
enumerate what Dan is owed. Passing a shared secret as a function argument is
worse still: arguments are recorded in `pg_stat_statements`.

What contains the risk:

- The key is read **only** inside `app/api/cron/reminders/route.ts`, never in a
  page, a component, or a server action.
- That route refuses anything without the correct `CRON_SECRET`, returning a
  bare 404 so its existence is not confirmed to a prober — the same two-gate
  shape as `app/api/dev/login/route.ts`.
- It is never exposed to a browser: the variable has no `NEXT_PUBLIC_` prefix,
  so Next will not inline it client-side.
- The route only ever reads invoices and writes `reminder_log`.

The residual risk is real and should be stated plainly: that key bypasses every
policy in the database, so a future mistake in server code could reach anything.
It is accepted because a secret-guarded cron endpoint is a far smaller surface
than the public page for which it was previously refused.

## Prerequisites

| Variable | Where | Note |
|---|---|---|
| `CRON_SECRET` | Vercel | Vercel sends it as `Authorization: Bearer …` on scheduled runs |
| `SUPABASE_SERVICE_ROLE_KEY` | Vercel | Supabase dashboard → Project Settings → API |

Both are server-only. Neither may take a `NEXT_PUBLIC_` prefix.

## Architecture

### `lib/reminders.ts` — the decision, with no I/O

```ts
export type ReminderInvoice = {
  id: string
  number: number
  due_date: string          // YYYY-MM-DD
  total_cents: number
  status: 'draft' | 'sent' | 'paid' | 'void'
  client_name: string
  alerted_overdue: boolean  // has a reminder_log row of kind 'overdue_alert'
}

export type Sweep = {
  dueSoon: ReminderInvoice[]       // due within 7 days, not yet due
  overdue: ReminderInvoice[]       // past due
  newlyOverdue: ReminderInvoice[]  // past due AND never alerted
  totalOutstandingCents: number
}

export function sweep(invoices: ReminderInvoice[], today: string): Sweep
export function isDigestDay(today: string): boolean   // Monday in Chicago
```

Pure, so every rule is testable without a database, an email or a clock.
`draft`, `paid` and `void` never appear in any bucket: a draft has not been sent
to anybody, and the other two are settled. Only `sent` is chaseable.

`DUE_SOON_DAYS = 7` is a named constant, not a literal.

**`sweep` must decide overdue by calling `displayStatus` and `daysUntilDue` from
`lib/status.ts`, not by writing its own date comparison.** That file already owns
the rule — `due_date < today`, so an invoice due *today* is not yet overdue — and
it is what the invoice list and the public page display. A second copy here would
be a second definition, and the two would eventually disagree about what a client
sees versus what triggers an email. Reuse is the point, not convenience.

### `lib/reminderEmail.ts` — the digest, built and sent

Same build/send split as `lib/invoiceEmailBody.ts` and `lib/invoiceEmail.ts`, for
the same reason: the wording and the figures are unit-testable without a network.

```ts
export function buildDigestEmail(s: Sweep, today: string, appUrl: string):
  { subject: string; text: string; html: string }

export function buildOverdueAlertEmail(inv: ReminderInvoice, appUrl: string):
  { subject: string; text: string; html: string }
```

Both link each invoice to `${appUrl}/invoices/${id}` — the authenticated screen,
not the public one. These emails go to Dan; the public link is for clients.

A quiet week produces `Nothing outstanding — 0 open invoices.` and still sends.

### `app/api/cron/reminders/route.ts`

`GET`. In order:

1. Reject unless `CRON_SECRET` is set and the `Authorization` header matches —
   bare 404 either way.
2. Read every `sent` invoice with its client and its `reminder_log` rows, using
   the service-role client.
3. Call `sweep(invoices, todayInChicago())`. **The query in step 2 is the
   keepalive and runs every day**, whatever happens after it.
4. If `isDigestDay(today)`, send the digest.
5. For each `newlyOverdue`, send the alert and write a `reminder_log` row of kind
   `overdue_alert` — **only after the send succeeds**, the same ordering the
   invoice send uses, so a failure never records a message that did not go.
6. Return a JSON count summary. Useful when running it by hand; it is behind the
   secret, so it may name figures.

**`/api/cron` must be added to `PUBLIC_PREFIXES` in `proxy.ts`.** A route that
answers without a session and is not allowlisted there gets a silent 307 to
`/login` — the trap that cost CrewTracker its keepalive, and which the file's own
header comment warns about.

### `vercel.json`

```json
{ "crons": [{ "path": "/api/cron/reminders", "schedule": "0 13 * * *" }] }
```

13:00 UTC is 8am Chicago in summer, 7am in winter — Monday in both, so the
weekday test never straddles a boundary. Vercel's Hobby plan allows one run per
day, which is exactly what this needs.

### The client nudge

On the invoice screen, next to Email invoice: **Send reminder**. It emails the
client a short note — amount, due date, link to the online copy — and writes
`reminder_log` with kind `client_reminder`.

It does **not** block a second send. Chasing twice is legitimate. Instead the
button carries the last date: `Send reminder · last sent 8/12`. Informative,
never in the way.

Offered only for a `sent` invoice with a billing email, matching the existing
send button's rules.

## Testing

`sweep` is pure, so the boundaries get pinned exactly:

- due in 8 days → nothing; due in 7 → `dueSoon`; due today → `dueSoon`
- due yesterday, never alerted → `overdue` **and** `newlyOverdue`
- due last week, already alerted → `overdue`, **not** `newlyOverdue`
- `draft`, `paid` and `void` never appear in any bucket, at any date
- `totalOutstandingCents` is a sum of stored cents, never recomputed

`isDigestDay` is tested across a full week of dates, including a Sunday evening
in Chicago that is already Monday in UTC — the case a naive UTC weekday check
gets wrong.

The digest builder is tested for a quiet week and a busy one, and asserted never
to contain `ach_details`.

**No test sends mail.** The cron route's guard is tested by calling it without
the header and asserting a 404.

## Out of scope

- Automatic client reminders on a schedule. Rejected: with four open invoices it
  saves almost nothing, and it will eventually chase a client who has already
  paid an invoice Dan has not yet marked.
- Partial payments. `payments` exists and is empty; outstanding is the full
  `total_cents` of a `sent` invoice.
- Escalating tone, or a second and third notice.
- SMS or push. Email is what he reads.
