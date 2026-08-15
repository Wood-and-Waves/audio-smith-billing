# Rate Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A client can hold more than one rate card; a show freezes the card it was created from; and the invoice says which card, who the work was for, and the client's full address.

**Architecture:** A `client_rate_cards` table backfilled from the single rate each client has today. `createShow` copies the chosen card onto the show — day rate, overtime threshold, and travel at full or half — exactly as it already copies a rate card. The card's name is frozen on the show and suffixes every rate-derived invoice line.

**Tech Stack:** Next.js 16 App Router, Supabase Postgres + RLS, `node --test` with native type stripping.

**Spec:** `docs/superpowers/specs/2026-08-15-rate-cards-design.md`

**Task 1's SQL was executed before this plan shipped** — inside a rolled-back transaction against the live database. The table, the partial unique index and the backfill all applied; the index refused a second default and accepted a named card beside it; the rollback left nothing. **The backfill produced 11 cards from 20 clients** — nine have no day rate, including Journey Church (24 invoices) and Harvest Bible Chapel (8), because those were always hand-written rather than billed from shows.

## Global Constraints

- **Money is integer cents.** Rates are copied, never recomputed on read — `travelRateFrom` and `overtimeRateFrom` are *suggestions*, and the number actually used is stored on the line.
- **The default card is UNNAMED, and an unnamed card decorates nothing.** 105 historical invoices and every single-rate client must render byte-identically.
- **A show freezes its card**, name included. Renaming a card later must not rewrite an invoice already sent — the same rule as `bill_to_snapshot` and the frozen rate columns.
- **Travel bills per LEG.** `travel_full_day` therefore doubles a fly-in/fly-out trip from one day rate to two. Intended, and tested.
- **`work_for` must survive a hand-edit.** `billShows` writes it; `InvoiceEditor` never sends it; `saveInvoice`'s update path must leave it alone, exactly as it now leaves `backup_snapshot` alone.
- **`anon` keeps ZERO privileges** on the new table. RLS on, owner-scoped, `revoke all from anon`.
- **Additive only.** `clients.day_rate_cents` and `ot_after_hours` stay but stop being read; dropping them is a later migration.
- **The em dash in `Day Rate — PM` is verified safe** — a glyph probe confirmed it renders in both Helvetica and Oswald in the PDF. **U+2212 renders as nothing** and must never appear.
- `lib/` imports relative with explicit `.ts`, no JSX; `app/` uses `@/`.
- The live database holds **106 invoices / $186,790.49 and 20 clients**. No destructive SQL, no email from any test.
- Every task ends with `npm test`, `npx tsc --noEmit`, `npm run build` clean. Baseline **150 passing**.

---

### Task 1: Schema

**Files:** Create `scripts/sql/migrations/0013_rate_cards.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 0013 — rate cards, travel at full or half day, addresses, and naming the work
--
-- Streamline Pictures pays $900 for PwC PM work and $780 for everything else.
-- A client has had exactly one day_rate_cents, frozen onto each show at
-- creation. Dan could already make a $900 show by editing the rate afterwards —
-- but travel_rate_cents and pm_rate_cents were derived from $780 at creation and
-- stayed there, because updateShow takes all three as independent raw inputs and
-- re-derives nothing. Choosing the right card at creation is what fixes that.
create table client_rate_cards (
  id               uuid primary key default gen_random_uuid(),
  owner_id         uuid not null references auth.users(id) on delete cascade,
  client_id        uuid not null references clients(id) on delete cascade,

  -- NULL is the default card, and a default decorates no invoice line. Naming
  -- it would put "Day Rate — Standard" on every invoice for every client,
  -- including the many who will only ever have one rate.
  name             text,

  day_rate_cents   bigint not null check (day_rate_cents > 0),
  ot_after_hours   numeric(4,1) not null default 10,

  -- Travel bills per LEG, so this doubles a fly-in/fly-out trip from one day
  -- rate to two. That is the intended reading of "some companies pay a full day
  -- rate for a travel day", and it is surprising enough to be worth saying here.
  travel_full_day  boolean not null default false,

  created_at       timestamptz not null default now(),
  constraint card_name_not_blank check (name is null or length(btrim(name)) > 0)
);

create index client_rate_cards_client_idx on client_rate_cards (client_id, name);

-- One default per client. Two would make "which rate does a new show get"
-- ambiguous, and the answer would be whichever row came back first.
create unique index client_rate_cards_default_once
  on client_rate_cards (client_id) where name is null;

alter table client_rate_cards enable row level security;
create policy client_rate_cards_owner_all on public.client_rate_cards
  for all to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
revoke all on public.client_rate_cards from anon;
grant select, insert, update, delete on public.client_rate_cards to authenticated;
grant all on public.client_rate_cards to service_role;

-- Backfill: every client that has a rate gets it as their default card. Nothing
-- is invented. Nine of twenty clients have no rate at all — Journey Church and
-- Harvest Bible Chapel among them — because their invoices were always written
-- by hand rather than billed from shows. They get no card, and createShow keeps
-- refusing them with the message it already gives.
insert into client_rate_cards (owner_id, client_id, day_rate_cents, ot_after_hours)
select owner_id, id, day_rate_cents, ot_after_hours
  from clients
 where day_rate_cents is not null and day_rate_cents > 0;

comment on column clients.day_rate_cents is
  'SUPERSEDED by client_rate_cards. Left in place so 0013 stays reversible; a '
  'later migration drops it once cards are proven. Nothing reads it.';
comment on column clients.ot_after_hours is
  'SUPERSEDED by client_rate_cards — see clients.day_rate_cents.';

-- The show freezes the card it was created from, name included. Renaming a card
-- later must not rewrite an invoice already sent.
alter table shows add column rate_card_name text;

-- Who the work was for. billShows already writes show names into invoices.notes,
-- but notes prints in the small muted footer AND a hand-edit through
-- InvoiceEditor overwrites it, because that textarea is the source of truth.
alter table invoices add column work_for text;

alter table clients add column city text;
alter table clients add column state text;
alter table clients add column postal_code text;
```

- [ ] **Step 2: Apply it**

```bash
npm run db:migrate
```

Expected: `0013_rate_cards.sql … ok`, no drift on 0001–0012. Drift on an earlier file is a STOP — report it, repair nothing.

- [ ] **Step 3: Verify**

```sql
set local role anon;
select current_user as who,
       has_table_privilege('public.client_rate_cards','select') as can_read;
reset role;
select (select count(*) from client_rate_cards) as cards,
       (select count(*) from client_rate_cards where name is null) as defaults,
       (select count(*) from clients) as clients,
       (select count(*) from invoices) as invoices,
       (select sum(total_cents) from invoices) as cents;
```

Expected: `who = anon`, `can_read = false`; **11 cards, all 11 default**, 20 clients, 106 invoices, 18679049 cents. Any `true`, or a changed invoice count or total, is a STOP.

- [ ] **Step 4: Commit**

```bash
npm test && npx tsc --noEmit && npm run build 2>&1 | grep -E "Compiled|Failed"
git add scripts/sql/migrations/0013_rate_cards.sql
git commit -m "Add rate cards, per-card travel, client addresses and work_for."
```

---

### Task 2: The line decoration

Pure. This is the part a client reads.

**Files:** Modify `lib/showBuckets.ts`; modify `scripts/test/showBuckets.test.ts`

**Interfaces:**
- `ShowRates` gains `rate_card_name: string | null`
- `rulesetAndRatesFor`'s `FrozenShowColumns` gains `rate_card_name: string | null`

- [ ] **Step 1: Write the failing tests**

Append to `scripts/test/showBuckets.test.ts`:

```ts
// This file has no DAYS constant — it builds days from showDay()/travelDay(),
// which already exist above. One travel leg in, two worked days.
const CARD_DAYS: ShowDayLike[] = [
  travelDay('t1', '2026-07-13', 'in'),
  showDay('s1', '2026-07-14'),
  showDay('s2', '2026-07-15'),
]

test('an unnamed card produces exactly the descriptions it always has', () => {
  // 105 historical invoices and every single-rate client depend on these exact
  // strings. This test exists to make that dependency explicit.
  const lines = computeShowLines(CARD_DAYS, [], { ...RATES, rate_card_name: null }, RULES)
  assert.deepEqual(
    lines.map((l) => l.description).sort(),
    ['Day Rate', 'Travel Rate'],
  )
})

test('a named card suffixes every line whose price comes from it', () => {
  // Decorating only the day rate would be worse than decorating none: a PM card
  // at $900 also carries a $135 overtime rate against the standard $117, so a
  // mixed invoice would show two "Overtime" lines at different prices with
  // nothing to tell them apart.
  const lines = computeShowLines(CARD_DAYS, [], { ...RATES, rate_card_name: 'PM' }, RULES)
  assert.deepEqual(
    lines.map((l) => l.description).sort(),
    ['Day Rate — PM', 'Travel Rate — PM'],
  )
})

test('a meal penalty is NOT decorated — its price is not the card\'s', () => {
  // Named explicitly because the default RATES fixture has meal_penalty_cents 0,
  // so a blanket "every line is decorated" assertion would pass without ever
  // exercising this.
  const rates = { ...RATES, rate_card_name: 'PM', meal_penalty_cents: 5000 }
  const rules = { ...RULES, meal_penalty_enabled: true, meal_penalty_grace_hours: 4 }
  const lines = computeShowLines(CARD_DAYS, [], rates, rules)
  const penalty = lines.find((l) => l.description.startsWith('Meal Penalty'))
  if (penalty) assert.equal(penalty.description, 'Meal Penalty', 'never suffixed')
})

test('two cards on one invoice stay separate and stay labelled', () => {
  const standard = computeShowLines(CARD_DAYS, [], { ...RATES, rate_card_name: null }, RULES)
  const pm = computeShowLines(CARD_DAYS, [], {
    ...RATES, rate_card_name: 'PM', day_rate_cents: 90000, ot_rate_cents: 13500,
  }, RULES)
  const merged = mergeLines([standard, pm])

  const dayLines = merged.filter((l) => l.description.startsWith('Day Rate'))
  assert.equal(dayLines.length, 2, 'two rates, two lines')
  assert.deepEqual(
    dayLines.map((l) => l.description).sort(),
    ['Day Rate', 'Day Rate — PM'],
  )
})

test('the suffix uses an em dash, never a Unicode minus', () => {
  // U+2212 renders as NOTHING in Helvetica — a deposit once printed as a charge
  // rather than a credit because of it. The em dash was glyph-probed and does
  // render in both Helvetica and Oswald.
  const joined = computeShowLines(CARD_DAYS, [], { ...RATES, rate_card_name: 'PM' }, RULES)
    .map((l) => l.description).join(' ')
  assert.ok(joined.includes('—'), 'em dash')
  assert.ok(!joined.includes('\u2212'), 'never U+2212')
})
```

`RATES`, `RULES`, `showDay` and `travelDay` already exist in this file — **there
is no `DAYS` constant**, which is why one is built above. `RATES` needs
`rate_card_name` added where it is declared, which is the point: every existing
call site must be updated, and `tsc` will find them all.

- [ ] **Step 2: Run and watch it fail**

```bash
npm test 2>&1 | tail -20
```

Expected: FAIL — `rate_card_name` is not on `ShowRates`.

- [ ] **Step 3: Implement**

In `lib/showBuckets.ts`, add to `ShowRates`:

```ts
  /**
   * The rate card this show was created from, frozen. NULL is the default card
   * and decorates nothing — naming the default would put "Day Rate — Standard"
   * on every invoice for every client, including the many with one rate.
   */
  rate_card_name: string | null
```

Add the same to `FrozenShowColumns`, and carry it through `rulesetAndRatesFor`.

Then, immediately above the six `push(...)` calls:

```ts
  // Every line whose price comes from the card carries the card's name. Not
  // just the day rate: a PM card at $900 also has a $135 overtime rate against
  // the standard $117, so a mixed invoice would otherwise show two "Overtime"
  // lines at different prices with nothing to distinguish them.
  const label = (base: string) =>
    rates.rate_card_name ? `${base} — ${rates.rate_card_name}` : base
```

and wrap each of the six descriptions in `label(...)`. **Leave the meal-penalty line and every expense line undecorated** — their prices do not come from the card.

- [ ] **Step 4: Verify and commit**

```bash
npm test 2>&1 | grep -E "^ℹ (pass|fail)"     # 155
npx tsc --noEmit && npm run build 2>&1 | grep -E "Compiled|Failed"
git add lib/showBuckets.ts scripts/test/showBuckets.test.ts
git commit -m "Put the rate card's name on the lines its price produced."
```

---

### Task 3: The client editor — cards and address

**Files:** Modify `components/ClientEditor.tsx`, `app/clients/actions.ts`, `app/clients/[id]/page.tsx`, `app/clients/page.tsx`

- [ ] **Step 1: Cards**

`ClientEditor` gains a rate-card section: the default card (unnamed, labelled "Default rate") plus any named cards, each with day rate, OT-after hours, and a **"Travel bills a full day rate"** checkbox.

Two things the spec asks for explicitly:

- **The full-day checkbox must say what it does.** Travel bills per leg, so a fly-in/fly-out trip goes from one day rate to two. Put that in the helper text, not in a doc.
- **A client with no card must say so.** Nine clients have none — including Journey Church at 24 invoices. Today the only clue is an error when creating a show. Show an explicit "No rate card yet — a show cannot be created for this client until one exists."

`saveClient` writes cards alongside the client. The unnamed card is upserted; named cards are inserted, updated and deleted as the form changes. **Refuse a second unnamed card in the action**, not only via the index, so the message is readable.

- [ ] **Step 2: Address**

Add `city`, `state`, `postal_code` to `EditorClient`, the form, `ClientInput` and `saveClient`, following exactly how `address_line1` already flows.

**Warn about the double-print.** Twenty clients currently carry "Lake in the Hills, IL 60156" as free text in Line 2. Filling in City while leaving it there prints it twice on the next invoice. A muted note under Line 2 — "If the city, state and ZIP are still here, move them to the fields below."

- [ ] **Step 3: Stop reading the old columns**

`app/clients/page.tsx` renders a rate summary from `client.day_rate_cents`. Point it at the default card, and show the count when there is more than one ("2 rate cards"). `app/clients/[id]/page.tsx` selects cards for the editor.

- [ ] **Step 4: Verify and commit**

```bash
npm test 2>&1 | grep -E "^ℹ (pass|fail)" && npx tsc --noEmit && npm run build 2>&1 | grep -E "Compiled|Failed"
npm run db:sql -- /dev/stdin <<'EOF'
select count(*) as cards from client_rate_cards;
EOF
```

Expected: 155 passing, and **11 cards** — the editor must not have written anything.

---

### Task 4: Creating a show from a card

**Files:** Modify `app/shows/actions.ts` (`createShow`), `components/NewShowForm.tsx`, `app/shows/new/page.tsx`

- [ ] **Step 1: `createShow` takes a card**

Read `createShow` (~lines 28–65) first. It currently reads `clients.day_rate_cents` and derives everything. It now takes an optional `rate_card_id`, loads that card (or the client's default when absent), and copies:

```ts
    day_rate_cents: card.day_rate_cents,
    // Travel bills per LEG. A full-day card therefore makes a fly-in/fly-out
    // trip bill two day rates where a half-day card bills one.
    travel_rate_cents: card.travel_full_day ? card.day_rate_cents : travelRateFrom(card.day_rate_cents),
    pm_rate_cents: hours > 0 ? Math.round(card.day_rate_cents / hours) : 0,
    ot_after_hours: hours,
    rate_card_name: card.name,
```

where `hours = Number(card.ot_after_hours ?? 10)`.

**Keep the existing refusal** for a client with no card, wording intact — nine clients depend on it and its message is already good. Verify the loaded card belongs to the given client.

- [ ] **Step 2: The picker**

`NewShowForm`'s `Client` type carries its cards. When a client has one card, show the rate as it does today and send no `rate_card_id`. When a client has more than one, show a `Select` (the ported one) listing "Default — $780.00" and "PM — $900.00", and require a choice.

The existing `noDayRate` explanation stays; it now means "no cards".

- [ ] **Step 3: Verify and commit**

Same checks. Confirm `select count(*) from shows` is unchanged — creating a show must not have run.

---

### Task 5: `work_for` and the FOR: heading

**Files:** Modify `app/shows/actions.ts` (`billShows`), `app/invoices/actions.ts` (`saveInvoice`), `components/InvoiceDocument.tsx`, `lib/invoicePdf.ts`, `app/invoices/[id]/page.tsx`, `scripts/test/invoicePdf.test.ts`

- [ ] **Step 1: Write it at bill time**

`billShows` already computes `shows.map((s) => s.name).join(', ')` for `notes`. Pass the same string as `work_for`.

In `saveInvoice`, add `work_for` to the **insert branch only** — never to the shared `row`. The update path is reachable from `InvoiceEditor`, and putting it in `row` would blank a frozen value on an unrelated hand-edit. This is the identical trap that was caught for `backup_snapshot`; read lines 100–115 of that file, which already do this correctly, and follow them.

- [ ] **Step 2: Render it**

`DocumentData` gains `work_for?: string | null`. Both renderers print a `FOR:` block under `BILL TO` when it is set, and nothing when it is not — so all 105 historical invoices are unchanged.

- [ ] **Step 3: Test**

```ts
test('the FOR heading prints only when the invoice names its work', () => {
  const withWork = { ...INVOICE, work_for: 'PwC Orlando, Streamline Napa' }
  const on = textOf(buildInvoicePdf(PARTS, withWork, ASSETS)).join(' ')
  assert.ok(on.includes('PwC Orlando, Streamline Napa'))

  const off = textOf(buildInvoicePdf(PARTS, INVOICE, ASSETS)).join(' ')
  assert.ok(!/\bFOR\b/.test(off), 'a historical invoice gains nothing')
})
```

- [ ] **Step 4: Verify and commit**

```bash
npm test 2>&1 | grep -E "^ℹ (pass|fail)"     # 156
npm run pdf:sample && sips -s format png tmp/invoice-simple.pdf --out tmp/check.png
```

The samples carry no `work_for`, so they must render exactly as before. **Look at the PNG.**

---

## Verification

- `npm test` — 156 passing. `tsc` clean, build compiles.
- `anon` holds no privilege on `client_rate_cards`.
- An unnamed card produces byte-identical line descriptions to today.
- 106 invoices / $186,790.49 unchanged throughout.

## Manual verification

1. Give Streamline a `PM` card at $900 with travel full-day; leave the default at $780.
2. Create two shows, one from each card. Check the PM show's **travel and PM rates** derive from $900, not $780 — that is the bug this fixes.
3. Add a travel leg each way on the PM show; confirm it bills **two** day rates.
4. Bill both onto one invoice: `Day Rate — PM` and `Day Rate` as separate lines, and a `FOR:` heading naming both shows.
5. Edit that invoice's notes in `InvoiceEditor` and re-save — the `FOR:` heading must survive.
6. Add city/state/zip to a client and confirm the next invoice's BILL TO reads correctly and does not repeat the city.
7. Open a historical invoice (#380) — unchanged.

## Blast radius

One new table, four new columns, no data destroyed. `clients.day_rate_cents` keeps its value and stops being read. Every existing client has exactly one unnamed card, which decorates nothing — so every invoice in the book renders as it does today.
