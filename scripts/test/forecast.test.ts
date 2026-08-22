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
  date: '2026-09-01', travel_in: false, travel_out: false, pay_as_half_day: false,
  travel_works: false, ...over,
})

const show = (over: Partial<ForecastShow> = {}): ForecastShow => ({
  id: 's1', name: 'Willow Creek', client_id: 'c1', status: 'open',
  day_rate_cents: 100000, travel_rate_cents: 20000,
  pm_rate_cents: 0, pm_role: false, location: null,
  days: [day()], ...over,
})

const invoice = (over: Partial<ForecastInvoice> = {}): ForecastInvoice => ({
  id: 'i1', number: 391, client_id: 'c1', status: 'sent', total_cents: 240000,
  sent_at: '2026-08-01T00:00:00Z', ...over,
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

test('a flagged travel day is a travel day, not also a work day — a day flagged both '
  + 'travel_in AND travel_out still counts as ONE travel day at ONE travel rate, never two', () => {
  const s = show({
    day_rate_cents: 100000, travel_rate_cents: 20000,
    days: [day({ date: '2026-09-01', travel_in: true, travel_out: true })],
  })
  // The day is entirely a travel day: no day-rate work happens on it at all.
  assert.equal(projectedShowCents(s, HOME_STATE), 20000)
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
// projectedShowCents — travel days are part of the scheduled block (out-of-
// state assumption + flagged days), never added on top of it. A travel day
// is no longer necessarily separate from a work day, though: a FLAGGED
// (never assumed) travel day that also has `travel_works` set is BOTH a
// travel day and a work day. So dayCount + travelDays is no longer a strict
// partition of the scheduled block — it equals the show's total scheduled
// days PLUS the number of worked travel days (zero when none are marked).

test('the new partition invariant: dayCount + travelDays equals days.length plus the number of '
  + 'worked travel days — the guard that would catch a day counted in neither bucket', () => {
  const s = show({
    day_rate_cents: 100000, travel_rate_cents: 25000,
    days: [
      day({ date: '2026-09-01', travel_in: true, travel_works: true }), // worked travel day
      day({ date: '2026-09-02' }), // plain work day
    ],
  })
  const result = buildForecast(baseInput({ shows: [s] }))
  const proj = result.showProjections[0]
  const workedTravelDays = s.days.filter((d) => (d.travel_in || d.travel_out) && d.travel_works).length
  assert.equal(proj.dayCount + proj.travelDays, s.days.length + workedTravelDays)
})

test('the same partition invariant holds at a different shape — a 5-day show with TWO worked '
  + 'travel days (both the first and last leg also worked), not just one', () => {
  const s = show({
    day_rate_cents: 100000, travel_rate_cents: 25000,
    days: [
      day({ date: '2026-09-01', travel_in: true, travel_works: true }), // worked travel day
      day({ date: '2026-09-02' }), // plain work day
      day({ date: '2026-09-03' }), // plain work day
      day({ date: '2026-09-04' }), // plain work day
      day({ date: '2026-09-05', travel_out: true, travel_works: true }), // worked travel day
    ],
  })
  const result = buildForecast(baseInput({ shows: [s] }))
  const proj = result.showProjections[0]
  const workedTravelDays = s.days.filter((d) => (d.travel_in || d.travel_out) && d.travel_works).length
  assert.equal(workedTravelDays, 2)
  assert.equal(proj.dayCount + proj.travelDays, s.days.length + workedTravelDays)
})

test('a 2-day out-of-state show with no flags is 2 travel days and ZERO work days — the '
  + 'literal, deliberate consequence of "first and last scheduled day are travel," not '
  + 'special-cased into a 3rd, worked day', () => {
  const s = show({
    day_rate_cents: 100000, travel_rate_cents: 25000, location: 'Orlando, FL',
    days: [day({ date: '2026-09-01' }), day({ date: '2026-09-02' })],
  })
  assert.equal(projectedShowCents(s, HOME_STATE), 2 * 25000)
  const result = buildForecast(baseInput({ shows: [s] }))
  const proj = result.showProjections[0]
  assert.equal(proj.dayCount, 0)
  assert.equal(proj.travelDays, 2)
  assert.equal(proj.travelAssumed, true)
  assert.equal(proj.dayCount + proj.travelDays, s.days.length)
})

test('a 3-day out-of-state show with no flags is 1 work day (the middle one) + 2 travel days '
  + '(first and last)', () => {
  const s = show({
    day_rate_cents: 100000, travel_rate_cents: 25000, location: 'Orlando, FL',
    days: [day({ date: '2026-09-01' }), day({ date: '2026-09-02' }), day({ date: '2026-09-03' })],
  })
  assert.equal(projectedShowCents(s, HOME_STATE), 100000 + 2 * 25000)
  const result = buildForecast(baseInput({ shows: [s] }))
  const proj = result.showProjections[0]
  assert.equal(proj.dayCount, 1)
  assert.equal(proj.travelDays, 2)
  assert.equal(proj.dayCount + proj.travelDays, s.days.length)
})

test('the owner\'s own 6-day example: 2 travel days + 4 working days, never 6 worked days '
  + 'with 2 travel legs added on top', () => {
  const s = show({
    day_rate_cents: 100000, travel_rate_cents: 25000, location: 'Orlando, FL',
    days: [1, 2, 3, 4, 5, 6].map((n) => day({ date: `2026-09-0${n}` })),
  })
  assert.equal(projectedShowCents(s, HOME_STATE), 4 * 100000 + 2 * 25000)
  const result = buildForecast(baseInput({ shows: [s] }))
  const proj = result.showProjections[0]
  assert.equal(proj.dayCount, 4)
  assert.equal(proj.travelDays, 2)
  assert.equal(proj.dayCount + proj.travelDays, s.days.length)
})

test('a real pinned example — 5-day out-of-state Bentonville show at $780/$390 day/travel '
  + 'rates projects $3,120 (3 work days + 2 travel days), not the old, overstated $4,680 '
  + '(5 work days plus 2 travel legs added on top)', () => {
  const s = show({
    day_rate_cents: 78000, travel_rate_cents: 39000, location: 'Bentonville, AR',
    days: [1, 2, 3, 4, 5].map((n) => day({ date: `2026-09-0${n}` })),
  })
  assert.equal(projectedShowCents(s, HOME_STATE), 312000) // $3,120.00
})

test('a one-day out-of-state show is 0 travel + 1 work day — flown in and out the same day, '
  + 'not billed as travel', () => {
  const s = show({
    day_rate_cents: 100000, travel_rate_cents: 25000, location: 'Orlando, FL',
    days: [day({ date: '2026-09-01' })],
  })
  assert.equal(projectedShowCents(s, HOME_STATE), 100000)
  const result = buildForecast(baseInput({ shows: [s] }))
  const proj = result.showProjections[0]
  assert.equal(proj.dayCount, 1)
  assert.equal(proj.travelDays, 0)
})

test('a one-day out-of-state show WITH a flagged travel day uses the flag, not the (absent) '
  + 'assumption — the flagged day is pure travel, not also a paid work day', () => {
  const s = show({
    day_rate_cents: 100000, travel_rate_cents: 25000, location: 'Orlando, FL',
    days: [day({ date: '2026-09-01', travel_in: true, travel_out: true })],
  })
  assert.equal(projectedShowCents(s, HOME_STATE), 25000)
})

test('a same-state show assumes no travel days', () => {
  const s = show({
    day_rate_cents: 100000, travel_rate_cents: 25000, location: 'Chicago, IL',
    days: [day({ date: '2026-09-01' })],
  })
  assert.equal(projectedShowCents(s, HOME_STATE), 100000)
})

test('a same-state multi-day show is all work, zero travel, even across several scheduled '
  + 'days — the out-of-state assumption never fires at all', () => {
  const s = show({
    day_rate_cents: 100000, travel_rate_cents: 25000, location: 'Chicago, IL',
    days: [day({ date: '2026-09-01' }), day({ date: '2026-09-02' }), day({ date: '2026-09-03' })],
  })
  assert.equal(projectedShowCents(s, HOME_STATE), 3 * 100000)
  const result = buildForecast(baseInput({ shows: [s] }))
  const proj = result.showProjections[0]
  assert.equal(proj.dayCount, 3)
  assert.equal(proj.travelDays, 0)
  assert.equal(proj.travelAssumed, false)
})

test('a blank location assumes no travel days', () => {
  const s = show({
    day_rate_cents: 100000, travel_rate_cents: 25000, location: '',
    days: [day({ date: '2026-09-01' })],
  })
  assert.equal(projectedShowCents(s, HOME_STATE), 100000)
})

test('flagged travel days are exactly the travel days and everything else is work — 4 days, '
  + 'first flagged travel_in, last flagged travel_out -> 2 work days + 2 travel days', () => {
  const s = show({
    day_rate_cents: 100000, travel_rate_cents: 25000,
    days: [
      day({ date: '2026-09-01', travel_in: true }),
      day({ date: '2026-09-02' }),
      day({ date: '2026-09-03' }),
      day({ date: '2026-09-04', travel_out: true }),
    ],
  })
  assert.equal(projectedShowCents(s, HOME_STATE), 2 * 100000 + 2 * 25000)
  const result = buildForecast(baseInput({ shows: [s] }))
  const proj = result.showProjections[0]
  assert.equal(proj.dayCount, 2)
  assert.equal(proj.travelDays, 2)
  assert.equal(proj.travelAssumed, false)
  assert.equal(proj.dayCount + proj.travelDays, s.days.length)
})

// ---------------------------------------------------------------------------
// projectedShowCents — homeState normalization (F1). `stateOf` already
// trims+uppercases the show's own location; homeState must get the same
// treatment before the comparison, or a home state stored lowercase,
// padded, or missing would either invent phantom travel or, if empty,
// mark literally everything as "out of state."

test('a lowercase home state still matches an in-state multi-day show — no phantom travel days', () => {
  const s = show({
    day_rate_cents: 100000, travel_rate_cents: 25000, location: 'Chicago, IL',
    days: [day({ date: '2026-09-01' }), day({ date: '2026-09-02' })],
  })
  assert.equal(projectedShowCents(s, 'il'), 2 * 100000)
})

test('a whitespace-padded home state still matches an in-state multi-day show — no phantom travel days', () => {
  const s = show({
    day_rate_cents: 100000, travel_rate_cents: 25000, location: 'Chicago, IL',
    days: [day({ date: '2026-09-01' }), day({ date: '2026-09-02' })],
  })
  assert.equal(projectedShowCents(s, ' IL '), 2 * 100000)
})

test('an empty home state assumes no travel days on an in-state multi-day show', () => {
  const s = show({
    day_rate_cents: 100000, travel_rate_cents: 25000, location: 'Chicago, IL',
    days: [day({ date: '2026-09-01' }), day({ date: '2026-09-02' })],
  })
  assert.equal(projectedShowCents(s, ''), 2 * 100000)
})

test('an empty home state assumes no travel days on an out-of-state multi-day show either — '
  + 'an unusable home state can never justify assuming travel', () => {
  const s = show({
    day_rate_cents: 100000, travel_rate_cents: 25000, location: 'Orlando, FL',
    days: [day({ date: '2026-09-01' }), day({ date: '2026-09-02' })],
  })
  assert.equal(projectedShowCents(s, ''), 2 * 100000)
})

test('a flagged travel day wins over the (absent) out-of-state assumption — the double-count '
  + 'guard — and, being a travel day, is not also a paid work day', () => {
  const s = show({
    day_rate_cents: 100000, travel_rate_cents: 25000, location: null,
    days: [day({ date: '2026-09-01', travel_in: true, travel_out: true })],
  })
  assert.equal(projectedShowCents(s, HOME_STATE), 25000)
})

test('a show that is BOTH out-of-state AND has a flagged travel day uses the flag only — no '
  + 'double count, and the out-of-state assumption does not ALSO mark the last day as travel '
  + 'even though this 3-day show would otherwise qualify for it', () => {
  const s = show({
    day_rate_cents: 100000, travel_rate_cents: 25000,
    location: 'Orlando, FL', // out of state — would independently justify a 2-day assumption
    days: [
      day({ date: '2026-09-01', travel_in: true }), // flagged travel day
      day({ date: '2026-09-02' }), // plain work day
      day({ date: '2026-09-03' }), // plain work day — NOT travel, even though it's the last
    ],
  })
  // If the guard were broken, the out-of-state assumption would also mark 09-03 (the last
  // day) as travel, on top of the flagged 09-01, double-counting to 1 work + 2 travel.
  assert.equal(projectedShowCents(s, HOME_STATE), 2 * 100000 + 25000)
  const result = buildForecast(baseInput({ shows: [s] }))
  const proj = result.showProjections[0]
  assert.equal(proj.dayCount, 2)
  assert.equal(proj.travelDays, 1)
  assert.equal(proj.travelAssumed, false)
})

// ---------------------------------------------------------------------------
// projectedShowCents — travel_works: a travel day Dan explicitly marks as
// also worked. "Sometimes we travel and work the same day which would be
// more money." Only ever fires on a FLAGGED travel day — never on one that
// came from the out-of-state assumption, since the assumption only fires
// when nothing was marked at all, so nothing is known about whether it was
// worked.

test('a flagged travel day with travel_works also bills a full work day on top of the '
  + 'travel rate', () => {
  const s = show({
    day_rate_cents: 100000, travel_rate_cents: 20000,
    days: [day({ date: '2026-09-01', travel_in: true, travel_works: true })],
  })
  assert.equal(projectedShowCents(s, HOME_STATE), 100000 + 20000)
  const result = buildForecast(baseInput({ shows: [s] }))
  const proj = result.showProjections[0]
  assert.equal(proj.dayCount, 1)
  assert.equal(proj.travelDays, 1)
  assert.equal(proj.dayCents, 100000)
  assert.equal(proj.travelCents, 20000)
})

test('a flagged travel day WITHOUT travel_works still bills travel only — unchanged from '
  + 'before travel_works existed', () => {
  const s = show({
    day_rate_cents: 100000, travel_rate_cents: 20000,
    days: [day({ date: '2026-09-01', travel_in: true })],
  })
  assert.equal(projectedShowCents(s, HOME_STATE), 20000)
  const result = buildForecast(baseInput({ shows: [s] }))
  const proj = result.showProjections[0]
  assert.equal(proj.dayCount, 0)
  assert.equal(proj.travelDays, 1)
})

test('a worked travel day that is also flagged pay_as_half_day bills the travel rate plus a '
  + 'half day rate, not a full one', () => {
  const s = show({
    day_rate_cents: 100000, travel_rate_cents: 20000,
    days: [day({ date: '2026-09-01', travel_in: true, travel_works: true, pay_as_half_day: true })],
  })
  assert.equal(projectedShowCents(s, HOME_STATE), 20000 + 50000) // travel + half of 100000
  const result = buildForecast(baseInput({ shows: [s] }))
  const proj = result.showProjections[0]
  assert.equal(proj.dayCount, 0.5)
  assert.equal(proj.travelDays, 1)
  assert.equal(proj.dayCents, 50000)
  assert.equal(proj.travelCents, 20000)
})

test('a day flagged BOTH travel_in and travel_out, with travel_works, still counts as ONE '
  + 'travel day plus ONE work day — never two travel legs', () => {
  const s = show({
    day_rate_cents: 100000, travel_rate_cents: 20000,
    days: [day({ date: '2026-09-01', travel_in: true, travel_out: true, travel_works: true })],
  })
  assert.equal(projectedShowCents(s, HOME_STATE), 100000 + 20000)
  const result = buildForecast(baseInput({ shows: [s] }))
  const proj = result.showProjections[0]
  assert.equal(proj.dayCount, 1)
  assert.equal(proj.travelDays, 1)
})

test('travel_works on a day with no travel flags at all is ignored entirely — it only means '
  + 'something on an actual travel day', () => {
  const s = show({
    day_rate_cents: 100000, travel_rate_cents: 20000,
    days: [day({ date: '2026-09-01', travel_works: true })],
  })
  assert.equal(projectedShowCents(s, HOME_STATE), 100000)
  const result = buildForecast(baseInput({ shows: [s] }))
  const proj = result.showProjections[0]
  assert.equal(proj.dayCount, 1)
  assert.equal(proj.travelDays, 0)
})

test('an ASSUMED travel day is never treated as worked, even if travel_works is somehow true '
  + 'on it (defensive) — the assumption fires only when nothing was marked, so nothing is '
  + 'known about whether that day was worked', () => {
  const s = show({
    day_rate_cents: 100000, travel_rate_cents: 25000, location: 'Orlando, FL',
    days: [
      day({ date: '2026-09-01', travel_works: true }),
      day({ date: '2026-09-02', travel_works: true }),
    ],
  })
  assert.equal(projectedShowCents(s, HOME_STATE), 2 * 25000)
  const result = buildForecast(baseInput({ shows: [s] }))
  const proj = result.showProjections[0]
  assert.equal(proj.dayCount, 0)
  assert.equal(proj.travelDays, 2)
  assert.equal(proj.travelAssumed, true)
})

test('a single flagged, worked travel day still suppresses the out-of-state assumption for '
  + 'the rest of an otherwise-unmarked show, and is itself both a travel day and a work day', () => {
  const s = show({
    day_rate_cents: 100000, travel_rate_cents: 25000,
    location: 'Orlando, FL', // out of state — would independently justify a 2-day assumption
    days: [
      day({ date: '2026-09-01', travel_in: true, travel_works: true }), // flagged, worked travel day
      day({ date: '2026-09-02' }), // plain work day
      day({ date: '2026-09-03' }), // plain work day — NOT auto-marked travel by the assumption
    ],
  })
  const result = buildForecast(baseInput({ shows: [s] }))
  const proj = result.showProjections[0]
  assert.equal(proj.travelAssumed, false)
  assert.equal(proj.travelDays, 1)
  assert.equal(proj.dayCount, 3) // worked 09-01 + plain 09-02 + plain 09-03
  assert.equal(proj.travelCents, 25000)
  assert.equal(proj.dayCents, 3 * 100000)
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
  // work (5 scheduled days minus the first+last assumed as travel = 3): 3 * 100000 = 300000
  // travel (assumed, out-of-state, no flags, first+last): 2 * 20000 = 40000
  // pm (flat, unaffected by the travel/work split): 4 * 5000 = 20000
  // total = 360000
  assert.equal(projectedShowCents(s, HOME_STATE), 360000)
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
  const paidInv = invoice({ id: 'i1', status: 'paid', sent_at: '2027-06-01T00:00:00Z' })
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
  const paid = invoice({ id: 'i1', status: 'paid', total_cents: 100000 })
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
// client with a rich history of settled invoices projects off its plain
// terms_days now — the previous "learned median" machinery (and the
// 365-day window built to guard it) is gone entirely, including the fields
// (`linked`, `paid_at`) it used to read off ForecastInvoice.

test('every client\'s pay lag is simply terms_days now — settled invoice history '
  + 'that would once have taught a learned median has no effect', () => {
  const settledInvoices = [
    // Under the old model these two would have taught a learned median of
    // 29.5 -> 30 days for this client, overriding its stated terms.
    invoice({ id: 'i1', status: 'paid', sent_at: '2026-06-01T00:00:00Z' }),
    invoice({ id: 'i2', status: 'paid', sent_at: '2026-06-05T00:00:00Z' }),
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
    // 3 scheduled days out-of-state: first+last assumed travel, middle stays work —
    // deliberately NOT 2 days, so this general reconciliation check doesn't collide
    // with the 2-day (0 work, 2 travel) edge case pinned by its own dedicated test.
    days: [day({ date: '2026-09-05' }), day({ date: '2026-09-06' }), day({ date: '2026-09-07' })],
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
  assert.equal(zephyr.dayCount, 1) // just the middle day, 09-06
  assert.equal(zephyr.travelDays, 2) // first (09-05) and last (09-07)
  assert.equal(zephyr.dayCents, 100000)
  assert.equal(zephyr.travelCents, 40000)
  assert.equal(zephyr.travelAssumed, true)
  assert.equal(zephyr.totalCents, 140000)
  assert.equal(zephyr.firstDay, '2026-09-05')
  assert.equal(zephyr.lastDay, '2026-09-07')
  assert.equal(zephyr.dayCount + zephyr.travelDays, showA.days.length)
})

test('travelAssumed is true only when travel days came from the out-of-state rule, never from '
  + 'flags', () => {
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
    // Two flagged travel days (not one day flagged twice), so this show's totals land on
    // the same numbers as outOfState's 2-day assumption above, sourced from flags instead.
    days: [
      day({ date: '2026-09-05', travel_in: true }),
      day({ date: '2026-09-06', travel_out: true }),
    ],
  })
  const result = buildForecast(baseInput({ shows: [outOfState, flagged] }))
  const outProj = result.showProjections.find((p) => p.showId === 's-out')!
  const flagProj = result.showProjections.find((p) => p.showId === 's-flag')!
  assert.equal(outProj.travelAssumed, true)
  assert.equal(outProj.travelDays, 2)
  assert.equal(outProj.dayCount, 0)
  assert.equal(flagProj.travelAssumed, false)
  assert.equal(flagProj.travelDays, 2)
  assert.equal(flagProj.dayCount, 0)
  // same total as the assumption above, but sourced from flags, not the out-of-state rule
  assert.equal(flagProj.travelCents, outProj.travelCents)
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

test('showProjections count fields (dayCount/travelDays/pmHours) reconcile with the money fields '
  + 'on a mixed out-of-state, multi-day, PM show — AND a half-day flag on the assumed LAST '
  + 'travel day is ignored, since a travel day is never also a (half-)work day', () => {
  const mixedShow = show({
    id: 's1', name: 'Mixed Show', client_id: 'c1',
    day_rate_cents: 100000, travel_rate_cents: 20000, pm_rate_cents: 7500, pm_role: true,
    location: 'Orlando, FL', // out of state vs HOME_STATE 'IL' — the travel assumption fires
    days: [
      day({ date: '2026-09-01' }), // assumed travel (first)
      day({ date: '2026-09-02' }), // work
      day({ date: '2026-09-03' }), // work
      // last day — assumed travel — ALSO flagged pay_as_half_day. That flag must be
      // ignored: the day is a travel day, not a half-priced work day, so it must not
      // contribute halfRate to dayCents nor shrink dayCount below the 2 plain work days.
      day({ date: '2026-09-04', pay_as_half_day: true }),
    ],
  })
  const result = buildForecast(baseInput({ shows: [mixedShow] }))
  assert.equal(result.showProjections.length, 1)
  const proj = result.showProjections[0]

  // 2 plain work days (09-02, 09-03) — the half-day flag on the assumed travel day
  // (09-04) contributes nothing, full or half.
  assert.equal(proj.dayCount, 2)
  // no flagged days, but >1 scheduled day and out-of-state -> the 2-travel-day assumption
  // (first 09-01 and last 09-04, regardless of 09-04's half-day flag)
  assert.equal(proj.travelDays, 2)
  assert.equal(proj.travelAssumed, true)
  assert.equal(proj.dayCount + proj.travelDays, mixedShow.days.length)
  // pm_role set -> the flat PM_FORECAST_HOURS, once
  assert.equal(proj.pmHours, PM_FORECAST_HOURS)

  // Same computation as the money fields, not a second pass — these must reconcile exactly.
  assert.equal(proj.dayCents, 2 * 100000)
  assert.equal(proj.travelCents, proj.travelDays * 20000)
  assert.equal(proj.pmCents, proj.pmHours * 7500)
})

test('showProjections count fields on a plain one-day local show: 1 day, no travel, no PM', () => {
  const localShow = show({
    id: 's2', name: 'Local Show', client_id: 'c1',
    day_rate_cents: 80000, travel_rate_cents: 15000, pm_rate_cents: 0, pm_role: false,
    location: 'Chicago, IL', // same as HOME_STATE, and only one day anyway
    days: [day({ date: '2026-09-10' })],
  })
  const result = buildForecast(baseInput({ shows: [localShow] }))
  assert.equal(result.showProjections.length, 1)
  const proj = result.showProjections[0]
  assert.equal(proj.dayCount, 1)
  assert.equal(proj.travelDays, 0)
  assert.equal(proj.travelAssumed, false)
  assert.equal(proj.pmHours, 0)
  assert.equal(proj.dayCents, 80000)
  assert.equal(proj.travelCents, 0)
  assert.equal(proj.pmCents, 0)
})
