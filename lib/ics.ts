// An RFC 5545 (iCalendar) feed builder for the show/flight schedule — and
// nothing else. FeedDay and FeedFlight below carry no cents field, no rate,
// no total: there is no dollar amount anywhere in these types for a future
// edit to accidentally stringify into a SUMMARY or DESCRIPTION. That's not
// a discipline this file has to maintain by hand; it's a compile error the
// moment someone tries. The feed this builds gets handed a subscribe URL
// and lands in Dan's (and possibly a client's) actual calendar app — a
// client-facing surface is exactly the wrong place to leak what a show pays.
//
// The clock is never read in here. DTSTAMP comes from the caller's nowIso,
// not `new Date()`, so the same input always produces the same output —
// byte for byte except DTSTAMP, which is what makes this testable at all.
// In deployment DTSTAMP changes on every poll (the route handler passes
// `new Date().toISOString()`), so byte-stability of the rest of the feed
// does not stop a re-download — what actually stops a calendar app from
// duplicating an event is the stable UID below: DTSTAMP only ever tells it
// "the feed was regenerated," never "this event changed."
//
// UIDs are derived from the row's own id (`showday-{id}@…`,
// `flight-{id}@…`), never generated. A calendar app keys on UID: a stable
// one means an edited show or flight updates the existing event: a fresh
// one every build would duplicate it instead.
//
// Pure: no database, no @/ imports, no JSX. Exercised by node --test.

/** Schedule facts for one show day. No money field exists on this type. */
export type FeedDay = {
  id: string
  date: string // YYYY-MM-DD
  showName: string
  venue: string | null
  location: string | null
  client: string
}

/** Schedule facts for one flight leg. No money field exists on this type. */
export type FeedFlight = {
  id: string
  flightNo: string
  flightDate: string // YYYY-MM-DD, used when either time is missing
  depAirport: string | null
  arrAirport: string | null
  depAt: string | null // ISO instant
  arrAt: string | null // ISO instant
}

const CRLF = '\r\n'
const FOLD_LIMIT = 75 // octets per RFC 5545 §3.1; see foldLine for the chunking rule.
const CONTENT_CHUNK = 74 // first chunk (no leading space) or a continuation's payload
// (continuation physical line = 1 space + up to 74 octets = 75 total).

/**
 * Escapes a TEXT value per RFC 5545 §3.3.11. Order matters: backslash goes
 * first, because the escaped forms of semicolon/comma/newline all start
 * with a backslash — escaping them before the literal backslash pass would
 * get those freshly-inserted backslashes escaped a second time.
 */
function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n')
}

/**
 * Folds one unfolded content line to RFC 5545's 75-octet limit, mindful
 * that UTF-8 characters (the ✈ in a flight SUMMARY is 3 bytes) can never be
 * split mid-character. The simple, safe rule used here: chunk the line into
 * pieces of at most 74 octets, splitting only between whole characters,
 * then join the pieces with CRLF + a single space. Every physical line this
 * produces — first chunk or a space-prefixed continuation — is at most 75
 * octets, which is the only thing RFC 5545 actually requires.
 */
function foldLine(line: string): string {
  if (new TextEncoder().encode(line).length <= FOLD_LIMIT) return line

  const chunks: string[] = []
  let current = ''
  let currentBytes = 0
  for (const ch of line) { // iterates by code point: never splits a surrogate pair
    const chBytes = new TextEncoder().encode(ch).length
    if (currentBytes + chBytes > CONTENT_CHUNK) {
      chunks.push(current)
      current = ''
      currentBytes = 0
    }
    current += ch
    currentBytes += chBytes
  }
  if (current) chunks.push(current)

  return chunks.join(CRLF + ' ')
}

/**
 * nowIso / an ISO instant -> 'YYYYMMDDTHHMMSSZ'. Routed through `Date` and
 * `toISOString()` rather than a lexical strip: Postgres renders a
 * timestamptz as JSON with an explicit offset (`2026-08-10T14:30:00+00:00`)
 * and sometimes microsecond precision, neither of which a regex over the
 * raw string handles — an offset form has no trailing `Z` for the punctuation
 * strip to leave behind, producing an illegal DATE-TIME. `Date` normalizes
 * both away first.
 */
function toStamp(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '')
}

/** Plain YYYY-MM-DD -> YYYYMMDD, for DTSTART;VALUE=DATE. */
function toDateBasic(iso: string): string {
  return iso.replace(/-/g, '')
}

function showDayEvent(day: FeedDay, stamp: string): string[] {
  const lines = [
    'BEGIN:VEVENT',
    `UID:showday-${day.id}@theaudiosmith.com`,
    `DTSTAMP:${stamp}`,
    `DTSTART;VALUE=DATE:${toDateBasic(day.date)}`,
    `SUMMARY:${escapeText(day.showName)}`,
  ]

  const location = [day.venue, day.location].filter((v): v is string => v !== null).join(' · ')
  if (location) lines.push(`LOCATION:${escapeText(location)}`)

  lines.push(`DESCRIPTION:${escapeText(day.client)}`)
  lines.push('END:VEVENT')
  return lines
}

/**
 * Flight timing has three cases, checked on depAt alone (arrAt never
 * decides whether the event is timed — an arrival with no departure has
 * nothing to anchor DTSTART on, so it falls back to all-day same as having
 * neither): both times known -> DTSTART+DTEND, both UTC basic form, so the
 * event spans the actual flight instead of reading as instantaneous;
 * departure only -> a timed DTSTART with no DTEND (RFC 5545 treats a
 * DTSTART-only VEVENT as a point in time, which is exactly what a known
 * departure and unknown arrival is); neither, or arrival-only -> all-day on
 * flightDate, same as before.
 */
function flightEvent(flight: FeedFlight, stamp: string): string[] {
  const summary = flight.arrAirport
    ? `✈ ${flight.flightNo} → ${flight.arrAirport}`
    : `✈ ${flight.flightNo}`

  const lines = [
    'BEGIN:VEVENT',
    `UID:flight-${flight.id}@theaudiosmith.com`,
    `DTSTAMP:${stamp}`,
  ]

  if (flight.depAt) {
    lines.push(`DTSTART:${toStamp(flight.depAt)}`)
    if (flight.arrAt) lines.push(`DTEND:${toStamp(flight.arrAt)}`)
  } else {
    lines.push(`DTSTART;VALUE=DATE:${toDateBasic(flight.flightDate)}`)
  }

  lines.push(`SUMMARY:${escapeText(summary)}`)
  lines.push('END:VEVENT')
  return lines
}

/** Builds a complete RFC 5545 VCALENDAR feed from schedule facts alone. */
export function buildCalendarFeed(input: {
  days: FeedDay[]
  flights: FeedFlight[]
  nowIso: string // DTSTAMP for every event; the clock comes from the caller so output is reproducible.
}): string {
  const stamp = toStamp(input.nowIso)

  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//The Audio Smith//Calendar Feed//EN',
    'X-WR-CALNAME:The Audio Smith',
    'CALSCALE:GREGORIAN',
  ]

  for (const day of input.days) lines.push(...showDayEvent(day, stamp))
  for (const flight of input.flights) lines.push(...flightEvent(flight, stamp))

  lines.push('END:VCALENDAR')

  return lines.map(foldLine).join(CRLF) + CRLF
}
