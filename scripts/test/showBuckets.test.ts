import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeShowLines, mergeLines, type ShowRates, type BucketLine } from '../../lib/showBuckets.ts'
import { lineTotal, overtimeRateFrom } from '../../lib/money.ts'
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
  id, date, pay_as_half_day: false, travel_in: false, travel_out: false,
  punches: [
    { punch_type: 'start', punched_at: `${date}T13:00:00Z` },
    { punch_type: 'end', punched_at: `${date}T23:00:00Z` },
  ],
})

// One leg per travel-only day: 'in' sets travel_in, 'out' sets travel_out.
const travelDay = (id: string, date: string, leg: 'in' | 'out' = 'in'): ShowDayLike => ({
  id, date, pay_as_half_day: false,
  travel_in: leg === 'in', travel_out: leg === 'out',
  punches: [],
})

test('day rates, travel and overtime become invoice lines', () => {
  const days: ShowDayLike[] = [
    travelDay('t1', '2026-07-13', 'in'),
    showDay('s1', '2026-07-14'),
    showDay('s2', '2026-07-15'),
    travelDay('t2', '2026-07-16', 'out'),
  ]
  const lines = computeShowLines(days, [], RATES, RULES)

  assert.deepEqual(lines, [
    { description: 'Day Rate', qty_hundredths: 200, unit_price_cents: 78000 },
    { description: 'Travel Rate', qty_hundredths: 200, unit_price_cents: 39000 },
  ])
})

test('a long day produces an overtime line', () => {
  const long: ShowDayLike = {
    id: 'l1', date: '2026-07-14', pay_as_half_day: false, travel_in: false, travel_out: false,
    punches: [
      { punch_type: 'start', punched_at: '2026-07-14T13:00:00Z' },
      { punch_type: 'end', punched_at: '2026-07-15T02:00:00Z' },   // 13 hours
    ],
  }
  const lines = computeShowLines([long], [], RATES, RULES)
  assert.deepEqual(lines, [
    { description: 'Day Rate', qty_hundredths: 100, unit_price_cents: 78000 },
    { description: 'Overtime', qty_hundredths: 200, unit_price_cents: 10636 },
  ])
})

test('zero buckets produce no lines', () => {
  assert.deepEqual(computeShowLines([], [], RATES, RULES), [])
})

test('lines from several shows combine by bucket', () => {
  const mk = (id: string, date: string): ShowDayLike => ({
    id, date, pay_as_half_day: false, travel_in: false, travel_out: false,
    punches: [
      { punch_type: 'start', punched_at: `${date}T13:00:00Z` },
      { punch_type: 'end', punched_at: `${date}T23:00:00Z` },
    ],
  })
  const a = computeShowLines([mk('a', '2026-07-01')], [], RATES, RULES)
  const b = computeShowLines([mk('b', '2026-07-08')], [], RATES, RULES)

  assert.deepEqual(mergeLines([a, b]), [
    { description: 'Day Rate', qty_hundredths: 200, unit_price_cents: 78000 },
  ])
})

// Streamline rate card with the short-turnaround penalty on: rest under 10
// hours between yesterday's out punch and today's in punch bills the whole
// day at double time instead of a day rate.
const STA_RULES: ShowRuleset = {
  ...RULES,
  short_turn_penalty_enabled: true,
  short_turn_rest_hours: 10,
}

test('a short-turnaround day bills no day rate and double time with the guarantee, not both', () => {
  const day1: ShowDayLike = {
    id: 'd1', date: '2026-07-14', pay_as_half_day: false, travel_in: false, travel_out: false,
    punches: [
      { punch_type: 'start', punched_at: '2026-07-14T13:00:00Z' },
      { punch_type: 'end', punched_at: '2026-07-14T23:00:00Z' },     // 10h — plain day rate
    ],
  }
  // Only 6 hours of rest before this day's start (under the 10-hour minimum),
  // so day 2 is a short-turnaround day even though it's only worked 5 hours.
  const day2: ShowDayLike = {
    id: 'd2', date: '2026-07-15', pay_as_half_day: false, travel_in: false, travel_out: false,
    punches: [
      { punch_type: 'start', punched_at: '2026-07-15T05:00:00Z' },   // 6h rest since day1's end
      { punch_type: 'end', punched_at: '2026-07-15T10:00:00Z' },     // 5h worked
    ],
  }

  const lines = computeShowLines([day1, day2], [], RATES, STA_RULES)

  // Day 2 must NOT add a second Day Rate line, and its 5 worked hours must
  // bill as 11 hours of Double Time — the overtime_after_hours guarantee —
  // not the bare 5 actually worked.
  assert.deepEqual(lines, [
    { description: 'Day Rate', qty_hundredths: 100, unit_price_cents: 78000 },
    { description: 'Double Time', qty_hundredths: 1100, unit_price_cents: 14182 },
  ])
})

test('the same two days bill normally when rest clears the short-turnaround threshold', () => {
  const day1: ShowDayLike = {
    id: 'd1', date: '2026-07-14', pay_as_half_day: false, travel_in: false, travel_out: false,
    punches: [
      { punch_type: 'start', punched_at: '2026-07-14T13:00:00Z' },
      { punch_type: 'end', punched_at: '2026-07-14T23:00:00Z' },     // 10h
    ],
  }
  // 11 hours of rest before this day's start — clears the 10-hour minimum,
  // so the short-turnaround rule must not fire.
  const day2: ShowDayLike = {
    id: 'd2', date: '2026-07-15', pay_as_half_day: false, travel_in: false, travel_out: false,
    punches: [
      { punch_type: 'start', punched_at: '2026-07-15T10:00:00Z' },   // 11h rest since day1's end
      { punch_type: 'end', punched_at: '2026-07-15T15:00:00Z' },     // 5h worked
    ],
  }

  const lines = computeShowLines([day1, day2], [], RATES, STA_RULES)

  // Two ordinary day-rate days, no double time.
  assert.deepEqual(lines, [
    { description: 'Day Rate', qty_hundredths: 200, unit_price_cents: 78000 },
  ])
})

test('the same description at different prices does not merge', () => {
  const cheap: ShowRates = { ...RATES, day_rate_cents: 60000 }
  const mk = (id: string, date: string): ShowDayLike => ({
    id, date, pay_as_half_day: false, travel_in: false, travel_out: false,
    punches: [
      { punch_type: 'start', punched_at: `${date}T13:00:00Z` },
      { punch_type: 'end', punched_at: `${date}T23:00:00Z` },
    ],
  })
  const merged = mergeLines([
    computeShowLines([mk('a', '2026-07-01')], [], RATES, RULES),
    computeShowLines([mk('b', '2026-07-08')], [], cheap, RULES),
  ])
  assert.equal(merged.length, 2)
  assert.deepEqual(merged.map((l) => l.unit_price_cents).sort((x, y) => x - y), [60000, 78000])
})

// The rounding disagreement this closes: a multi-show preview that sums each
// show's already-rounded lineTotal can disagree, by a cent, with the invoice
// billShows actually creates — because billShows merges quantities BEFORE
// rounding (mergeLines, then lineTotal), and round(a) + round(b) is not
// always round(a + b).
//
// Day rate $700, overtime after 9h: ot_rate_cents = overtimeRateFrom(70000, 9)
// = round((70000 / 9) * 1.5) = round(11666.666...) = 11667 cents. Two visits
// (church multi-visit billing, the scenario this merge exists for) each
// carry 0.08h (8 hundredths) of overtime at that rate:
//   per-show:  lineTotal(8, 11667)  = round(933.36)  = 933 each -> 933 + 933 = 1866
//   merged:    lineTotal(16, 11667) = round(1866.72) = 1867
test('merging two shows before rounding can bill a different total than summing each show\'s rounded total', () => {
  const otRate = overtimeRateFrom(70000, 9)
  assert.equal(otRate, 11667)

  const showA: BucketLine[] = [{ description: 'Overtime', qty_hundredths: 8, unit_price_cents: otRate }]
  const showB: BucketLine[] = [{ description: 'Overtime', qty_hundredths: 8, unit_price_cents: otRate }]

  // What a preview must NOT do: sum each show's own already-rounded total.
  const summedRoundedTotals =
    lineTotal(showA[0].qty_hundredths, showA[0].unit_price_cents) +
    lineTotal(showB[0].qty_hundredths, showB[0].unit_price_cents)
  assert.equal(summedRoundedTotals, 1866)

  // What billShows actually does, and what the fixed preview must match:
  // merge quantities first, then round once.
  const merged = mergeLines([showA, showB])
  assert.deepEqual(merged, [{ description: 'Overtime', qty_hundredths: 16, unit_price_cents: otRate }])

  const invoiceTotal = merged.reduce((sum, l) => sum + lineTotal(l.qty_hundredths, l.unit_price_cents), 0)
  assert.equal(invoiceTotal, 1867)

  // They disagree by exactly the one cent this fix closes.
  assert.notEqual(summedRoundedTotals, invoiceTotal)
})

test('travel legs bill per leg, not per day', () => {
  const legDay = (id: string, date: string, over: Partial<ShowDayLike> = {}): ShowDayLike => ({
    id, date, pay_as_half_day: false, travel_in: false, travel_out: false, punches: [], ...over,
  })
  // A trip: fly in, work two days, fly home. Two legs regardless of day count.
  const days = [
    legDay('a', '2026-07-13', { travel_in: true }),
    legDay('b', '2026-07-14', { punches: [
      { punch_type: 'start', punched_at: '2026-07-14T13:00:00Z' },
      { punch_type: 'end',   punched_at: '2026-07-14T23:00:00Z' }] }),
    legDay('c', '2026-07-15', { punches: [
      { punch_type: 'start', punched_at: '2026-07-15T13:00:00Z' },
      { punch_type: 'end',   punched_at: '2026-07-15T23:00:00Z' }] }),
    legDay('d', '2026-07-16', { travel_out: true }),
  ]
  assert.deepEqual(computeShowLines(days, [], RATES, RULES), [
    { description: 'Day Rate', qty_hundredths: 200, unit_price_cents: 78000 },
    { description: 'Travel Rate', qty_hundredths: 200, unit_price_cents: 39000 },
  ])
})

test('a day flown in AND worked bills the leg and the full day rate', () => {
  // Invoice #384's shape: fly in, work a long day, fly home.
  const day: ShowDayLike = {
    id: 'x', date: '2026-07-14', pay_as_half_day: false,
    travel_in: true, travel_out: true,
    punches: [
      { punch_type: 'start', punched_at: '2026-07-14T13:00:00Z' },
      { punch_type: 'end',   punched_at: '2026-07-15T02:00:00Z' }],  // 13 hours
  }
  assert.deepEqual(computeShowLines([day], [], RATES, RULES), [
    { description: 'Day Rate', qty_hundredths: 100, unit_price_cents: 78000 },
    { description: 'Travel Rate', qty_hundredths: 200, unit_price_cents: 39000 },
    { description: 'Overtime', qty_hundredths: 200, unit_price_cents: 10636 },
  ])
})

test('PM minutes sum then round UP to the next whole hour, once', () => {
  const pm = (minutes: number) => ({ minutes })
  // Four 30-minute sessions are exactly 2 hours and bill 2 — NOT 4, which is
  // what rounding each session separately would produce.
  assert.deepEqual(computeShowLines([], [pm(30), pm(60), pm(30)], RATES, RULES), [
    { description: 'PM Hours', qty_hundredths: 200, unit_price_cents: 7800 },
  ])
  // 2.5 hours bills 3.
  assert.deepEqual(computeShowLines([], [pm(30), pm(60), pm(60)], RATES, RULES), [
    { description: 'PM Hours', qty_hundredths: 300, unit_price_cents: 7800 },
  ])
  // A single 15-minute session still bills a whole hour.
  assert.deepEqual(computeShowLines([], [pm(15)], RATES, RULES), [
    { description: 'PM Hours', qty_hundredths: 100, unit_price_cents: 7800 },
  ])
  assert.deepEqual(computeShowLines([], [], RATES, RULES), [])
})

// The zero-quantity invariant. `push()` drops any line whose quantity rounds
// to zero, so a "Day Rate x 0 @ $780.00" can never reach a client. Today no
// input can produce one — every quantity is either an integer counter or an
// integer hour count minus a numeric(4,1) threshold, so the smallest positive
// value is 0.1, far above the 0.005 rounding floor. That makes this a guard on
// a DB column's decimal scale rather than on code, which is exactly why it is
// asserted here: widen ot_after_hours past one decimal and this fails loudly
// instead of printing a zero line on an invoice.
test('no line ever carries a zero quantity', () => {
  const cases: BucketLine[][] = [
    computeShowLines([showDay('a', '2026-08-10')], [], RATES, RULES),
    computeShowLines([travelDay('b', '2026-08-11')], [], RATES, RULES),
    computeShowLines([showDay('c', '2026-08-12')], [{ minutes: 15 }], RATES, RULES),
    computeShowLines([], [{ minutes: 30 }], RATES, RULES),
  ]
  for (const lines of cases) {
    for (const l of lines) {
      assert.ok(l.qty_hundredths > 0, `${l.description} carries qty 0`)
    }
  }
})
