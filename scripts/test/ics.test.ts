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
  id: 'd1', date: '2026-08-10', showName: 'Clinique Product Launch',
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
  const block = eventLines(feed, 'UID:showday-d1@theaudiosmith.com')
  const propNames = block.map((l) => l.split(/[:;]/)[0])
  assert.deepEqual(propNames, ['BEGIN', 'UID', 'DTSTAMP', 'DTSTART', 'SUMMARY', 'LOCATION', 'DESCRIPTION', 'END'])
  assert.deepEqual(block, [
    'BEGIN:VEVENT',
    'UID:showday-d1@theaudiosmith.com',
    'DTSTAMP:20260821T230000Z',
    'DTSTART;VALUE=DATE:20260810',
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
  const block = eventLines(feed, 'UID:showday-d1@theaudiosmith.com')
  assert.ok(!block.some((l) => l.startsWith('LOCATION')))
  assert.deepEqual(block.map((l) => l.split(/[:;]/)[0]), ['BEGIN', 'UID', 'DTSTAMP', 'DTSTART', 'SUMMARY', 'DESCRIPTION', 'END'])
})

test('a show day with only a venue skips the joiner', () => {
  const feed = buildCalendarFeed({ days: [day({ venue: 'The Grand Hall', location: null })], flights: [], nowIso: NOW })
  const block = eventLines(feed, 'UID:showday-d1@theaudiosmith.com')
  assert.ok(block.includes('LOCATION:The Grand Hall'))
})

test('a flight with both times builds a timed VEVENT with DTSTART in UTC basic format', () => {
  const feed = buildCalendarFeed({ days: [], flights: [flight()], nowIso: NOW })
  const block = eventLines(feed, 'UID:flight-f1@theaudiosmith.com')
  assert.deepEqual(block, [
    'BEGIN:VEVENT',
    'UID:flight-f1@theaudiosmith.com',
    'DTSTAMP:20260821T230000Z',
    'DTSTART:20260810T143000Z',
    'SUMMARY:✈ AA123 → LAX',
    'END:VEVENT',
  ])
})

test('a flight with no arrival airport drops the arrow from SUMMARY', () => {
  const feed = buildCalendarFeed({ days: [], flights: [flight({ arrAirport: null })], nowIso: NOW })
  const block = eventLines(feed, 'UID:flight-f1@theaudiosmith.com')
  assert.ok(block.includes('SUMMARY:✈ AA123'))
})

test('a flight missing either time falls back to an all-day VEVENT on flightDate', () => {
  const noArrTime = buildCalendarFeed({
    days: [], flights: [flight({ id: 'f2', arrAt: null })], nowIso: NOW,
  })
  const block1 = eventLines(noArrTime, 'UID:flight-f2@theaudiosmith.com')
  assert.ok(block1.includes('DTSTART;VALUE=DATE:20260810'))
  assert.ok(!block1.some((l) => l.startsWith('DTSTART:'))) // not the timed form

  const noTimesAtAll = buildCalendarFeed({
    days: [], flights: [flight({ id: 'f3', depAt: null, arrAt: null })], nowIso: NOW,
  })
  const block2 = eventLines(noTimesAtAll, 'UID:flight-f3@theaudiosmith.com')
  assert.ok(block2.includes('DTSTART;VALUE=DATE:20260810'))
})

test('identical input builds byte-identical output — UIDs and content are stable, not random', () => {
  const input = { days: [day()], flights: [flight()], nowIso: NOW }
  assert.equal(buildCalendarFeed(input), buildCalendarFeed(input))

  // Same row twice in separate calls still gets the same UID, so a calendar
  // app updates the existing event instead of duplicating it.
  const uid = (feed: string) => feed.split('\r\n').find((l) => l.startsWith('UID:showday-'))
  assert.equal(uid(buildCalendarFeed(input)), uid(buildCalendarFeed(input)))
})

test('TEXT values escape backslash, comma, semicolon, and newline per RFC 5545', () => {
  // Backslash escaped FIRST, or the backslashes just inserted for
  // semicolon/comma/newline would get re-escaped into double-backslashes.
  const raw = 'Acme' + '\\' + 'Corp' + ',' + ' Product' + '\n' + 'Launch' + ';' + ' Encore'
  const feed = buildCalendarFeed({ days: [day({ showName: raw })], flights: [], nowIso: NOW })
  const block = eventLines(feed, 'UID:showday-d1@theaudiosmith.com')
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
      day({ id: 'd2', showName: 'Clinique Rate Card Event', venue: 'Premium Ballroom', client: 'Clinique' }),
    ],
    flights: [flight(), flight({ id: 'f2', flightNo: 'DL456' })],
    nowIso: NOW,
  })
  assert.ok(!feed.includes('$'), 'no dollar sign should ever appear in a schedule-only feed')
  assert.ok(!feed.toLowerCase().includes('cents'), 'no "cents" text should ever appear in a schedule-only feed')
})
