# Calendar + Flights + ICS Feed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `/calendar` month-grid page (shows + flights, add-flight with corrected lookup), a `flights` table, and a tokenized public ICS feed at `/cal/{token}.ics` that Google/Apple Calendar subscribe to.

**Architecture:** Migration 0033 (flights table + `settings.calendar_token`). Two pure libs: `lib/ics.ts` (RFC 5545 builder — schedule facts only, money structurally impossible) and `lib/flightLookup.ts` (AeroDataBox response parser). Server actions in `app/calendar/actions.ts` (lookup, save/update/delete flight, generate/regenerate token). Public route `app/cal/[token]/route.ts` (`'/cal'` joins PUBLIC_PREFIXES; the `/calendar` page stays behind login — prefix matching is exact-segment, verified `proxy.ts:45`). Month-grid server page + client dialogs.

**Design doc:** `docs/superpowers/specs/2026-08-21-calendar-flights-design.md` (committed 3f937a0). Dan's decisions: lookup-then-correct; flights live on the calendar page (no show link); month grid.

**Flight data provider (decided in planning):** AeroDataBox via RapidAPI — free tier 600 units/month at 1 req/s, no trial expiry; endpoint `GET https://aerodatabox.p.rapidapi.com/flights/number/{flightNo}/{date}` with headers `X-RapidAPI-Key: $FLIGHT_API_KEY`, `X-RapidAPI-Host: aerodatabox.p.rapidapi.com`. Response: JSON array of legs, each with `departure`/`arrival` objects carrying `airport.iata`, `airport.timeZone`, `scheduledTime.utc` + `.local`. The parser is built against the documented sample response (fixture in tests); live verification happens after Dan creates the RapidAPI account and adds the key (account signup is HIS step — verify-by-doing, per house rule on sensitive env vars). Multi-leg numbers: the lib returns all candidate legs; the UI takes the first and Dan edits if it grabbed the wrong leg.

## Global Constraints

- Pure libs (`lib/ics.ts`, `lib/flightLookup.ts`): no `@/` imports, no JSX, relative `.ts` imports, tested in `scripts/test/*.test.ts`.
- Migration ADDITIVE ONLY: `scripts/sql/migrations/0033_calendar_flights.sql`. **SHIP ORDER: migrate prod FIRST, then merge.**
- **The feed carries schedule facts only** — `lib/ics.ts`'s input types accept ONLY name/place/date/time fields; no cents field exists in any input type, making money-in-the-feed a compile error. No rates, totals, invoice numbers, punch math.
- Feed route is public (token-gated, 404 on mismatch); the `/calendar` page is Dan-only (NOT in PUBLIC_PREFIXES).
- Fail-direction rule everywhere: guard reads that gate writes destructure `error` and return before the presence test.
- Owner-scoping: RLS + explicit owner_id on inserts; flight actions re-validate server-side (public POST endpoints). Settings reads use explicit column lists, never `*`.
- Lookup input sanitizing before the provider URL: flight number must match `/^[A-Z0-9]{2,8}$/` after uppercasing/de-spacing; date must pass `isPlainDate`.
- A flight is saveable with ONLY number + date (all other fields nullable); no-times flights render as all-day events.
- UI copy minimal; house idioms (eyebrow headers, FIELD_FULL, `components/ui/Select`, PunchClock dialog pattern, useTransition + router.refresh + `{error}`).
- Every unbounded read pages (`.range()`, created_at/id order).
- 1000-row rule applies to show_days and flights fetches.
- UID stability in the feed: `showday-{id}@theaudiosmith.com` / `flight-{id}@theaudiosmith.com` — edits update events, never duplicate. RFC 5545: CRLF line endings, 75-octet folding — the lib owns both; tests pin them.

## Model tiering (Dan's standing directive)

- Task 1 (migration): cheapest — complete SQL below.
- Tasks 2–3 (ics lib, flightLookup lib, TDD): mid.
- Tasks 4–6 (actions, feed route, calendar page/UI): mid.
- Final whole-branch review: top model (public surface + new external dependency earn it).

---

## Context

Dan books shows; the app already knows every show day, venue, and client — but his calendar doesn't. He also wants flights on that calendar by typing a flight number + date and having times fill themselves in. This wave: an in-app month-grid Calendar page (the page he expects the app to "end up with"), a flights table with lookup-then-correct entry, and a subscribe-once ICS feed so Google/Apple Calendar stay current automatically. The feed link works without login (that's what lets calendar apps poll it), gated by a regenerable secret token — the public-invoice-link trust model.

## Spec corrections (exploration findings — the plan governs; Task 7 postscripts the spec)

1. **No service-role read for the feed.** The house invariant says `SUPABASE_SERVICE_ROLE_KEY` appears in exactly two files (cron + dev-login; asserted in `app/api/cron/reminders/route.ts:18-24`). The public-token pattern is a **`security definer` RPC** granted to `anon, authenticated` with `revoke all … from public` first and `set search_path = public, pg_temp` (the 0006/0007/0024 idiom) — the feed gets `public_calendar_feed(p_token uuid)`, read through the ordinary anon `createClient()`.
2. **Token is a `uuid`**, minted with `crypto.randomUUID()` (the invoices idiom, `app/invoices/actions.ts:531-539`) — inherits the `UUID.test()` shape guard both `/i` routes use so malformed input 404s instead of 500ing.
3. **The route must strip `.ics`** before validating: `/cal/{uuid}.ics` arrives as `token === '{uuid}.ics'`.
4. Bonus: the RPC aggregates to jsonb **in SQL**, so the PostgREST 1000-row cap doesn't apply to the feed; the page's queries are month-bounded (`.gte/.lte` on date) so they're naturally capped too — no paging loops needed anywhere in this wave.

## Reuse (do not reinvent)

- Public-route error discipline (`app/i/[token]/page.tsx:34-66`): malformed shape → 404; DB error → 500 with generic body (never error.message); null → 404 (prober learns nothing); else render.
- `crypto.randomUUID()` minting + `.eq('owner_id', user.id)` settings update idiom (`app/settings/actions.ts:79-88` — UPDATE, never upsert; the row is assumed to exist).
- Settings reads: explicit column list + `.eq('owner_id', user.id).maybeSingle()` (`app/settings/page.tsx:25-37`).
- Non-JSON Response idiom: `app/i/[token]/pdf/route.ts:13-14` (`runtime='nodejs'`, `force-dynamic`), `:20-24` (Next 16 `params: Promise<…>` + await), `:58-64` (headers + `Cache-Control: 'no-store'`).
- `searchParams` idiom with validated fallback: `app/money/reports/page.tsx:98-106`.
- Dialog: `PunchClock.tsx:147-215` / `CornerAdjuster` overlay (`fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-4`, panel `w-full max-w-sm bg-bg border border-line rounded-field p-5`, Escape/Enter on the panel, `FIELD_FULL` inputs).
- Today idiom: container `border-l-2 border-l-accent bg-accent-wash`, chip `text-accent-ink bg-accent-surface rounded-field px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-wider` (`app/shows/[id]/page.tsx:281-300`). Grid "today" uses `todayInChicago()` (list-grade view — the shows LIST page precedent, documented at `app/shows/page.tsx:124-125`).
- Weekday-from-plain-date arithmetic: `new Date(Date.UTC(y, m-1, d)).getUTCDay()` (`lib/backupSnapshot.ts:68-76`); ALL date math UTC-pinned per `lib/dates.ts:1-9`.
- Action conventions: `Fail | { ok: true }`, no throwing, explicit `owner_id` on inserts, re-fetch parent for lock decisions, `revalidatePath` before return (`app/shows/actions.ts:331-361`).
- `instantToWall`/`friendlyTime` (`lib/zonedTime.ts`) for flight-time display; `timezoneShortLabel` (`lib/timezones.ts:44`) for compact zone labels.
- `components/ui/Button`, `SectionHead` (server-safe), `FIELD_FULL`, `cn`.
- Current schema (verified): `show_days` = `id, owner_id, show_id, date, pay_as_half_day, notes, created_at, travel_in, travel_out` (NO day_type — dropped in 0005); `shows` has `name, venue, location, timezone` (NO city/state — `location` is free text "San Diego, CA"); `clients(name)`.
- Select strings are NOT type-checked (no generated DB types) — hand-verify every new column name.
- Adding `{ href: '/calendar', label: 'Calendar', key: 'calendar' }` to `NAV` (`components/AppShell.tsx:8-14`) auto-widens the `current` union; MobileNav needs nothing. Desktop bar is tight (its own comment warns it overflows first) — visual check required in the browser at ~640px.

---

## Task 1: Migration 0033 — flights, calendar_token, feed RPC

**Files:**
- Create: `scripts/sql/migrations/0033_calendar_flights.sql`

**Tier:** cheapest (complete SQL below; transcription + apply + verify).

- [ ] **Step 1: Write the migration** — exact contents:

```sql
-- 0033 — the calendar: flights, the feed token, and the feed's reader.
--
-- Flights are schedule entries, not billing data — no show link, no money
-- column. Everything except the number and date is nullable on purpose: a
-- lookup that fails must never block saving "AA1234 on 9/12"; the calendar
-- shows what it has (an all-day entry until times arrive).
create table flights (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references auth.users(id) on delete cascade,
  flight_no    text not null check (flight_no ~ '^[A-Z0-9]{2,8}$'),
  flight_date  date not null,
  dep_airport  text,        -- IATA ("ORD")
  arr_airport  text,
  dep_at       timestamptz, -- scheduled instants; flights cross timezones
  arr_at       timestamptz,
  dep_tz       text,        -- IANA zone when the provider supplies it;
  arr_tz       text,        --   display falls back to America/Chicago
  note         text,
  created_at   timestamptz not null default now(),

  constraint flights_arrival_after_departure
    check (dep_at is null or arr_at is null or arr_at >= dep_at)
);

create index flights_owner_date_idx on flights (owner_id, flight_date);

-- Standard owner-scoped RLS (the 0030/0032 idiom).
do $$
declare t text;
begin
  foreach t in array array['flights']
  loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy %I on public.%I for all to authenticated
         using (owner_id = auth.uid()) with check (owner_id = auth.uid())',
      t || '_owner_all', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;

-- The feed token. A uuid like invoices.public_token: crypto.randomUUID() on
-- the app side, nullable (null = no feed issued), regenerating kills the old
-- URL — which is the whole of revocation, same as 0006.
alter table settings add column calendar_token uuid;

-- The feed's reader. Security definer like public_invoice (0006): anon holds
-- no table privileges; this function returns ONE owner's schedule by
-- unguessable token and nothing else. SCHEDULE FACTS ONLY — names, places,
-- dates, flight times. No rates, totals, or invoice numbers may ever join
-- these selects: the feed is a client-facing surface even though only Dan
-- holds the URL.
create function public.public_calendar_feed(p_token uuid)
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  select case when s.owner_id is null then null else jsonb_build_object(
    'days', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',         d.id,
        'date',       d.date,
        'show_name',  sh.name,
        'venue',      sh.venue,
        'location',   sh.location,
        'client',     c.name
      ) order by d.date)
      from show_days d
      join shows sh on sh.id = d.show_id
      join clients c on c.id = sh.client_id
      where d.owner_id = s.owner_id
    ), '[]'::jsonb),
    'flights', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',          f.id,
        'flight_no',   f.flight_no,
        'flight_date', f.flight_date,
        'dep_airport', f.dep_airport,
        'arr_airport', f.arr_airport,
        'dep_at',      f.dep_at,
        'arr_at',      f.arr_at
      ) order by f.flight_date)
      from flights f
      where f.owner_id = s.owner_id
    ), '[]'::jsonb)
  ) end
  from (
    select owner_id from settings where calendar_token = p_token
  ) s
$$;

-- Pin the search path (the 0007 hardening) and apply least privilege (0024):
-- create function grants EXECUTE to PUBLIC by default.
alter function public.public_calendar_feed(uuid) set search_path = public, pg_temp;
revoke all on function public.public_calendar_feed(uuid) from public;
grant execute on function public.public_calendar_feed(uuid) to anon, authenticated;
```

- [ ] **Step 2:** `npm run db:migrate` (DEV) — 0032→0033 applied.
- [ ] **Step 3:** Verify via `npm run db:sql` one-off: `select public_calendar_feed(gen_random_uuid());` → expect one row, null (no match); and information_schema check for `flights` + `settings.calendar_token`. Delete the check file.
- [ ] **Step 4:** Commit: `0033: flights, calendar_token, public_calendar_feed`.
- [ ] **PROD NOTE:** applied at ship (Task 7), FIRST.

---

## Task 2: `lib/dates.ts` grid helpers + `lib/ics.ts` (TDD)

**Files:**
- Modify: `lib/dates.ts`  ·  Create: `lib/ics.ts`
- Modify: `scripts/test/dates.test.ts`  ·  Create: `scripts/test/ics.test.ts`

**Tier:** mid.

**Interfaces (exact — Tasks 5–6 consume verbatim):**

```ts
// lib/dates.ts additions (UTC-pinned like everything in this file)
export const WEEKDAYS: readonly string[]            // ['Sun','Mon',…,'Sat']
export function weekdayIndex(iso: string): number    // 0=Sun, from Date.UTC parts
export function monthLabel(ym: string): string       // '2026-08' -> 'August 2026'
export function addMonths(ym: string, n: number): string  // '2026-08',-1 -> '2026-07'
export function monthGrid(ym: string): string[][]
// Weeks (Sun-first) of plain YYYY-MM-DD covering the month, padded with
// leading/trailing adjacent-month dates to full 7-day rows. 4–6 rows.

// lib/ics.ts — schedule facts ONLY; no cents field exists in these types,
// making money-in-the-feed a compile error.
export type FeedDay = {
  id: string; date: string;                 // YYYY-MM-DD
  showName: string; venue: string | null
  location: string | null; client: string
}
export type FeedFlight = {
  id: string; flightNo: string; flightDate: string
  depAirport: string | null; arrAirport: string | null
  depAt: string | null; arrAt: string | null   // ISO instants
}
export function buildCalendarFeed(input: {
  days: FeedDay[]; flights: FeedFlight[]; nowIso: string  // DTSTAMP; clock from caller
}): string
```

**Pinned ICS rules:** `VCALENDAR` wrapper with `VERSION:2.0`, `PRODID`, `X-WR-CALNAME:The Audio Smith`, `CALSCALE:GREGORIAN`. Show day → all-day `VEVENT`: `UID:showday-{id}@theaudiosmith.com`, `DTSTART;VALUE=DATE:YYYYMMDD` (no DTEND — RFC default = one day), `SUMMARY` = showName, `LOCATION` = venue + location joined " · " (skip nulls), `DESCRIPTION` = client. Flight with both times → timed `VEVENT`: `UID:flight-{id}@…`, `DTSTART:YYYYMMDDTHHMMSSZ` (UTC — avoids VTIMEZONE entirely), `SUMMARY` = `✈ {flightNo} → {arrAirport}` (or `✈ {flightNo}` when airports null). Flight missing either time → all-day on flightDate. Every event carries `DTSTAMP` from nowIso. TEXT values escaped per RFC 5545 (backslash, semicolon, comma, newline). Lines CRLF-terminated, folded at 75 octets with space continuation.

- [ ] **Step 1:** Failing tests. dates: `monthGrid august 2026 runs sunday july twenty-sixth through saturday september fifth` — 2026-08-01 is a Saturday (verified), so the Sun-first grid is exactly 6 rows, `[0][0] === '2026-07-26'`, `[5][6] === '2026-09-05'`; also assert every row has 7 entries and '2026-08-01' sits at `[0][6]`. `addMonths wraps the year both directions` ('2026-01' −1 → '2025-12'; '2026-12' +1 → '2027-01'). `weekdayIndex is UTC-pinned — no machine-timezone drift`. ics: all-day show event shape; timed flight in UTC; no-times flight falls back to all-day; UID stability (same input twice → identical output); escaping (a show name with a comma and a newline); 75-octet folding (a long venue); CRLF endings (assert `\r\n` and NO bare `\n`); `the builder's types carry no money — a feed built from real-looking data contains no dollar signs or cents` (fixture with rate-card-like names; assert no `$` and no `cents`).
- [ ] **Step 2:** red → **Step 3:** implement → **Step 4:** green + cold tsc.
- [ ] **Step 5:** Commit: `feat: month-grid date helpers + RFC 5545 feed builder`.

---

## Task 3: `lib/flightLookup.ts` — AeroDataBox parser (TDD)

**Files:**
- Create: `lib/flightLookup.ts`  ·  Create: `scripts/test/flightLookup.test.ts`

**Tier:** mid.

**Interfaces (exact):**

```ts
export function normalizeFlightNo(raw: string): string | null
// uppercase, strip spaces; null unless /^[A-Z0-9]{2,8}$/
export type CandidateLeg = {
  depAirport: string | null; arrAirport: string | null
  depAt: string | null; arrAt: string | null    // ISO instants (UTC)
  depTz: string | null; arrTz: string | null    // IANA when present
}
export function parseAeroDataBox(json: unknown): { candidates: CandidateLeg[] } | { error: string }
```

**Rules:** the provider returns a JSON array of legs; each leg has `departure`/`arrival` objects with `airport.iata`, `airport.timeZone`, `scheduledTime.utc` (e.g. `"2026-09-12 14:30Z"`) and `.local`. Parse defensively — every field individually optional (missing → null); a non-array / empty array / unrecognizable shape → `{ error: 'No flight found for that number and date.' }`. Convert the provider's `"YYYY-MM-DD HH:MMZ"` into a real ISO instant (`YYYY-MM-DDTHH:MM:00Z`). NEVER throw. Header comment: parser isolated here so the provider can be swapped without touching UI, and so canned-JSON fixtures pin it; the live shape gets verified by doing once Dan's key exists.

- [ ] **Step 1:** Failing tests: happy single leg; multi-leg returns both in order; missing airport/timezone fields → nulls, still a candidate; empty array → error; object-not-array → error; garbage string → error; time-format conversion pinned; `normalizeFlightNo` ('aa 1234' → 'AA1234'; 'x' → null; injection-ish 'AA/12' → null).
- [ ] **Step 2–4:** red → implement → green + cold tsc. **Step 5:** Commit: `feat: flight lookup parser`.

---

## Task 4: `app/calendar/actions.ts` — lookup, flight CRUD, token

**Files:**
- Create: `app/calendar/actions.ts`

**Tier:** mid. Model every action on `app/shows/actions.ts:331-361` (auth → guards → owner_id inserts → revalidate; `Fail | { ok: true; … }`; fail-closed error reads).

**Exact signatures (Task 6 calls these):**

```ts
export async function lookupFlight(input: { flightNo: string; date: string }):
  Promise<Fail | { ok: true; candidates: CandidateLeg[] }>
export async function saveFlight(input: {
  flightNo: string; flightDate: string
  depAirport: string | null; arrAirport: string | null
  depAt: string | null; arrAt: string | null
  depTz: string | null; arrTz: string | null; note: string
}): Promise<Fail | { ok: true; id: string }>
export async function updateFlight(input: {
  id: string; flightNo: string; flightDate: string
  depAirport: string | null; arrAirport: string | null
  depAt: string | null; arrAt: string | null
  depTz: string | null; arrTz: string | null; note: string
}): Promise<Fail | { ok: true }>
export async function deleteFlight(id: string): Promise<Fail | { ok: true }>
export async function generateCalendarToken(): Promise<Fail | { ok: true }>
```

**Binding semantics:**
- `lookupFlight`: auth; `normalizeFlightNo` (null → error) + `isPlainDate` BEFORE anything touches a URL; `FLIGHT_API_KEY` absent → `{ error: 'Flight lookup is not set up yet — enter the times by hand.' }`; `fetch('https://aerodatabox.p.rapidapi.com/flights/number/{no}/{date}', { headers: { 'X-RapidAPI-Key': key, 'X-RapidAPI-Host': 'aerodatabox.p.rapidapi.com' } })` with a ~10s AbortController timeout; non-OK → friendly error (404 → 'No flight found…'); body → `parseAeroDataBox`. Never writes; never leaks provider error bodies.
- `saveFlight`/`updateFlight`: validate flightNo (normalize; store normalized), `isPlainDate(flightDate)`, both-times-ordered check mirroring the DB constraint (friendly message, not a DB error), airports uppercased 3-letter-or-null (`/^[A-Z]{3}$/` after trim/upper, else null — lenient: junk becomes null, not an error), tz strings passed through as-is or null. Insert carries `owner_id: user.id`. Update fetches the row first (RLS-scoped, fail closed on error, missing → error). `revalidatePath('/calendar')`.
- `deleteFlight`: fetch-first, then delete; revalidate.
- `generateCalendarToken`: `crypto.randomUUID()` → `.from('settings').update({ calendar_token: token }).eq('owner_id', user.id)` (the saveSettings idiom, `app/settings/actions.ts:79-88`); works for both first-generate and regenerate; revalidate `/calendar`.

- [ ] **Step 1:** Implement (no new tests — brains live in Task 3's lib; convention).
- [ ] **Step 2:** Gates: `npm test`, cold tsc, `npm run build`. **Step 3:** Commit: `feat: calendar actions — lookup, flights, feed token`.

---

## Task 5: Feed route + public prefix

**Files:**
- Create: `app/cal/[token]/route.ts`  ·  Modify: `proxy.ts` (PUBLIC_PREFIXES + comment)

**Tier:** cheapest-leaning mid (small, but the error discipline is exacting).

- [ ] **Step 1:** `proxy.ts`: add `'/cal'` to PUBLIC_PREFIXES with a comment line matching the file's style: `/cal is the calendar feed — one security-definer function keyed by unguessable token (0033), mirroring /i.` (The `/calendar` PAGE stays private: matching is `path === p || startsWith(p + '/')`.)
- [ ] **Step 2:** Route (copy `app/i/[token]/pdf/route.ts` shape): `runtime='nodejs'`, `force-dynamic`; await params; strip a single trailing `.ics` (present or absent both accepted); `UUID.test` (copy the regex from `app/i/[token]/page.tsx:24`) → 404 `new Response('Not found', { status: 404 })`; anon `createClient()` → `supabase.rpc('public_calendar_feed', { p_token: token })`; error → 500 with generic body; null data → 404; else map the jsonb's `days`/`flights` (snake_case) into `FeedDay[]`/`FeedFlight[]`, call `buildCalendarFeed({ days, flights, nowIso: new Date().toISOString() })`, return:

```ts
  return new Response(ics, {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  })
```

- [ ] **Step 3:** Gates + curl check on dev: unknown token → 404; after generating a token in Task 6's UI (or a hand UPDATE in dev), `curl localhost:3000/cal/{token}.ics` → BEGIN:VCALENDAR. **Step 4:** Commit: `feat: public ICS feed at /cal/{token}.ics`.

---

## Task 6: `/calendar` page, month grid, dialogs, nav

**Files:**
- Create: `app/calendar/page.tsx`  ·  Create: `components/CalendarMonth.tsx`  ·  Create: `components/AddFlightDialog.tsx`  ·  Create: `components/CalendarSubscribe.tsx`
- Modify: `components/AppShell.tsx` (NAV entry only)

**Tier:** mid (the wave's biggest UI task).

**Page** (server, `force-dynamic`, `<AppShell current="calendar">` — NOT `wide`; a 7-col grid fits max-w-5xl):
1. `searchParams: Promise<{ m?: string }>` — validate `/^\d{4}-(0[1-9]|1[0-2])$/`, fallback `todayInChicago().slice(0, 7)` (the reports-page idiom).
2. `monthGrid(m)` gives the visible dates; query BOTH tables bounded to the grid's first/last date (not the month's — leading/trailing cells show their entries too): `show_days.select('id, date, travel_in, travel_out, pay_as_half_day, show_id, shows(name, venue, location, timezone, clients(name))').gte('date', first).lte('date', last).order('date')`; `flights.select('id, flight_no, flight_date, dep_airport, arr_airport, dep_at, arr_at, dep_tz, arr_tz, note').gte('flight_date', first).lte('flight_date', last).order('flight_date')`. (Month-bounded → no paging loops; hand-verify every column name — selects aren't type-checked.)
3. Settings: `.select('calendar_token').eq('owner_id', user.id).maybeSingle()` (explicit columns — never widen). Feed URL composed the way invoice links are — find `appUrl` in `app/invoices/actions.ts` (~line 854) and reuse its source: `${appUrl}/cal/${token}.ics`.
4. Render: header row (children, not AppShell props): eyebrow month label + prev/next arrows (`<Link href={`/calendar?m=${addMonths(m,-1)}`}>`), Add flight button, Subscribe control. Then `<CalendarMonth …/>`.

**CalendarMonth** (`'use client'`): weekday header from `WEEKDAYS`; `grid grid-cols-7` with `border-line` cell borders; adjacent-month cells `text-muted` + dimmed; **today** = `bg-accent-wash` + `border-l-2 border-l-accent` (computed via `todayInChicago()`, passed from the server page — no client clock); each cell: day number top-right, then up to ~3 compact entries — show chip (`bg-accent-surface text-accent-ink` truncated show name) and flight line (`✈ AA1234`, `text-ink`), `+N more` when over. Day-tap (whole cell button) opens the detail dialog (PunchClock overlay idiom): the date long-formatted, each show entry (name · venue · location · client, travel/half-day badge line via the `[travel_in && 'travel in', …].filter(Boolean).join(' · ')` idiom, linking to `/shows/{show_id}`), each flight (`✈ AA1234 · ORD → MCO`, times via `instantToWall(depAt, depTz ?? 'America/Chicago')` + `friendlyTime` + `timezoneShortLabel`, note) with Edit and Delete (delete = confirm-free `deleteFlight` + refresh — flights are one-tap re-creatable). Phone: same grid, tighter (`text-[11px]`, entries collapse to dots below `sm:` with the day-tap as the reader).
**AddFlightDialog** (`'use client'`): PunchClock dialog idiom. Fields: flight number + date (`FIELD_FULL`; date defaults today) → `Look up` button (`useTransition`; on `{ok}` fills dep/arr airport + local date/time inputs from candidates[0] — times shown via `instantToWall` in the leg's zones; on `{error}` shows it inline and leaves fields for hand entry) → editable fields (dep/arr airport, dep/arr date+time+zone-label, note) → Save calls `saveFlight` (times converted back via `wallToInstant` with the leg's tz, fallback America/Chicago), refresh, close. Also opens pre-filled in Edit mode for `updateFlight`.
**CalendarSubscribe** (`'use client'`): no token → one `Generate feed link` button (`generateCalendarToken` + refresh). With token: the URL in a readonly `FIELD_FULL` input + Copy (navigator.clipboard) + `Regenerate` (neutral idiom; regenerating kills the old URL — say exactly that in the one permitted line of copy: `Regenerating kills the old link.`). Minimal copy throughout.
**Nav:** add `{ href: '/calendar', label: 'Calendar', key: 'calendar' }` after Shows. `current` union auto-widens; MobileNav needs nothing.

- [ ] **Step 1:** Page + grid. **Step 2:** Dialogs + subscribe. **Step 3:** Nav entry; browser check the desktop bar at ~640–800px width — if the bar wraps/overflows, tighten `gap-1` or accept the squeeze ONLY if nothing wraps; report what you saw.
- [ ] **Step 4:** Gates: `npm test`, cold tsc, `npm run build`. **Step 5:** Commit: `feat: calendar page — month grid, flights, subscribe`.

---

## Task 7: Docs, final review, walkthrough, ship

**Tier:** controller-direct docs; top-model whole-branch review (new PUBLIC surface + first inbound external API earn it).

- [ ] **Step 1 — docs:** CLAUDE.md: nav is six items; calendar map entry (feed = security-definer RPC keyed by settings.calendar_token uuid; feed carries schedule facts only — joins the client-facing chokepoint list; flights table; grid helpers live in lib/dates.ts, UTC-pinned). BACKLOG: remove the calendar item; carry the deferred list (travel-day rendering in grid/feed, punches in feed events, show↔flight links, live delay tracking). Spec postscript: service-role → RPC correction + uuid token + `.ics` strip.
- [ ] **Step 2 — final review** (opus, review-package over the branch): lens = Global Constraints; especially the RPC's field list (schedule facts only — no money column in any select), the feed route's three-way error discipline, PUBLIC_PREFIXES scope (`/cal` public, `/calendar` private — test both), token minting/regeneration, lookup input sanitizing + no provider-error leakage, UTC-pinning of all new date math, month-boundary correctness (grid edges query-bounded), select-string column names vs 0033/0005 schema. ONE fix subagent for findings.
- [ ] **Step 3 — dev walkthrough (browser pane, sandbox):** Calendar nav lands on current month; sandbox show days visible on their dates; today highlighted; prev/next arrows; add a flight manually (no key in dev unless present — the error path IS the test: lookup shows the friendly message, hand-entered times save); flight renders in cell + detail dialog; edit + delete it; Generate feed link → curl the URL → valid VCALENDAR with the show days; bad token → 404; `/calendar` logged out → redirects to login; `/cal/{token}.ics` logged out → 200.
- [ ] **Step 4 — SHIP:** `npm run db:migrate -- --prod` (0033) FIRST → merge → push → prod smoke (login page 200; feed 404 on a random uuid). THEN hand Dan the RapidAPI steps (his account): rapidapi.com → subscribe AeroDataBox Basic (free, 600 units/mo) → copy the key → add `FLIGHT_API_KEY` to Vercel prod env + `.env.local` → verify by doing one real lookup. Lookup is the ONLY thing waiting on the key; page, grid, feed, manual flights all live without it.

---

## Execution notes

- Branch `calendar` off main. SDD per house process; tiers above; progress ledger.
- `security-audit/schema.sql` is a stale pre-0005 snapshot — never trust it for show_days.
- Nothing in this wave touches money code, the bridge, or the import path.

## Verification

Task 7 Step 3 (browser + curl walkthrough) and Step 4 (prod smoke). Automated: `npm test` (new dates/ics/flightLookup suites), cold `npx tsc --noEmit`, `npm run build` — green before every commit.
