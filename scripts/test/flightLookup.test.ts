// AeroDataBox has no key yet (see lib/flightLookup.ts's header), so these
// fixtures are the only thing pinning the parser's contract until a real
// call can be made. legFixture models one realistic leg the way the
// provider's docs describe it; every test that needs a gap builds its own
// departure/arrival object rather than mutating the fixture's nested shape.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseAeroDataBox, normalizeFlightNo } from '../../lib/flightLookup.ts'

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
