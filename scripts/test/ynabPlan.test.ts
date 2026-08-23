// YNAB's Plan export -> budget rows. Fixtures are invented; Dan's real figures
// stay out of the repository.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseYnabPlan } from '../../lib/ynabPlan.ts'

const HEADER = '"Month","Category Group/Category","Category Group","Category","Assigned","Activity","Available"'
const csv = (...lines: string[]) => [HEADER, ...lines].join('\n') + '\n'

test('a plain row parses into cents and a YYYY-MM month', () => {
  const [row] = parseYnabPlan(csv('"Aug 2026","Bills: Insurance","Bills","Insurance",$427.00,$0.00,$35.00'))
  assert.deepEqual(row, {
    month: '2026-08', grp: 'Bills', category: 'Insurance',
    assignedCents: 42_700, activityCents: 0, availableCents: 3_500,
  })
})

test('a negative carries its minus before the dollar sign', () => {
  const [row] = parseYnabPlan(csv('"Aug 2026","Bills: Spotify","Bills","Spotify",$12.99,-$12.99,$0.00'))
  assert.equal(row.activityCents, -1_299)
})

test('thousands separators do not become a truncated amount', () => {
  const [row] = parseYnabPlan(csv('"Mar 2026","Savings: Taxes","Savings","Taxes","$6,682.19",$0.00,$0.00'))
  assert.equal(row.assignedCents, 668_219)
})

test('every month abbreviation maps to the right number', () => {
  const names = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  const rows = parseYnabPlan(csv(...names.map((n) =>
    `"${n} 2026","Bills: Insurance","Bills","Insurance",$0.00,$0.00,$0.00`)))
  assert.deepEqual(rows.map((r) => r.month),
    names.map((_, i) => `2026-${String(i + 1).padStart(2, '0')}`))
})

test('a blank trailing line is dropped, not parsed as a row', () => {
  const rows = parseYnabPlan(csv('"Aug 2026","Bills: Insurance","Bills","Insurance",$0.00,$0.00,$0.00') + '\n')
  assert.equal(rows.length, 1)
})

test('an unexpected header is refused rather than silently misread', () => {
  assert.throws(
    () => parseYnabPlan('"Month","Category","Assigned"\n"Aug 2026","Insurance",$0.00\n'),
    /header/i,
  )
})

test('an unparseable month is refused with its line number', () => {
  assert.throws(
    () => parseYnabPlan(csv('"Smarch 2026","Bills: Insurance","Bills","Insurance",$0.00,$0.00,$0.00')),
    /line 2/,
  )
})

test('an empty file is refused, not silently imported as zero rows', () => {
  assert.throws(
    () => parseYnabPlan(''),
    /empty/i,
  )
})

test('a row with more fields than the header throws, naming the line', () => {
  assert.throws(
    () => parseYnabPlan(csv('"Aug 2026","Bills: Insurance","Bills","Insurance",$427.00,$0.00,$35.00,"extra"')),
    /line 2/,
  )
})

test('a row with fewer fields than the header throws', () => {
  assert.throws(
    () => parseYnabPlan(csv('"Aug 2026","Bills: Insurance","Bills","Insurance",$427.00')),
    /expected 7 fields, got 5/,
  )
})

test('a money field with invalid characters throws, naming the line and field', () => {
  assert.throws(
    () => parseYnabPlan(csv('"Aug 2026","Bills: Insurance","Bills","Insurance",$abc.99,$0.00,$35.00')),
    /line 2.*Assigned/,
  )
})

test('a money field with three decimal places throws rather than silently rounding', () => {
  assert.throws(
    () => parseYnabPlan(csv('"Aug 2026","Bills: Insurance","Bills","Insurance",$1.234,$0.00,$35.00')),
    /line 2/,
  )
})
