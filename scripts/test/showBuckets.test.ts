import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeShowLines, mergeLines, rulesetAndRatesFor,
  type ShowRates, type BucketLine, type FrozenShowColumns,
} from '../../lib/showBuckets.ts'
import { lineTotal, overtimeRateFrom } from '../../lib/money.ts'
import type { ShowRuleset, ShowDayLike } from '../../lib/payroll.ts'

const RATES: ShowRates = {
  day_rate_cents: 78000,        // Streamline
  travel_rate_cents: 39000,
  pm_rate_cents: 7800,
  ot_rate_cents: 10636,         // 780 / 11 * 1.5
  dt_rate_cents: 14182,
  meal_penalty_cents: 0,
  rate_card_name: null,
  bill_hourly: false,
  hourly_rate_cents: 0,
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

// This file has no DAYS constant — it builds days from showDay()/travelDay(),
// which already exist above. One travel leg in, two worked days.
const CARD_DAYS: ShowDayLike[] = [
  travelDay('t1', '2026-07-13', 'in'),
  showDay('s1', '2026-07-14'),
  showDay('s2', '2026-07-15'),
]

test('an unnamed card produces exactly the descriptions it always has', () => {
  // 105 historical invoices and every single-rate client depend on these exact
  // strings. This test exists to make that dependency explicit.
  const lines = computeShowLines(CARD_DAYS, [], { ...RATES, rate_card_name: null }, RULES)
  assert.deepEqual(
    lines.map((l) => l.description).sort(),
    ['Day Rate', 'Travel Rate'],
  )
})

test('a named card suffixes every line whose price comes from it', () => {
  // Decorating only the day rate would be worse than decorating none: a PM card
  // at $900 also carries a $135 overtime rate against the standard $117, so a
  // mixed invoice would show two "Overtime" lines at different prices with
  // nothing to tell them apart.
  const lines = computeShowLines(CARD_DAYS, [], { ...RATES, rate_card_name: 'PM' }, RULES)
  assert.deepEqual(
    lines.map((l) => l.description).sort(),
    ['Day Rate — PM', 'Travel Rate — PM'],
  )
})

test('a meal penalty is NOT decorated — its price is not the card\'s', () => {
  // Named explicitly because the default RATES fixture has meal_penalty_cents 0,
  // so a blanket "every line is decorated" assertion would pass without ever
  // exercising this.
  const rates = { ...RATES, rate_card_name: 'PM', meal_penalty_cents: 5000 }
  const rules = { ...RULES, meal_penalty_enabled: true, meal_penalty_grace_hours: 4 }
  const lines = computeShowLines(CARD_DAYS, [], rates, rules)
  const penalty = lines.find((l) => l.description.startsWith('Meal Penalty'))
  if (penalty) assert.equal(penalty.description, 'Meal Penalty', 'never suffixed')
})

test('two cards on one invoice stay separate and stay labelled', () => {
  const standard = computeShowLines(CARD_DAYS, [], { ...RATES, rate_card_name: null }, RULES)
  const pm = computeShowLines(CARD_DAYS, [], {
    ...RATES, rate_card_name: 'PM', day_rate_cents: 90000, ot_rate_cents: 13500,
  }, RULES)
  const merged = mergeLines([standard, pm])

  const dayLines = merged.filter((l) => l.description.startsWith('Day Rate'))
  assert.equal(dayLines.length, 2, 'two rates, two lines')
  assert.deepEqual(
    dayLines.map((l) => l.description).sort(),
    ['Day Rate', 'Day Rate — PM'],
  )
})

test('the suffix uses an em dash, never a Unicode minus', () => {
  // U+2212 renders as NOTHING in Helvetica — a deposit once printed as a charge
  // rather than a credit because of it. The em dash was glyph-probed and does
  // render in both Helvetica and Oswald.
  const joined = computeShowLines(CARD_DAYS, [], { ...RATES, rate_card_name: 'PM' }, RULES)
    .map((l) => l.description).join(' ')
  assert.ok(joined.includes('—'), 'em dash')
  assert.ok(!joined.includes('−'), 'never U+2212')
})

// --- The "Day Rate (half)" branch --------------------------------------------

test('a half day bills half the day rate, on its own line from full days', () => {
  const half: ShowDayLike = {
    id: 'h1', date: '2026-07-14', pay_as_half_day: true, travel_in: false, travel_out: false,
    punches: [
      { punch_type: 'start', punched_at: '2026-07-14T13:00:00Z' },
      { punch_type: 'end', punched_at: '2026-07-14T18:00:00Z' },   // 5h — half day, still worked
    ],
  }
  const full = showDay('f1', '2026-07-15')
  const lines = computeShowLines([half, full], [], RATES, RULES)
  assert.deepEqual(lines, [
    { description: 'Day Rate', qty_hundredths: 100, unit_price_cents: 78000 },
    { description: 'Day Rate (half)', qty_hundredths: 100, unit_price_cents: 39000 },  // 78000 / 2
  ])
})

test('a half day with no punches bills nothing, even though the flag is set', () => {
  // pay_as_half_day only matters once st > 0 — the half-day rate is earned by
  // working, same as the full rate.
  const d: ShowDayLike = {
    id: 'x', date: '2026-07-14', pay_as_half_day: true, travel_in: false, travel_out: false, punches: [],
  }
  assert.deepEqual(computeShowLines([d], [], RATES, RULES), [])
})

// --- The "Double Time" branch (the ordinary path, not the short-turnaround one) ---

test('a very long day bills overtime up to the DT threshold, then double time past it', () => {
  const DT_RULES: ShowRuleset = { ...RULES, double_time_enabled: true, double_time_after_hours: 14 }
  const long: ShowDayLike = {
    id: 'l1', date: '2026-07-14', pay_as_half_day: false, travel_in: false, travel_out: false,
    punches: [
      { punch_type: 'start', punched_at: '2026-07-14T13:00:00Z' },
      { punch_type: 'end', punched_at: '2026-07-15T05:00:00Z' },   // 16 hours
    ],
  }
  const lines = computeShowLines([long], [], RATES, DT_RULES)
  assert.deepEqual(lines, [
    { description: 'Day Rate', qty_hundredths: 100, unit_price_cents: 78000 },
    { description: 'Overtime', qty_hundredths: 300, unit_price_cents: 10636 },     // capped at 14 - 11
    { description: 'Double Time', qty_hundredths: 200, unit_price_cents: 14182 },  // 16 - 14
  ])
})

// --- The "Meal Penalty" branch -----------------------------------------------

test('a meal penalty becomes its own invoice line, priced flat per penalty', () => {
  const rates: ShowRates = { ...RATES, meal_penalty_cents: 5000 }
  const rules: ShowRuleset = { ...RULES, meal_penalty_enabled: true, meal_penalty_grace_hours: 5 }
  const longNoBreak: ShowDayLike = {
    id: 'p1', date: '2026-07-14', pay_as_half_day: false, travel_in: false, travel_out: false,
    punches: [
      { punch_type: 'start', punched_at: '2026-07-14T13:00:00Z' },
      { punch_type: 'end', punched_at: '2026-07-14T19:30:00Z' },   // 6.5h, no meal taken — past 5h grace
    ],
  }
  const lines = computeShowLines([longNoBreak], [], rates, rules)
  assert.deepEqual(lines, [
    { description: 'Day Rate', qty_hundredths: 100, unit_price_cents: 78000 },
    { description: 'Meal Penalty', qty_hundredths: 100, unit_price_cents: 5000 },
  ])
})

test('meal penalties from several days sum into one invoice line', () => {
  const rates: ShowRates = { ...RATES, meal_penalty_cents: 5000 }
  const rules: ShowRuleset = { ...RULES, meal_penalty_enabled: true, meal_penalty_grace_hours: 5 }
  const mk = (id: string, date: string): ShowDayLike => ({
    id, date, pay_as_half_day: false, travel_in: false, travel_out: false,
    punches: [
      { punch_type: 'start', punched_at: `${date}T13:00:00Z` },
      { punch_type: 'end', punched_at: `${date}T19:30:00Z` },   // 6.5h, no break, on each of two days
    ],
  })
  const lines = computeShowLines([mk('a', '2026-07-14'), mk('b', '2026-07-15')], [], rates, rules)
  const penalty = lines.find((l) => l.description === 'Meal Penalty')
  assert.deepEqual(penalty, { description: 'Meal Penalty', qty_hundredths: 200, unit_price_cents: 5000 })
})

// --- A show day with a start punch and no end punch --------------------------

test('a day with a start punch and no end punch bills nothing on the invoice', () => {
  // The tech forgot to punch out. hasBothEnds gates every hours function this
  // relies on, so an unfinished day contributes no line at all — not a
  // partial guess at what the day would have billed.
  const unfinished: ShowDayLike = {
    id: 'u1', date: '2026-07-14', pay_as_half_day: false, travel_in: false, travel_out: false,
    punches: [{ punch_type: 'start', punched_at: '2026-07-14T13:00:00Z' }],
  }
  assert.deepEqual(computeShowLines([unfinished], [], RATES, RULES), [])
})

test('a card name with stray whitespace does not reach the invoice', () => {
  // The DB constraint validates length(btrim(name)) > 0 but stores the value
  // verbatim, and shows.rate_card_name carries no constraint at all — so " PM"
  // would print "Day Rate —  PM" on a document an accountant reads closely.
  const padded = computeShowLines(CARD_DAYS, [], { ...RATES, rate_card_name: '  PM  ' }, RULES)
  assert.ok(padded.every((l) => !l.description.includes('  ')), 'no doubled space')
  assert.ok(padded.some((l) => l.description === 'Day Rate — PM'))

  // And a name that is nothing but whitespace decorates nothing at all.
  const blank = computeShowLines(CARD_DAYS, [], { ...RATES, rate_card_name: '   ' }, RULES)
  assert.ok(blank.every((l) => !l.description.includes('—')), 'blank is not a name')
})

// --- Hourly billing (sub-threshold days, for shows that pay by the hour) -----
//
// Church-style billing: a sub-10-hour day pays hours worked at an hourly rate;
// hit the threshold and it reverts to day-rate-plus-overtime, same as every
// other show. bill_hourly also disables the short-turnaround penalty — see
// lib/payroll.ts:108 — since "bill a whole short-notice day at double time"
// and "bill exactly the hours worked" are mutually exclusive policies.

const baseRates: ShowRates = { ...RATES }
const baseRules: ShowRuleset = { ...RULES }

// day $600, ot after 10 -> derived $60/hr.
const hourlyRates: ShowRates = { ...baseRates, day_rate_cents: 60000, bill_hourly: true, hourly_rate_cents: 6000 }
const hourlyRules: ShowRuleset = { ...baseRules, overtime_after_hours: 10, short_turn_penalty_enabled: false }

const sixHourDay: ShowDayLike = {
  id: 'six1', date: '2026-07-14', pay_as_half_day: false, travel_in: false, travel_out: false,
  punches: [
    { punch_type: 'start', punched_at: '2026-07-14T13:00:00Z' },
    { punch_type: 'end', punched_at: '2026-07-14T19:00:00Z' },     // 6 hours
  ],
}

const sixTwentyFiveDay: ShowDayLike = {
  id: 'six25', date: '2026-07-14', pay_as_half_day: false, travel_in: false, travel_out: false,
  punches: [
    { punch_type: 'start', punched_at: '2026-07-14T13:00:00Z' },
    { punch_type: 'end', punched_at: '2026-07-14T19:15:00Z' },     // 6.25 hours
  ],
}

// Exactly at the 10-hour threshold — the seamless crossover to a day rate.
const tenHourDay: ShowDayLike = showDay('ten1', '2026-07-14')

const elevenHourDay: ShowDayLike = {
  id: 'eleven1', date: '2026-07-15', pay_as_half_day: false, travel_in: false, travel_out: false,
  punches: [
    { punch_type: 'start', punched_at: '2026-07-15T13:00:00Z' },
    { punch_type: 'end', punched_at: '2026-07-16T00:00:00Z' },     // 11 hours
  ],
}

// Two sub-threshold days close enough together to trip short-turnaround IF it
// were enabled. shortDay2 starts 7 hours after shortDay1 ends — under
// RULES.short_turn_rest_hours (10).
const shortDay1: ShowDayLike = {
  id: 'short1', date: '2026-07-14', pay_as_half_day: false, travel_in: false, travel_out: false,
  punches: [
    { punch_type: 'start', punched_at: '2026-07-14T13:00:00Z' },
    { punch_type: 'end', punched_at: '2026-07-14T19:00:00Z' },     // 6 hours worked
  ],
}
const shortDay2: ShowDayLike = {
  id: 'short2', date: '2026-07-15', pay_as_half_day: false, travel_in: false, travel_out: false,
  punches: [
    { punch_type: 'start', punched_at: '2026-07-15T02:00:00Z' },   // 7h rest since shortDay1's end
    { punch_type: 'end', punched_at: '2026-07-15T07:00:00Z' },     // 5 hours worked
  ],
}

const frozenColumns: FrozenShowColumns = {
  day_rate_cents: 78000,
  travel_rate_cents: 39000,
  pm_rate_cents: 7800,
  ot_after_hours: 11,
  dt_after_hours: null,
  minimum_meal_break_minutes: 60,
  meal_break_deduction_cap: 60,
  meal_penalty_grace_hours: 6,
  meal_penalty_cents: 0,
  short_turn_rest_hours: 10,
  continuous_time_enabled: false,
  rate_card_name: null,
  bill_hourly: false,
}

test('a sub-threshold day bills hours × hourly, not a day rate', () => {
  // A 6-hour worked day. Expect one Hourly line, 6.00 × $60, no Day Rate line.
  const lines = computeShowLines([sixHourDay], [], hourlyRates, hourlyRules)
  const hourly = lines.find((l) => l.description.startsWith('Hourly'))
  assert.ok(hourly, 'an Hourly line exists')
  assert.equal(hourly.qty_hundredths, 600)      // 6.00 hours
  assert.equal(hourly.unit_price_cents, 6000)   // $60.00
  assert.equal(lines.find((l) => l.description.startsWith('Day Rate')), undefined)
})

test('6.25 hours rounds up to 7 (per-day ceiling, reused)', () => {
  const lines = computeShowLines([sixTwentyFiveDay], [], hourlyRates, hourlyRules)
  const hourly = lines.find((l) => l.description.startsWith('Hourly'))
  assert.equal(hourly.qty_hundredths, 700)      // 7.00 hours, not 6.25
})

test('a day at exactly the threshold bills the full day rate, no Hourly line', () => {
  // 10-hour day. The seamless crossover: $600 either way, but it bills as a day.
  const lines = computeShowLines([tenHourDay], [], hourlyRates, hourlyRules)
  assert.ok(lines.find((l) => l.description.startsWith('Day Rate')))
  assert.equal(lines.find((l) => l.description.startsWith('Hourly')), undefined)
  assert.equal(lines.find((l) => l.description.startsWith('Overtime')), undefined)
})

test('a day over the threshold bills day rate + overtime, no Hourly line', () => {
  const lines = computeShowLines([elevenHourDay], [], hourlyRates, hourlyRules)
  assert.ok(lines.find((l) => l.description.startsWith('Day Rate')))
  assert.ok(lines.find((l) => l.description.startsWith('Overtime')))
  assert.equal(lines.find((l) => l.description.startsWith('Hourly')), undefined)
})

test('a mixed show: hourly day and a long day on one invoice', () => {
  const lines = computeShowLines([sixHourDay, elevenHourDay], [], hourlyRates, hourlyRules)
  assert.equal(lines.find((l) => l.description.startsWith('Hourly')).qty_hundredths, 600)
  assert.equal(lines.find((l) => l.description.startsWith('Day Rate')).qty_hundredths, 100) // 1 day
  assert.ok(lines.find((l) => l.description.startsWith('Overtime')))
})

test('short-turnaround is inert in hourly mode: no double-time penalty', () => {
  // Two short days close enough to trip short-turnaround. With bill_hourly on,
  // short_turn_penalty_enabled is false, so each bills its own hours hourly —
  // no Double Time line.
  const lines = computeShowLines([shortDay1, shortDay2], [], hourlyRates, hourlyRules)
  assert.equal(lines.find((l) => l.description.startsWith('Double Time')), undefined)
  // Not just "no penalty" — the days must positively bill their own hours
  // hourly, or an implementation that silently dropped both days would also
  // pass the assertion above.
  const hourly = lines.find((l) => l.description.startsWith('Hourly'))
  assert.ok(hourly, 'the two short days bill as Hourly')
  assert.equal(hourly.qty_hundredths, 1100)
})

test('the Hourly line carries the rate card name like every other line', () => {
  const named = { ...hourlyRates, rate_card_name: 'Willow Creek' }
  const lines = computeShowLines([sixHourDay], [], named, { ...hourlyRules })
  assert.ok(lines.find((l) => l.description === 'Hourly — Willow Creek'))
})

test('bill_hourly OFF is byte-identical to a day-rate show (regression)', () => {
  // The load-bearing guard. A representative multi-day show billed with
  // bill_hourly:false must equal exactly what it bills today.
  const dayRateRates = { ...baseRates, day_rate_cents: 60000, bill_hourly: false, hourly_rate_cents: 6000 }
  const dayRateRules = { ...baseRules, overtime_after_hours: 10, short_turn_penalty_enabled: true }
  const lines = computeShowLines([sixHourDay, elevenHourDay], [], dayRateRates, dayRateRules)
  // 6-hour day bills a full day rate (unchanged behaviour), plus the 11-hour day.
  assert.equal(lines.find((l) => l.description.startsWith('Hourly')), undefined)
  assert.equal(lines.find((l) => l.description.startsWith('Day Rate')).qty_hundredths, 200) // 2 days
})

test('rulesetAndRatesFor derives hourly rate and flips short-turn off', () => {
  const { rates, rules } = rulesetAndRatesFor({ ...frozenColumns, day_rate_cents: 60000, ot_after_hours: 10, bill_hourly: true })
  assert.equal(rates.bill_hourly, true)
  assert.equal(rates.hourly_rate_cents, 6000)     // 60000 / 10
  assert.equal(rules.short_turn_penalty_enabled, false)
})

test('rulesetAndRatesFor with bill_hourly false keeps short-turn on', () => {
  const { rates, rules } = rulesetAndRatesFor({ ...frozenColumns, bill_hourly: false })
  assert.equal(rates.bill_hourly, false)
  assert.equal(rules.short_turn_penalty_enabled, true)
})
