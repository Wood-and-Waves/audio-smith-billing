import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  calculateNetHours, paidNetHours, paidStraightTimeHours, paidOvertimeHours, paidDoubleTimeHours,
  isShortTurnaround, mealPenaltyCount, mealDeductionMinutes,
  type ShowRuleset, type ShowDayLike,
} from '../../lib/payroll.ts'

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

// --- A day punched in but never punched out -------------------------------
//
// The tablet app lets a tech punch in and walk away. hasBothEnds is the
// single gate that stops an unfinished day from billing as if it were a
// full one — this proves it holds across every hours function, not just one.

test('a start punch with no matching end punch bills nothing, on every measure', () => {
  const d = day({ start: '2026-08-10T13:00:00Z' })
  assert.equal(calculateNetHours(d, RULES), 0)
  assert.equal(paidNetHours(d, RULES), 0)
  assert.equal(paidStraightTimeHours(d, [d], RULES), 0)
  assert.equal(paidOvertimeHours(d, [d], RULES), 0)
  assert.equal(paidDoubleTimeHours(d, [d], RULES), 0)
  assert.equal(mealPenaltyCount(d, { ...RULES, meal_penalty_enabled: true }), 0)
})

// --- mealPenaltyCount -------------------------------------------------------
//
// "One penalty per stretch longer than the grace period without a break."
// Grace here is 5 hours — a real number: meal-penalty rules commonly require
// a break to start before the end of the 5th hour worked.

const MP_RULES: ShowRuleset = { ...RULES, meal_penalty_enabled: true, meal_penalty_grace_hours: 5 }

test('no meal break at all is fine, as long as the day is short enough', () => {
  const d = day({ start: '2026-08-10T13:00:00Z', end: '2026-08-10T16:00:00Z' })  // 3h, no break needed
  assert.equal(mealPenaltyCount(d, MP_RULES), 0)
})

test('working straight through the grace period with no break at all incurs one penalty', () => {
  const d = day({ start: '2026-08-10T13:00:00Z', end: '2026-08-10T19:00:00Z' })  // 6h, never broke
  assert.equal(mealPenaltyCount(d, MP_RULES), 1)
})

test('working exactly the grace period is not penalized — only going OVER counts', () => {
  const exact = day({ start: '2026-08-10T13:00:00Z', end: '2026-08-10T18:00:00Z' })  // exactly 5h
  const overByOneSecond = day({ start: '2026-08-10T13:00:00Z', end: '2026-08-10T18:00:01Z' })
  assert.equal(mealPenaltyCount(exact, MP_RULES), 0)
  assert.equal(mealPenaltyCount(overByOneSecond, MP_RULES), 1)
})

test('a meal break taken before the grace period expires clears the penalty', () => {
  // 4 hours to the break, a break, then 3.5 more hours — both stretches stay
  // under the 5-hour grace even though the whole shift is 8 hours.
  const d = day({
    start: '2026-08-10T13:00:00Z',
    meal_out: '2026-08-10T17:00:00Z',
    meal_in: '2026-08-10T17:30:00Z',
    end: '2026-08-10T21:00:00Z',
  })
  assert.equal(mealPenaltyCount(d, MP_RULES), 0)
})

test('two long stretches in one day, split by a break, incur two penalties', () => {
  // Both the pre-lunch and pre-dinner stretches run 6 hours — over grace
  // twice, so this is "several", not "one".
  const d = day({
    start: '2026-08-10T13:00:00Z',
    meal_out: '2026-08-10T19:00:00Z',    // 6h, over grace
    meal_in: '2026-08-10T19:30:00Z',
    meal2_out: '2026-08-11T01:30:00Z',   // 6h since meal_in, over grace again
    meal2_in: '2026-08-11T02:00:00Z',
    end: '2026-08-11T03:00:00Z',         // 1h since meal2_in, under grace
  })
  assert.equal(mealPenaltyCount(d, MP_RULES), 2)
})

test('a long final stretch after both meal breaks is never checked — the rule only walks two pairs', () => {
  // Found while pinning behaviour, not a fix: MEAL_PAIRS has exactly two
  // entries (meal, meal2), so once both are used the loop ends without ever
  // scoring the stretch from the second meal-in to the end punch. Here that
  // final stretch runs 9 hours — well over grace — and still adds nothing.
  const d = day({
    start: '2026-08-10T13:00:00Z',
    meal_out: '2026-08-10T15:00:00Z',    // 2h, under grace
    meal_in: '2026-08-10T15:30:00Z',
    meal2_out: '2026-08-10T17:30:00Z',   // 2h since meal_in, under grace
    meal2_in: '2026-08-10T18:00:00Z',
    end: '2026-08-11T03:00:00Z',         // 9h since meal2_in — unscored
  })
  assert.equal(mealPenaltyCount(d, MP_RULES), 0)
})

test('meal penalty never accrues when the rule is disabled, however long the stretch', () => {
  const d = day({ start: '2026-08-10T13:00:00Z', end: '2026-08-10T20:00:00Z' })  // 7h, no break
  assert.equal(mealPenaltyCount(d, RULES), 0)  // RULES: meal_penalty_enabled false
})

test('mealPenaltyCount needs a start punch to measure anything', () => {
  const d = day({ end: '2026-08-10T20:00:00Z' })  // no start recorded
  assert.equal(mealPenaltyCount(d, MP_RULES), 0)
})

// --- isShortTurnaround -------------------------------------------------------

const ST_RULES: ShowRuleset = { ...RULES, short_turn_penalty_enabled: true }  // rest threshold: 10h

test('rest exactly at the threshold is not a short turnaround — only UNDER counts', () => {
  const yesterday = day({ start: '2026-08-09T13:00:00Z', end: '2026-08-09T23:00:00Z' }, { id: 'y', date: '2026-08-09' })
  const today = day({ start: '2026-08-10T09:00:00Z' }, { id: 't', date: '2026-08-10' })  // exactly 10h rest
  assert.equal(isShortTurnaround(today, [yesterday, today], ST_RULES), false)
})

test('one second less rest tips it into a short turnaround', () => {
  const yesterday = day({ start: '2026-08-09T13:00:00Z', end: '2026-08-09T23:00:00Z' }, { id: 'y', date: '2026-08-09' })
  const today = day({ start: '2026-08-10T08:59:59Z' }, { id: 't', date: '2026-08-10' })  // 9h59m59s rest
  assert.equal(isShortTurnaround(today, [yesterday, today], ST_RULES), true)
})

test('with several earlier days, only rest since the most recent one counts', () => {
  // A Streamline run two days ago is ancient history by the time this day
  // starts; what matters is the tight turnaround since YESTERDAY.
  const twoDaysAgo = day({ start: '2026-08-08T13:00:00Z', end: '2026-08-08T15:00:00Z' }, { id: 'a', date: '2026-08-08' })
  const yesterday = day({ start: '2026-08-09T18:00:00Z', end: '2026-08-09T20:00:00Z' }, { id: 'b', date: '2026-08-09' })
  const today = day({ start: '2026-08-10T02:00:00Z' }, { id: 'c', date: '2026-08-10' })  // 6h since yesterday's end
  assert.equal(isShortTurnaround(today, [twoDaysAgo, yesterday, today], ST_RULES), true)
})

test('a previous day with no end punch cannot establish rest, so it does not trigger the rule', () => {
  const stillOpen = day({ start: '2026-08-09T08:00:00Z' }, { id: 'o', date: '2026-08-09' })  // never clocked out
  const today = day({ start: '2026-08-09T20:00:00Z' }, { id: 't', date: '2026-08-09' })
  assert.equal(isShortTurnaround(today, [stillOpen, today], ST_RULES), false)
})

test('the rule never fires when disabled, even for a very tight turnaround', () => {
  const yesterday = day({ start: '2026-08-09T13:00:00Z', end: '2026-08-09T23:00:00Z' }, { id: 'y', date: '2026-08-09' })
  const today = day({ start: '2026-08-10T01:00:00Z' }, { id: 't', date: '2026-08-10' })  // 2h rest
  assert.equal(isShortTurnaround(today, [yesterday, today], RULES), false)  // short_turn_penalty_enabled: false
})

test('a day with no start punch cannot be a short turnaround', () => {
  const today = day({ end: '2026-08-10T20:00:00Z' }, { id: 't', date: '2026-08-10' })
  assert.equal(isShortTurnaround(today, [today], ST_RULES), false)
})

test('nothing earlier means no short turnaround to detect', () => {
  const today = day({ start: '2026-08-10T09:00:00Z' }, { id: 't', date: '2026-08-10' })
  assert.equal(isShortTurnaround(today, [today], ST_RULES), false)
})

// --- paidDoubleTimeHours and the overtime cap that feeds it -----------------

const DT_RULES: ShowRuleset = { ...RULES, double_time_enabled: true, overtime_after_hours: 10, double_time_after_hours: 14 }

test('double time begins strictly after its threshold, not at it', () => {
  const d = day({ start: '2026-08-10T13:00:00Z', end: '2026-08-11T03:00:00Z' })  // 14h exactly
  assert.equal(paidDoubleTimeHours(d, [d], DT_RULES), 0)
  assert.equal(paidOvertimeHours(d, [d], DT_RULES), 4)  // 14 - 10, right at the cap but not past it
})

test('past the double-time threshold, overtime stops growing and the excess becomes double time', () => {
  const d = day({ start: '2026-08-10T13:00:00Z', end: '2026-08-11T04:00:00Z' })  // 15h
  const st = paidStraightTimeHours(d, [d], DT_RULES)
  const ot = paidOvertimeHours(d, [d], DT_RULES)
  const dt = paidDoubleTimeHours(d, [d], DT_RULES)
  assert.equal(ot, 4)   // capped at double_time_after_hours - overtime_after_hours (14-10), not the raw 5
  assert.equal(dt, 1)   // the one hour past 14 that the OT cap pushed out
  assert.equal(st + ot + dt, paidNetHours(d, DT_RULES))  // the day's hours are fully accounted for
})

test('double time never accrues when the rule is off, no matter how long the day runs', () => {
  const d = day({ start: '2026-08-10T13:00:00Z', end: '2026-08-11T09:00:00Z' })  // 20h
  const rules = { ...RULES, overtime_after_hours: 10 }  // double_time_enabled stays false
  assert.equal(paidDoubleTimeHours(d, [d], rules), 0)
  assert.equal(paidOvertimeHours(d, [d], rules), 10)  // uncapped: 20 - 10, no double-time ceiling to hit
})

test('a short-turnaround day\'s minimum-call guarantee can bill more double time than hours worked', () => {
  // lib/backupSnapshot.ts documents this exact relationship: a four-hour call
  // still guarantees the overtime threshold at double time, so DT can print
  // higher than the day's own paid net hours. That's deliberate, not a bug.
  const yesterday = day({ start: '2026-08-09T13:00:00Z', end: '2026-08-09T23:00:00Z' }, { id: 'y', date: '2026-08-09' })
  const today = day(
    { start: '2026-08-10T01:00:00Z', end: '2026-08-10T05:00:00Z' },  // 2h rest, 4h worked
    { id: 't', date: '2026-08-10' },
  )
  const stRules = { ...RULES, short_turn_penalty_enabled: true, short_turn_rest_hours: 10, overtime_after_hours: 10 }
  const net = paidNetHours(today, stRules)
  const dt = paidDoubleTimeHours(today, [yesterday, today], stRules)
  assert.equal(net, 4)                          // only 4 hours actually worked
  assert.equal(dt, 10)                          // max(net, overtime_after_hours) — the guarantee
  assert.ok(dt > net, 'the guarantee bills more DT than the day actually worked')
})

// --- paidNetHours ceiling rounding -------------------------------------------
//
// calculateNetHours rounds to the nearest MINUTE; paidNetHours then ceilings
// that to the next whole HOUR. The two roundings compound: thirty seconds is
// the line between a call that pays flat and one that tips a full extra hour.

test('a call landing on an exact whole hour is not bumped', () => {
  const d = day({ start: '2026-08-10T13:00:00Z', end: '2026-08-10T23:00:00Z' })  // exactly 10h
  assert.equal(paidNetHours(d, RULES), 10)
})

test('one minute over a whole hour ceilings the whole day up a full hour', () => {
  const under = day({ start: '2026-08-10T13:00:00Z', end: '2026-08-10T23:00:29Z' })  // 10h00m29s
  const over = day({ start: '2026-08-10T13:00:00Z', end: '2026-08-10T23:00:31Z' })   // 10h00m31s
  // 29s rounds DOWN to the whole minute (10:00), so no hour is added.
  assert.equal(paidNetHours(under, RULES), 10)
  // 31s rounds UP to the next minute (10:01), and THAT ceilings to 11.
  assert.equal(paidNetHours(over, RULES), 11)
})

// --- The meal-deduction cap ---------------------------------------------------

test('a meal break that runs long deducts only up to the cap, not the full time away', () => {
  const capRules: ShowRuleset = { ...RULES, minimum_meal_break_enabled: true, minimum_meal_break_minutes: 20, meal_break_deduction_cap: 60 }
  const d = day({
    start: '2026-08-10T13:00:00Z',
    meal_out: '2026-08-10T17:00:00Z',
    meal_in: '2026-08-10T18:30:00Z',   // 90 minutes away — half again the cap
    end: '2026-08-10T22:30:00Z',
  })
  assert.equal(mealDeductionMinutes(d, capRules), 60)   // capped, not the actual 90
  assert.equal(calculateNetHours(d, capRules), 8.5)     // 9.5h gross - 1h capped deduction
})

test('the cap applies per break, so two long breaks in one day can deduct twice the cap', () => {
  // Not a bug: meal_break_deduction_cap limits what ONE break removes. A day
  // with two meal periods legitimately takes two capped deductions, which is
  // exactly the situation this test pins.
  const capRules: ShowRuleset = { ...RULES, minimum_meal_break_enabled: true, minimum_meal_break_minutes: 20, meal_break_deduction_cap: 60 }
  const d = day({
    start: '2026-08-10T13:00:00Z',
    meal_out: '2026-08-10T15:00:00Z',
    meal_in: '2026-08-10T16:30:00Z',    // 90 min, capped to 60
    meal2_out: '2026-08-10T20:30:00Z',
    meal2_in: '2026-08-10T22:00:00Z',   // another 90 min, also capped to 60
    end: '2026-08-10T23:00:00Z',
  })
  assert.equal(mealDeductionMinutes(d, capRules), 120)
})
