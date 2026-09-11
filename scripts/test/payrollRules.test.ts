// The tax rules are data, but data that decides what Dan pays the IRS. Two
// things are pinned here: the shape (so a half-filled year can't reach the
// calculator) and the no-fallback rule (so a missing year is loud).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SEED_TAX_YEARS, findRules, yearsOnFile, type TaxYearRules } from '../../lib/payrollRules.ts'

test('every seeded year carries every figure, as an integer', () => {
  const numeric: (keyof TaxYearRules)[] = [
    'year', 'ssRateBp', 'ssWageBaseCents', 'medicareRateBp', 'addlMedicareRateBp',
    'addlMedicareThresholdCents', 'futaRateBp', 'futaWageBaseCents',
    'ilIncomeRateBp', 'ilAllowanceCents', 'ilSutaRateBp', 'ilSutaWageBaseCents',
  ]
  for (const rules of SEED_TAX_YEARS) {
    for (const field of numeric) {
      const value = rules[field]
      assert.equal(typeof value, 'number', `${rules.year} ${String(field)}`)
      assert.ok(Number.isInteger(value), `${rules.year} ${String(field)} must be an integer`)
      assert.ok((value as number) > 0, `${rules.year} ${String(field)} must be positive`)
    }
  }
})

// The note is what makes a wrong figure findable by the one person who can
// recognise it. An empty one defeats the whole arrangement.
test('every seeded year says where its figures came from', () => {
  for (const rules of SEED_TAX_YEARS) {
    assert.ok(rules.note.trim().length > 0, String(rules.year))
  }
})

test('a year on file is found', () => {
  const found = findRules(SEED_TAX_YEARS, 2026)
  assert.equal(found?.year, 2026)
})

// The load-bearing test. Falling back to the nearest year would produce
// clean arithmetic against a stale wage base — wrong, and invisible.
test('a year with no rules is null, never the nearest year', () => {
  assert.equal(findRules(SEED_TAX_YEARS, 2027), null)
  assert.equal(findRules(SEED_TAX_YEARS, 2025), null)
  assert.equal(findRules([], 2026), null)
})

test('the years on file come back in order', () => {
  const rows = [{ year: 2028 }, { year: 2026 }, { year: 2027 }] as TaxYearRules[]
  assert.deepEqual(yearsOnFile(rows), [2026, 2027, 2028])
})

// Sanity on the seed itself: these are the two figures most likely to be
// mistyped, and both have a known shape even if the exact value needs checking.
test('Social Security is charged at the same rate to both sides, and Medicare is uncapped', () => {
  const rules = findRules(SEED_TAX_YEARS, 2026)
  assert.ok(rules !== null)
  assert.equal(rules.ssRateBp, 620)
  assert.equal(rules.medicareRateBp, 145)
  assert.ok(!('medicareWageBaseCents' in rules), 'Medicare has no wage base')
})
