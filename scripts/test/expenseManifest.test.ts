// Parsing the expense spreadsheet Dan attaches to an invoice.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseExpenseManifest, type ManifestCell } from '../../lib/expenseManifest.ts'

// Praxis page 1 and IllumiNations page 2, captured verbatim from pdfjs on
// 2026-09-10. Do not tidy these: the differing x scales are the point, and
// "United $10.00" on the last Praxis row is an inflight snack sitting in the
// FOOD column, which is why column comes from position and never from a name.
const c = (x: number, text: string): ManifestCell => ({ x, text })

const PRAXIS: ManifestCell[][] = [
  [c(153, 'Food Total'), c(351, 'Ride Total'), c(507, 'Baggage Total'), c(671, 'Total')],
  [c(160, '$266.21'), c(363, '$0.00'), c(523, '$120.00'), c(665, '$386.21')],
  [c(111, 'Where'), c(200, 'Amount'), c(260, 'Rcpt'), c(308, 'Where'), c(380, 'Amount'), c(440, 'Rcpt'), c(488, 'Where'), c(560, 'Amount'), c(620, 'Rcpt')],
  [c(106, 'The Well'), c(204, '$19.98'), c(489, 'United'), c(564, '$60.00')],
  [c(96, "Auntie Anne's"), c(204, '$12.28'), c(489, 'United'), c(564, '$60.00')],
  [c(81, 'Meritage Blend Cafe'), c(206, '$8.98')],
  [c(81, 'Meritage Blend Cafe'), c(206, '$8.98')],
  [c(92, 'Butters Burgers'), c(204, '$35.23')],
  [c(81, 'The Meritage Resort'), c(204, '$24.38')],
  [c(97, "Ben & Jerry's"), c(204, '$12.65')],
  [c(81, 'The Meritage Resort'), c(204, '$62.20')],
  [c(81, 'The Meritage Resort'), c(204, '$24.38')],
  [c(81, 'The Meritage Resort'), c(204, '$47.15')],
  [c(111, 'United'), c(204, '$10.00')],
]

// No fourth "Total" column, and a different x scale entirely.
const ILLUMINATIONS: ManifestCell[][] = [
  [c(124, 'Food Total'), c(295, 'Ride Total'), c(433, 'Baggage Total')],
  [c(130, '$190.34'), c(305, '$0.00'), c(447, '$120.00')],
  [c(86, 'Where'), c(160, 'Amount'), c(214, 'Rcpt'), c(256, 'Where'), c(320, 'Amount'), c(373, 'Rcpt'), c(416, 'Where'), c(480, 'Amount'), c(533, 'Rcpt')],
  [c(79, 'Empanada'), c(164, '$13.39'), c(416, 'United'), c(483, '$60.00')],
  [c(62, "Dave's Hot Chicken"), c(164, '$23.09'), c(416, 'United'), c(483, '$60.00')],
  [c(84, 'Fiddlers'), c(164, '$67.25')],
  [c(76, 'Dairy Queen'), c(166, '$7.90')],
  [c(64, 'Southern Grounds'), c(166, '$5.18')],
  [c(74, 'Auntie Annes'), c(164, '$11.16')],
  [c(85, 'Hudson'), c(164, '$31.19')],
  [c(80, 'Starbucks'), c(166, '$4.76')],
  [c(80, 'Starbucks'), c(164, '$12.14')],
  [c(80, 'Starbucks'), c(166, '$4.76')],
  [c(80, 'Starbucks'), c(166, '$4.76')],
  [c(80, 'Starbucks'), c(166, '$4.76')],
]

test('every line is read, with its amount in cents', () => {
  const m = parseExpenseManifest(PRAXIS)
  assert.equal(m.items.length, 13)
  assert.deepEqual(m.items[0], { vendor: 'The Well', amountCents: 1998, column: 'food' })
})

test('a bundle with no fourth Total column reads the same way', () => {
  const m = parseExpenseManifest(ILLUMINATIONS)
  assert.equal(m.items.length, 14)
  assert.equal(m.totals.food, 19034)
  assert.equal(m.totals.baggage, 12000)
  assert.equal(m.totals.stated, null)
  assert.equal(m.foots, true)
})

test('the columns foot, which is the check the whole backfill leans on', () => {
  const m = parseExpenseManifest(PRAXIS)
  assert.equal(m.totals.food, 26621)
  assert.equal(m.totals.baggage, 12000)
  assert.equal(m.totals.ride, 0)
  assert.equal(m.totals.stated, 38621)
  assert.equal(m.foots, true)
})

test('the two baggage lines are baggage and the inflight United is food', () => {
  const m = parseExpenseManifest(PRAXIS)
  const bags = m.items.filter(i => i.column === 'baggage')
  assert.equal(bags.length, 2)
  assert.ok(bags.every(b => b.amountCents === 6000))
  assert.ok(m.items.some(i => i.column === 'food' && i.amountCents === 1000))
})

test('an empty Ride column contributes no items', () => {
  const m = parseExpenseManifest(PRAXIS)
  assert.equal(m.items.filter(i => i.column === 'ride').length, 0)
})

test('a row with two amounts is two items, one per column', () => {
  const m = parseExpenseManifest(ILLUMINATIONS)
  const first = m.items.filter(i => i.amountCents === 1339 || i.amountCents === 6000)
  assert.equal(first.length, 3) // one Empanada + two United bag fees
  assert.equal(m.items.filter(i => i.column === 'baggage').length, 2)
})

test('a table that does not foot says so rather than throwing', () => {
  const bad = PRAXIS.map(r => [...r])
  bad[1][0] = c(160, '$999.99')
  const m = parseExpenseManifest(bad)
  assert.equal(m.foots, false)
  assert.equal(m.items.length, 13)
})

test('an empty page is empty, not an error', () => {
  const m = parseExpenseManifest([])
  assert.deepEqual(m.items, [])
  assert.equal(m.foots, false)
})

test('a page that is not a manifest at all yields nothing', () => {
  const m = parseExpenseManifest([[c(70, 'Thanks!')], [c(70, 'Dan Smith')]])
  assert.deepEqual(m.items, [])
  assert.equal(m.foots, false)
})
