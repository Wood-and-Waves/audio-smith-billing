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

test('the overdue alert names one invoice and how late it is', () => {
  const { subject, text, html } = buildOverdueAlertEmail(inv(), APP)
  assert.ok(subject.includes('385'), 'the number is in the subject')
  for (const body of [text, html]) {
    assert.ok(body.includes('Streamline Pictures'))
    assert.ok(body.includes(formatUSD(655314)))
    assert.ok(body.includes(`${APP}/invoices/aaaa-1111`))
  }
})

test('neither email can carry bank details', () => {
  // No path passes settings into these builders at all. This asserts the
  // shape stays that way — if someone threads settings in later to print a
  // remit-to block, this is what should stop them adding ach_details with it.
  const s = sweep([inv()], TODAY)
  const bodies = [
    buildDigestEmail(s, APP).text, buildDigestEmail(s, APP).html,
    buildOverdueAlertEmail(inv(), APP).text, buildOverdueAlertEmail(inv(), APP).html,
  ]
  for (const b of bodies) {
    assert.ok(!/routing/i.test(b), 'no routing number')
    assert.ok(!/ach/i.test(b), 'no ACH block — these go to Dan, not a client')
  }
})

test('a client name containing markup is escaped in the html', () => {
  const { html } = buildDigestEmail(sweep([inv({ client_name: '<script>x</script>' })], TODAY), APP)
  assert.ok(!html.includes('<script>'), 'the raw tag never survives')
  assert.ok(html.includes('&lt;script&gt;'), 'it is escaped')
})
