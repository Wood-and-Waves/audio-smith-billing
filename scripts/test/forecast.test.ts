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
  // client() terms_days=30, no learned lag -> sent_at + 30 days = 2026-09-13 -> month 2026-09 (index 1)
  assert.equal(result.months[0].endingBalanceCents, 300000) // 500000 + 0 income - 100000 - 100000
  assert.equal(result.months[1].endingBalanceCents, 5100000) // 300000 + 5000000 - 100000 - 100000
  assert.equal(result.months[2].endingBalanceCents, 4900000) // 5100000 + 0 income - 200000, carried forward
  assert.ok(result.months.every((m) => m.covered))
})

test('the first uncovered month is identified exactly, and coveredThrough is the month before it', () => {
  const result = buildForecast(baseInput({
    startingBalanceCents: 250000,
    assumptions: assumptions({ overheadCents: 100000, takeHomeCents: 100000, taxRateBp: 0 }),
  }))
  // no income at all: balance drops 200000/month. 250000 -> 50000 (covered) -> -150000 (uncovered)
  assert.equal(result.months[0].endingBalanceCents, 50000)
  assert.equal(result.months[0].covered, true)
  assert.equal(result.months[1].endingBalanceCents, -150000)
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
  const result = buildForecast(baseInput({
    startingBalanceCents: 200000,
    assumptions: assumptions({ overheadCents: 100000, takeHomeCents: 100000, taxRateBp: 0 }),
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

test('bookedThrough is the latest month among all inflows, and null when there are none', () => {
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
  // farShow: last day 2027-01-10 + billingLag(7) + payLag(terms 30) = 2027-02-16 -> month 2027-02
  assert.equal(result.bookedThrough, '2027-02')
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

test('tax is computed on profit, never below zero, at the configured basis points', () => {
  const invA = invoice({
    id: 'i1', status: 'sent', sent_at: '2026-08-14T00:00:00Z', total_cents: 1000000,
    client_id: 'c1',
  })
  const result = buildForecast(baseInput({
    invoices: [invA],
    assumptions: assumptions({ overheadCents: 100000, takeHomeCents: 0, taxRateBp: 1500, billingLagDays: 0 }),
  }))
  // income lands in month it's expected (sent_at 2026-08-14 + terms 30 = 2026-09-13 -> month 2026-09)
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
