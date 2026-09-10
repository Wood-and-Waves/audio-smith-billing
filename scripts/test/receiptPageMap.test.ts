// Validating which page of a bundle holds which receipt.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readPageMap } from '../../lib/receiptPageMap.ts'

const ok = {
  pages: [
    { page: 3, vendor: 'Starbucks', amount: '4.76' },
    { page: 4, vendor: 'Dairy Queen', amount: '7.90' },
  ],
}

test('a good map reads through, amounts in cents', () => {
  const r = readPageMap(ok, { pageCount: 16 })
  assert.ok(!('error' in r))
  assert.deepEqual(r.pages[0], { page: 3, vendor: 'Starbucks', amountCents: 476 })
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
