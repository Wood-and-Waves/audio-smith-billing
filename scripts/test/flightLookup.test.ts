// AeroDataBox has no key yet (see lib/flightLookup.ts's header), so these
// fixtures are the only thing pinning the parser's contract until a real
// call can be made. legFixture models one realistic leg the way the
// provider's docs describe it; every test that needs a gap builds its own
// departure/arrival object rather than mutating the fixture's nested shape.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseAeroDataBox, normalizeFlightNo, legChoiceLabel } from '../../lib/flightLookup.ts'

const legFixture = (over: Partial<Record<string, unknown>> = {}): Record<string, unknown> => ({
  departure: {
    airport: { iata: 'ORD', timeZone: 'America/Chicago' },
    scheduledTime: { utc: '2026-09-12 14:30Z', local: '2026-09-12 09:30-05:00' },
  },
  arrival: {
    airport: { iata: 'LAX', timeZone: 'America/Los_Angeles' },
    scheduledTime: { utc: '2026-09-12 17:00Z', local: '2026-09-12 10:00-07:00' },
  },
  ...over,
})

test('a happy single leg parses every field', () => {
  const result = parseAeroDataBox([legFixture()])
  assert.deepEqual(result, {
    candidates: [{
      depAirport: 'ORD', arrAirport: 'LAX',
      depAt: '2026-09-12T14:30:00Z', arrAt: '2026-09-12T17:00:00Z',
      depTz: 'America/Chicago', arrTz: 'America/Los_Angeles',
    }],
  })
})

test('multiple legs come back in the same order', () => {
  const second = legFixture({
    departure: { airport: { iata: 'LAX', timeZone: 'America/Los_Angeles' }, scheduledTime: { utc: '2026-09-13 09:00Z' } },
    arrival: { airport: { iata: 'ORD', timeZone: 'America/Chicago' }, scheduledTime: { utc: '2026-09-13 15:00Z' } },
  })
  const result = parseAeroDataBox([legFixture(), second])
  assert.equal('candidates' in result, true)
  if (!('candidates' in result)) return
  assert.equal(result.candidates.length, 2)
  assert.deepEqual([result.candidates[0].depAirport, result.candidates[0].arrAirport], ['ORD', 'LAX'])
  assert.deepEqual([result.candidates[1].depAirport, result.candidates[1].arrAirport], ['LAX', 'ORD'])
})

test('missing airport and timezone fields become nulls but the leg still counts', () => {
  const result = parseAeroDataBox([
    legFixture({
      departure: { scheduledTime: { utc: '2026-09-12 14:30Z' } }, // no airport at all
      arrival: { airport: { iata: 'LAX' }, scheduledTime: { utc: '2026-09-12 17:00Z' } }, // no timeZone
    }),
  ])
  assert.deepEqual(result, {
    candidates: [{
      depAirport: null, arrAirport: 'LAX',
      depAt: '2026-09-12T14:30:00Z', arrAt: '2026-09-12T17:00:00Z',
      depTz: null, arrTz: null,
    }],
  })
})

test('an empty array is a no-flight error, not an empty candidate list', () => {
  const result = parseAeroDataBox([])
  assert.deepEqual(result, { error: 'No flight found for that number and date.' })
})

test('a bare object instead of an array is a no-flight error', () => {
  const result = parseAeroDataBox({ legs: [legFixture()] })
  assert.deepEqual(result, { error: 'No flight found for that number and date.' })
})

test('a garbage string never throws — it is a no-flight error', () => {
  const result = parseAeroDataBox('garbage')
  assert.deepEqual(result, { error: 'No flight found for that number and date.' })
})

test("a leg with extra unknown fields parses fine — the parser reads only what it knows", () => {
  const result = parseAeroDataBox([
    {
      ...legFixture(),
      aircraft: { model: '737 MAX 8', reg: 'N12345' },
      codeshareStatus: 'IsOperator',
      departure: {
        airport: { iata: 'ORD', timeZone: 'America/Chicago', municipalityName: 'Chicago', extra: { nested: true } },
        scheduledTime: { utc: '2026-09-12 14:30Z', local: '2026-09-12 09:30-05:00' },
        terminal: '3', gate: 'B12',
      },
      arrival: {
        airport: { iata: 'LAX', timeZone: 'America/Los_Angeles' },
        scheduledTime: { utc: '2026-09-12 17:00Z', local: '2026-09-12 10:00-07:00' },
        quality: ['Basic', 'Live'],
      },
    },
  ])
  assert.deepEqual(result, {
    candidates: [{
      depAirport: 'ORD', arrAirport: 'LAX',
      depAt: '2026-09-12T14:30:00Z', arrAt: '2026-09-12T17:00:00Z',
      depTz: 'America/Chicago', arrTz: 'America/Los_Angeles',
    }],
  })
})

test('the provider\'s "YYYY-MM-DD HH:MMZ" format converts to a real ISO instant', () => {
  const result = parseAeroDataBox([
    legFixture({
      departure: { scheduledTime: { utc: '2026-01-05 03:07Z' } },
      arrival: { scheduledTime: { utc: '2026-12-31 23:59Z' } },
    }),
  ])
  assert.equal('candidates' in result, true)
  if (!('candidates' in result)) return
  assert.deepEqual([result.candidates[0].depAt, result.candidates[0].arrAt], [
    '2026-01-05T03:07:00Z', '2026-12-31T23:59:00Z',
  ])
})

test('normalizeFlightNo uppercases and strips spaces', () => {
  assert.equal(normalizeFlightNo('aa 1234'), 'AA1234')
})

test('normalizeFlightNo rejects a string shorter than two characters', () => {
  assert.equal(normalizeFlightNo('x'), null)
})

test('normalizeFlightNo rejects punctuation, including slash-injection-shaped input', () => {
  assert.equal(normalizeFlightNo('AA/12'), null)
})

// legChoiceLabel — the line Dan reads when one flight number flies twice on
// one date. Every field on a CandidateLeg is independently nullable, so the
// degraded shapes matter as much as the happy one.

const legOf = (over: Partial<Parameters<typeof legChoiceLabel>[0]> = {}) => ({
  depAirport: 'ORD', arrAirport: 'LAX',
  depAt: '2026-08-28T14:30:00Z', arrAt: '2026-08-28T17:00:00Z',
  depTz: 'America/Chicago', arrTz: 'America/Los_Angeles',
  ...over,
})

test('legChoiceLabel reads each airport in its OWN local time, never one zone', () => {
  // 14:30Z is 9:30 AM in Chicago; 17:00Z is 10:00 AM in Los Angeles. Both
  // are morning local times even though the flight crosses two zones —
  // converting either one to the other's zone is the bug this pins.
  assert.deepEqual(legChoiceLabel(legOf()), {
    route: 'ORD → LAX',
    when: '9:30 AM Central → 10:00 AM Pacific',
  })
})

test('legChoiceLabel tells two same-numbered legs apart by time', () => {
  const morning = legChoiceLabel(legOf())
  const evening = legChoiceLabel(legOf({ depAt: '2026-08-29T01:15:00Z', arrAt: '2026-08-29T03:45:00Z' }))
  assert.notEqual(morning.when, evening.when)
  assert.equal(evening.when, '8:15 PM Central → 8:45 PM Pacific')
})

test('legChoiceLabel omits the zone label when the provider gave no zone', () => {
  // CalendarMonth's FlightTime rule: a bare time is honest, a guessed zone
  // label is not. The time still falls back to Chicago for the conversion.
  assert.equal(legChoiceLabel(legOf({ depTz: null, arrTz: null })).when, '9:30 AM → 12:00 PM')
})

test('legChoiceLabel degrades a missing airport to a dash, not "null"', () => {
  assert.equal(legChoiceLabel(legOf({ arrAirport: null })).route, 'ORD → —')
})

test('legChoiceLabel says so plainly when a leg carries no times at all', () => {
  assert.deepEqual(legChoiceLabel(legOf({ depAt: null, arrAt: null })), {
    route: 'ORD → LAX',
    when: 'No times given',
  })
})

test('legChoiceLabel still shows an arrival-only leg what it has', () => {
  assert.equal(legChoiceLabel(legOf({ depAt: null })).when, 'arrives 10:00 AM Pacific')
})

test('legChoiceLabel shows a departure-only leg without a trailing arrow', () => {
  assert.equal(legChoiceLabel(legOf({ arrAt: null })).when, '9:30 AM Central')
})
