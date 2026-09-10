// Rebuilding a 2026 show from the invoice that billed it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ratesFromInvoiceLines, dayCountsFromInvoiceLines, planShowDays, windowProblems,
  type BackfillLine,
} from '../../lib/showBackfill.ts'

const line = (description: string, qty: number, unit: number): BackfillLine =>
  ({ description, qty_hundredths: Math.round(qty * 100), unit_price_cents: Math.round(unit * 100) })

// Invoice #383 as it sits in prod, the richest real shape: PM hours as well as
// day, travel and overtime.
const INV_383: BackfillLine[] = [
  line('PM Hours', 12, 78),
  line('Travel Day', 2, 390),
  line('Day Rate', 5, 780),
  line('Overtime', 6, 117),
  line('Meals and Expenses', 1, 368.53),
]

test('the frozen rate card comes off the invoice', () => {
  assert.deepEqual(ratesFromInvoiceLines(INV_383), {
    dayRateCents: 78000, travelRateCents: 39000, pmRateCents: 7800,
  })
})

test('day and travel counts come off the same lines', () => {
  assert.deepEqual(dayCountsFromInvoiceLines(INV_383), { showDays: 5, travelDays: 2 })
})

// Every description Dan's invoices actually use. Wording drifted year to year
// and the reader must not care.
test('"Standard Day Rate" and "Travel Rate" read the same as the plain forms', () => {
  const inv381 = [
    line('Travel Rate', 2, 400),
    line('Standard Day Rate', 3, 800),
    line('Overtime Rate', 5, 120),
  ]
  assert.deepEqual(ratesFromInvoiceLines(inv381), {
    dayRateCents: 80000, travelRateCents: 40000, pmRateCents: 0,
  })
  assert.deepEqual(dayCountsFromInvoiceLines(inv381), { showDays: 3, travelDays: 2 })
})

test('"Travel Day Rate" is travel, never a show day', () => {
  const inv367 = [line('Travel Day Rate', 2, 360), line('Day Rate', 5, 780)]
  assert.deepEqual(dayCountsFromInvoiceLines(inv367), { showDays: 5, travelDays: 2 })
  assert.equal(ratesFromInvoiceLines(inv367).travelRateCents, 36000)
})

test('overtime is neither a day nor a rate we freeze', () => {
  const counts = dayCountsFromInvoiceLines([line('Overtime', 19, 117)])
  assert.deepEqual(counts, { showDays: 0, travelDays: 0 })
  assert.deepEqual(ratesFromInvoiceLines([line('Overtime', 19, 117)]), {
    dayRateCents: 0, travelRateCents: 0, pmRateCents: 0,
  })
})

test('an invoice with no PM line reports a zero PM rate, it does not throw', () => {
  assert.equal(ratesFromInvoiceLines([line('Day Rate', 1, 500)]).pmRateCents, 0)
})

test('expense lines are ignored entirely', () => {
  const expenses = [
    line('Baggage Fees', 2, 50), line('Uber to ORD', 1, 84.06),
    line('Expenses (See PDF)', 1, 108.23), line('Food - Starbucks', 1, 3.3),
  ]
  assert.deepEqual(dayCountsFromInvoiceLines(expenses), { showDays: 0, travelDays: 0 })
  assert.deepEqual(ratesFromInvoiceLines(expenses), {
    dayRateCents: 0, travelRateCents: 0, pmRateCents: 0,
  })
})

test('an empty invoice is zeros, not a crash', () => {
  assert.deepEqual(ratesFromInvoiceLines([]), {
    dayRateCents: 0, travelRateCents: 0, pmRateCents: 0,
  })
  assert.deepEqual(dayCountsFromInvoiceLines([]), { showDays: 0, travelDays: 0 })
})

// --- planShowDays -----------------------------------------------------------
//
// Since migration 0005 every show_days row is a WORK day and travel is a flag
// on the day. computeShowLines counts legs (travel_in + travel_out, so one date
// can carry two) separately from worked days, and a travel flag never
// suppresses a day rate.

const shapeOf = (days) => days.map(d =>
  `${d.date}${d.travel_in ? ' in' : ''}${d.travel_out ? ' out' : ''}${d.travel_works ? ' works' : ''}`)

test('Praxis: fly in, work, fly home', () => {
  const { days, problems } = planShowDays('2026-05-16', '2026-05-21', 'own-day', 'own-day')
  assert.deepEqual(problems, [])
  assert.deepEqual(shapeOf(days), [
    '2026-05-16 in',
    '2026-05-17',
    '2026-05-18',
    '2026-05-19',
    '2026-05-20',
    '2026-05-21 out',
  ])
  // Four worked days and two travel legs, which is what the window should hold.
  assert.deepEqual(windowProblems({ showDays: 4, travelDays: 2 }, days), [])
})

test('a local show with no travel carries no flags', () => {
  const { days } = planShowDays('2026-06-01', '2026-06-03', 'none', 'none')
  assert.deepEqual(shapeOf(days), ['2026-06-01', '2026-06-02', '2026-06-03'])
  assert.deepEqual(windowProblems({ showDays: 3, travelDays: 0 }, days), [])
})

test('a single-day show is one unflagged row', () => {
  const { days, problems } = planShowDays('2026-03-05', '2026-03-05', 'none', 'none')
  assert.deepEqual(days, [
    { date: '2026-03-05', travel_in: false, travel_out: false, travel_works: false },
  ])
  assert.deepEqual(problems, [])
})

test('Chosen Con: he worked the last Sunday and flew home that night', () => {
  const { days, problems } = planShowDays('2026-02-16', '2026-02-22', 'own-day', 'same-day')
  assert.deepEqual(problems, [])
  assert.deepEqual(shapeOf(days), [
    '2026-02-16 in',
    '2026-02-17',
    '2026-02-18',
    '2026-02-19',
    '2026-02-20',
    '2026-02-21',
    '2026-02-22 out works',
  ])
  // Six worked days and two travel legs across seven dates — exactly what
  // invoice #365 billed.
  assert.deepEqual(windowProblems({ showDays: 6, travelDays: 2 }, days), [])
})

test('travel_works never appears without a travel flag — 0037 forbids it', () => {
  const { days } = planShowDays('2026-02-16', '2026-02-22', 'own-day', 'same-day')
  for (const d of days) {
    if (d.travel_works) assert.ok(d.travel_in || d.travel_out, `${d.date} works without a leg`)
  }
})

test('one day, drove out and back, worked it: two legs on a worked day', () => {
  const { days, problems } = planShowDays('2026-03-05', '2026-03-05', 'same-day', 'same-day')
  assert.deepEqual(problems, [])
  assert.deepEqual(shapeOf(days), ['2026-03-05 in out works'])
  assert.deepEqual(windowProblems({ showDays: 1, travelDays: 2 }, days), [])
})

test('one day of pure travel at both ends is no show at all — report it', () => {
  const { days, problems } = planShowDays('2026-03-05', '2026-03-05', 'own-day', 'own-day')
  assert.equal(days.length, 1)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /one day/i)
})

test('an end before its start is reported, not silently reversed', () => {
  const { days, problems } = planShowDays('2026-05-21', '2026-05-16', 'none', 'none')
  assert.deepEqual(days, [])
  assert.equal(problems.length, 1)
  assert.match(problems[0], /before/i)
})

test('a malformed date is reported', () => {
  const { problems } = planShowDays('May 16', '2026-05-21', 'none', 'none')
  assert.equal(problems.length, 1)
  assert.match(problems[0], /date/i)
})

// --- windowProblems ---------------------------------------------------------

test('a window too short for the days the invoice billed is reported', () => {
  const { days } = planShowDays('2026-05-16', '2026-05-18', 'own-day', 'own-day')
  const problems = windowProblems({ showDays: 4, travelDays: 2 }, days)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /billed 4 show/i)
})

test('travel billed but no leg planned is reported', () => {
  const { days } = planShowDays('2026-06-01', '2026-06-03', 'none', 'none')
  const problems = windowProblems({ showDays: 3, travelDays: 2 }, days)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /travel/i)
})

test('a window longer than the invoice billed is silence, not a problem', () => {
  const { days } = planShowDays('2026-05-16', '2026-05-21', 'own-day', 'own-day')
  assert.deepEqual(windowProblems({ showDays: 2, travelDays: 2 }, days), [])
})
