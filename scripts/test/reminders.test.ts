// The sweep is pure, so every boundary is pinned here exactly — no database,
// no clock, no email. "Today" is always injected.
//
// Reference dates, checked against a calendar before this was written:
//   2026-08-16 Sunday   2026-08-17 Monday   2026-08-18 Tuesday
//   2026-08-24 Monday   2026-08-20 Thursday

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sweep, isDigestDay, DUE_SOON_DAYS, type ReminderInvoice } from '../../lib/reminders.ts'

const TODAY = '2026-08-20'   // a Thursday

const inv = (over: Partial<ReminderInvoice> = {}): ReminderInvoice => ({
  id: 'i1',
  number: 400,
  due_date: TODAY,
  total_cents: 50000,
  status: 'sent',
  client_name: 'Journey Church',
  alerted_overdue: false,
  ...over,
})

test('due in 8 days is not yet due-soon; 7 days is', () => {
  const far = sweep([inv({ due_date: '2026-08-28' })], TODAY)
  assert.equal(far.dueSoon.length, 0, '8 days out is quiet')
  assert.equal(far.overdue.length, 0)

  const edge = sweep([inv({ due_date: '2026-08-27' })], TODAY)
  assert.equal(edge.dueSoon.length, 1, `${DUE_SOON_DAYS} days out is due soon`)
})

test('due today is due-soon, NOT overdue', () => {
  const s = sweep([inv({ due_date: TODAY })], TODAY)
  assert.equal(s.dueSoon.length, 1, 'due today still counts as due soon')
  assert.equal(s.overdue.length, 0, 'and is not yet overdue — lib/status.ts owns this rule')
})

test('due yesterday and never alerted is overdue AND newly overdue', () => {
  const s = sweep([inv({ due_date: '2026-08-19', alerted_overdue: false })], TODAY)
  assert.equal(s.overdue.length, 1)
  assert.equal(s.newlyOverdue.length, 1)
  assert.equal(s.dueSoon.length, 0)
})

test('already alerted is overdue but NOT newly overdue', () => {
  // This is what stops the same invoice emailing every single morning.
  const s = sweep([inv({ due_date: '2026-08-01', alerted_overdue: true })], TODAY)
  assert.equal(s.overdue.length, 1)
  assert.equal(s.newlyOverdue.length, 0)
})

test('draft, paid and void never appear, at any date', () => {
  for (const status of ['draft', 'paid', 'void'] as const) {
    for (const due of ['2026-08-01', TODAY, '2026-08-25']) {
      const s = sweep([inv({ status, due_date: due })], TODAY)
      assert.equal(s.dueSoon.length, 0, `${status} due ${due} is not due-soon`)
      assert.equal(s.overdue.length, 0, `${status} due ${due} is not overdue`)
      assert.equal(s.newlyOverdue.length, 0, `${status} due ${due} is not newly overdue`)
      assert.equal(s.totalOutstandingCents, 0, `${status} owes nothing`)
    }
  }
})

test('outstanding sums stored cents across every chaseable invoice', () => {
  // Including one due far in the future, which is owed but not yet chased.
  const s = sweep([
    inv({ id: 'a', total_cents: 655314, due_date: '2026-08-01' }),   // overdue
    inv({ id: 'b', total_cents: 50000, due_date: '2026-08-22' }),    // due soon
    inv({ id: 'c', total_cents: 234000, due_date: '2026-12-01' }),   // neither
    inv({ id: 'd', total_cents: 999900, status: 'paid' }),           // ignored
  ], TODAY)
  assert.equal(s.totalOutstandingCents, 655314 + 50000 + 234000)
  assert.equal(s.overdue.length, 1)
  assert.equal(s.dueSoon.length, 1)
})

test('an invoice due in 30 days lands in later, not dueSoon or overdue', () => {
  // This is the case a 30-day-terms business actually lives in most of the
  // time: DUE_SOON_DAYS is 7, so most of an invoice's life is neither
  // overdue nor due soon. It still has to show up somewhere, or the digest's
  // printed total stops matching the invoices named above it.
  const s = sweep([inv({ due_date: '2026-09-19' })], TODAY)  // 30 days out
  assert.equal(s.later.length, 1)
  assert.equal(s.dueSoon.length, 0)
  assert.equal(s.overdue.length, 0)
  assert.equal(s.totalOutstandingCents, 50000)
})

test('each bucket is ordered soonest first', () => {
  const s = sweep([
    inv({ id: 'late', due_date: '2026-08-19' }),
    inv({ id: 'later', due_date: '2026-08-05' }),
  ], TODAY)
  assert.deepEqual(s.overdue.map((i) => i.id), ['later', 'late'], 'oldest overdue leads')
})

test('dueSoon, newlyOverdue and later are each sorted, not just overdue', () => {
  // The comparator is shared, so one bucket passing used to be taken as proof
  // for all four — and a bucket that is never asserted with more than one item
  // in it is a bucket whose sort could be dropped without a single test going
  // red. Every one of these is what the digest prints, in the order it prints
  // it; the thing needing attention has to lead.
  //
  // Fed in deliberately shuffled, and every due_date distinct, so an
  // implementation that merely preserved input order cannot pass.
  const s = sweep([
    inv({ id: 'soon-mid', due_date: '2026-08-24' }),
    inv({ id: 'od-newest', due_date: '2026-08-19' }),
    inv({ id: 'later-far', due_date: '2026-12-01' }),
    inv({ id: 'soon-last', due_date: '2026-08-26' }),
    inv({ id: 'od-oldest', due_date: '2026-07-02' }),
    inv({ id: 'later-near', due_date: '2026-09-19' }),
    inv({ id: 'soon-first', due_date: '2026-08-21' }),
    inv({ id: 'od-middle', due_date: '2026-08-10' }),
  ], TODAY)

  assert.deepEqual(
    s.dueSoon.map((i) => i.id), ['soon-first', 'soon-mid', 'soon-last'],
    'due soonest leads the due-soon list',
  )
  assert.deepEqual(
    s.overdue.map((i) => i.id), ['od-oldest', 'od-middle', 'od-newest'],
    'longest overdue leads',
  )
  assert.deepEqual(
    s.newlyOverdue.map((i) => i.id), ['od-oldest', 'od-middle', 'od-newest'],
    'and newlyOverdue, which is what the cron sends alerts from, is sorted too',
  )
  assert.deepEqual(
    s.later.map((i) => i.id), ['later-near', 'later-far'],
    'later is sorted as well',
  )
})

test('newlyOverdue keeps its own order when only some are already alerted', () => {
  // newlyOverdue is filtered out of overdue, so it can be sorted correctly by
  // accident whenever it happens to be the whole bucket. Alerting on the
  // middle one takes it out and leaves a case where the two orders differ.
  const s = sweep([
    inv({ id: 'b', due_date: '2026-08-10', alerted_overdue: true }),
    inv({ id: 'c', due_date: '2026-08-19', alerted_overdue: false }),
    inv({ id: 'a', due_date: '2026-07-02', alerted_overdue: false }),
  ], TODAY)
  assert.deepEqual(s.overdue.map((i) => i.id), ['a', 'b', 'c'])
  assert.deepEqual(s.newlyOverdue.map((i) => i.id), ['a', 'c'], 'oldest unalerted leads')
})

test('isDigestDay is true only on Monday, in Chicago', () => {
  assert.equal(isDigestDay('2026-08-17'), true, 'Monday')
  assert.equal(isDigestDay('2026-08-24'), true, 'the next Monday')
  assert.equal(isDigestDay('2026-08-16'), false, 'Sunday')
  assert.equal(isDigestDay('2026-08-18'), false, 'Tuesday')
  assert.equal(isDigestDay('2026-08-20'), false, 'Thursday')
})

test('a Chicago Sunday that is already Monday in UTC is NOT a digest day', () => {
  // 2026-08-16 is a Sunday in Chicago. At 8pm Chicago it is already 01:00
  // Monday in UTC. todayInChicago() correctly returns the Sunday, and
  // isDigestDay must agree with it — a naive UTC weekday check would fire the
  // weekly digest a day early, every week.
  assert.equal(isDigestDay('2026-08-16'), false)
})
