// "Am I behind?" — the question the whole payroll feature exists to answer.
//
// Every date below was checked against a real 2027 calendar rather than
// reasoned about, because a deadline that is wrong by a day is a penalty.
//   2027-05-15 is a Saturday   2027-08-15 is a Sunday
//   2027-07-31 is a Saturday   2027-10-31 is a Sunday
//   2027-04-30 is a Friday     2028-01-31 is a Monday

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildObligations, type ObligationRun, type ObligationPayment } from '../../lib/payrollObligations.ts'

const run = (payDate: string, over: Partial<ObligationRun> = {}): ObligationRun => ({
  payDate,
  federalDepositCents: 139_250,
  ilDepositCents: 28_875,
  futaCents: 3_500,
  ilSutaCents: 23_042,
  ...over,
})

const build = (runs: ObligationRun[], payments: ObligationPayment[] = [], today = '2027-01-05') =>
  buildObligations({ runs, payments, today })

const find = (runs: ObligationRun[], code: string, today = '2027-01-05') =>
  build(runs, [], today).filter((o) => o.code === code)

// --- the federal deposit, which is the one with a monthly heartbeat ---

test('wages paid in January are deposited by 15 February', () => {
  const [deposit] = find([run('2027-01-31')], '941-deposit')
  assert.equal(deposit.periodStart, '2027-01-01')
  assert.equal(deposit.periodEnd, '2027-01-31')
  assert.equal(deposit.dueOn, '2027-02-15')
  assert.equal(deposit.amountDueCents, 139_250)
})

test('two paychecks in one month make one deposit, not two', () => {
  const deposits = find([run('2027-01-15'), run('2027-01-31')], '941-deposit')
  assert.equal(deposits.length, 1)
  assert.equal(deposits[0].amountDueCents, 278_500)
})

// A due date on a weekend moves to the Monday. Federal holidays can push it
// one further, which this does NOT model — deliberately: showing a deadline
// a day EARLY can never cause a late payment, and showing one late can.
test('a deposit due on a Saturday moves to the Monday', () => {
  const [deposit] = find([run('2027-04-30')], '941-deposit')
  assert.equal(deposit.dueOn, '2027-05-17') // the 15th is a Saturday
})

test('a deposit due on a Sunday moves to the Monday', () => {
  const [deposit] = find([run('2027-07-30')], '941-deposit')
  assert.equal(deposit.dueOn, '2027-08-16') // the 15th is a Sunday
})

test('Illinois withholding is deposited separately from the federal amount', () => {
  const [il] = find([run('2027-01-31')], 'il-941-deposit')
  assert.equal(il.amountDueCents, 28_875)
  assert.equal(il.dueOn, '2027-02-15')
})

// --- the quarterly and annual ones ---

test('the quarterly 941 is a filing, not a payment — the money already went', () => {
  const [ret] = find([run('2027-04-30')], '941-return')
  assert.equal(ret.kind, 'filing')
  assert.equal(ret.amountDueCents, 0)
  assert.equal(ret.periodStart, '2027-04-01')
  assert.equal(ret.periodEnd, '2027-06-30')
  assert.equal(ret.dueOn, '2027-08-02') // 31 July is a Saturday
})

test('Illinois unemployment is quarterly, and is money', () => {
  const [ui] = find([run('2027-01-31'), run('2027-02-28')], 'il-ui')
  assert.equal(ui.kind, 'payment')
  assert.equal(ui.periodStart, '2027-01-01')
  assert.equal(ui.periodEnd, '2027-03-31')
  assert.equal(ui.dueOn, '2027-04-30') // a Friday
  assert.equal(ui.amountDueCents, 46_084)
})

// FUTA on a $70k salary is about $42 for the whole year, under the $500
// threshold that would force quarterly deposits — so it is one annual payment.
test('FUTA accrues across the year and is paid once, by 31 January', () => {
  const runs = ['2027-01-31', '2027-02-28', '2027-03-31'].map((d) => run(d))
  const futa = find(runs, '940')
  assert.equal(futa.length, 1)
  assert.equal(futa[0].periodStart, '2027-01-01')
  assert.equal(futa[0].periodEnd, '2027-12-31')
  assert.equal(futa[0].dueOn, '2028-01-31')
  assert.equal(futa[0].amountDueCents, 10_500)
})

test('each year gets its own FUTA obligation', () => {
  const futa = find([run('2027-06-30'), run('2028-06-30')], '940')
  assert.equal(futa.length, 2)
  assert.deepEqual(futa.map((o) => o.dueOn), ['2028-01-31', '2029-01-31'])
})

// --- payments against them ---

test('a payment in full closes the obligation', () => {
  const payments: ObligationPayment[] = [
    { code: '941-deposit', periodStart: '2027-01-01', periodEnd: '2027-01-31', amountCents: 139_250 },
  ]
  const deposit = build([run('2027-01-31')], payments, '2027-03-01')
    .find((o) => o.code === '941-deposit')
  assert.equal(deposit?.amountPaidCents, 139_250)
  assert.equal(deposit?.balanceCents, 0)
  assert.equal(deposit?.status, 'done')
})

test('a part payment leaves the balance owing, and still counts as behind', () => {
  const payments: ObligationPayment[] = [
    { code: '941-deposit', periodStart: '2027-01-01', periodEnd: '2027-01-31', amountCents: 100_000 },
  ]
  const deposit = build([run('2027-01-31')], payments, '2027-03-01')
    .find((o) => o.code === '941-deposit')
  assert.equal(deposit?.balanceCents, 39_250)
  assert.equal(deposit?.status, 'overdue')
})

test('a payment against another period does not close this one', () => {
  const payments: ObligationPayment[] = [
    { code: '941-deposit', periodStart: '2027-02-01', periodEnd: '2027-02-28', amountCents: 139_250 },
  ]
  const deposit = build([run('2027-01-31')], payments, '2027-03-01')
    .find((o) => o.code === '941-deposit')
  assert.equal(deposit?.amountPaidCents, 0)
})

// A filing has no money attached, so "done" has to come from somewhere else:
// a zero-amount record standing for "I filed this".
test('a filing is marked done by a record, not by an amount', () => {
  const payments: ObligationPayment[] = [
    { code: '941-return', periodStart: '2027-01-01', periodEnd: '2027-03-31', amountCents: 0 },
  ]
  const ret = build([run('2027-01-31')], payments, '2027-06-01')
    .find((o) => o.code === '941-return')
  assert.equal(ret?.status, 'done')
})

test('an unfiled return past its date is overdue even though nothing is owed', () => {
  const ret = build([run('2027-01-31')], [], '2027-06-01').find((o) => o.code === '941-return')
  assert.equal(ret?.amountDueCents, 0)
  assert.equal(ret?.status, 'overdue')
})

// --- status against today ---

test('an obligation past its date with a balance is overdue', () => {
  const deposit = build([run('2027-01-31')], [], '2027-03-01').find((o) => o.code === '941-deposit')
  assert.equal(deposit?.status, 'overdue')
})

test('an obligation coming up soon is due, and one far off is merely upcoming', () => {
  const soon = build([run('2027-01-31')], [], '2027-02-01').find((o) => o.code === '941-deposit')
  assert.equal(soon?.status, 'due')
  const later = build([run('2027-01-31')], [], '2027-01-02').find((o) => o.code === '941-deposit')
  assert.equal(later?.status, 'upcoming')
})

test('an obligation due today has not yet been missed', () => {
  const deposit = build([run('2027-01-31')], [], '2027-02-15').find((o) => o.code === '941-deposit')
  assert.equal(deposit?.status, 'due')
})

// --- shape ---

test('obligations come back in the order they fall due', () => {
  const all = build([run('2027-01-31'), run('2027-05-31')])
  const dates = all.map((o) => o.dueOn)
  assert.deepEqual(dates, [...dates].sort())
})

test('no payroll means nothing owed — not a list of empty periods', () => {
  assert.deepEqual(build([]), [])
})

test('every obligation carries a label a human can act on', () => {
  for (const o of build([run('2027-01-31')])) {
    assert.ok(o.label.trim().length > 0, o.code)
  }
})

test('a run with no tax owed still produces its filings', () => {
  const empty = run('2027-01-31', {
    federalDepositCents: 0, ilDepositCents: 0, futaCents: 0, ilSutaCents: 0,
  })
  const codes = build([empty]).map((o) => o.code)
  assert.ok(codes.includes('941-return'))
  assert.ok(codes.includes('il-941-return'))
})
