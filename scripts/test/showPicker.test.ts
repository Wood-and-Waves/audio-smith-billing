// Which show is Dan standing in — the one guess snap-a-receipt makes.
//
// A wrong pick files a receipt against the wrong client's invoice, so these
// pin the declining-to-guess cases at least as hard as the guessing one.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { showForToday, pickerCandidates, NEARBY_DAYS, type PickableShow } from '../../lib/showPicker.ts'

const show = (over: Partial<PickableShow> = {}): PickableShow => ({
  id: 's1', name: 'BMS', status: 'open', dates: ['2026-09-13'], ...over,
})

const TODAY = '2026-09-13'

test('today inside exactly one show picks it — the common case, no question asked', () => {
  const s = show({ dates: ['2026-09-12', '2026-09-13', '2026-09-14'] })
  assert.equal(showForToday([s], TODAY)?.id, 's1')
})

test('the first day of a show counts as inside', () => {
  const s = show({ dates: ['2026-09-13', '2026-09-14'] })
  assert.equal(showForToday([s], TODAY)?.id, 's1')
})

test('the last day of a show counts as inside', () => {
  const s = show({ dates: ['2026-09-12', '2026-09-13'] })
  assert.equal(showForToday([s], TODAY)?.id, 's1')
})

test('a gap day inside a run does NOT match — the dates are the truth, not the span', () => {
  // 9/12 and 9/14 are scheduled; 9/13 is a dark day with no show_days row.
  const s = show({ dates: ['2026-09-12', '2026-09-14'] })
  assert.equal(showForToday([s], TODAY), null)
})

test('two shows on the same day decline to guess — nothing in the data breaks the tie', () => {
  const a = show({ id: 'a', dates: [TODAY] })
  const b = show({ id: 'b', name: 'Other', dates: [TODAY] })
  assert.equal(showForToday([a, b], TODAY), null)
})

test('no show today declines to guess', () => {
  assert.equal(showForToday([show({ dates: ['2026-10-01'] })], TODAY), null)
})

test('a billed show is never picked — its expenses are frozen and addExpense refuses', () => {
  const s = show({ status: 'billed', dates: [TODAY] })
  assert.equal(showForToday([s], TODAY), null)
})

test('a billed show does not block an open one on the same day', () => {
  const billed = show({ id: 'b', status: 'billed', dates: [TODAY] })
  const open = show({ id: 'o', name: 'Open one', dates: [TODAY] })
  assert.equal(showForToday([billed, open], TODAY)?.id, 'o')
})

test('a show with no dates never matches', () => {
  assert.equal(showForToday([show({ dates: [] })], TODAY), null)
})

// pickerCandidates — the list shown when there is no automatic answer.

test('billed shows are omitted from the picker, not shown and refused', () => {
  const out = pickerCandidates(
    [show({ id: 'b', status: 'billed' }), show({ id: 'o', name: 'Open' })],
    TODAY,
  )
  assert.deepEqual(out.map((s) => s.id), ['o'])
})

test('shows within a week of today come first, nearest first', () => {
  const far = show({ id: 'far', name: 'Far', dates: ['2026-12-01'] })
  const near = show({ id: 'near', name: 'Near', dates: ['2026-09-15'] })
  const today = show({ id: 'today', name: 'Today', dates: [TODAY] })
  const out = pickerCandidates([far, near, today], TODAY)
  assert.deepEqual(out.map((s) => s.id), ['today', 'near', 'far'])
})

test('the nearby window boundary is inclusive at seven days', () => {
  const onEdge = show({ id: 'edge', name: 'Edge', dates: ['2026-09-20'] }) // +7
  const justOut = show({ id: 'out', name: 'Out', dates: ['2026-09-21'] })  // +8
  const out = pickerCandidates([justOut, onEdge], TODAY)
  assert.equal(NEARBY_DAYS, 7)
  assert.deepEqual(out.map((s) => s.id), ['edge', 'out'])
})

test('a show a week BEFORE today is just as near as one a week after', () => {
  const before = show({ id: 'before', name: 'Before', dates: ['2026-09-06'] })
  const after = show({ id: 'after', name: 'After', dates: ['2026-09-20'] })
  const out = pickerCandidates([after, before], TODAY)
  // Equal distance — the deterministic tail orders them by name.
  assert.deepEqual(out.map((s) => s.id), ['after', 'before'])
})

test('a show with no dates is still offered, but last', () => {
  const dateless = show({ id: 'none', name: 'Dateless', dates: [] })
  const dated = show({ id: 'dated', name: 'Dated', dates: [TODAY] })
  const out = pickerCandidates([dateless, dated], TODAY)
  assert.deepEqual(out.map((s) => s.id), ['dated', 'none'])
})

test('ordering is deterministic when two shows sit the same distance away', () => {
  const b = show({ id: 'b', name: 'Bravo', dates: ['2026-09-15'] })
  const a = show({ id: 'a', name: 'Alpha', dates: ['2026-09-15'] })
  assert.deepEqual(pickerCandidates([b, a], TODAY).map((s) => s.id), ['a', 'b'])
  assert.deepEqual(pickerCandidates([a, b], TODAY).map((s) => s.id), ['a', 'b'])
})

test('a multi-day show is measured by its NEAREST date, not its first', () => {
  // Runs 9/20-9/30; its nearest day is 7 out, so it is "nearby".
  const late = show({ id: 'late', name: 'Late', dates: ['2026-09-20', '2026-09-30'] })
  const other = show({ id: 'other', name: 'Other', dates: ['2026-09-25'] })
  const out = pickerCandidates([other, late], TODAY)
  assert.deepEqual(out.map((s) => s.id), ['late', 'other'])
})
