import { test } from 'node:test'
import assert from 'node:assert/strict'
import { calculateNetHours, paidOvertimeHours, type ShowRuleset, type ShowDayLike }
  from '../../lib/payroll.ts'

const RULES: ShowRuleset = {
  overtime_after_hours: 10,
  double_time_enabled: false,
  double_time_after_hours: 12,
  meal_penalty_enabled: false,
  meal_penalty_grace_hours: 6,
  minimum_meal_break_enabled: true,
  minimum_meal_break_minutes: 60,
  meal_break_deduction_cap: 60,
  short_turn_penalty_enabled: false,
  short_turn_rest_hours: 10,
  continuous_time_enabled: false,
}

const day = (punches: Record<string, string>, over: Partial<ShowDayLike> = {}): ShowDayLike => ({
  id: 'd1',
  date: '2026-08-10',
  pay_as_half_day: false,
  travel_in: false,
  travel_out: false,
  punches: Object.entries(punches).map(([punch_type, punched_at]) => ({ punch_type, punched_at })),
  ...over,
})

test('net hours deducts a qualifying meal break', () => {
  const d = day({
    start: '2026-08-10T13:00:00Z',      // 8am Chicago
    meal_out: '2026-08-10T18:00:00Z',
    meal_in: '2026-08-10T19:00:00Z',    // 60 minute break
    end: '2026-08-11T00:00:00Z',        // 7pm Chicago
  })
  assert.equal(calculateNetHours(d, RULES), 10)  // 11 gross - 1 meal
})

test('a break under the minimum is not deducted', () => {
  const d = day({
    start: '2026-08-10T13:00:00Z',
    meal_out: '2026-08-10T18:00:00Z',
    meal_in: '2026-08-10T18:30:00Z',    // 30 minutes, under the 60 minimum
    end: '2026-08-11T00:00:00Z',
  })
  assert.equal(calculateNetHours(d, RULES), 11)
})

test('overtime is hours past the threshold', () => {
  const d = day({ start: '2026-08-10T13:00:00Z', end: '2026-08-11T01:00:00Z' })  // 12h
  assert.equal(paidOvertimeHours(d, [], RULES), 2)
})
