// Validating which page of a bundle holds which receipt.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readPageMap, collapseRepeatedPages } from '../../lib/receiptPageMap.ts'

const ok = {
  pages: [
    { page: 3, vendor: 'Starbucks', amount: '4.76', date: '2026-04-29' },
    { page: 4, vendor: 'Dairy Queen', amount: '7.90', date: null },
  ],
}

test('a good map reads through, amounts in cents', () => {
  const r = readPageMap(ok, { pageCount: 16 })
  assert.ok(!('error' in r))
  assert.deepEqual(r.pages[0],
    { page: 3, vendor: 'Starbucks', amountCents: 476, spentOn: '2026-04-29' })
  assert.equal(r.pages.length, 2)
})

test('a page beyond the document is refused', () => {
  const r = readPageMap({ pages: [{ page: 99, vendor: 'x', amount: '1.00' }] }, { pageCount: 16 })
  assert.ok('error' in r)
  assert.match(r.error, /page/i)
})

test('page zero is refused — pages are 1-based', () => {
  const r = readPageMap({ pages: [{ page: 0, vendor: 'x', amount: '1.00' }] }, { pageCount: 16 })
  assert.ok('error' in r)
})

test('the same page claimed twice is refused', () => {
  const dup = { pages: [ok.pages[0], { ...ok.pages[0] }] }
  const r = readPageMap(dup, { pageCount: 16 })
  assert.ok('error' in r)
  assert.match(r.error, /twice|duplicate/i)
})

test('an unreadable amount is refused, never guessed', () => {
  const r = readPageMap({ pages: [{ page: 2, vendor: 'x', amount: 'about five dollars' }] }, { pageCount: 4 })
  assert.ok('error' in r)
})

test('a blank vendor is refused', () => {
  const r = readPageMap({ pages: [{ page: 2, vendor: '   ', amount: '1.00' }] }, { pageCount: 4 })
  assert.ok('error' in r)
})

test('junk is an error, never a throw', () => {
  for (const bad of [null, undefined, {}, { pages: 'no' }, { pages: [{ page: 1 }] }, 42, []]) {
    const r = readPageMap(bad, { pageCount: 4 })
    assert.ok('error' in r, `expected an error for ${JSON.stringify(bad)}`)
  }
})

test('an empty map is legal — a bundle may hold no receipt images at all', () => {
  const r = readPageMap({ pages: [] }, { pageCount: 2 })
  assert.ok(!('error' in r))
  assert.deepEqual(r.pages, [])
})

// --- collapseRepeatedPages ---------------------------------------------------

const entry = (page: number, vendor: string, amountCents: number) =>
  ({ page, vendor, amountCents, spentOn: null })

test('one receipt printed across two pages counts once', () => {
  // PepsiCo, pages 5 and 6: the same Uber twice.
  const kept = collapseRepeatedPages([entry(5, 'Uber', 8394), entry(6, 'Uber', 8394)])
  assert.deepEqual(kept, [entry(5, 'Uber', 8394)])
})

test('three consecutive pages of the same receipt still count once', () => {
  const kept = collapseRepeatedPages([
    entry(1, 'United Airlines', 6000), entry(2, 'United Airlines', 6000), entry(3, 'United Airlines', 6000),
  ])
  assert.equal(kept.length, 1)
})

test('the same amount on NON-adjacent pages is two receipts', () => {
  // Two $60 bag fees, one each way, with the trip's receipts in between.
  const kept = collapseRepeatedPages([
    entry(2, 'United', 6000), entry(7, 'Starbucks', 476), entry(11, 'United', 6000),
  ])
  assert.equal(kept.length, 3)
})

test('adjacent pages differing in amount are both kept', () => {
  const kept = collapseRepeatedPages([entry(5, 'Uber', 8394), entry(6, 'Uber', 12353)])
  assert.equal(kept.length, 2)
})

test('adjacent pages differing in vendor are both kept', () => {
  const kept = collapseRepeatedPages([entry(5, 'Uber', 8394), entry(6, 'Lyft', 8394)])
  assert.equal(kept.length, 2)
})

test('an empty map collapses to nothing', () => {
  assert.deepEqual(collapseRepeatedPages([]), [])
})

test('a receipt with no legible date reads as null, not a guess', () => {
  const r = readPageMap(ok, { pageCount: 16 })
  assert.ok(!('error' in r))
  assert.equal(r.pages[1].spentOn, null)
})

test("a date the model invents in the wrong shape is dropped, not stored", () => {
  const r = readPageMap({ pages: [{ page: 1, vendor: 'x', amount: '1.00', date: 'April 29' }] },
    { pageCount: 4 })
  assert.ok(!('error' in r))
  assert.equal(r.pages[0].spentOn, null)
})

test('a backfill date from last year survives — it is shape-checked, not aged', () => {
  const r = readPageMap({ pages: [{ page: 1, vendor: 'x', amount: '1.00', date: '2026-01-24' }] },
    { pageCount: 4 })
  assert.ok(!('error' in r))
  assert.equal(r.pages[0].spentOn, '2026-01-24')
})
