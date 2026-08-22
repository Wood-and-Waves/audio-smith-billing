// Wall-clock time in a named zone, to and from an instant.
//
// The case that matters: a show in Orlando, billed from Chicago. Typing 9:00 AM
// has to mean 9:00 Eastern — the time Dan walked in — not 9:00 Central.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  wallToInstant, instantToWall, nearest15, friendlyTime, elapsedLabel,
} from '../../lib/zonedTime.ts'

test('a wall time is anchored to the show zone, not the machine zone', () => {
  // 29 Aug is EDT, UTC-4. 9:00 Eastern is 13:00 UTC.
  assert.equal(
    wallToInstant('2026-08-29', '09:00', 'America/New_York'),
    '2026-08-29T13:00:00.000Z',
  )
  // The same wall time in Chicago (CDT, UTC-5) is a DIFFERENT instant. If these
  // two ever agreed, the zone would be doing nothing.
  assert.equal(
    wallToInstant('2026-08-29', '09:00', 'America/Chicago'),
    '2026-08-29T14:00:00.000Z',
  )
})

test('the offset follows daylight saving, it is not a fixed number', () => {
  // January is EST, UTC-5 — an hour further from UTC than August's EDT.
  assert.equal(
    wallToInstant('2026-01-15', '09:00', 'America/New_York'),
    '2026-01-15T14:00:00.000Z',
  )
})

test('a time on the spring-forward day resolves without an hour of drift', () => {
  // 2026-03-08, US spring forward: 02:00 Central jumps to 03:00, so 02:30 does
  // not exist. It must land on a real instant that reads back sanely rather
  // than silently landing an hour off — this is what the second offset pass is
  // for, and a single-pass conversion gets it wrong.
  const iso = wallToInstant('2026-03-08', '02:30', 'America/Chicago')
  const back = instantToWall(iso, 'America/Chicago')
  assert.equal(back.date, '2026-03-08')
  assert.equal(back.time, '03:30', 'the skipped hour resolves forward, not backward')
})

test('an hour that happens twice resolves to its first occurrence', () => {
  // 2026-11-01, US fall back: 02:00 Central returns to 01:00, so 01:30 happens
  // twice. Taking the earlier one means a punch reads back as the time it was
  // typed, and it is the same rule every date library uses.
  const iso = wallToInstant('2026-11-01', '01:30', 'America/Chicago')
  assert.equal(iso, '2026-11-01T06:30:00.000Z', 'the CDT occurrence, not the CST one')
  assert.deepEqual(instantToWall(iso, 'America/Chicago'), { date: '2026-11-01', time: '01:30' })
})

test('an ordinary time on a DST-change day is unaffected', () => {
  // 9am on the same spring-forward day is well clear of the transition and must
  // survive it exactly — CDT, UTC-5.
  assert.equal(
    wallToInstant('2026-03-08', '09:00', 'America/Chicago'),
    '2026-03-08T14:00:00.000Z',
  )
})

test('every wall time round-trips through the instant unchanged', () => {
  // The property that actually matters: what Dan types is what he reads back.
  for (const tz of ['America/Chicago', 'America/New_York', 'America/Los_Angeles', 'UTC']) {
    for (const date of ['2026-01-15', '2026-06-21', '2026-08-29', '2026-11-01']) {
      for (const time of ['00:00', '06:45', '09:00', '13:30', '17:15', '23:45']) {
        const back = instantToWall(wallToInstant(date, time, tz), tz)
        assert.equal(`${back.date} ${back.time}`, `${date} ${time}`, `${tz} ${date} ${time}`)
      }
    }
  }
})

test('midnight and one minute to midnight stay on their own dates', () => {
  const tz = 'America/Chicago'
  assert.deepEqual(instantToWall(wallToInstant('2026-08-29', '00:00', tz), tz),
    { date: '2026-08-29', time: '00:00' })
  assert.deepEqual(instantToWall(wallToInstant('2026-08-29', '23:59', tz), tz),
    { date: '2026-08-29', time: '23:59' })
})

test('the prefill rounds to the nearest quarter hour', () => {
  assert.equal(nearest15('09:07'), '09:00', 'rounds down below the halfway point')
  assert.equal(nearest15('09:08'), '09:15', 'and up above it')
  assert.equal(nearest15('09:00'), '09:00', 'an exact quarter is left alone')
  assert.equal(nearest15('09:45'), '09:45')
  assert.equal(nearest15('13:52'), '13:45')
  assert.equal(nearest15('13:53'), '14:00', 'rounding up crosses the hour')
})

test('rounding near midnight wraps rather than inventing a 24th hour', () => {
  // 23:53 rounds to 24:00, which is not a time. It must come back as 00:00 —
  // a <input type="time"> silently rejects "24:00" and would clear the field.
  assert.equal(nearest15('23:53'), '00:00')
  assert.equal(nearest15('23:59'), '00:00')
  assert.equal(nearest15('00:07'), '00:00')
})

test('the readback is in the 12-hour form Dan reads on the floor', () => {
  assert.equal(friendlyTime('13:45'), '1:45 PM')
  assert.equal(friendlyTime('00:00'), '12:00 AM', 'midnight is 12 AM, not 0 AM')
  assert.equal(friendlyTime('12:00'), '12:00 PM', 'noon is 12 PM, not 0 PM')
  assert.equal(friendlyTime('09:05'), '9:05 AM')
  assert.equal(friendlyTime('23:59'), '11:59 PM')
})

// elapsedLabel — the figure that reconciles two airport-local times.

test('a flight across a timezone reads shorter than its clock times suggest', () => {
  // 8:30 AM Central -> 12:10 PM Eastern is 2h40m, not the 3h40m the clocks imply.
  const dep = wallToInstant('2026-09-12', '08:30', 'America/Chicago')
  const arr = wallToInstant('2026-09-12', '12:10', 'America/New_York')
  assert.equal(elapsedLabel(dep, arr), '2h 40m')
})

test('a whole number of hours drops the minutes', () => {
  assert.equal(elapsedLabel('2026-09-12T14:00:00Z', '2026-09-12T17:00:00Z'), '3h')
})

test('under an hour reads as minutes alone', () => {
  assert.equal(elapsedLabel('2026-09-12T14:00:00Z', '2026-09-12T14:45:00Z'), '45m')
})

test('arrival before departure returns null — a wrong duration is worse than none', () => {
  assert.equal(elapsedLabel('2026-09-12T17:00:00Z', '2026-09-12T14:00:00Z'), null)
})

test('an unparseable instant returns null rather than NaN', () => {
  assert.equal(elapsedLabel('not a date', '2026-09-12T14:00:00Z'), null)
  assert.equal(elapsedLabel('2026-09-12T14:00:00Z', ''), null)
})

test('equal instants are zero minutes, not null', () => {
  assert.equal(elapsedLabel('2026-09-12T14:00:00Z', '2026-09-12T14:00:00Z'), '0m')
})
