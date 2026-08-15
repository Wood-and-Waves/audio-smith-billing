// Both builders are pure, so the wording and the figures are testable with no
// network and no key. These emails go to Dan, so they link to the
// authenticated invoice screen, never to a client's public link.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildDigestEmail, buildOverdueAlertEmail, sendReminderEmail,
} from '../../lib/reminderEmail.ts'
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

// ---------------------------------------------------------------------------
// sendReminderEmail — the envelope, not the API call
//
// Everything above tests a pure builder. This section tests the one part of the
// sender that is its own decision rather than Resend's: the envelope it hands
// over — the from-name fallback, the reply-to that is present only when asked
// for, and the two configuration refusals. Every message the cron sends and
// every client nudge from the invoice screen goes through it, and until now its
// only exercise was a CLI script somebody ran by hand once.
//
// NOTHING LEAVES THE PROCESS. `capture` swaps global fetch for a stub, which is
// what resend v6 posts through, and reads the request body it was handed. As a
// second line of defence it also pins RESEND_BASE_URL at a closed loopback
// port, so if a future resend release ever stopped going through global fetch
// the request would fail against 127.0.0.1 rather than quietly reach
// api.resend.com carrying a real client's invoice. The key is a fake.
// ---------------------------------------------------------------------------

/** The JSON body Resend would have posted, decoded. */
type Envelope = {
  from?: string; to?: string; subject?: string; text?: string; html?: string
  reply_to?: string
}

const ENV_KEYS = ['RESEND_API_KEY', 'INVOICE_FROM_EMAIL', 'RESEND_BASE_URL'] as const

async function capture(
  input: Parameters<typeof sendReminderEmail>[0],
  env: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {},
): Promise<{ result: { error?: string }; envelope: Envelope | null; url: string | null }> {
  const saved = ENV_KEYS.map((k) => [k, process.env[k]] as const)
  const realFetch = globalThis.fetch

  const applied: Record<string, string | undefined> = {
    RESEND_API_KEY: 're_not_a_real_key',
    INVOICE_FROM_EMAIL: 'invoices@theaudiosmith.com',
    // A port nothing listens on, deliberately.
    RESEND_BASE_URL: 'http://127.0.0.1:1',
    ...env,
  }
  for (const k of ENV_KEYS) {
    if (applied[k] === undefined) delete process.env[k]
    else process.env[k] = applied[k]
  }

  let envelope: Envelope | null = null
  let url: string | null = null
  globalThis.fetch = (async (target: unknown, init?: { body?: unknown }) => {
    url = String(target)
    envelope = JSON.parse(String(init?.body ?? '{}')) as Envelope
    return new Response(JSON.stringify({ id: 'stubbed-never-sent' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch

  try {
    const result = await sendReminderEmail(input)
    return { result, envelope, url }
  } finally {
    globalThis.fetch = realFetch
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

const digest = () => ({
  to: 'dan@theaudiosmith.com',
  subject: 'Invoices: 1 overdue, 0 due soon',
  text: 'body', html: '<p>body</p>',
})

test('the envelope carries the subject and both bodies through unchanged', async () => {
  const { result, envelope, url } = await capture(digest())
  assert.equal(result.error, undefined, 'a 200 from Resend is not an error')
  assert.ok(envelope, 'the stub was reached — nothing went to the network')
  assert.ok(url?.endsWith('/emails'), 'posted to the emails endpoint')
  assert.equal(envelope!.to, 'dan@theaudiosmith.com')
  assert.equal(envelope!.subject, 'Invoices: 1 overdue, 0 due soon')
  assert.equal(envelope!.text, 'body')
  assert.equal(envelope!.html, '<p>body</p>')
})

test('the from-name falls back to the LEGAL name, and always wraps INVOICE_FROM_EMAIL', async () => {
  // Client-facing mail routed through here is read by an accounts-payable
  // clerk who has "Smith Audio, LLC" on file, not the trading name.
  const { envelope } = await capture(digest())
  assert.equal(envelope!.from, 'Smith Audio, LLC <invoices@theaudiosmith.com>')
})

test('a caller-supplied from-name replaces the default but not the address', async () => {
  // The client nudge overrides this from Settings; the address is never the
  // caller's to choose, because only INVOICE_FROM_EMAIL is a verified sender.
  const { envelope } = await capture({ ...digest(), fromName: 'Smith Audio Services, LLC' })
  assert.equal(envelope!.from, 'Smith Audio Services, LLC <invoices@theaudiosmith.com>')
})

test('reply-to is absent unless asked for, and is the address given when it is', async () => {
  // Nobody replies to Dan's own digest, so the key must not be present at all
  // — sending reply_to: undefined is a different message from sending none.
  const plain = await capture(digest())
  assert.ok(!('reply_to' in plain.envelope!) || plain.envelope!.reply_to === undefined,
    'the digest carries no reply-to')

  const nudge = await capture({ ...digest(), replyTo: 'dan@theaudiosmith.com' })
  assert.equal(nudge.envelope!.reply_to, 'dan@theaudiosmith.com',
    'a client reply has to reach Dan, not the unattended from-address')
})

test('an owner-facing send still carries no bank details of any kind', async () => {
  // The builders are checked for this above; this checks the envelope that
  // actually goes out, which is the thing settings.ach_details would have to
  // reach to leak. remit_to prints on an invoice; ACH is given on request only.
  const s = sweep([inv()], TODAY)
  const { subject, text, html } = buildDigestEmail(s, APP)
  const { envelope } = await capture({ to: 'dan@theaudiosmith.com', subject, text, html })
  const wire = JSON.stringify(envelope)
  assert.ok(!/ach/i.test(wire), 'no ACH block anywhere in the envelope')
  assert.ok(!/routing/i.test(wire), 'no routing number')
})

test('a missing RESEND_API_KEY refuses by name, before anything is attempted', async () => {
  const { result, envelope } = await capture(digest(), { RESEND_API_KEY: undefined })
  assert.match(result.error ?? '', /RESEND_API_KEY/, 'names the variable that is missing')
  assert.equal(envelope, null, 'and gives up before building a request at all')
})

test('a missing INVOICE_FROM_EMAIL refuses by name too', async () => {
  const { result, envelope } = await capture(digest(), { INVOICE_FROM_EMAIL: undefined })
  assert.match(result.error ?? '', /INVOICE_FROM_EMAIL/)
  assert.equal(envelope, null)
})

test('neither refusal ever quotes the key it is complaining about', async () => {
  // These messages land in a cron JSON response and in Vercel's log retention.
  // A key printed once is a key that has to be rotated.
  const missingFrom = await capture(digest(), { INVOICE_FROM_EMAIL: undefined })
  assert.ok(!(missingFrom.result.error ?? '').includes('re_not_a_real_key'),
    'the API key value is never echoed')
})
