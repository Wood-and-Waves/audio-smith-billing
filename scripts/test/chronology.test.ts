import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chronologyError, isIncompleteDay, isUnfinishedDay } from '../../lib/chronology.ts'

const at = (h: number) => `2026-08-10T${String(h).padStart(2, '0')}:00:00Z`

test('a punch cannot land before the one that precedes it', () => {
  const existing = [{ punch_type: 'start', punched_at: at(13) }]
  assert.match(chronologyError('end', at(12), existing) ?? '', /after/i)
  assert.equal(chronologyError('end', at(23), existing), null)
})

test('a meal cannot end before it began', () => {
  const existing = [
    { punch_type: 'start', punched_at: at(13) },
    { punch_type: 'meal_out', punched_at: at(18) },
  ]
  assert.match(chronologyError('meal_in', at(17), existing) ?? '', /after/i)
  assert.equal(chronologyError('meal_in', at(19), existing), null)
})

test('a duplicate punch type is refused', () => {
  const existing = [{ punch_type: 'start', punched_at: at(13) }]
  assert.match(chronologyError('start', at(14), existing) ?? '', /already/i)
})

test('a punch cannot land after the one that follows it', () => {
  const existing = [{ punch_type: 'end', punched_at: at(20) }]
  assert.match(chronologyError('meal_in', at(21), existing) ?? '', /before/i)
  assert.equal(chronologyError('meal_in', at(19), existing), null)
})

test('a complete day with paired meals is not incomplete', () => {
  const punches = [
    { punch_type: 'start' }, { punch_type: 'meal_out' }, { punch_type: 'meal_in' },
    { punch_type: 'end' },
  ]
  assert.equal(isIncompleteDay(punches), false)
})

test('a day with no punches at all is not incomplete', () => {
  assert.equal(isIncompleteDay([]), false)
})

test('an unfinished start/end pair is incomplete', () => {
  assert.equal(isIncompleteDay([{ punch_type: 'start' }]), true)
})

// This is the bug from the finding: punching out for a meal and forgetting
// to punch back in must be caught even though start/end are both present —
// otherwise the break silently bills as worked time.
test('an unpaired meal punch is incomplete even with both start and end present', () => {
  const punches = [
    { punch_type: 'start' }, { punch_type: 'meal_out' }, { punch_type: 'end' },
  ]
  assert.equal(isIncompleteDay(punches), true)
})

test('an unpaired second meal punch is incomplete too', () => {
  const punches = [
    { punch_type: 'start' }, { punch_type: 'meal_out' }, { punch_type: 'meal_in' },
    { punch_type: 'meal2_out' }, { punch_type: 'end' },
  ]
  assert.equal(isIncompleteDay(punches), true)
})

test('a punch at the same moment as another is rejected', () => {
  // The picker prefills a later punch from the previous one, so saving without
  // touching the time is a single careless tap. An out equal to its in is a
  // zero-length day; a meal that starts and ends at once is not a break.
  const existing = [{ punch_type: 'start', punched_at: at(9) }]
  assert.match(chronologyError('end', at(9), existing) ?? '', /after/i)
  assert.equal(chronologyError('end', at(9.25), existing), null, 'a quarter hour later is fine')

  const withEnd = [
    { punch_type: 'start', punched_at: at(9) },
    { punch_type: 'end', punched_at: at(18) },
  ]
  assert.match(chronologyError('meal_out', at(18), withEnd) ?? '', /before/i)
})

// isUnfinishedDay — the billing gate. A day blocks billing when it has a
// dangling punch OR is empty and not travel-only (a day likely forgotten).
const day = (
  punches: { punch_type: string }[],
  travel_in = false,
  travel_out = false,
) => ({ punches, travel_in, travel_out })

test('a completed work day is finished', () => {
  assert.equal(isUnfinishedDay(day([{ punch_type: 'start' }, { punch_type: 'end' }])), false)
})

test('a dangling clock-in blocks — the case Dan hit', () => {
  assert.equal(isUnfinishedDay(day([{ punch_type: 'start' }])), true)
})

test('a dangling meal blocks even with start and end present', () => {
  assert.equal(
    isUnfinishedDay(day([{ punch_type: 'start' }, { punch_type: 'meal_out' }, { punch_type: 'end' }])),
    true,
  )
})

test('an empty day with no travel blocks — the forgotten day', () => {
  // The whole point of this rule: a day added but never clocked would otherwise
  // bill nothing and quietly under-bill the show.
  assert.equal(isUnfinishedDay(day([])), true)
})

test('an empty day marked travel is finished — a legit fly day', () => {
  assert.equal(isUnfinishedDay(day([], true, false)), false)
  assert.equal(isUnfinishedDay(day([], false, true)), false)
})

test('a worked day that is also a travel day is finished', () => {
  assert.equal(
    isUnfinishedDay(day([{ punch_type: 'start' }, { punch_type: 'end' }], true)),
    false,
  )
})
