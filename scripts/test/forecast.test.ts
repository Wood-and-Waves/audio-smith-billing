// The whole cash-flow model, pinned. Like ledgerMatch.test.ts, fixtures are
// built with Partial<T> overrides so every test states only what it's
// actually exercising.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  projectedShowCents, payLagFor, computeOverheadCents, buildForecast, HORIZON_MONTHS,
} from '../../lib/forecast.ts'
import type {
  ForecastShow, ForecastShowDay, ForecastInvoice, ForecastClient, ForecastAssumptions,
} from '../../lib/forecast.ts'

const day = (over: Partial<ForecastShowDay> = {}): ForecastShowDay => ({
  date: '2026-09-01', travel_in: false, travel_out: false, pay_as_half_day: false, ...over,
})

const show = (over: Partial<ForecastShow> = {}): ForecastShow => ({
  id: 's1', name: 'Willow Creek', client_id: 'c1', status: 'open',
  day_rate_cents: 100000, travel_rate_cents: 20000,
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
// projectedShowCents

test('a plain two-day show bills two full days, no travel', () => {
  const s = show({ days: [day({ date: '2026-09-01' }), day({ date: '2026-09-02' })] })
  assert.equal(projectedShowCents(s), 200000)
})

test('a half day bills at day_rate/2, rounded', () => {
  const s = show({
    day_rate_cents: 10001,
    days: [day({ date: '2026-09-01' }), day({ date: '2026-09-02', pay_as_half_day: true })],
  })
  // full day 10001 + half round(10001/2)=round(5000.5)=5001
  assert.equal(projectedShowCents(s), 10001 + 5001)
})

test('travel legs add on top of the day, one leg per flag', () => {
  const s = show({
    day_rate_cents: 100000, travel_rate_cents: 20000,
    days: [day({ date: '2026-09-01', travel_in: true, travel_out: true })],
  })
  assert.equal(projectedShowCents(s), 100000 + 2 * 20000)
})

test('zero rates project zero, no crash', () => {
  const s = show({ day_rate_cents: 0, travel_rate_cents: 0, days: [day({ travel_in: true })] })
  assert.equal(projectedShowCents(s), 0)
})

test('negative rates project zero rather than a negative amount', () => {
  const s = show({ day_rate_cents: -50000, travel_rate_cents: -1000, days: [day({ travel_in: true })] })
  assert.equal(projectedShowCents(s), 0)
})

test('an hourly show bills the same as a day-rate show off the same frozen day_rate_cents', () => {
  // The type carries no bill_hourly flag — an hourly show's rate is already
  // frozen into day_rate_cents by the time it reaches this lib, so the same
  // arithmetic applies with no special case.
  const dayRateShow = show({ day_rate_cents: 84500, travel_rate_cents: 15000, days: [day()] })
  const hourlyShapedShow = show({ id: 's2', day_rate_cents: 84500, travel_rate_cents: 15000, days: [day()] })
  assert.equal(projectedShowCents(hourlyShapedShow), projectedShowCents(dayRateShow))
})

test('a show with no scheduled days projects zero, no crash', () => {
  const s = show({ days: [] })
  assert.equal(projectedShowCents(s), 0)
})

// ---------------------------------------------------------------------------
// payLagFor

test('pay lag is learned as the median of three linked invoices sent within a year', () => {
  const invoices = [
    invoice({ id: 'i1', linked: true, sent_at: '2026-06-01T00:00:00Z', paid_at: '2026-06-28' }), // 27
    invoice({ id: 'i2', linked: true, sent_at: '2026-06-05T00:00:00Z', paid_at: '2026-07-07' }), // 32
    invoice({ id: 'i3', linked: true, sent_at: '2026-06-10T00:00:00Z', paid_at: '2026-07-17' }), // 37
  ]
  const result = payLagFor('c1', invoices, [client()], '2026-08-21')
  assert.deepEqual(result, { clientId: 'c1', days: 32, source: 'learned', sampleSize: 3 })
})

test('the Journey case — ancient settlements outside the 365-day window fall back to terms', () => {
  // Every sent_at below is well over a year before today (2026-08-21) —
  // the shape of Dan's real Journey Church invoices, settled 2024-25 after
  // sitting for a year-plus. Learning from these would model Journey as a
  // two-year payer, so the window excludes them all.
  const invoices = [
    invoice({ id: 'i1', linked: true, sent_at: '2024-08-01T00:00:00Z', paid_at: '2025-08-29' }),
    invoice({ id: 'i2', linked: true, sent_at: '2024-05-01T00:00:00Z', paid_at: '2025-08-31' }),
    invoice({ id: 'i3', linked: true, sent_at: '2024-01-01T00:00:00Z', paid_at: '2025-10-13' }),
    invoice({ id: 'i4', linked: true, sent_at: '2023-08-01T00:00:00Z', paid_at: '2025-08-23' }),
  ]
  const result = payLagFor('c1', invoices, [client({ terms_days: 30 })], '2026-08-21')
  assert.deepEqual(result, { clientId: 'c1', days: 30, source: 'terms', sampleSize: 0 })
})

test('one qualifying sample is not enough — falls back to terms', () => {
  const invoices = [
    invoice({ id: 'i1', linked: true, sent_at: '2026-06-01T00:00:00Z', paid_at: '2026-06-28' }),
  ]
  const result = payLagFor('c1', invoices, [client({ terms_days: 45 })], '2026-08-21')
  assert.deepEqual(result, { clientId: 'c1', days: 45, source: 'terms', sampleSize: 1 })
})

test('an unlinked invoice with a paid_at is ignored — Mark Paid is not a real payment date', () => {
  const invoices = [
    invoice({ id: 'i1', linked: false, sent_at: '2026-06-01T00:00:00Z', paid_at: '2026-06-28' }),
    invoice({ id: 'i2', linked: false, sent_at: '2026-06-05T00:00:00Z', paid_at: '2026-07-07' }),
  ]
  const result = payLagFor('c1', invoices, [client({ terms_days: 30 })], '2026-08-21')
  assert.deepEqual(result, { clientId: 'c1', days: 30, source: 'terms', sampleSize: 0 })
})

test('an invoice missing sent_at or paid_at is excluded from the sample', () => {
  const invoices = [
    invoice({ id: 'i1', linked: true, sent_at: null, paid_at: '2026-06-28' }),
    invoice({ id: 'i2', linked: true, sent_at: '2026-06-05T00:00:00Z', paid_at: null }),
    invoice({ id: 'i3', linked: true, sent_at: '2026-06-10T00:00:00Z', paid_at: '2026-07-10' }),
  ]
  const result = payLagFor('c1', invoices, [client({ terms_days: 30 })], '2026-08-21')
  assert.deepEqual(result, { clientId: 'c1', days: 30, source: 'terms', sampleSize: 1 })
})

test('an even-sized sample averages the two middle values, rounded to a whole day', () => {
  const invoices = [
    invoice({ id: 'i1', linked: true, sent_at: '2026-06-01T00:00:00Z', paid_at: '2026-06-26' }), // 25
    invoice({ id: 'i2', linked: true, sent_at: '2026-06-02T00:00:00Z', paid_at: '2026-06-30' }), // 28
    invoice({ id: 'i3', linked: true, sent_at: '2026-06-03T00:00:00Z', paid_at: '2026-07-04' }), // 31
    invoice({ id: 'i4', linked: true, sent_at: '2026-06-04T00:00:00Z', paid_at: '2026-07-09' }), // 35
  ]
  // sorted: 25, 28, 31, 35 -> middle two 28,31 -> avg 29.5 -> round -> 30
  const result = payLagFor('c1', invoices, [client()], '2026-08-21')
  assert.deepEqual(result, { clientId: 'c1', days: 30, source: 'learned', sampleSize: 4 })
})

test('the 365-day window is a boundary: exactly 365 days in, 366 days out', () => {
  // today 2026-08-21. 365 days back = 2025-08-21. 366 days back = 2025-08-20.
  const invoices = [
    invoice({ id: 'i1', linked: true, sent_at: '2025-08-21T00:00:00Z', paid_at: '2025-09-20' }), // 30
    invoice({ id: 'i2', linked: true, sent_at: '2025-08-21T00:00:00Z', paid_at: '2025-09-22' }), // 32
  ]
  const inWindow = payLagFor('c1', invoices, [client()], '2026-08-21')
  assert.deepEqual(inWindow, { clientId: 'c1', days: 31, source: 'learned', sampleSize: 2 })

  const outside = payLagFor('c1', [
    invoice({ id: 'i1', linked: true, sent_at: '2025-08-20T00:00:00Z', paid_at: '2025-09-19' }),
    invoice({ id: 'i2', linked: true, sent_at: '2025-08-20T00:00:00Z', paid_at: '2025-09-21' }),
  ], [client({ terms_days: 30 })], '2026-08-21')
  assert.deepEqual(outside, { clientId: 'c1', days: 30, source: 'terms', sampleSize: 0 })
})

test('a client missing from the roster falls back to zero terms rather than throwing', () => {
  const result = payLagFor('unknown-client', [], [client({ id: 'c1' })], '2026-08-21')
  assert.deepEqual(result, { clientId: 'unknown-client', days: 0, source: 'terms', sampleSize: 0 })
})

test('samples from other clients never leak into this client\'s median', () => {
  const invoices = [
    invoice({ id: 'i1', client_id: 'c1', linked: true, sent_at: '2026-06-01T00:00:00Z', paid_at: '2026-06-11' }), // 10
    invoice({ id: 'i2', client_id: 'c1', linked: true, sent_at: '2026-06-02T00:00:00Z', paid_at: '2026-06-13' }), // 11
    invoice({ id: 'i3', client_id: 'c2', linked: true, sent_at: '2026-06-01T00:00:00Z', paid_at: '2026-09-01' }), // huge, other client
  ]
  const result = payLagFor('c1', invoices, [client({ id: 'c1' }), client({ id: 'c2' })], '2026-08-21')
  assert.deepEqual(result, { clientId: 'c1', days: 11, source: 'learned', sampleSize: 2 })
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
  // client() terms_days=30, no learned lag -> sent_at (Chicago date 2026-08-13)
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
  // its cash-landing inflow (last day + billingLag(7) + payLag(terms 30) =
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
  // both land the same month (same sent_at + same learned/terms lag), so tie-break by label:
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
  assert.equal(result.payLags.length, 0)
})

test('the pay-lag list only covers clients with actual booked work in this forecast', () => {
  const irrelevantClient = client({ id: 'c2', name: 'Nobody', terms_days: 15 })
  const result = buildForecast(baseInput({
    clients: [client(), irrelevantClient],
    invoices: [invoice({ id: 'i1', status: 'sent', sent_at: '2026-08-01T00:00:00Z' })],
  }))
  assert.deepEqual(result.payLags.map((p) => p.clientId), ['c1'])
})

// ---------------------------------------------------------------------------
// M1 — reachable learned pay lags. The page's invoice fetch used to filter
// to .in('status', ['draft','sent']) only, so no invoice it ever supplied
// to buildForecast could carry a paid_at (only written alongside
// status='paid') — payLagFor's `linked && paid_at !== null` condition was
// unreachable from the page, and every client silently fell back to
// terms_days no matter how many times they'd actually paid. This test is
// page-shaped on purpose — it supplies 'paid' rows the way the FIXED page's
// .in('status', ['draft','sent','paid']) fetch now does — to lock in the
// contract buildForecast has always honored (it never filtered its own
// input by status for pay-lag learning) so that fetch can't silently regress.
test('a page-shaped invoice set that includes paid+linked invoices produces a learned pay lag', () => {
  const settled1 = invoice({
    id: 'i1', status: 'paid', linked: true, sent_at: '2026-06-01T00:00:00Z', paid_at: '2026-06-28', // 27
  })
  const settled2 = invoice({
    id: 'i2', status: 'paid', linked: true, sent_at: '2026-06-05T00:00:00Z', paid_at: '2026-07-07', // 32
  })
  const stillOpen = invoice({ id: 'i3', status: 'sent', sent_at: '2026-08-14T00:00:00Z', total_cents: 100000 })
  const result = buildForecast(baseInput({ invoices: [settled1, settled2, stillOpen] }))
  const lag = result.payLags.find((p) => p.clientId === 'c1')
  assert.ok(lag)
  assert.equal(lag!.source, 'learned')
  assert.equal(lag!.sampleSize, 2)
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
