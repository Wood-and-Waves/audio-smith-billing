# Editing and Multi-Show Billing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make everything the app can display editable, and finish the billing flow so several shows can go on one invoice.

**Architecture:** Four screens currently read data they cannot write. Each gains a server-action module beside it and a client form component, following the pattern already established by `app/shows/actions.ts` + `components/NewShowForm.tsx`. No schema changes — every column already exists.

**Tech Stack:** Next.js 16 App Router, React 19, Supabase, Tailwind v4, `node --test`.

## Why these four

The final review of the time-tracking feature found ten columns that are read in two places and
written nowhere, plus a function (`billShows`) built to take an array that only ever receives one
element. The consequences are concrete:

- Four real clients — Journey Church, Harvest Bible Chapel, Crescent Event Productions, The
  Orchard Church — have a NULL day rate, so `createShow` refuses them and **their work cannot be
  tracked at all**.
- Five clients have no billing email, so they cannot be invoiced by email when that ships.
- `dt_after_hours`, `meal_penalty_cents` and `continuous_time_enabled` are never written, so
  **three of the seven payroll rules are unreachable** despite being ported and correct.
- `pay_as_half_day` has no toggle, so the `Day Rate (half)` bucket can never be produced.
- Billing several shows onto one invoice — the Journey Church pattern, *"my invoice for the last
  2 visits"* — has no UI.

## Global Constraints

- Money is integer cents held as a JS `number` (safe integers); Postgres columns are `bigint`.
  Parse user input with `parseUSD` from `lib/money.ts`, which returns `null` on unparseable input
  — distinguish that from zero. Never a fractional cent.
- Quantities are integer hundredths. Hours thresholds (`ot_after_hours`, `dt_after_hours`) are
  `numeric(4,1)` — a JS `number`, one decimal place.
- Dates format only through `lib/dates.ts`. Never `new Date()` to derive or render a calendar date.
- Server actions: `'use server'`, `createClient()` from `@/lib/supabase/server`, a `getUser()`
  guard, `{ error: string }` returns rather than thrown exceptions, `revalidatePath` after writes.
  Read `app/shows/actions.ts` for the established shape.
- Client forms: `'use client'`, `useTransition`, inline `{error}` display, the shared `field`
  class string. Read `components/NewShowForm.tsx` for the established shape.
- Files under `app/` and `components/` use the `@/` alias. `lib/` modules import each other
  relatively with a `.ts` extension.
- Tests run under `TZ=America/Chicago` via `npm test`. 40 pass today.
- The app is dark — charcoal ground, amber accent. Use existing token classes (`eyebrow`,
  `tabular`, `display`, `text-muted`, `text-accent`, `border-line`, `bg-surface`,
  `rounded-field`). Introduce no new colour values. Every screen works at 375px.
- **A billed show is locked.** Any new write path touching `shows`, `show_days` or `punches` must
  refuse when `shows.status = 'billed'`, exactly as the existing actions do.
- **Migration 0004 CHECK:** `(status = 'billed') = (invoice_id IS NOT NULL)`. Never write one
  without the other.
- Commit after every task.

---

### Task 1: Client editor

**Files:**
- Create: `app/clients/actions.ts`
- Create: `components/ClientEditor.tsx`
- Create: `app/clients/[id]/page.tsx`
- Modify: `app/clients/page.tsx` — restore the row link and drop the "not a link yet" comment

**Interfaces:**
- Produces: `updateClient(input)`, `createClient_(input)` — note the trailing underscore to avoid
  colliding with the imported Supabase `createClient`.

**Why first:** it unblocks the other three. Four clients cannot have shows tracked until they have
a day rate, and five cannot be emailed until they have an address.

Fields to edit, all on `clients`: `name`, `billing_email`, `contact_name`, `phone`,
`address_line1`, `address_line2`, `terms_days`, `day_rate_cents`, `ot_after_hours`, `notes`,
`archived`.

- [ ] **Step 1: Write `app/clients/actions.ts`**

```ts
'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { parseUSD } from '@/lib/money'

export type ClientInput = {
  id?: string
  name: string
  billing_email: string
  contact_name: string
  phone: string
  address_line1: string
  address_line2: string
  terms_days: number
  day_rate: string        // raw user input, e.g. "780" or "$780.00"
  ot_after_hours: number
  notes: string
  archived: boolean
}

type Fail = { error: string }

export async function saveClient(input: ClientInput): Promise<Fail | { ok: true; id: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  if (!input.name.trim()) return { error: 'A client needs a name.' }

  // parseUSD returns null on junk and 0 on an empty string. A blank day rate is
  // legitimate — it means "no rate card" — but "banana" is not.
  const raw = input.day_rate.trim()
  const dayRate = raw === '' ? null : parseUSD(raw)
  if (raw !== '' && dayRate === null) {
    return { error: `Couldn't read "${input.day_rate}" as a day rate. Try something like 780.` }
  }
  if (dayRate !== null && dayRate < 0) return { error: 'A day rate cannot be negative.' }

  if (!Number.isFinite(input.ot_after_hours) || input.ot_after_hours <= 0) {
    return { error: 'Overtime threshold must be more than zero hours.' }
  }
  if (!Number.isFinite(input.terms_days) || input.terms_days < 0) {
    return { error: 'Payment terms must be zero days or more.' }
  }

  const row = {
    owner_id: user.id,
    name: input.name.trim(),
    billing_email: input.billing_email.trim() || null,
    contact_name: input.contact_name.trim() || null,
    phone: input.phone.trim() || null,
    address_line1: input.address_line1.trim() || null,
    address_line2: input.address_line2.trim() || null,
    terms_days: input.terms_days,
    day_rate_cents: dayRate,
    ot_after_hours: input.ot_after_hours,
    notes: input.notes.trim() || null,
    archived: input.archived,
  }

  let id = input.id
  if (id) {
    const { error } = await supabase.from('clients').update(row).eq('id', id)
    if (error) return { error: error.message }
  } else {
    const { data, error } = await supabase.from('clients').insert(row).select('id').single()
    if (error) return { error: error.message }
    id = data.id
  }

  revalidatePath('/clients')
  revalidatePath(`/clients/${id}`)
  return { ok: true, id: id! }
}
```

- [ ] **Step 2: Write `components/ClientEditor.tsx`**

A `'use client'` form following `components/NewShowForm.tsx` exactly: the same `field` class
string, `useTransition`, an inline `{error}` paragraph with `role="alert"`, and an amber submit
button. One input per field listed above. Group them under three `eyebrow` headings — **Details**
(name, contact, email, phone, address), **Billing** (terms days, day rate, OT after hours), and
**Notes**.

Under the day-rate input, show a live preview of the derived rates using `travelRateFrom` and
`overtimeRateFrom` from `lib/money.ts`, formatted with `formatUSD`, in the same style the invoice
editor uses:

```tsx
{rateCents !== null && rateCents > 0 && (
  <p className="text-xs text-muted mt-1.5 tabular">
    Travel {formatUSD(travelRateFrom(rateCents))} · OT{' '}
    {formatUSD(overtimeRateFrom(rateCents, otHours))} after {otHours}h
  </p>
)}
```

Leaving the day rate blank must be allowed and explained inline: a client with no rate card is
billed ad hoc, and shows cannot be tracked for them.

- [ ] **Step 3: Write `app/clients/[id]/page.tsx`**

Server page: load the client by id, `notFound()` if absent, render `<ClientEditor>` inside
`<AppShell current="clients">`. Also show that client's invoice history — reuse
`components/InvoiceRow.tsx` rather than writing a second row layout.

- [ ] **Step 4: Restore the link on the clients list**

In `app/clients/page.tsx`, the row is currently a `<div>` with a comment saying it deliberately
does not link because no editor exists. Change it back to a `<Link href={`/clients/${c.id}`}>`,
remove that comment, and re-add the `hover:bg-surface transition-colors` class. Add a
`+ New client` link beside the heading, styled like `+ New invoice` on the invoices page.

- [ ] **Step 5: Verify and commit**

Run `npm run build` — must compile clean. Run `npm test` — 40 must still pass.
Then in a browser: give Journey Church a day rate of $600 and confirm the derived travel and
overtime figures appear. Confirm a show can then be created for them, which `createShow`
previously refused.

```bash
git add app/clients components/ClientEditor.tsx
git commit -m "Add the client editor, unblocking rate cards and billing emails."
```

---

### Task 2: Settings editor

**Files:**
- Create: `app/settings/actions.ts`
- Create: `components/SettingsEditor.tsx`
- Modify: `app/settings/page.tsx` — render the editor instead of the read-only `<Field>` list

**Interfaces:**
- Produces: `saveSettings(input)`.

Fields, all on the single `settings` row (`id = 1`): `business_name`, `legal_name`,
`address_line1`, `address_line2`, `phone`, `email`, `remit_to`, `ach_details`,
`default_terms_days`, `default_tax_bp`, `next_invoice_number`.

- [ ] **Step 1: Write `app/settings/actions.ts`**

Same shape as Task 1. Three rules the validation must enforce, each for a concrete reason:

```ts
// Lowering this would hand out an invoice number that already exists, and the
// unique index on (owner_id, number) would reject the next invoice with a
// database error the user cannot interpret. Refuse it here, clearly.
const { data: maxRow } = await supabase
  .from('invoices').select('number').order('number', { ascending: false }).limit(1).maybeSingle()
const highest = maxRow?.number ?? 0
if (input.next_invoice_number <= highest) {
  return { error: `Next invoice number must be above ${highest}, the highest already used.` }
}
```

Tax is entered as a percentage and stored as basis points: `Math.round(percent * 100)`. Reject a
negative or a value over 10000 (100%).

`ach_details` is written but never rendered anywhere a client can see — the invoice document
deliberately prints only `remit_to`. Say so in a comment so nobody "helpfully" adds it to the PDF.

- [ ] **Step 2: Write `components/SettingsEditor.tsx`**

Follow `NewShowForm.tsx`. Group under the same three `eyebrow` headings the read-only page already
uses — **Business**, **Invoicing**, **Payment** — so the screen keeps its shape.

For `ach_details`, use a `<textarea>` and label it clearly as never printed on an invoice, matching
the wording already on the read-only page: sent to a client only when they ask.

- [ ] **Step 3: Rewrite `app/settings/page.tsx`**

Load the settings row, pass it to `<SettingsEditor>`. Delete the local `Field` component and the
"These are read-only for now" note at the bottom.

- [ ] **Step 4: Verify and commit**

`npm run build` clean, `npm test` 40 passing. In a browser, change the default terms to 45, save,
reload, confirm it persisted. Then set it back to 30.

```bash
git add app/settings components/SettingsEditor.tsx
git commit -m "Make settings editable."
```

---

### Task 3: Show editor and half-day toggle

**Files:**
- Modify: `app/shows/actions.ts` — add `updateShow`, `setDayHalfDay`, `deleteShowDay`
- Create: `components/ShowSettings.tsx`
- Modify: `app/shows/[id]/page.tsx` — render `<ShowSettings>`, add the half-day control per day

**Interfaces:**
- Consumes: existing `app/shows/actions.ts` helpers.
- Produces: `updateShow(input)`, `setDayHalfDay(showDayId, value)`, `deleteShowDay(showDayId)`.

This is the task that makes three payroll rules reachable.

Editable on `shows`: `name`, `venue`, `notes`, `day_rate_cents`, `travel_rate_cents`,
`pm_rate_cents`, `ot_after_hours`, `dt_after_hours`, `minimum_meal_break_minutes`,
`meal_break_deduction_cap`, `meal_penalty_grace_hours`, `meal_penalty_cents`,
`short_turn_rest_hours`, `continuous_time_enabled`.

- [ ] **Step 1: Write the actions**

Every one must refuse when the show is billed, deriving status from the row being touched — not
from a caller-supplied id. `deletePunch` in the same file shows the pattern; copy its approach.

```ts
// A billed show's numbers are already on an invoice in a client's inbox.
// Derive the lock from the row being changed, never from an argument.
const { data: day } = await supabase
  .from('show_days').select('show_id, shows(status)').eq('id', showDayId).maybeSingle()
```

`dt_after_hours` is nullable and null means "no double time". An empty input must store null, not
zero — zero would mean every hour is double time. Guard it explicitly and comment why.

`meal_penalty_cents` at 0 disables meal penalties, which is how `billShows` derives
`meal_penalty_enabled`. That is intended; note it.

`updateShow` must reject `ot_after_hours <= 0` (it is a divisor for the PM and overtime rates) and
reject `dt_after_hours` less than or equal to `ot_after_hours` when both are set, since double
time starting before overtime is incoherent.

- [ ] **Step 2: Write `components/ShowSettings.tsx`**

A collapsible section — `<details>` with a `<summary>` reading "Rates and rules" — so the show page
stays about punching in and out, and the rule knobs are there when wanted. Inside, the fields
above, grouped **Rates** and **Rules**.

Show the frozen-rate-card explanation inline: these values were copied from the client when the
show was created, so changing the client's rate card later will not alter this show.

- [ ] **Step 3: Add the half-day toggle per day**

On `app/shows/[id]/page.tsx`, each day already renders a `<PunchClock>`. Add a half-day control
beside it, wired to `setDayHalfDay`. Per the spec, the UI offers it only when the day's net hours
are under 5 — compute that with `calculateNetHours` from `lib/payroll.ts` — but the stored value
is honoured whenever set, because it is a negotiated call rather than a computed one. Disable it
when the show is locked.

- [ ] **Step 4: Verify and commit**

`npm run build` clean, `npm test` 40 passing. In a browser: open a show, set double time after 12
hours, save, reload, confirm it persisted, and confirm the billing preview changes for a day over
12 hours.

```bash
git add app/shows components/ShowSettings.tsx
git commit -m "Add the show editor and half-day toggle, making DT, meal penalties and half-days reachable."
```

---

### Task 4: Multi-show billing

**Files:**
- Create: `components/UnbilledShows.tsx`
- Modify: `app/shows/page.tsx` — render `<UnbilledShows>` for the unbilled section

**Interfaces:**
- Consumes: `billShows(showIds: string[])` from `app/shows/actions.ts`, already written to take an
  array and already merging buckets via `mergeLines`. No action changes needed.

- [ ] **Step 1: Write `components/UnbilledShows.tsx`**

A `'use client'` component rendering the unbilled shows with a checkbox each, and a **Bill
selected** button calling `billShows(selectedIds)`.

Three rules the UI must enforce, because `billShows` already enforces them server-side and a
button that triggers a known error is a bad screen:

1. **Only one client at a time.** Once a show is selected, disable the checkboxes of shows for
   other clients and explain why inline — one invoice belongs to one client.
2. **Incomplete days block billing.** The show detail page already computes this; apply the same
   check here and disable a show whose days are incomplete, naming the date.
3. **Nothing selected** — the Bill button stays disabled.

Show a running total of what the selection would bill, using `computeShowLines` on the server and
passing the per-show totals down as props. Do not recompute money in the browser.

On success, `router.push` to the created invoice.

- [ ] **Step 2: Wire it into `app/shows/page.tsx`**

Replace the unbilled `<ul>` with `<UnbilledShows>`. The billed section stays exactly as it is.
The server page must load each unbilled show with its days and punches so it can compute both the
per-show total and the incomplete-day flag before passing them down.

- [ ] **Step 3: Verify and commit**

`npm run build` clean, `npm test` 40 passing. In a browser: create two small shows for the same
client, select both, bill them, and confirm ONE invoice is created whose Day Rate line shows the
combined quantity rather than two separate lines. Then delete the test data and reset
`settings.next_invoice_number`.

```bash
git add app/shows components/UnbilledShows.tsx
git commit -m "Bill several shows onto one invoice."
```

---

## Self-review notes

| Gap from the time-tracking final review | Task |
|---|---|
| 4 clients with NULL day rate cannot have shows tracked | 1 |
| 5 clients with no billing email | 1 |
| `dt_after_hours` never written — double time unreachable | 3 |
| `meal_penalty_cents` never written — meal penalties unreachable | 3 |
| `continuous_time_enabled` never written | 3 |
| `pay_as_half_day` has no toggle — half-day bucket unreachable | 3 |
| `billShows` takes an array but only ever gets one | 4 |
| Settings read-only | 2 |

**Deliberately still out of scope:** the billed-show lock remains application-level rather than a
database `with check` clause on the parent show's status; `roundingMinutes` is threaded through
`lib/payroll.ts` and never passed by any caller. Both are recorded from the previous review and
neither blocks use.
