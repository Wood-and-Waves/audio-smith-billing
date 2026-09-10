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

// PwC page 1: the same layout, but the first column is labelled "Expenses
// Total" rather than "Food Total". Nothing else differs.
const PWC: ManifestCell[][] = [
  [c(120, 'Expenses Total'), c(300, 'Ride Total'), c(440, 'Baggage Total'), c(600, 'Total')],
  [c(126, '$352.14'), c(310, '$0.00'), c(455, '$0.00'), c(596, '$352.14')],
  [c(84, 'Where'), c(158, 'Amount'), c(212, 'Rcpt'), c(254, 'Where'), c(318, 'Amount'), c(371, 'Rcpt'), c(414, 'Where'), c(478, 'Amount'), c(531, 'Rcpt')],
  [c(70, 'HMS Host'), c(162, '$8.21')],
  [c(70, 'HMS Host'), c(162, '$26.69')],
  [c(74, 'Hudson'), c(162, '$24.45')],
  [c(66, 'The Market'), c(162, '$15.80')],
  [c(62, 'Home Depot'), c(160, '$129.78')],
  [c(70, 'Starbucks'), c(162, '$17.32')],
  [c(78, 'Fed Ex'), c(164, '$4.00')],
  [c(68, 'Strarbucks'), c(162, '$13.31')],
  [c(70, 'HMS Host'), c(162, '$27.46')],
  [c(72, 'Amazon'), c(162, '$85.12')],
]

test('a sheet headed "Expenses Total" reads the same as one headed "Food Total"', () => {
  const m = parseExpenseManifest(PWC)
  assert.equal(m.items.length, 10)
  assert.equal(m.totals.food, 35214)
  assert.equal(m.totals.stated, 35214)
  assert.equal(m.foots, true)
  assert.deepEqual(m.items[0], { vendor: 'HMS Host', amountCents: 821, column: 'food' })
})

// IMC page 1: the richest layout. An HOURS block sits to the LEFT of the
// expense columns — Date / Day / Time / Notes / Total OT — and its cells must
// not be swept into a vendor name. This one also has a real Ride column.
const IMC: ManifestCell[][] = [
  [c(730, 'IMC 3/26')],
  [c(143, 'Hours'), c(315, 'Food Total'), c(461, 'Ride Total'), c(580, 'Baggage Total'), c(704, 'Total')],
  [c(55, 'Date'), c(80, 'Day'), c(121, 'Time'), c(176, 'Notes'), c(218, 'Total OT'), c(320, '$118.99'), c(470, '$6.55'), c(592, '$100.00'), c(699, '$225.54')],
  [c(56, '3/13'), c(82, 'Fri'), c(119, 'Travel'), c(232, '0'), c(283, 'Where'), c(346, 'Amount'), c(392, 'Rcpt'), c(428, 'Where'), c(483, 'Amount'), c(528, 'Rcpt'), c(565, 'Where'), c(620, 'Amount'), c(665, 'Rcpt')],
  [c(56, '3/14'), c(81, 'Sat'), c(114, '7:30a- 8p'), c(169, '1 hr Lunch'), c(232, '2'), c(282, 'Garrets'), c(349, '$12.78'), c(428, 'To Yolk'), c(487, '$3.03'), c(566, 'United'), c(623, '$50.00')],
  [c(56, '3/15'), c(80, 'Sun'), c(113, '9a-11:20p'), c(232, '5'), c(286, 'HMS'), c(349, '$10.93'), c(423, 'From Yolk'), c(487, '$3.52'), c(566, 'United'), c(623, '$50.00')],
  [c(56, '3/16'), c(79, 'Mon'), c(110, '6:30a-6:30p'), c(232, '2'), c(273, 'Open Market'), c(349, '$25.90')],
  [c(56, '3/17'), c(81, 'Tue'), c(110, '5:50a-7:45p'), c(232, '4'), c(275, 'Open Pallet'), c(349, '$34.23')],
  [c(56, '3/18'), c(79, 'Wed'), c(113, '6:30a-10p'), c(232, '6'), c(287, 'Yolk'), c(349, '$35.15')],
  [c(56, '3/19'), c(80, 'Thu'), c(119, 'Travel'), c(232, '0')],
]

test('an hours block to the left is not mistaken for a vendor', () => {
  const m = parseExpenseManifest(IMC)
  const garrets = m.items.find(i => i.amountCents === 1278)
  assert.deepEqual(garrets, { vendor: 'Garrets', amountCents: 1278, column: 'food' })
  const hms = m.items.find(i => i.amountCents === 1093)
  assert.equal(hms.vendor, 'HMS')
})

test('IMC has a real Ride column, and it reads as rides', () => {
  const m = parseExpenseManifest(IMC)
  const rides = m.items.filter(i => i.column === 'ride')
  assert.deepEqual(rides.map(r => r.amountCents), [303, 352])
  assert.deepEqual(rides.map(r => r.vendor), ['To Yolk', 'From Yolk'])
  assert.equal(m.totals.ride, 655)
})

test('IMC foots across all three columns', () => {
  const m = parseExpenseManifest(IMC)
  assert.equal(m.totals.food, 11899)
  assert.equal(m.totals.baggage, 10000)
  assert.equal(m.foots, true)
})
