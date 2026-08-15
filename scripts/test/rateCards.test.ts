import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defaultCardOf } from '../../lib/rateCards.ts'

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
