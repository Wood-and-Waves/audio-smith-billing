import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeShowLines, type ShowRates } from '../../lib/showBuckets.ts'
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
