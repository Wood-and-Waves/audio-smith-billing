// Calendar quarters and the Reports screen's range, pinned. Dan needs these
// figures for estimated quarterly taxes, so a wrong quarter boundary is a
// wrong number sent to the IRS.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { quarterRange, yearRange, resolveRange } from '../../lib/reportRange.ts'

test('the four calendar quarters have the boundaries the IRS uses', () => {
  assert.deepEqual(quarterRange(2026, 1), { from: '2026-01-01', to: '2026-03-31' })
  assert.deepEqual(quarterRange(2026, 2), { from: '2026-04-01', to: '2026-06-30' })
  assert.deepEqual(quarterRange(2026, 3), { from: '2026-07-01', to: '2026-09-30' })
  assert.deepEqual(quarterRange(2026, 4), { from: '2026-10-01', to: '2026-12-31' })
})

// No quarter ends in February, so a leap year cannot move any boundary here.
test('a leap year moves no quarter boundary', () => {
  assert.deepEqual(quarterRange(2028, 1), { from: '2028-01-01', to: '2028-03-31' })
})

test('a year range spans January 1 to December 31', () => {
  assert.deepEqual(yearRange(2026), { from: '2026-01-01', to: '2026-12-31' })
})

test('resolveRange passes a good range through untouched', () => {
  assert.deepEqual(
    resolveRange('2026-07-01', '2026-09-30', '2026-09-09'),
    { from: '2026-07-01', to: '2026-09-30' },
  )
})

// The screen has no destructive action, so an unreadable URL must not cost
// Dan the page — every bad input falls back to the current year.
test('resolveRange falls back to the current year on anything unusable', () => {
  const y2026 = { from: '2026-01-01', to: '2026-12-31' }
  assert.deepEqual(resolveRange(undefined, undefined, '2026-09-09'), y2026)
  assert.deepEqual(resolveRange('2026-07-01', undefined, '2026-09-09'), y2026)
  assert.deepEqual(resolveRange(undefined, '2026-09-30', '2026-09-09'), y2026)
  assert.deepEqual(resolveRange('garbage', '2026-09-30', '2026-09-09'), y2026)
  assert.deepEqual(resolveRange('2026-07-01', '2026-13-45', '2026-09-09'), y2026)
})

// A reversed range would silently report zero of everything, which reads as
// "you earned nothing this quarter" rather than as a broken URL.
test('resolveRange refuses a reversed range', () => {
  assert.deepEqual(
    resolveRange('2026-09-30', '2026-07-01', '2026-09-09'),
    { from: '2026-01-01', to: '2026-12-31' },
  )
})

test('a single-day range is legitimate and passes through', () => {
  assert.deepEqual(
    resolveRange('2026-09-09', '2026-09-09', '2026-09-09'),
    { from: '2026-09-09', to: '2026-09-09' },
  )
})
