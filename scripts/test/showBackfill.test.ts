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

test('Praxis: travel in, five show days, travel out', () => {
  const { days, problems } = planShowDays('2026-05-16', '2026-05-21', 'own-day', 'own-day')
  assert.deepEqual(problems, [])
  assert.deepEqual(days.map(d => `${d.date} ${d.day_type}`), [
    '2026-05-16 travel',
    '2026-05-17 show',
    '2026-05-18 show',
    '2026-05-19 show',
    '2026-05-20 show',
    '2026-05-21 travel',
  ])
})

test('a local show with no travel is all show days', () => {
  const { days } = planShowDays('2026-06-01', '2026-06-03', 'none', 'none')
  assert.deepEqual(days.map(d => d.day_type), ['show', 'show', 'show'])
})

test('a single-day show is one day', () => {
  const { days, problems } = planShowDays('2026-03-05', '2026-03-05', 'none', 'none')
  assert.deepEqual(days, [{ date: '2026-03-05', day_type: 'show' }])
  assert.deepEqual(problems, [])
})

test('a one-day window cannot hold travel both ways — say so, do not truncate', () => {
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

test('the invoice and the window agreeing is silence', () => {
  const { days } = planShowDays('2026-05-16', '2026-05-21', 'own-day', 'own-day')
  assert.deepEqual(windowProblems({ showDays: 4, travelDays: 2 }, days), [])
})

test('a window too short for the days the invoice billed is reported', () => {
  const { days } = planShowDays('2026-05-16', '2026-05-18', 'own-day', 'own-day')
  const problems = windowProblems({ showDays: 4, travelDays: 2 }, days)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /billed 4 show/i)
})

test('travel billed but no travel day planned is reported', () => {
  const { days } = planShowDays('2026-06-01', '2026-06-03', 'none', 'none')
  const problems = windowProblems({ showDays: 3, travelDays: 2 }, days)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /travel/i)
})

test('Chosen Con: he worked the last Sunday and flew home that night', () => {
  const { days, problems } = planShowDays('2026-02-16', '2026-02-22', 'own-day', 'same-day')
  assert.deepEqual(problems, [])
  assert.deepEqual(days.map(d => `${d.date} ${d.day_type}`), [
    '2026-02-16 travel',
    '2026-02-17 show',
    '2026-02-18 show',
    '2026-02-19 show',
    '2026-02-20 show',
    '2026-02-21 show',
    '2026-02-22 show',
    '2026-02-22 travel',
  ])
  // Which is the eight days invoice #365 billed across a seven-day window.
  assert.deepEqual(windowProblems({ showDays: 6, travelDays: 2 }, days), [])
})

test('a same-day leg on a one-day show is legal — he drove out and back', () => {
  const { days, problems } = planShowDays('2026-03-05', '2026-03-05', 'same-day', 'same-day')
  assert.deepEqual(problems, [])
  assert.deepEqual(days.map(d => d.day_type), ['show', 'travel'])
})
