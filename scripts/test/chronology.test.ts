import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chronologyError } from '../../lib/chronology.ts'

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
