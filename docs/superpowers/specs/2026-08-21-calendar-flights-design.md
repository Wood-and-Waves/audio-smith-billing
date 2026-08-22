> **Postscript (2026-08-21, from planning/build):** three corrections to the
> text below, discovered against the codebase. (1) The feed handler does NOT
> use a service-role read — that would break the house invariant that
> SUPABASE_SERVICE_ROLE_KEY lives in exactly two files; it reads through a
> `security definer` RPC (`public_calendar_feed`, 0033) granted to anon,
> mirroring `public_invoice`. (2) The token is a plain `uuid` minted with
> `crypto.randomUUID()` (the invoices idiom), not "32 bytes" — inheriting the
> UUID shape guard. (3) The route strips a trailing `.ics` before validating.
> Provider chosen: AeroDataBox via RapidAPI (free tier, 600 units/mo).

# Calendar page, flights, and the ICS feed — design

*"This system drives my calendar" (Dan, 2026-08-21). Every booked show
already carries the dates, venue and client that belong on his calendar;
this wave puts them there — plus flights, which the app has never held.*

## Decisions (Dan, 2026-08-21)

1. **Flight lookup, correctable.** Dan types a flight number and date; a
   flight-data service fills airports and times into an editable form; he
   corrects anything and saves. Lookup runs once at entry — no live delay
   tracking. If the lookup fails (bad number, service down, quota gone),
   the same form accepts hand-typed values: the feature degrades to
   manual entry, never breaks.
2. **Flights live on a calendar page**, not on shows. A flight is a
   schedule entry, not billing data — no show link this wave.
3. **The page is a month grid** — the calendar he pictures, not an agenda
   list.

## Data model — migration 0033 (additive)

### `flights`

```
id           uuid pk
owner_id     uuid not null → auth.users on delete cascade
flight_no    text not null      -- as entered, normalized upper/no-spaces ("AA1234")
flight_date  date not null      -- the departure date Dan entered
dep_airport  text               -- IATA ("ORD"); nullable: manual entry may skip it
arr_airport  text
dep_at       timestamptz        -- scheduled departure instant
arr_at       timestamptz
dep_tz       text               -- IANA zone when the provider supplies it;
arr_tz       text               -- display falls back to America/Chicago
note         text
created_at   timestamptz not null default now()
```

Standard owner-scoped RLS (the 0030/0032 idiom). Index on
`(owner_id, flight_date)`.

Times are stored as instants (timestamptz) because flights cross
timezones; the airport zones ride along for display. All fields except
number and date are nullable so a manual flight with just "AA1234 on
9/12" is legal — the calendar shows what it has.

### `settings.calendar_token text`

Nullable; null = no feed issued yet. Generated with the same entropy as
invoice `public_token`. Regenerating overwrites it, killing the old URL.
Settings reads stay explicit-column (house rule — `ach_details` never
rides along).

## The flight lookup

- Server action `lookupFlight(flightNo, date)` in `app/calendar/actions.ts`
  → calls one flight-data provider over HTTPS with a key from env
  (`FLIGHT_API_KEY`; Vercel prod + `.env.local` dev). Returns
  `{ candidate: { depAirport, arrAirport, depAt, arrAt, depTz, arrTz } }`
  or `{ error }` — it never writes.
- Provider chosen at build time from the free-tier field (AeroDataBox /
  aviationstack / AeroAPI class); the response-shape parsing lives in a
  pure lib (`lib/flightLookup.ts`) so the provider can be swapped without
  touching the UI, and so the parser is testable against canned JSON.
- `saveFlight` / `updateFlight` / `deleteFlight` actions: owner-scoped,
  validated (flight_no non-empty, date sane via `isSaneLedgerDate`-style
  check, arr_at ≥ dep_at when both present), explicit owner_id on insert.
- The key is server-only. The client never talks to the provider.

## The feed — `/cal/{token}.ics`

- Route handler `app/cal/[token]/route.ts`; `'/cal'` joins
  `PUBLIC_PREFIXES` in `proxy.ts` (prefix matching is exact-segment:
  `/cal/...` is public, the `/calendar` PAGE stays behind login —
  verified against `proxy.ts:45`).
- Token-gated: the handler looks up `settings.calendar_token` (explicit
  columns, service-role read like the cron routes) and 404s on mismatch —
  no auth cookie needed, which is what lets Google/Apple poll it.
- Content, built by a pure lib `lib/ics.ts` (tested; no `@/` imports):
  - `VCALENDAR` with `X-WR-CALNAME:The Audio Smith`, refresh hint.
  - One all-day `VEVENT` per show day: `DTSTART;VALUE=DATE`, summary =
    show name, location = venue + city, description = client name.
    UID = `showday-{id}@theaudiosmith.com` — stable, so edits update
    rather than duplicate.
  - One timed `VEVENT` per flight with known times (UTC instants):
    summary `✈ AA1234 → MCO` (or `✈ AA1234` when airports unknown),
    UID = `flight-{id}@…`. A flight with no times becomes an all-day
    event on `flight_date`.
  - Line folding at 75 octets and CRLF endings per RFC 5545 — the lib
    owns this; tests pin it.
- **No money data ever.** No rates, totals, invoice numbers, punch
  math — schedule facts only (names, places, dates, flight times).
  This joins the client-facing chokepoint list: the feed is
  outside-the-app surface even though only Dan holds the URL.
- Revocation: regenerate (or clear) the token in the page's Subscribe
  control; old URL 404s immediately.

## The calendar page — `/calendar`

- `Calendar` joins the `NAV` array in `AppShell` (and the mobile nav) —
  six items. Page is Dan-only (not a public prefix), force-dynamic.
- **Month grid**: 7-column grid, weeks as rows, arrows + current-month
  eyebrow header; today gets the accent treatment. Each day cell lists
  its entries compactly (show name chip / `✈ AA1234`); phones get the
  same grid with tighter cells. Tapping a day opens a detail panel
  (the PunchClock dialog idiom) listing that day's shows and flights —
  flights show times in their airport zones (fallback Chicago) and get
  Edit / Delete there.
- **Add flight**: button in the header → dialog: flight number + date →
  `Look up` (spinner, then fills the editable fields; on `{error}` the
  fields just stay blank for hand entry, with the error shown) → Save.
- **Subscribe**: a control on the page showing the feed URL with
  Copy and Regenerate (first visit: a Generate button). Minimal copy —
  the URL and two buttons.
- Data: all `show_days` joined to shows + clients (paged `.range()` —
  the 1000-row rule), all flights (paged). The grid renders the visible
  month; adjacent months are one arrow-click server render away
  (`?m=2026-09` searchParam).

## Guards

- RLS + explicit owner_id on flight writes; flight actions re-validate
  shape server-side (public POST endpoints).
- Feed handler: constant-time-ish token compare (string equality on a
  32-byte random token is fine — same standard as `/i/{token}`), 404 on
  unknown, `Content-Type: text/calendar`, `Cache-Control` short
  (calendar apps poll on their own schedule).
- The lookup action sanitizes its inputs before they reach the provider
  URL (flight_no `[A-Z0-9]{2,8}`, date `isPlainDate`).
- `FLIGHT_API_KEY` follows the Vercel-sensitive-var rule: verify by
  doing a real lookup, never by pulling.

## Testing

- `scripts/test/ics.test.ts`: all-day show event shape; timed flight
  event in UTC; no-times flight falls back to all-day; UID stability;
  75-octet folding; CRLF; a fixture with a rate-card name proves money
  strings never appear (the builder only accepts schedule fields — the
  type makes leakage a compile error, the test pins the output).
- `scripts/test/flightLookup.test.ts`: provider JSON fixture → candidate
  fields; malformed/empty response → `{ error }`; input sanitizing.
- Server actions untested per convention; brains live in the libs.

## Out of scope (noted for later)

Live delay tracking / airline pushes; travel-flagged show days rendering
differently in grid or feed; punch in/out times inside feed events;
show↔flight linkage; personal-vs-work flight separation; drag-to-move
on the grid.

## Ship

Migration 0033 to prod FIRST, then merge (non-negotiable order). The
feed needs `FLIGHT_API_KEY` only for lookups — the calendar page, feed,
and manual flights all work before the key exists, so the API signup
can happen after ship without blocking anything.
