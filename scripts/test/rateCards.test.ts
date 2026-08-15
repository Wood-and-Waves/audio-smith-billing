import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defaultCardOf, deriveFromDayRate, isDerivableDayRate } from '../../lib/rateCards.ts'

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

test('deriveFromDayRate halves the day rate for travel', () => {
  assert.deepEqual(deriveFromDayRate(78000, 10), { travel_rate_cents: 39000, pm_rate_cents: 7800 })
})

test('deriveFromDayRate follows a changed day rate, not the original one', () => {
  // The bug this exists to prevent: $780 -> $900 must carry travel/PM to
  // $450/$90, never leave them at the $780-derived $390/$78.
  assert.deepEqual(deriveFromDayRate(90000, 10), { travel_rate_cents: 45000, pm_rate_cents: 9000 })
})

test('deriveFromDayRate rounds the PM rate to the nearest cent', () => {
  assert.deepEqual(deriveFromDayRate(100000, 3), { travel_rate_cents: 50000, pm_rate_cents: 33333 })
})

test('deriveFromDayRate treats a zero overtime threshold as no PM rate rather than dividing by zero', () => {
  assert.deepEqual(deriveFromDayRate(78000, 0), { travel_rate_cents: 39000, pm_rate_cents: 0 })
})

test('deriveFromDayRate rounds an odd-cent day rate half away from zero for travel too', () => {
  assert.deepEqual(deriveFromDayRate(78001, 10), { travel_rate_cents: 39001, pm_rate_cents: 7800 })
})

test('isDerivableDayRate rejects an emptied box (parseUSD("") === 0), not just junk', () => {
  // The bug this exists to prevent: a `=== null` check alone lets a
  // cleared day-rate box (parseUSD("") -> 0) re-derive travel/PM from $0.
  assert.equal(isDerivableDayRate(0), false)
})

test('isDerivableDayRate rejects junk input (parseUSD returns null)', () => {
  assert.equal(isDerivableDayRate(null), false)
})

test('isDerivableDayRate rejects a negative day rate', () => {
  assert.equal(isDerivableDayRate(-100), false)
})

test('isDerivableDayRate accepts a real positive day rate', () => {
  assert.equal(isDerivableDayRate(78000), true)
})
