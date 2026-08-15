// Catching a receipt that has already been added.
//
// The hard part is not finding repeats — it is not crying wolf. Dan buys two
// coffees at the same airport Starbucks on the same day, and both are real.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  dropExactRepeats, receiptKey, duplicateOf, markDuplicates, type NamedCandidate,
} from '../../lib/receiptDuplicates.ts'

const at = (vendor: string | null, amountCents: number | null, spentOn: string | null) =>
  ({ vendor, amountCents, spentOn })
const named = (label: string, v: string | null, a: number | null, d: string | null): NamedCandidate =>
  ({ label, ...at(v, a, d) })

test('the same file picked twice is dropped, and the first keeps its place', () => {
  const { kept, dropped } = dropExactRepeats([
    { name: 'a.jpg', hash: 'AAA' },
    { name: 'b.jpg', hash: 'BBB' },
    { name: 'a-again.jpg', hash: 'AAA' },
    { name: 'c.jpg', hash: 'CCC' },
  ])
  assert.equal(dropped, 1)
  assert.deepEqual(kept.map((f) => f.name), ['a.jpg', 'b.jpg', 'c.jpg'])
})

test('different bytes are always kept, however alike they look', () => {
  // Two photographs of one receipt have different bytes. That case is the
  // FLAG's job, not this one's — the exact check is bytes and nothing else.
  const { kept, dropped } = dropExactRepeats([
    { name: 'shot1.jpg', hash: 'AAA' },
    { name: 'shot2.jpg', hash: 'BBB' },
  ])
  assert.equal(dropped, 0)
  assert.equal(kept.length, 2)
})

test('vendor, amount and date all agreeing is flagged', () => {
  const match = duplicateOf(at('HMS Host', 1998, '2026-08-22'), [
    named('Uber', 'Uber', 4310, '2026-08-22'),
    named('HMS Host', 'HMS Host', 1998, '2026-08-22'),
  ])
  assert.equal(match, 'HMS Host')
})

test('a different amount is not a duplicate — two coffees are two coffees', () => {
  // The case that makes this a flag rather than a delete.
  assert.equal(
    duplicateOf(at('Starbucks', 632, '2026-08-22'), [
      named('Starbucks', 'Starbucks', 598, '2026-08-22'),
    ]),
    null,
  )
})

test('a different date is not a duplicate', () => {
  assert.equal(
    duplicateOf(at('HMS Host', 1998, '2026-08-23'), [
      named('HMS Host', 'HMS Host', 1998, '2026-08-22'),
    ]),
    null,
  )
})

test('the vendor is compared as it comes off a photograph', () => {
  // OCR will not read the same name identically twice.
  assert.equal(
    duplicateOf(at('  hms   HOST ', 1998, '2026-08-22'), [
      named('HMS Host', 'HMS Host', 1998, '2026-08-22'),
    ]),
    'HMS Host',
  )
})

test('an expense already on the show counts as something to repeat', () => {
  // The case Dan actually described: photographing the same receipt a week
  // apart. A batch-only check would miss it entirely.
  assert.equal(
    duplicateOf(at('United', 6000, '2026-08-22'), [
      named('an expense already on this show', 'United', 6000, '2026-08-22'),
    ]),
    'an expense already on this show',
  )
})

test('a receipt with no amount is never a duplicate of anything', () => {
  // OCR returns null for an amount it cannot read. Without this, every
  // unreadable receipt in a batch would be flagged as a repeat of the last
  // unreadable one — a warning on exactly the rows that need typing.
  assert.equal(receiptKey(at('HMS Host', null, '2026-08-22')), null)
  assert.equal(
    duplicateOf(at(null, null, null), [named('also unreadable', null, null, null)]),
    null,
  )
  assert.equal(
    duplicateOf(at('HMS Host', null, '2026-08-22'), [
      named('same vendor and day', 'HMS Host', null, '2026-08-22'),
    ]),
    null,
  )
})

test('a missing date also makes it incomparable', () => {
  assert.equal(receiptKey(at('HMS Host', 1998, null)), null)
})

test('a missing vendor still compares on amount and date', () => {
  // An unreadable vendor with a clear total is still identifiable — and this
  // is the shape a faded thermal receipt actually arrives in.
  assert.equal(
    duplicateOf(at(null, 1998, '2026-08-22'), [named('blank too', null, 1998, '2026-08-22')]),
    'blank too',
  )
})

test('nothing earlier means nothing to duplicate', () => {
  assert.equal(duplicateOf(at('HMS Host', 1998, '2026-08-22'), []), null)
})

test('the settle pass catches a duplicate the incremental check would miss', () => {
  // Rows 1 and 3 are the same receipt. With three workers in flight, row 3 can
  // finish before row 1 has an amount to compare against — so the incremental
  // check clears it. Walking by position gives the same answer regardless of
  // who finished first.
  const rows: NamedCandidate[] = [
    named('HMS Host', 'HMS Host', 1998, '2026-08-22'),
    named('Uber', 'Uber', 4310, '2026-08-22'),
    named('HMS Host (again)', 'HMS Host', 1998, '2026-08-22'),
  ]
  assert.deepEqual(markDuplicates(rows, []), [null, null, 'HMS Host'])
})

test('the settle pass flags only the later copy, never the first', () => {
  const rows: NamedCandidate[] = [
    named('first', 'United', 6000, '2026-08-22'),
    named('second', 'United', 6000, '2026-08-22'),
    named('third', 'United', 6000, '2026-08-22'),
  ]
  assert.deepEqual(markDuplicates(rows, []), [null, 'first', 'first'])
})

test('the settle pass also sees expenses already on the show', () => {
  assert.deepEqual(
    markDuplicates(
      [named('new photo', 'United', 6000, '2026-08-22')],
      [named('already on this show', 'United', 6000, '2026-08-22')],
    ),
    ['already on this show'],
  )
})
