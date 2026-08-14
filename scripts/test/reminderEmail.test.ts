// Both builders are pure, so the wording and the figures are testable with no
// network and no key. These emails go to Dan, so they link to the
// authenticated invoice screen, never to a client's public link.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildDigestEmail, buildOverdueAlertEmail } from '../../lib/reminderEmail.ts'
import { sweep, type ReminderInvoice } from '../../lib/reminders.ts'
import { formatUSD } from '../../lib/money.ts'

const APP = 'https://billing.theaudiosmith.com'
const TODAY = '2026-08-20'

const inv = (over: Partial<ReminderInvoice> = {}): ReminderInvoice => ({
  id: 'aaaa-1111', number: 385, due_date: '2026-08-18', total_cents: 655314,
  status: 'sent', client_name: 'Streamline Pictures', alerted_overdue: false, ...over,
})

test('a busy digest names each invoice, its client and its stored total', () => {
  const s = sweep([
    inv(),
    inv({ id: 'bbbb-2222', number: 386, due_date: '2026-08-22', total_cents: 50000, client_name: 'Journey Church' }),
  ], TODAY)
  const { subject, text, html } = buildDigestEmail(s, APP)

  assert.ok(subject.includes('1 overdue'), 'the subject leads with the overdue count')
  for (const body of [text, html]) {
    assert.ok(body.includes('#385'), 'names the overdue invoice')
    assert.ok(body.includes('Streamline Pictures'))
    assert.ok(body.includes(formatUSD(655314)), 'the stored total, $6,553.14')
    assert.ok(body.includes('#386'), 'names the due-soon invoice')
    assert.ok(body.includes(formatUSD(50000)))
    assert.ok(body.includes(`${APP}/invoices/aaaa-1111`), 'links to the authenticated screen')
  }
})

test('a quiet week still sends, and says so plainly', () => {
  // A genuinely empty invoice list — every bucket empty, including later —
  // is the one and only case that should say "nothing outstanding".
  const { subject, text } = buildDigestEmail(sweep([], TODAY), APP)
  assert.ok(/nothing outstanding/i.test(text), 'says there is nothing to do')
  assert.ok(!/undefined|NaN/.test(text), 'no leaked placeholders')
  assert.ok(!/undefined|NaN/.test(subject))
})

test('the digest total is the stored sum, never recomputed', () => {
  const s = sweep([inv({ total_cents: 655314 }), inv({ id: 'x', total_cents: 234000 })], TODAY)
  const { text } = buildDigestEmail(s, APP)
  assert.ok(text.includes(formatUSD(655314 + 234000)), 'outstanding is $8,893.14')
})

test('invoices due far in the future are neither silent nor mislabeled "nothing outstanding"', () => {
  // The bug this whole finding is about: a digest with real money open but
  // nothing overdue or due soon used to print "Invoices: nothing
  // outstanding" and a body saying 0 open invoices. This is the live-data
  // case — four invoices, all more than 7 days out, $9,993.14 total.
  const s = sweep([
    inv({ id: 'a', number: 385, total_cents: 655314, due_date: '2026-09-19' }),
    inv({ id: 'b', number: 386, total_cents: 50000, due_date: '2026-09-19' }),
    inv({ id: 'c', number: 387, total_cents: 60000, due_date: '2026-09-19' }),
    inv({ id: 'd', number: 388, total_cents: 234000, due_date: '2026-09-19' }),
  ], TODAY)
  assert.equal(s.dueSoon.length, 0)
  assert.equal(s.overdue.length, 0)
  assert.equal(s.later.length, 4)

  const { subject, text, html } = buildDigestEmail(s, APP)
  assert.ok(!/nothing outstanding/i.test(subject), 'subject must not claim nothing is owed')
  assert.ok(!/nothing outstanding/i.test(text), 'body must not claim nothing is owed')
  const total = formatUSD(655314 + 50000 + 60000 + 234000)
  assert.ok(subject.includes(total) || text.includes(total), 'the $9,993.14 total appears')
  for (const body of [text, html]) {
    assert.ok(body.includes('#385'), 'the far-future invoices are actually listed')
    assert.ok(body.includes('#388'))
  }
})

test('the printed Outstanding figure equals the sum of every invoice named in the body', () => {
  const s = sweep([
    inv({ id: 'a', number: 385, total_cents: 655314, due_date: '2026-08-01' }),  // overdue
    inv({ id: 'b', number: 386, total_cents: 50000, due_date: '2026-08-22' }),   // due soon
    inv({ id: 'c', number: 387, total_cents: 234000, due_date: '2026-12-01' }),  // later
  ], TODAY)
  const { text } = buildDigestEmail(s, APP)

  const named = [...s.overdue, ...s.dueSoon, ...s.later]
  assert.equal(named.length, 3, 'every chaseable invoice is named in exactly one bucket')
  const namedTotal = named.reduce((sum, i) => sum + i.total_cents, 0)
  assert.equal(namedTotal, s.totalOutstandingCents, 'nothing is counted without being named')
  assert.ok(text.includes(`Outstanding: ${formatUSD(s.totalOutstandingCents)}`))
})

test('the overdue alert names one invoice and how late it is', () => {
  const { subject, text, html } = buildOverdueAlertEmail(inv(), APP)
  assert.ok(subject.includes('385'), 'the number is in the subject')
  for (const body of [text, html]) {
    assert.ok(body.includes('Streamline Pictures'))
    assert.ok(body.includes(formatUSD(655314)))
    assert.ok(body.includes(`${APP}/invoices/aaaa-1111`))
  }
})

test('neither owner-facing builder can carry bank details', () => {
  // No path passes settings into buildDigestEmail or buildOverdueAlertEmail
  // at all. This asserts the shape stays that way — if someone threads
  // settings in later to print a remit-to block, this is what should stop
  // them adding ach_details with it. (sendReminderEmail itself is a generic
  // sender used for both owner-facing and client-facing mail — see its
  // header comment — but these two builders specifically never see settings.)
  const s = sweep([inv()], TODAY)
  const bodies = [
    buildDigestEmail(s, APP).text, buildDigestEmail(s, APP).html,
    buildOverdueAlertEmail(inv(), APP).text, buildOverdueAlertEmail(inv(), APP).html,
  ]
  for (const b of bodies) {
    assert.ok(!/routing/i.test(b), 'no routing number')
    assert.ok(!/ach/i.test(b), 'no ACH block in the digest or overdue alert')
  }
})

test('a client name containing markup is escaped in the html', () => {
  const { html } = buildDigestEmail(sweep([inv({ client_name: '<script>x</script>' })], TODAY), APP)
  assert.ok(!html.includes('<script>'), 'the raw tag never survives')
  assert.ok(html.includes('&lt;script&gt;'), 'it is escaped')
})
