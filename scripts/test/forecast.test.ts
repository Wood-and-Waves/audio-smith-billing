// The whole cash-flow model, pinned. Like ledgerMatch.test.ts, fixtures are
// built with Partial<T> overrides so every test states only what it's
// actually exercising.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  projectedShowCents, stateOf, computeOverheadCents, buildForecast, HORIZON_MONTHS, PM_FORECAST_HOURS,
} from '../../lib/forecast.ts'
import type {
  ForecastShow, ForecastShowDay, ForecastInvoice, ForecastClient, ForecastAssumptions,
} from '../../lib/forecast.ts'

// Dan's configured home state for every fixture below, matching the client()
// factory's implicit Chicago-area business — 'FL'-located shows are the
// out-of-state case throughout this file.
const HOME_STATE = 'IL'

const day = (over: Partial<ForecastShowDay> = {}): ForecastShowDay => ({
  date: '2026-09-01', travel_in: false, travel_out: false, pay_as_half_day: false, ...over,
})

const show = (over: Partial<ForecastShow> = {}): ForecastShow => ({
  id: 's1', name: 'Willow Creek', client_id: 'c1', status: 'open',
  day_rate_cents: 100000, travel_rate_cents: 20000,
  pm_rate_cents: 0, pm_role: false, location: null,
  days: [day()], ...over,
})

const invoice = (over: Partial<ForecastInvoice> = {}): ForecastInvoice => ({
  id: 'i1', number: 391, client_id: 'c1', status: 'sent', total_cents: 240000,
  sent_at: '2026-08-01T00:00:00Z', paid_at: null, linked: false, ...over,
})

const client = (over: Partial<ForecastClient> = {}): ForecastClient => ({
  id: 'c1', name: 'Clinique', terms_days: 30, ...over,
})

const assumptions = (over: Partial<ForecastAssumptions> = {}): ForecastAssumptions => ({
  takeHomeCents: 760000, overheadCents: 500000, taxRateBp: 1500, billingLagDays: 7, ...over,
})

// ---------------------------------------------------------------------------
// stateOf

test('stateOf parses the trailing two-letter state from a comma-separated location', () => {
  assert.equal(stateOf('Orlando, FL'), 'FL')
  assert.equal(stateOf('Chicago, IL '), 'IL')
  assert.equal(stateOf('South Barrington, IL'), 'IL')
})

test('stateOf uses only the LAST comma-separated token — extra commas do not confuse it', () => {
  assert.equal(stateOf('a, b, IL'), 'IL')
})

test('stateOf is case-insensitive on the way in — a lowercase abbreviation still resolves', () => {
  assert.equal(stateOf('orlando, fl'), 'FL')
})

test('stateOf returns null for null, empty, whitespace-only, or comma-less text', () => {
  assert.equal(stateOf(null), null)
  assert.equal(stateOf(''), null)
  assert.equal(stateOf('   '), null)
  assert.equal(stateOf('Somewhere'), null)
})

test('stateOf returns null when the trailing token is not exactly two A-Z letters '
  + '(a trailing period, or anything longer/shorter)', () => {
  assert.equal(stateOf('Orlando, FL.'), null)
  assert.equal(stateOf('Orlando, Florida'), null)
  assert.equal(stateOf('Orlando, F'), null)
  assert.equal(stateOf('Orlando, '), null)
})

// ---------------------------------------------------------------------------
// projectedShowCents — day/half-day arithmetic (unchanged doctrine)

test('a plain two-day show bills two full days, no travel', () => {
  const s = show({ days: [day({ date: '2026-09-01' }), day({ date: '2026-09-02' })] })
  assert.equal(projectedShowCents(s, HOME_STATE), 200000)
})

test('a half day bills at day_rate/2, rounded', () => {
  const s = show({
    day_rate_cents: 10001,
    days: [day({ date: '2026-09-01' }), day({ date: '2026-09-02', pay_as_half_day: true })],
  })
  // full day 10001 + half round(10001/2)=round(5000.5)=5001
  assert.equal(projectedShowCents(s, HOME_STATE), 10001 + 5001)
})

test('travel legs add on top of the day, one leg per flag', () => {
  const s = show({
    day_rate_cents: 100000, travel_rate_cents: 20000,
    days: [day({ date: '2026-09-01', travel_in: true, travel_out: true })],
  })
  assert.equal(projectedShowCents(s, HOME_STATE), 100000 + 2 * 20000)
})

test('zero rates project zero, no crash', () => {
  const s = show({ day_rate_cents: 0, travel_rate_cents: 0, days: [day({ travel_in: true })] })
  assert.equal(projectedShowCents(s, HOME_STATE), 0)
})

test('negative rates project zero rather than a negative amount', () => {
  const s = show({ day_rate_cents: -50000, travel_rate_cents: -1000, days: [day({ travel_in: true })] })
  assert.equal(projectedShowCents(s, HOME_STATE), 0)
})

test('an hourly show bills the same as a day-rate show off the same frozen day_rate_cents', () => {
  // The type carries no bill_hourly flag — an hourly show's rate is already
  // frozen into day_rate_cents by the time it reaches this lib, so the same
  // arithmetic applies with no special case.
  const dayRateShow = show({ day_rate_cents: 84500, travel_rate_cents: 15000, days: [day()] })
  const hourlyShapedShow = show({ id: 's2', day_rate_cents: 84500, travel_rate_cents: 15000, days: [day()] })
  assert.equal(projectedShowCents(hourlyShapedShow, HOME_STATE), projectedShowCents(dayRateShow, HOME_STATE))
})

test('a show with no scheduled days projects zero, no crash', () => {
  const s = show({ days: [] })
  assert.equal(projectedShowCents(s, HOME_STATE), 0)
})

// ---------------------------------------------------------------------------
// projectedShowCents — assumed travel legs (out-of-state rule + double-count guard)

test('a multi-day out-of-state show with no flagged legs assumes 2 legs at its own travel rate', () => {
  const s = show({
    day_rate_cents: 100000, travel_rate_cents: 25000, location: 'Orlando, FL',
    days: [day({ date: '2026-09-01' }), day({ date: '2026-09-02' })],
  })
  assert.equal(projectedShowCents(s, HOME_STATE), 2 * 100000 + 2 * 25000)
})

test('a one-day out-of-state show assumes NO travel legs — flown in and out the same day, '
  + 'not billed as travel days', () => {
  const s = show({
    day_rate_cents: 100000, travel_rate_cents: 25000, location: 'Orlando, FL',
    days: [day({ date: '2026-09-01' })],
  })
  assert.equal(projectedShowCents(s, HOME_STATE), 100000)
})

test('a one-day out-of-state show WITH flagged legs still uses the flags, not the (absent) '
  + 'assumption', () => {
  const s = show({
    day_rate_cents: 100000, travel_rate_cents: 25000, location: 'Orlando, FL',
    days: [day({ date: '2026-09-01', travel_in: true, travel_out: true })],
  })
  assert.equal(projectedShowCents(s, HOME_STATE), 100000 + 2 * 25000)
})

test('a same-state show assumes no travel legs', () => {
  const s = show({
    day_rate_cents: 100000, travel_rate_cents: 25000, location: 'Chicago, IL',
    days: [day({ date: '2026-09-01' })],
  })
  assert.equal(projectedShowCents(s, HOME_STATE), 100000)
})

test('a blank location assumes no travel legs', () => {
  const s = show({
    day_rate_cents: 100000, travel_rate_cents: 25000, location: '',
    days: [day({ date: '2026-09-01' })],
  })
  assert.equal(projectedShowCents(s, HOME_STATE), 100000)
})

test('flagged travel legs win over the (absent) out-of-state assumption — the double-count guard', () => {
  const s = show({
    day_rate_cents: 100000, travel_rate_cents: 25000, location: null,
    days: [day({ date: '2026-09-01', travel_in: true, travel_out: true })],
  })
  assert.equal(projectedShowCents(s, HOME_STATE), 100000 + 2 * 25000)
})

test('a show that is BOTH out-of-state AND has flagged travel legs uses the flags only — no double count', () => {
  const s = show({
    day_rate_cents: 100000, travel_rate_cents: 25000,
    location: 'Orlando, FL', // out of state — would independently justify 2 assumed legs
    days: [
      day({ date: '2026-09-01', travel_in: true }),
      day({ date: '2026-09-02', travel_in: true, travel_out: true }),
    ], // 3 flagged legs
  })
  // If the guard were broken this would double-count to 3 (flagged) + 2 (assumed) = 5 legs.
  assert.equal(projectedShowCents(s, HOME_STATE), 100000 * 2 + 3 * 25000)
})

// ---------------------------------------------------------------------------
// projectedShowCents — PM hours

test('PM adds exactly 4 x pm_rate_cents once, regardless of day count (2-day show)', () => {
  const s = show({
    day_rate_cents: 100000, travel_rate_cents: 0, pm_rate_cents: 5000, pm_role: true,
    days: [day({ date: '2026-09-01' }), day({ date: '2026-09-02' })],
  })
  assert.equal(projectedShowCents(s, HOME_STATE), 2 * 100000 + PM_FORECAST_HOURS * 5000)
})

test('PM stays a flat once-per-show fee across a much longer run (6 days)', () => {
  const s = show({
    day_rate_cents: 100000, travel_rate_cents: 0, pm_rate_cents: 5000, pm_role: true,
    days: [1, 2, 3, 4, 5, 6].map((n) => day({ date: `2026-09-0${n}` })),
  })
  assert.equal(projectedShowCents(s, HOME_STATE), 6 * 100000 + PM_FORECAST_HOURS * 5000)
})

test('pm_role false adds nothing even with a nonzero pm_rate_cents', () => {
  const s = show({
    day_rate_cents: 100000, travel_rate_cents: 0, pm_rate_cents: 5000, pm_role: false,
    days: [day({ date: '2026-09-01' })],
  })
  assert.equal(projectedShowCents(s, HOME_STATE), 100000)
})

test('pm_role true with a $0 pm_rate_cents adds nothing, and is not a "no rate" exclusion', () => {
  const s = show({
    id: 's1', name: 'Willow Creek', status: 'open',
    day_rate_cents: 100000, travel_rate_cents: 0, pm_rate_cents: 0, pm_role: true,
    days: [day({ date: '2026-09-01' })],
  })
  assert.equal(projectedShowCents(s, HOME_STATE), 100000)
  const result = buildForecast(baseInput({ shows: [s] }))
  assert.equal(result.notProjected.length, 0)
  assert.equal(result.inflows.length, 1)
})

test('a full example — 5-day out-of-state PM show — matches hand arithmetic', () => {
  const s = show({
    day_rate_cents: 100000, travel_rate_cents: 20000, pm_rate_cents: 5000, pm_role: true,
    location: 'Orlando, FL',
    days: [1, 2, 3, 4, 5].map((n) => day({ date: `2026-09-0${n}` })),
  })
  // day: 5 * 100000 = 500000
  // travel (assumed, out-of-state, no flags): 2 * 20000 = 40000
  // pm: 4 * 5000 = 20000
  // total = 560000
  assert.equal(projectedShowCents(s, HOME_STATE), 560000)
})

// ---------------------------------------------------------------------------
// computeOverheadCents

test('overhead is the mean of the three complete calendar months before today', () => {
  const txns = [
    { date: '2026-05-15', amount_cents: -100000, kind: 'expense' },
    { date: '2026-06-15', amount_cents: -200000, kind: 'expense' },
    { date: '2026-07-15', amount_cents: -300000, kind: 'expense' },
  ]
  // (100000+200000+300000)/3 = 200000
  assert.equal(computeOverheadCents(txns, '2026-08-21'), 200000)
})

test('overhead excludes owner_pay and transfer rows entirely', () => {
  const txns = [
    { date: '2026-07-10', amount_cents: -90000, kind: 'expense' },
    { date: '2026-07-11', amount_cents: -760000, kind: 'owner_pay' },
    { date: '2026-07-12', amount_cents: -500000, kind: 'transfer' },
    { date: '2026-07-13', amount_cents: 300000, kind: 'income' },
    // June and May filler rows: this test is about which KIND of row sums,
    // not the denominator, so these just keep both months "with history"
    // (see the denominator tests below) so the divisor stays 3.
    { date: '2026-06-01', amount_cents: 100, kind: 'income' },
    { date: '2026-05-01', amount_cents: 100, kind: 'income' },
  ]
  // only the expense row counts: 90000/3 = 30000
  assert.equal(computeOverheadCents(txns, '2026-08-21'), 30000)
})

test('overhead uses complete months only — the current month is excluded even late in the month', () => {
  const txns = [
    { date: '2026-08-01', amount_cents: -9000000, kind: 'expense' }, // current month, excluded
    { date: '2026-07-01', amount_cents: -60000, kind: 'expense' },
    // June and May filler rows: this test is about the CURRENT month being
    // excluded, not the denominator, so these just keep both months "with
    // history" (see the denominator tests below) so the divisor stays 3.
    { date: '2026-06-01', amount_cents: 100, kind: 'income' },
    { date: '2026-05-01', amount_cents: 100, kind: 'income' },
  ]
  assert.equal(computeOverheadCents(txns, '2026-08-21'), 20000)
})

test('a month with no ledger history at all is not averaged in — thin history does not understate overhead', () => {
  const txns = [
    { date: '2026-07-15', amount_cents: -100000, kind: 'expense' },
    { date: '2026-06-15', amount_cents: -200000, kind: 'expense' },
    // 2026-05 (three months back) has no transactions at all — no import,
    // no history — and must not be treated as a $0-spend month.
  ]
  // (100000+200000)/2 = 150000, not /3
  assert.equal(computeOverheadCents(txns, '2026-08-21'), 150000)
})

test('a month with transactions but no spending still counts as a real zero', () => {
  const txns = [
    { date: '2026-07-15', amount_cents: -100000, kind: 'expense' },
    { date: '2026-06-15', amount_cents: -200000, kind: 'expense' },
    // 2026-05 has ledger history (an income row) but no expense-kind row —
    // a genuinely frugal month, distinct from "no history". It still counts
    // in the denominator.
    { date: '2026-05-10', amount_cents: 500000, kind: 'income' },
  ]
  // (100000+200000+0)/3 = 100000, not /2
  assert.equal(computeOverheadCents(txns, '2026-08-21'), 100000)
})

test('no qualifying spend in the window computes zero', () => {
  assert.equal(computeOverheadCents([], '2026-08-21'), 0)
})

test('overhead spans a year boundary correctly', () => {
  const txns = [
    { date: '2025-11-15', amount_cents: -100000, kind: 'expense' },
    { date: '2025-12-15', amount_cents: -100000, kind: 'expense' },
    { date: '2026-01-15', amount_cents: -100000, kind: 'expense' },
  ]
  assert.equal(computeOverheadCents(txns, '2026-02-10'), 100000)
})

// ---------------------------------------------------------------------------
// buildForecast

const baseInput = (over: Partial<Parameters<typeof buildForecast>[0]> = {}) => ({
  today: '2026-08-21',
  startingBalanceCents: 1000000,
  homeState: HOME_STATE,
  shows: [] as ForecastShow[],
  invoices: [] as ForecastInvoice[],
  clients: [client()] as ForecastClient[],
  assumptions: assumptions(),
  ...over,
})

test('a draft invoice is counted once and its already-billed show is never double-counted', () => {
  const billedShow = show({ id: 's1', status: 'billed' })
  const draft = invoice({ id: 'i1', status: 'draft', total_cents: 240000, sent_at: null })
  const result = buildForecast(baseInput({ shows: [billedShow], invoices: [draft] }))
  assert.equal(result.inflows.length, 1)
  assert.equal(result.inflows[0].amountCents, 240000)
  assert.equal(result.inflows[0].label, '#391 Clinique')
})

test('an overdue sent invoice lands in the current month, flagged', () => {
  const overdue = invoice({ id: 'i1', status: 'sent', sent_at: '2026-01-01T00:00:00Z', total_cents: 100000 })
  const result = buildForecast(baseInput({ invoices: [overdue] }))
  assert.equal(result.inflows.length, 1)
  assert.equal(result.inflows[0].month, '2026-08')
  assert.equal(result.inflows[0].overdue, true)
})

test('a past unbilled show lands in the current month, flagged', () => {
  const pastShow = show({ id: 's1', status: 'open', days: [day({ date: '2026-01-05' })] })
  const result = buildForecast(baseInput({ shows: [pastShow] }))
  assert.equal(result.inflows.length, 1)
  assert.equal(result.inflows[0].month, '2026-08')
  assert.equal(result.inflows[0].overdue, true)
  assert.equal(result.inflows[0].label, 'Willow Creek (projected)')
})

test('surplus carries forward into the next month\'s balance rather than resetting', () => {
  // Income lands in month 1 only; overhead/draw drain steadily every month.
  // Month 2's balance must build off month 1's elevated total, not off
  // startingBalanceCents or zero.
  const bigInvoice = invoice({
    id: 'i1', status: 'sent', sent_at: '2026-08-14T00:00:00Z', total_cents: 5000000,
  })
  const result = buildForecast(baseInput({
    startingBalanceCents: 500000,
    invoices: [bigInvoice],
    assumptions: assumptions({ overheadCents: 100000, takeHomeCents: 100000, taxRateBp: 0, billingLagDays: 0 }),
  }))
  // client() terms_days=30 -> sent_at (Chicago date 2026-08-13)
  // + 30 days = 2026-09-12 -> month 2026-09 (index 1).
  // Month 0 (today 2026-08-21) is partial: August has 31 days, 11 remain
  // counting today -> fraction 11/31. overhead0 = round(100000*11/31) =
  // 35484; draw0 = same = 35484.
  assert.equal(result.months[0].endingBalanceCents, 429032) // 500000 + 0 income - 35484 - 35484
  assert.equal(result.months[1].endingBalanceCents, 5229032) // 429032 + 5000000 - 100000 - 100000 (full month)
  assert.equal(result.months[2].endingBalanceCents, 5029032) // 5229032 + 0 income - 200000, carried forward
  assert.ok(result.months.every((m) => m.covered))
})

test('the first uncovered month is identified exactly, and coveredThrough is the month before it', () => {
  const result = buildForecast(baseInput({
    startingBalanceCents: 250000,
    assumptions: assumptions({ overheadCents: 100000, takeHomeCents: 100000, taxRateBp: 0 }),
  }))
  // no income at all. Month 0 (today 2026-08-21) is partial: 11 of August's
  // 31 days remain counting today, so overhead/draw are pro-rated to 11/31
  // -> round(100000*11/31) = 35484 each, not the full 100000.
  // 250000 -> 179032 (covered) -> -20968 (uncovered, full month now)
  assert.equal(result.months[0].endingBalanceCents, 179032)
  assert.equal(result.months[0].covered, true)
  assert.equal(result.months[1].endingBalanceCents, -20968)
  assert.equal(result.months[1].covered, false)
  assert.equal(result.months.length, 2)
  assert.equal(result.coveredThrough, '2026-08')
})

test('coveredThrough is null when the very first month is already uncovered', () => {
  const result = buildForecast(baseInput({
    startingBalanceCents: 0,
    assumptions: assumptions({ overheadCents: 500000, takeHomeCents: 500000, taxRateBp: 0 }),
  }))
  assert.equal(result.months.length, 1)
  assert.equal(result.months[0].covered, false)
  assert.equal(result.coveredThrough, null)
})

test('a balance of exactly zero counts as covered, and the walk continues', () => {
  // Overhead/take-home chosen as multiples of 31 so month 0's 11/31
  // pro-ration (today is 2026-08-21, 11 of August's 31 days remain) divides
  // evenly, keeping this test's arithmetic exact rather than rounded.
  const result = buildForecast(baseInput({
    startingBalanceCents: 22000, // 11000 overhead0 + 11000 draw0
    assumptions: assumptions({ overheadCents: 31000, takeHomeCents: 31000, taxRateBp: 0 }),
  }))
  assert.equal(result.months[0].endingBalanceCents, 0)
  assert.equal(result.months[0].covered, true)
  // walk continues past month 0 since it wasn't uncovered
  assert.ok(result.months.length > 1)
})

test('income comfortably exceeding costs for the whole horizon reports beyond-horizon', () => {
  const result = buildForecast(baseInput({
    startingBalanceCents: 100000000,
    assumptions: assumptions({ overheadCents: 100000, takeHomeCents: 100000, taxRateBp: 0 }),
  }))
  assert.equal(result.beyondHorizon, true)
  assert.equal(result.months.length, HORIZON_MONTHS)
  assert.equal(result.coveredThrough, result.months[HORIZON_MONTHS - 1].month)
  assert.ok(result.months.every((m) => m.covered))
})

// ---------------------------------------------------------------------------
// Month 0 pro-ration (M2). Month 0's income is already only "what's left to
// land" — every inflow is dated to a future expected landing date, so
// nothing before today ever accrues into it. Overhead and the draw must be
// pro-rated the same way, or month 0 charges a full month's costs against a
// starting balance that already covered its share of both up through
// yesterday.

test('a mid-month start pro-rates both overhead and the draw by the days remaining, today included', () => {
  // today (baseInput) is 2026-08-21. August has 31 days; 11 remain counting
  // today itself (21st through 31st). Overhead/take-home chosen as multiples
  // of 31 so 11/31 divides evenly.
  const result = buildForecast(baseInput({
    assumptions: assumptions({ overheadCents: 310000, takeHomeCents: 620000, taxRateBp: 0 }),
  }))
  assert.equal(result.months[0].overheadCents, 110000) // 310000 * 11/31
  assert.equal(result.months[0].drawCents, 220000) // 620000 * 11/31
})

test('a forecast run on the 1st of the month charges the full month\'s overhead and draw', () => {
  const result = buildForecast(baseInput({
    today: '2026-08-01',
    assumptions: assumptions({ overheadCents: 500000, takeHomeCents: 760000, taxRateBp: 0 }),
  }))
  // All 31 days remain, today included -> fraction is 31/31 = 1.
  assert.equal(result.months[0].overheadCents, 500000)
  assert.equal(result.months[0].drawCents, 760000)
})

test('a forecast run on the last day of the month charges roughly one day\'s worth', () => {
  const result = buildForecast(baseInput({
    today: '2026-08-31',
    assumptions: assumptions({ overheadCents: 310000, takeHomeCents: 620000, taxRateBp: 0 }),
  }))
  // Only today itself remains -> fraction is 1/31.
  assert.equal(result.months[0].overheadCents, 10000) // 310000 / 31
  assert.equal(result.months[0].drawCents, 20000) // 620000 / 31
})

test('bookedThrough is the latest month of booked WORK, never a lag-shifted cash-landing date', () => {
  const empty = buildForecast(baseInput())
  assert.equal(empty.bookedThrough, null)
  assert.equal(empty.inflows.length, 0)

  const nearInvoice = invoice({
    id: 'i1', status: 'sent', sent_at: '2026-08-14T00:00:00Z', total_cents: 100000,
  })
  const farShow = show({
    id: 's1', status: 'open',
    days: [day({ date: '2027-01-10' })],
  })
  const result = buildForecast(baseInput({ invoices: [nearInvoice], shows: [farShow] }))
  // farShow's own last scheduled day is 2027-01-10 -> month 2027-01. Unlike
  // its cash-landing inflow (last day + billingLag(7) + terms(30) =
  // 2027-02-16, month 2027-02), bookedThrough is never lag-shifted — it's
  // the month Dan's calendar actually goes quiet, not the month the money
  // from that quiet calendar finally lands.
  assert.equal(result.bookedThrough, '2027-01')
})

test('bookedThrough: a draft invoice dates to today\'s month — it has no sent_at yet to date it by', () => {
  const draft = invoice({ id: 'i1', status: 'draft', sent_at: null, total_cents: 50000 })
  const result = buildForecast(baseInput({ invoices: [draft] }))
  assert.equal(result.bookedThrough, '2026-08') // today (baseInput) is 2026-08-21
})

test('bookedThrough: a sent invoice dates to the Chicago-calendar month it was actually sent, '
  + 'not the month its cash is expected', () => {
  const sent = invoice({ id: 'i1', status: 'sent', sent_at: '2026-05-01T00:00:00Z', total_cents: 50000 })
  const result = buildForecast(baseInput({ invoices: [sent] }))
  // sent_at midnight UTC May 1 reads back as April 30, 7pm in Chicago (CDT)
  // -> month 2026-04. Its cash (terms 30) lands 2026-05-31, a different
  // month entirely, which bookedThrough must not report.
  assert.equal(result.bookedThrough, '2026-04')
})

test('bookedThrough counts only open shows and unpaid (draft/sent) invoices — '
  + 'billed shows and paid/void invoices contribute nothing', () => {
  const billed = show({ id: 's1', status: 'billed', days: [day({ date: '2027-06-01' })] })
  const paidInv = invoice({
    id: 'i1', status: 'paid', sent_at: '2027-06-01T00:00:00Z', paid_at: '2027-06-15', linked: true,
  })
  const voidInv = invoice({ id: 'i2', status: 'void', sent_at: '2027-06-01T00:00:00Z' })
  const result = buildForecast(baseInput({ shows: [billed], invoices: [paidInv, voidInv] }))
  assert.equal(result.bookedThrough, null)
  assert.equal(result.inflows.length, 0)
})

test('m1 — a late-evening-Chicago sent_at is bucketed by the Chicago calendar day, not the UTC one', () => {
  // Sent 8pm Chicago on Aug 31 (CDT, UTC-5) is 2026-09-01T01:00:00Z. A raw
  // .slice(0, 10) of that ISO string reads '2026-09-01' — a whole month
  // later than the invoice was actually sent, which used to push its
  // expected payment (and thus the inflow's month) a month late too.
  const lateInvoice = invoice({
    id: 'i1', status: 'sent', sent_at: '2026-09-01T01:00:00Z', total_cents: 100000,
  })
  const result = buildForecast(baseInput({
    invoices: [lateInvoice],
    clients: [client({ terms_days: 0 })],
    assumptions: assumptions({ billingLagDays: 0 }),
  }))
  assert.equal(result.inflows.length, 1)
  // Chicago date is 2026-08-31; +0 lag, +0 terms = 2026-08-31 -> month 2026-08.
  assert.equal(result.inflows[0].month, '2026-08')
})

test('inflows are sorted by month ascending, then label', () => {
  const invA = invoice({
    id: 'i1', number: 200, status: 'sent', sent_at: '2026-08-14T00:00:00Z', total_cents: 100000,
    client_id: 'c1',
  })
  const invB = invoice({
    id: 'i2', number: 100, status: 'sent', sent_at: '2026-08-14T00:00:00Z', total_cents: 100000,
    client_id: 'c1',
  })
  const result = buildForecast(baseInput({
    invoices: [invA, invB],
    assumptions: assumptions({ billingLagDays: 0 }),
  }))
  // both land the same month (same sent_at + same terms), so tie-break by label:
  // "#100 Clinique" < "#200 Clinique"
  assert.equal(result.inflows.length, 2)
  assert.deepEqual(result.inflows.map((f) => f.label), ['#100 Clinique', '#200 Clinique'])
})

test('a sent invoice with a null sent_at (should not happen) is dated like a draft rather than crashing', () => {
  const malformed = invoice({ id: 'i1', status: 'sent', sent_at: null, total_cents: 50000 })
  const result = buildForecast(baseInput({
    invoices: [malformed],
    assumptions: assumptions({ billingLagDays: 7 }),
  }))
  assert.equal(result.inflows.length, 1)
  // today (2026-08-21) + billingLag(7) + terms(30) = 2026-09-27
  assert.equal(result.inflows[0].month, '2026-09')
})

test('paid and void invoices are excluded from inflows entirely', () => {
  const paid = invoice({ id: 'i1', status: 'paid', total_cents: 100000, paid_at: '2026-08-01' })
  const void_ = invoice({ id: 'i2', status: 'void', total_cents: 200000 })
  const result = buildForecast(baseInput({ invoices: [paid, void_] }))
  assert.equal(result.inflows.length, 0)
})

test('a show with no scheduled days contributes no inflow and does not crash the walk', () => {
  const emptyShow = show({ id: 's1', status: 'open', days: [] })
  const result = buildForecast(baseInput({ shows: [emptyShow] }))
  assert.equal(result.inflows.length, 0)
  assert.equal(result.bookedThrough, null)
})

// ---------------------------------------------------------------------------
// notProjected — a show the projection can't price or date used to vanish
// with no trace (no inflow, no mention anywhere on the page). It's listed
// instead, with a reason.

test('a show with no scheduled days is listed in notProjected instead of vanishing silently', () => {
  const emptyShow = show({ id: 's1', name: 'Willow Creek', status: 'open', days: [] })
  const result = buildForecast(baseInput({ shows: [emptyShow] }))
  assert.equal(result.inflows.length, 0)
  assert.deepEqual(result.notProjected, [{ showId: 's1', name: 'Willow Creek', reason: 'no days' }])
  assert.equal(result.showProjections.length, 0) // nothing to date the breakdown from either
})

test('a show with days but a zero projection (no rate card, no rates) is listed in notProjected '
  + 'instead of a silent $0 inflow', () => {
  const zeroRateShow = show({
    id: 's1', name: 'Willow Creek', status: 'open',
    day_rate_cents: 0, travel_rate_cents: 0, days: [day({ date: '2026-09-01' })],
  })
  const result = buildForecast(baseInput({ shows: [zeroRateShow] }))
  assert.equal(result.inflows.length, 0)
  assert.deepEqual(result.notProjected, [{ showId: 's1', name: 'Willow Creek', reason: 'no rate' }])
})

test('an empty forecast (no shows, no invoices) still walks the months on overhead/draw alone', () => {
  const result = buildForecast(baseInput({
    startingBalanceCents: 5000000,
    assumptions: assumptions({ overheadCents: 100000, takeHomeCents: 100000, taxRateBp: 0 }),
  }))
  assert.ok(result.months.length > 0)
  assert.equal(result.months[0].incomeCents, 0)
  assert.equal(result.showProjections.length, 0)
})

test('tax is computed on profit, never below zero, at the configured basis points', () => {
  const invA = invoice({
    id: 'i1', status: 'sent', sent_at: '2026-08-14T00:00:00Z', total_cents: 1000000,
    client_id: 'c1',
  })
  const result = buildForecast(baseInput({
    invoices: [invA],
    assumptions: assumptions({ overheadCents: 100000, takeHomeCents: 0, taxRateBp: 1500, billingLagDays: 0 }),
  }))
  // income lands in the month it's expected: sent_at 2026-08-14T00:00:00Z
  // reads as 2026-08-13 in Chicago, + terms 30 = 2026-09-12 -> month 2026-09
  const septMonth = result.months.find((m) => m.month === '2026-09')
  assert.ok(septMonth)
  assert.equal(septMonth!.incomeCents, 1000000)
  // tax = max(0, 1000000-100000) * 1500/10000 = 900000*0.15 = 135000
  assert.equal(septMonth!.taxCents, 135000)
})

test('tax never goes negative when overhead exceeds income', () => {
  const result = buildForecast(baseInput({
    assumptions: assumptions({ overheadCents: 500000, takeHomeCents: 0, taxRateBp: 1500 }),
  }))
  assert.equal(result.months[0].incomeCents, 0)
  assert.equal(result.months[0].taxCents, 0)
})

test('tax rounds a genuine .5-cent boundary up — Math.round\'s argument here is always >= 0 '
  + '(clamped by the max(0, ...) above), so this matches half-away-from-zero, not banker\'s rounding', () => {
  const invA = invoice({
    id: 'i1', status: 'sent', sent_at: '2026-08-14T00:00:00Z', total_cents: 1100010,
    client_id: 'c1',
  })
  const result = buildForecast(baseInput({
    invoices: [invA],
    assumptions: assumptions({ overheadCents: 100000, takeHomeCents: 0, taxRateBp: 1500, billingLagDays: 0 }),
  }))
  const septMonth = result.months.find((m) => m.month === '2026-09')
  assert.ok(septMonth)
  assert.equal(septMonth!.incomeCents, 1100010)
  // (1100010 - 100000) * 1500 / 10000 = 1000010 * 0.15 = 150001.5 exactly —
  // the pre-rounding product lands precisely on the .5-cent boundary.
  assert.equal(septMonth!.taxCents, 150002)
})

// ---------------------------------------------------------------------------
// Pay lag = terms_days, everywhere, always. No learning path remains: even a
// client with a rich history of settled, deposit-linked invoices projects
// off its plain terms_days now — the previous "learned median" machinery
// (and the 365-day window built to guard it) is gone entirely.

test('every client\'s pay lag is simply terms_days now — settled, deposit-linked history '
  + 'that would once have taught a learned median has no effect', () => {
  const settledInvoices = [
    // Under the old model these two would have taught a learned median of
    // 29.5 -> 30 days for this client, overriding its stated terms.
    invoice({ id: 'i1', status: 'paid', linked: true, sent_at: '2026-06-01T00:00:00Z', paid_at: '2026-06-28' }),
    invoice({ id: 'i2', status: 'paid', linked: true, sent_at: '2026-06-05T00:00:00Z', paid_at: '2026-07-07' }),
  ]
  const openInvoice = invoice({
    id: 'i3', status: 'sent', sent_at: '2026-08-14T00:00:00Z', total_cents: 100000, client_id: 'c1',
  })
  const result = buildForecast(baseInput({
    clients: [client({ id: 'c1', terms_days: 45 })],
    invoices: [...settledInvoices, openInvoice],
    assumptions: assumptions({ billingLagDays: 0 }),
  }))
  const inflow = result.inflows.find((f) => f.label === '#391 Clinique')
  assert.ok(inflow)
  // sent_at 2026-08-14T00:00:00Z reads 2026-08-13 in Chicago; +0 billing lag
  // + 45 terms (NOT the ~30-day learned median the old model would have
  // used) = 2026-09-27.
  assert.equal(inflow!.month, '2026-09')
})

test('an invoice for a client missing from the roster falls back to 30-day terms, not zero, '
  + 'and does not throw', () => {
  const orphan = invoice({
    id: 'i1', status: 'sent', sent_at: '2026-08-14T00:00:00Z', total_cents: 50000, client_id: 'ghost',
  })
  const result = buildForecast(baseInput({
    invoices: [orphan],
    assumptions: assumptions({ billingLagDays: 0 }),
  }))
  assert.equal(result.inflows.length, 1)
  // Chicago date 2026-08-13 + 0 billing lag + 30 fallback terms = 2026-09-12
  assert.equal(result.inflows[0].month, '2026-09')
})

// ---------------------------------------------------------------------------
// showProjections — the per-show breakdown the forecast screen lists.

test('showProjections reconciles exactly with inflows and orders by firstDay then name', () => {
  const showA = show({
    id: 's-a', name: 'Zephyr', client_id: 'c1',
    day_rate_cents: 100000, travel_rate_cents: 20000,
    location: 'Orlando, FL',
    days: [day({ date: '2026-09-05' }), day({ date: '2026-09-06' })],
  })
  const showB = show({
    id: 's-b', name: 'Alpha', client_id: 'c1',
    day_rate_cents: 50000, travel_rate_cents: 10000,
    days: [day({ date: '2026-09-01' })],
  })
  const result = buildForecast(baseInput({ shows: [showA, showB] }))

  assert.equal(result.showProjections.length, 2)
  // ordered by firstDay ascending: showB (09-01) before showA (09-05)
  assert.deepEqual(result.showProjections.map((p) => p.showId), ['s-b', 's-a'])

  for (const proj of result.showProjections) {
    const inflow = result.inflows.find((f) => f.label === `${proj.name} (projected)`)
    assert.ok(inflow)
    assert.equal(proj.totalCents, inflow!.amountCents)
    assert.equal(proj.landsMonth, inflow!.month)
  }

  const zephyr = result.showProjections.find((p) => p.showId === 's-a')!
  assert.equal(zephyr.dayCents, 200000)
  assert.equal(zephyr.travelCents, 40000)
  assert.equal(zephyr.travelAssumed, true)
  assert.equal(zephyr.totalCents, 240000)
  assert.equal(zephyr.firstDay, '2026-09-05')
  assert.equal(zephyr.lastDay, '2026-09-06')
})

test('travelAssumed is true only when legs came from the out-of-state rule, never from flags', () => {
  const outOfState = show({
    id: 's-out', name: 'OutOfState Show', client_id: 'c1',
    day_rate_cents: 100000, travel_rate_cents: 20000,
    location: 'Orlando, FL',
    days: [day({ date: '2026-09-01' }), day({ date: '2026-09-02' })], // >1 day so the assumption fires
  })
  const flagged = show({
    id: 's-flag', name: 'Flagged Show', client_id: 'c1',
    day_rate_cents: 100000, travel_rate_cents: 20000,
    location: 'Orlando, FL', // also out of state — the guard's whole point
    days: [day({ date: '2026-09-05', travel_in: true, travel_out: true })],
  })
  const result = buildForecast(baseInput({ shows: [outOfState, flagged] }))
  const outProj = result.showProjections.find((p) => p.showId === 's-out')!
  const flagProj = result.showProjections.find((p) => p.showId === 's-flag')!
  assert.equal(outProj.travelAssumed, true)
  assert.equal(flagProj.travelAssumed, false)
  assert.equal(flagProj.travelCents, 2 * 20000) // same total as the assumption, but sourced from flags
})

test('a zero-total show still appears in showProjections (as $0) even though it is excluded '
  + 'from inflows and listed in notProjected — nothing is invisible', () => {
  const zeroShow = show({
    id: 's1', name: 'Willow Creek', status: 'open',
    day_rate_cents: 0, travel_rate_cents: 0, pm_rate_cents: 0, pm_role: false,
    days: [day({ date: '2026-09-01' })],
  })
  const result = buildForecast(baseInput({ shows: [zeroShow] }))
  assert.equal(result.inflows.length, 0)
  assert.deepEqual(result.notProjected, [{ showId: 's1', name: 'Willow Creek', reason: 'no rate' }])
  assert.equal(result.showProjections.length, 1)
  assert.equal(result.showProjections[0].showId, 's1')
  assert.equal(result.showProjections[0].totalCents, 0)
})

test('a multi-day PM show contributes one showProjections row with pmCents counted once', () => {
  const pmShow = show({
    id: 's1', name: 'Big PM Show', client_id: 'c1',
    day_rate_cents: 100000, travel_rate_cents: 0, pm_rate_cents: 7500, pm_role: true,
    days: [1, 2, 3, 4].map((n) => day({ date: `2026-09-0${n}` })),
  })
  const result = buildForecast(baseInput({ shows: [pmShow] }))
  assert.equal(result.showProjections.length, 1)
  const proj = result.showProjections[0]
  assert.equal(proj.dayCents, 4 * 100000)
  assert.equal(proj.pmCents, PM_FORECAST_HOURS * 7500)
  assert.equal(proj.totalCents, 4 * 100000 + PM_FORECAST_HOURS * 7500)
})
