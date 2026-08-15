import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defaultCardOf, deriveFromDayRate } from '../../lib/rateCards.ts'

test('defaultCardOf picks the unnamed card', () => {
  const cards = [{ name: 'PM', v: 1 }, { name: null, v: 2 }]
  assert.deepEqual(defaultCardOf(cards), { name: null, v: 2 })
})

test('defaultCardOf is null when every card is named', () => {
  assert.equal(defaultCardOf([{ name: 'PM' }, { name: 'Rehearsal' }]), null)
})

test('defaultCardOf is null with no cards at all', () => {
  assert.equal(defaultCardOf([]), null)
})

test('deriveFromDayRate halves the day rate for travel by default', () => {
  assert.deepEqual(deriveFromDayRate(78000, 10, false), { travel_rate_cents: 39000, pm_rate_cents: 7800 })
})

test('deriveFromDayRate bills a full day rate for travel when the card says so', () => {
  assert.deepEqual(
    deriveFromDayRate(90000, 10, true),
    { travel_rate_cents: 90000, pm_rate_cents: 9000 },
  )
})

test('deriveFromDayRate follows a changed day rate, not the original one', () => {
  // The bug this exists to prevent: $780 -> $900 must carry travel/PM to
  // $450/$90, never leave them at the $780-derived $390/$78.
  assert.deepEqual(deriveFromDayRate(90000, 10, false), { travel_rate_cents: 45000, pm_rate_cents: 9000 })
})

test('deriveFromDayRate rounds the PM rate to the nearest cent', () => {
  assert.deepEqual(deriveFromDayRate(100000, 3, false), { travel_rate_cents: 50000, pm_rate_cents: 33333 })
})

test('deriveFromDayRate treats a zero overtime threshold as no PM rate rather than dividing by zero', () => {
  assert.deepEqual(deriveFromDayRate(78000, 0, false), { travel_rate_cents: 39000, pm_rate_cents: 0 })
})
