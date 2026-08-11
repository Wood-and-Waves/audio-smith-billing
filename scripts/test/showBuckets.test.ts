import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeShowLines, mergeLines, type ShowRates } from '../../lib/showBuckets.ts'
import type { ShowRuleset, ShowDayLike } from '../../lib/payroll.ts'

const RATES: ShowRates = {
  day_rate_cents: 78000,        // Streamline
  travel_rate_cents: 39000,
  pm_rate_cents: 7800,
  ot_rate_cents: 10636,         // 780 / 11 * 1.5
  dt_rate_cents: 14182,
  meal_penalty_cents: 0,
}

const RULES: ShowRuleset = {
  overtime_after_hours: 11, double_time_enabled: false, double_time_after_hours: 14,
  meal_penalty_enabled: false, meal_penalty_grace_hours: 6,
  minimum_meal_break_enabled: true, minimum_meal_break_minutes: 60,
  meal_break_deduction_cap: 60, short_turn_penalty_enabled: false,
  short_turn_rest_hours: 10, continuous_time_enabled: false,
}

// 13:00Z to 23:00Z is 10 hours — under Streamline's 11-hour threshold, so a
// plain day rate with no overtime.
const showDay = (id: string, date: string): ShowDayLike => ({
  id, date, day_type: 'show', pay_as_half_day: false,
  punches: [
    { punch_type: 'start', punched_at: `${date}T13:00:00Z` },
    { punch_type: 'end', punched_at: `${date}T23:00:00Z` },
  ],
})

const travelDay = (id: string, date: string): ShowDayLike => ({
  id, date, day_type: 'travel', pay_as_half_day: false, punches: [],
})

test('day rates, travel and overtime become invoice lines', () => {
  const days: ShowDayLike[] = [
    travelDay('t1', '2026-07-13'),
    showDay('s1', '2026-07-14'),
    showDay('s2', '2026-07-15'),
    travelDay('t2', '2026-07-16'),
  ]
  const lines = computeShowLines(days, RATES, RULES)

  assert.deepEqual(lines, [
    { description: 'Day Rate', qty_hundredths: 200, unit_price_cents: 78000 },
    { description: 'Travel Rate', qty_hundredths: 200, unit_price_cents: 39000 },
  ])
})

test('a long day produces an overtime line', () => {
  const long: ShowDayLike = {
    id: 'l1', date: '2026-07-14', day_type: 'show', pay_as_half_day: false,
    punches: [
      { punch_type: 'start', punched_at: '2026-07-14T13:00:00Z' },
      { punch_type: 'end', punched_at: '2026-07-15T02:00:00Z' },   // 13 hours
    ],
  }
  const lines = computeShowLines([long], RATES, RULES)
  assert.deepEqual(lines, [
    { description: 'Day Rate', qty_hundredths: 100, unit_price_cents: 78000 },
    { description: 'Overtime', qty_hundredths: 200, unit_price_cents: 10636 },
  ])
})

test('PM hours bill actual time with no day-rate minimum', () => {
  const pm: ShowDayLike = {
    id: 'p1', date: '2026-07-10', day_type: 'pm', pay_as_half_day: false,
    punches: [
      { punch_type: 'start', punched_at: '2026-07-10T14:00:00Z' },
      { punch_type: 'end', punched_at: '2026-07-10T18:00:00Z' },   // 4 hours
    ],
  }
  const lines = computeShowLines([pm], RATES, RULES)
  assert.deepEqual(lines, [
    { description: 'PM Hours', qty_hundredths: 400, unit_price_cents: 7800 },
  ])
})

test('zero buckets produce no lines', () => {
  assert.deepEqual(computeShowLines([], RATES, RULES), [])
})

test('a bucket that rounds to zero hundredths produces no line', () => {
  // PM hours directly return the output of calculateNetHours, which can be
  // fractional. A very short PM day may produce hours that round to less than
  // 0.005 (which is 0.5 hundredths, rounded down to 0). The guard must test
  // the rounded quantity, not the pre-rounded float.
  //
  // With a 3ms punch difference:
  // - netSeconds = 0.003
  // - netMinutes = Math.round(0.003 / 60) = 0
  // - pmHours returns 0 / 60 = 0 (no line expected)
  //
  // Verify the invariant: no line ever has qty_hundredths: 0
  const minimalPM: ShowDayLike = {
    id: 'p_min', date: '2026-07-10', day_type: 'pm', pay_as_half_day: false,
    punches: [
      { punch_type: 'start', punched_at: '2026-07-10T14:00:00.000Z' },
      { punch_type: 'end', punched_at: '2026-07-10T14:00:00.003Z' },   // 3ms
    ],
  }
  const lines = computeShowLines([minimalPM], RATES, RULES)

  // No lines should be produced for a 3ms PM day
  assert.deepEqual(lines, [])

  // Verify the invariant across all returned lines: qty_hundredths > 0
  for (const line of lines) {
    assert(line.qty_hundredths > 0, `Line "${line.description}" has qty_hundredths: ${line.qty_hundredths}`)
  }
})

test('lines from several shows combine by bucket', () => {
  const mk = (id: string, date: string): ShowDayLike => ({
    id, date, day_type: 'show', pay_as_half_day: false,
    punches: [
      { punch_type: 'start', punched_at: `${date}T13:00:00Z` },
      { punch_type: 'end', punched_at: `${date}T23:00:00Z` },
    ],
  })
  const a = computeShowLines([mk('a', '2026-07-01')], RATES, RULES)
  const b = computeShowLines([mk('b', '2026-07-08')], RATES, RULES)

  assert.deepEqual(mergeLines([a, b]), [
    { description: 'Day Rate', qty_hundredths: 200, unit_price_cents: 78000 },
  ])
})

test('the same description at different prices does not merge', () => {
  const cheap: ShowRates = { ...RATES, day_rate_cents: 60000 }
  const mk = (id: string, date: string): ShowDayLike => ({
    id, date, day_type: 'show', pay_as_half_day: false,
    punches: [
      { punch_type: 'start', punched_at: `${date}T13:00:00Z` },
      { punch_type: 'end', punched_at: `${date}T23:00:00Z` },
    ],
  })
  const merged = mergeLines([
    computeShowLines([mk('a', '2026-07-01')], RATES, RULES),
    computeShowLines([mk('b', '2026-07-08')], cheap, RULES),
  ])
  assert.equal(merged.length, 2)
  assert.deepEqual(merged.map((l) => l.unit_price_cents).sort((x, y) => x - y), [60000, 78000])
})
