// The calendar feed's shape is pinned here byte-for-byte: property order,
// escaping, folding, and line endings are exactly what a calendar app (and
// RFC 5545) require, not "close enough". Like ledgerMatch.test.ts, fixtures
// are factories with Partial<T> overrides so each test only states what it
// changes.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildCalendarFeed } from '../../lib/ics.ts'
import type { FeedDay, FeedFlight } from '../../lib/ics.ts'

const day = (over: Partial<FeedDay> = {}): FeedDay => ({
  id: 'd1', showId: 's1', date: '2026-08-10', showName: 'Clinique Product Launch',
  venue: 'The Grand Hall', location: 'Grant Park', client: 'Clinique',
  ...over,
})

const flight = (over: Partial<FeedFlight> = {}): FeedFlight => ({
  id: 'f1', flightNo: 'AA123', flightDate: '2026-08-10',
  depAirport: 'ORD', arrAirport: 'LAX',
  depAt: '2026-08-10T14:30:00Z', arrAt: '2026-08-10T17:45:00Z',
  ...over,
})

const NOW = '2026-08-21T23:00:00.000Z'

// Pulls one VEVENT's physical lines (unfolded is not assumed — callers that
// care about folding read rawLines directly).
function eventLines(feed: string, uidLine: string): string[] {
  const lines = feed.split('\r\n')
  const uidIdx = lines.indexOf(uidLine)
  assert.ok(uidIdx !== -1, `${uidLine} not found in:\n${feed}`)
  const beginIdx = uidIdx - 1
  const endIdx = lines.indexOf('END:VEVENT', uidIdx)
  return lines.slice(beginIdx, endIdx + 1)
}

test('a show day builds an all-day VEVENT with properties in the pinned order', () => {
  const feed = buildCalendarFeed({ days: [day()], flights: [], nowIso: NOW })
  const block = eventLines(feed, 'UID:showrun-s1-2026-08-10@theaudiosmith.com')
  const propNames = block.map((l) => l.split(/[:;]/)[0])
  assert.deepEqual(propNames, ['BEGIN', 'UID', 'DTSTAMP', 'DTSTART', 'DTEND', 'SUMMARY', 'LOCATION', 'DESCRIPTION', 'END'])
  assert.deepEqual(block, [
    'BEGIN:VEVENT',
    'UID:showrun-s1-2026-08-10@theaudiosmith.com',
    'DTSTAMP:20260821T230000Z',
    'DTSTART;VALUE=DATE:20260810',
    'DTEND;VALUE=DATE:20260811',
    'SUMMARY:Clinique Product Launch',
    'LOCATION:The Grand Hall · Grant Park',
    'DESCRIPTION:Clinique',
    'END:VEVENT',
  ])
})

test('a show day carries the calendar wrapper: VERSION, PRODID, X-WR-CALNAME, CALSCALE', () => {
  const feed = buildCalendarFeed({ days: [day()], flights: [], nowIso: NOW })
  const lines = feed.split('\r\n')
  assert.equal(lines[0], 'BEGIN:VCALENDAR')
  assert.ok(lines.includes('VERSION:2.0'))
  assert.ok(lines.some((l) => l.startsWith('PRODID:')))
  assert.ok(lines.includes('X-WR-CALNAME:The Audio Smith'))
  assert.ok(lines.includes('CALSCALE:GREGORIAN'))
  assert.ok(lines.includes('END:VCALENDAR'))
})

test('a show day with no venue or location omits LOCATION entirely', () => {
  const feed = buildCalendarFeed({ days: [day({ venue: null, location: null })], flights: [], nowIso: NOW })
  const block = eventLines(feed, 'UID:showrun-s1-2026-08-10@theaudiosmith.com')
  assert.ok(!block.some((l) => l.startsWith('LOCATION')))
  assert.deepEqual(block.map((l) => l.split(/[:;]/)[0]), ['BEGIN', 'UID', 'DTSTAMP', 'DTSTART', 'DTEND', 'SUMMARY', 'DESCRIPTION', 'END'])
})

test('a show day with only a venue skips the joiner', () => {
  const feed = buildCalendarFeed({ days: [day({ venue: 'The Grand Hall', location: null })], flights: [], nowIso: NOW })
  const block = eventLines(feed, 'UID:showrun-s1-2026-08-10@theaudiosmith.com')
  assert.ok(block.includes('LOCATION:The Grand Hall'))
})

test('a flight with both times builds a timed VEVENT with DTSTART and DTEND in UTC basic format', () => {
  const feed = buildCalendarFeed({ days: [], flights: [flight()], nowIso: NOW })
  const block = eventLines(feed, 'UID:flight-f1@theaudiosmith.com')
  assert.deepEqual(
    block.map((l) => l.split(/[:;]/)[0]),
    ['BEGIN', 'UID', 'DTSTAMP', 'DTSTART', 'DTEND', 'SUMMARY',
     'BEGIN', 'TRIGGER', 'ACTION', 'DESCRIPTION', 'END', 'END'],
  )
  assert.deepEqual(block, [
    'BEGIN:VEVENT',
    'UID:flight-f1@theaudiosmith.com',
    'DTSTAMP:20260821T230000Z',
    'DTSTART:20260810T143000Z',
    'DTEND:20260810T174500Z',
    'SUMMARY:✈ AA123 → LAX',
    'BEGIN:VALARM',
    'TRIGGER:-PT24H',
    'ACTION:DISPLAY',
    'DESCRIPTION:Check in for AA123',
    'END:VALARM',
    'END:VEVENT',
  ])
})

test('a flight with no arrival airport drops the arrow from SUMMARY', () => {
  const feed = buildCalendarFeed({ days: [], flights: [flight({ arrAirport: null })], nowIso: NOW })
  const block = eventLines(feed, 'UID:flight-f1@theaudiosmith.com')
  assert.ok(block.includes('SUMMARY:✈ AA123'))
})

test('a flight with a departure time but no arrival time is timed with no DTEND', () => {
  const feed = buildCalendarFeed({
    days: [], flights: [flight({ id: 'f2', arrAt: null })], nowIso: NOW,
  })
  const block = eventLines(feed, 'UID:flight-f2@theaudiosmith.com')
  assert.deepEqual(block, [
    'BEGIN:VEVENT',
    'UID:flight-f2@theaudiosmith.com',
    'DTSTAMP:20260821T230000Z',
    'DTSTART:20260810T143000Z',
    'SUMMARY:✈ AA123 → LAX',
    'BEGIN:VALARM',
    'TRIGGER:-PT24H',
    'ACTION:DISPLAY',
    'DESCRIPTION:Check in for AA123',
    'END:VALARM',
    'END:VEVENT',
  ])
  assert.ok(!block.some((l) => l.startsWith('DTEND')))
})

test('a departure time in Postgres timestamptz offset form produces a legal DTSTART', () => {
  // Postgres renders a timestamptz as JSON with an explicit offset, not a
  // trailing Z — a lexical strip would leave `+0000` on the end instead of
  // converting it to the `Z` RFC 5545 requires.
  const feed = buildCalendarFeed({
    days: [], flights: [flight({ id: 'f5', depAt: '2026-08-10T14:30:00+00:00', arrAt: null })], nowIso: NOW,
  })
  const block = eventLines(feed, 'UID:flight-f5@theaudiosmith.com')
  assert.ok(block.includes('DTSTART:20260810T143000Z'))
})

test('a departure time with microseconds and an offset also normalizes to a legal DTSTART', () => {
  const feed = buildCalendarFeed({
    days: [], flights: [flight({ id: 'f6', depAt: '2026-08-10T14:30:00.123456+00:00', arrAt: null })], nowIso: NOW,
  })
  const block = eventLines(feed, 'UID:flight-f6@theaudiosmith.com')
  assert.ok(block.includes('DTSTART:20260810T143000Z'))
})

test('a flight with an arrival time but no departure time falls back to all-day', () => {
  const feed = buildCalendarFeed({
    days: [], flights: [flight({ id: 'f3', depAt: null })], nowIso: NOW,
  })
  const block = eventLines(feed, 'UID:flight-f3@theaudiosmith.com')
  assert.ok(block.includes('DTSTART;VALUE=DATE:20260810'))
  assert.ok(!block.some((l) => l.startsWith('DTSTART:'))) // not the timed form
  assert.ok(!block.some((l) => l.startsWith('DTEND')))
})

test('a flight with neither time falls back to an all-day VEVENT on flightDate', () => {
  const feed = buildCalendarFeed({
    days: [], flights: [flight({ id: 'f4', depAt: null, arrAt: null })], nowIso: NOW,
  })
  const block = eventLines(feed, 'UID:flight-f4@theaudiosmith.com')
  assert.ok(block.includes('DTSTART;VALUE=DATE:20260810'))
  assert.ok(!block.some((l) => l.startsWith('DTEND')))
})

test('identical input builds byte-identical output — UIDs and content are stable, not random', () => {
  const input = { days: [day()], flights: [flight()], nowIso: NOW }
  assert.equal(buildCalendarFeed(input), buildCalendarFeed(input))

  // Same row twice in separate calls still gets the same UID, so a calendar
  // app updates the existing event instead of duplicating it.
  const uid = (feed: string) => feed.split('\r\n').find((l) => l.startsWith('UID:showrun-'))
  assert.equal(uid(buildCalendarFeed(input)), uid(buildCalendarFeed(input)))
})

test('TEXT values escape backslash, comma, semicolon, and newline per RFC 5545', () => {
  // Backslash escaped FIRST, or the backslashes just inserted for
  // semicolon/comma/newline would get re-escaped into double-backslashes.
  const raw = 'Acme' + '\\' + 'Corp' + ',' + ' Product' + '\n' + 'Launch' + ';' + ' Encore'
  const feed = buildCalendarFeed({ days: [day({ showName: raw })], flights: [], nowIso: NOW })
  const block = eventLines(feed, 'UID:showrun-s1-2026-08-10@theaudiosmith.com')
  const summary = block.find((l) => l.startsWith('SUMMARY:'))
  assert.ok(summary)
  const value = summary!.slice('SUMMARY:'.length)

  const expected = [
    'Acme',
    '\\\\',  // one raw backslash -> two literal backslash chars
    'Corp',
    '\\,',   // raw comma -> backslash + comma
    ' Product',
    '\\n',   // raw newline -> literal backslash + n (NOT a real newline)
    'Launch',
    '\\;',   // raw semicolon -> backslash + semicolon
    ' Encore',
  ].join('')

  assert.equal(value, expected)
  assert.ok(!value.includes('\n'), 'a real newline must never survive into a folded content line')
})

test('TEXT escaping folds a CRLF pair and a bare CR into literal \\n, never a raw carriage return', () => {
  const raw = 'Line one\r\nLine two\rLine three'
  const feed = buildCalendarFeed({ days: [day({ showName: raw })], flights: [], nowIso: NOW })
  const block = eventLines(feed, 'UID:showrun-s1-2026-08-10@theaudiosmith.com')
  const summary = block.find((l) => l.startsWith('SUMMARY:'))
  assert.ok(summary)
  const value = summary!.slice('SUMMARY:'.length)

  assert.equal(value, 'Line one\\nLine two\\nLine three')
  assert.ok(!value.includes('\r'), 'a raw carriage return must never survive into a folded content line')
  assert.ok(!value.includes('\n'), 'a raw newline must never survive into a folded content line')
})

test('a content line over 75 octets folds with CRLF + single-space continuation', () => {
  const longVenue = 'Grand Exhibition Hall and Convention Center Annex Building East Wing Suite 4400'
  const feed = buildCalendarFeed({ days: [day({ venue: longVenue, location: null })], flights: [], nowIso: NOW })
  const rawLines = feed.split('\r\n')
  const locIdx = rawLines.findIndex((l) => l.startsWith('LOCATION:'))
  assert.ok(locIdx !== -1)

  const folded = [rawLines[locIdx]]
  let i = locIdx + 1
  while (i < rawLines.length && rawLines[i].startsWith(' ')) {
    folded.push(rawLines[i])
    i++
  }
  assert.ok(folded.length > 1, 'expected the long LOCATION value to fold across multiple physical lines')

  for (const physical of folded) {
    assert.ok(Buffer.byteLength(physical, 'utf8') <= 75, `physical line exceeds 75 octets: ${JSON.stringify(physical)}`)
  }

  // Continuation lines start with exactly one space of fold whitespace.
  for (const cont of folded.slice(1)) assert.ok(cont.startsWith(' ') && !cont.startsWith('  '))

  const unfolded = folded[0] + folded.slice(1).map((l) => l.slice(1)).join('')
  assert.equal(unfolded, `LOCATION:${longVenue}`)
})

test('a SUMMARY containing the multibyte ✈ character folds without splitting it', () => {
  const longAirportName = 'INTERNATIONAL'.repeat(6)
  const feed = buildCalendarFeed({
    days: [], flights: [flight({ id: 'f4', arrAirport: longAirportName })], nowIso: NOW,
  })
  const rawLines = feed.split('\r\n')
  const sumIdx = rawLines.findIndex((l) => l.startsWith('SUMMARY:'))
  assert.ok(sumIdx !== -1)

  const folded = [rawLines[sumIdx]]
  let i = sumIdx + 1
  while (i < rawLines.length && rawLines[i].startsWith(' ')) {
    folded.push(rawLines[i])
    i++
  }
  assert.ok(folded.length > 1, 'expected the long SUMMARY to fold across multiple physical lines')

  for (const physical of folded) {
    assert.ok(Buffer.byteLength(physical, 'utf8') <= 75, `physical line exceeds 75 octets: ${JSON.stringify(physical)}`)
  }

  const unfolded = folded[0] + folded.slice(1).map((l) => l.slice(1)).join('')
  assert.equal(unfolded, `SUMMARY:✈ AA123 → ${longAirportName}`)
  // The multibyte characters must survive whole, not truncated or replaced.
  assert.ok(unfolded.includes('✈'))
  assert.ok(unfolded.includes('→'))
})

test('every line ends CRLF and no bare LF ever appears', () => {
  const feed = buildCalendarFeed({
    days: [day({ showName: 'Line one\nLine two' })],
    flights: [flight({ arrAirport: 'INTERNATIONAL'.repeat(6) })],
    nowIso: NOW,
  })
  assert.ok(feed.includes('\r\n'))
  assert.equal(/(?<!\r)\n/.test(feed), false, 'found a line feed not preceded by a carriage return')
})

test("the builder's types carry no money — realistic-looking data leaves no dollar signs or cents in the feed", () => {
  const feed = buildCalendarFeed({
    days: [
      day({ id: 'd1', showName: 'Streamline Corporate Product Launch', client: 'Streamline, Inc.' }),
      // A DISTINCT showId and date (task-2 review catch): once the feed
      // groups days into runs, two fixtures sharing the factory's default
      // showId collapse into ONE event and the second show's venue/client
      // never reach the output — quietly gutting this guard, which exists
      // to prove a feed built from SEVERAL shows' worth of real data leaks
      // no money. The event-count assertion below keeps that honest.
      day({ id: 'd2', showId: 's2', date: '2026-08-12', showName: 'Clinique Rate Card Event', venue: 'Premium Ballroom', client: 'Clinique' }),
    ],
    flights: [flight(), flight({ id: 'f2', flightNo: 'DL456' })],
    nowIso: NOW,
  })
  assert.equal(feed.match(/BEGIN:VEVENT/g)?.length, 4, 'two shows plus two flights must be four events')
  assert.ok(feed.includes('Clinique'), "the second show's own data must actually reach the feed")
  assert.ok(!feed.includes('$'), 'no dollar sign should ever appear in a schedule-only feed')
  assert.ok(!feed.toLowerCase().includes('cents'), 'no "cents" text should ever appear in a schedule-only feed')
})

const runDay = (showId: string, date: string, showName = 'PwC Tax Assurance') => ({
  id: `d-${showId}-${date}`, showId, date, showName,
  venue: 'Hyatt', location: 'Chicago, IL', client: 'PwC',
})

test('an all-day run ends the DAY AFTER its last day — DTEND is exclusive (RFC 5545)', () => {
  const ics = buildCalendarFeed({
    days: [runDay('s1', '2026-08-28'), runDay('s1', '2026-08-29'), runDay('s1', '2026-08-30')],
    flights: [],
    nowIso: '2026-08-25T12:00:00Z',
  })
  assert.match(ics, /DTSTART;VALUE=DATE:20260828/)
  // Last day is the 30th, so DTEND must read the 31st. A DTEND of 20260830
  // would show subscribers a two-day show instead of three.
  assert.match(ics, /DTEND;VALUE=DATE:20260831/)
  assert.equal(ics.match(/BEGIN:VEVENT/g)?.length, 1)
})

test('a single-day show spans exactly one day', () => {
  const ics = buildCalendarFeed({ days: [runDay('s1', '2026-09-15')], flights: [], nowIso: '2026-08-25T12:00:00Z' })
  assert.match(ics, /DTSTART;VALUE=DATE:20260915/)
  assert.match(ics, /DTEND;VALUE=DATE:20260916/)
})

test('a gapped show emits two events with distinct, run-scoped UIDs', () => {
  const ics = buildCalendarFeed({
    days: [runDay('s1', '2026-09-13'), runDay('s1', '2026-09-14'), runDay('s1', '2026-09-17')],
    flights: [],
    nowIso: '2026-08-25T12:00:00Z',
  })
  assert.equal(ics.match(/BEGIN:VEVENT/g)?.length, 2)
  assert.match(ics, /UID:showrun-s1-2026-09-13@theaudiosmith\.com/)
  assert.match(ics, /UID:showrun-s1-2026-09-17@theaudiosmith\.com/)
})

test('two shows on adjacent days stay two events', () => {
  const ics = buildCalendarFeed({
    days: [runDay('s1', '2026-09-13', 'BMS'), runDay('s2', '2026-09-14', 'CHF')],
    flights: [],
    nowIso: '2026-08-25T12:00:00Z',
  })
  assert.equal(ics.match(/BEGIN:VEVENT/g)?.length, 2)
})

test('the run keeps the show details on its event', () => {
  const ics = buildCalendarFeed({ days: [runDay('s1', '2026-09-15')], flights: [], nowIso: '2026-08-25T12:00:00Z' })
  assert.match(ics, /SUMMARY:PwC Tax Assurance/)
  // escapeText escapes the comma in "Chicago, IL" per RFC 5545 §3.3.11 —
  // the LOCATION content line carries a literal backslash before it.
  assert.match(ics, /LOCATION:Hyatt · Chicago\\, IL/)
  assert.match(ics, /DESCRIPTION:PwC/)
})


// The 24-hour check-in alarm. Its whole design is the depAt guard: an alarm
// is only meaningful when the feed knows when the plane actually leaves.

test('a flight with a known departure carries a 24-hour check-in alarm', () => {
  const feed = buildCalendarFeed({ days: [], flights: [flight()], nowIso: NOW })
  const block = eventLines(feed, 'UID:flight-f1@theaudiosmith.com')
  assert.ok(block.includes('BEGIN:VALARM'), 'the alarm is present')
  assert.ok(block.includes('TRIGGER:-PT24H'), 'and fires 24 hours before DTSTART')
  assert.ok(block.includes('DESCRIPTION:Check in for AA123'), 'naming the flight')
})

test('the alarm is nested INSIDE the event, not a sibling of it', () => {
  // A VALARM outside its VEVENT is not a calendar entry with an alarm, it is
  // malformed iCalendar — so position is the assertion, not mere presence.
  const block = eventLines(
    buildCalendarFeed({ days: [], flights: [flight()], nowIso: NOW }),
    'UID:flight-f1@theaudiosmith.com',
  )
  const alarmStart = block.indexOf('BEGIN:VALARM')
  const alarmEnd = block.indexOf('END:VALARM')
  assert.ok(alarmStart > 0 && alarmEnd > alarmStart, 'opens and closes in order')
  assert.equal(block[block.length - 1], 'END:VEVENT', 'the event closes last')
  assert.ok(alarmEnd < block.length - 1, 'and the alarm closes before it')
})

test('a flight with NO departure time gets no alarm at all', () => {
  // All-day event: most clients read -PT24H off an all-day DTSTART as
  // midnight the day before, which would fire at a useless hour for a
  // departure the app does not know. Silence is the honest answer.
  const block = eventLines(
    buildCalendarFeed({ days: [], flights: [flight({ depAt: null, arrAt: null })], nowIso: NOW }),
    'UID:flight-f1@theaudiosmith.com',
  )
  assert.ok(block.some((l) => l.startsWith('DTSTART;VALUE=DATE')), 'it is an all-day event')
  assert.ok(!block.includes('BEGIN:VALARM'), 'and carries no alarm')
})

test('an arrival-only flight gets no alarm either — arrAt never anchors one', () => {
  const block = eventLines(
    buildCalendarFeed({ days: [], flights: [flight({ depAt: null })], nowIso: NOW }),
    'UID:flight-f1@theaudiosmith.com',
  )
  assert.ok(!block.includes('BEGIN:VALARM'))
})

test('a departure-only flight DOES alarm — the departure is all it needs', () => {
  const block = eventLines(
    buildCalendarFeed({ days: [], flights: [flight({ arrAt: null })], nowIso: NOW }),
    'UID:flight-f1@theaudiosmith.com',
  )
  assert.ok(block.includes('TRIGGER:-PT24H'))
})

test('show days never carry an alarm — this is a flight-only feature', () => {
  const feed = buildCalendarFeed({ days: [day()], flights: [], nowIso: NOW })
  assert.ok(!feed.includes('VALARM'), 'no alarm anywhere in a flightless feed')
})
