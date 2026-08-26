// Run: npm test -- scripts/test/payeeName.test.ts
//
// Dan has 18 rows categorized under `Starbucks`; Chase sends
// `STARBUCKS 8007827282 800-782-728`. Payee memory keys on the exact string,
// so it never matched and every import arrived uncategorized. This is the
// suggestion he confirms once per merchant.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { suggestDisplayName } from '../../lib/payeeName.ts'

const KNOWN = ['Starbucks', 'Walmart', 'Uber', 'Uber Eats', 'Hyatt Regency Greenwich', 'Amazon']

test("his own real case: Chase's Starbucks string suggests the Starbucks he already uses", () => {
  assert.equal(suggestDisplayName('STARBUCKS 8007827282 800-782-728', KNOWN), 'Starbucks')
})

test('punctuation in the bank string does not defeat the match', () => {
  // He has `Walmart`; Chase sends `WAL-MART #5023 NATIONAL CITY CA`.
  assert.equal(suggestDisplayName('WAL-MART #5023 NATIONAL CITY CA', KNOWN), 'Walmart')
})

test('the LONGEST known payee wins, so Uber Eats never collapses into Uber', () => {
  assert.equal(suggestDisplayName('UBER EATS SAN FRANCISCO CA', KNOWN), 'Uber Eats')
  assert.equal(suggestDisplayName('UBER TRIP HELP.UBER.COM CA', KNOWN), 'Uber')
})

test('a merchant he has never seen falls back to a cleaned version of the raw string', () => {
  // Not "Grand Hyatt San Diego F San Dieg" — the trailing location noise and
  // the truncated tail go, and it is title-cased.
  assert.equal(suggestDisplayName('GRAND HYATT SAN DIEGO F SAN DIEG', []), 'Grand Hyatt')
  assert.equal(suggestDisplayName('TST*CRACK TACO - SEAPOR San Dieg', []), 'Crack Taco')
})

test('a different Hyatt does NOT get merged into his Greenwich one', () => {
  // The guard against silent wrong merges — his own example. "Hyatt Regency
  // Greenwich" is not a substring of the San Diego string, so no match.
  assert.equal(suggestDisplayName('GRAND HYATT SAN DIEGO F SAN DIEG', KNOWN), 'Grand Hyatt')
})

test('a suggestion can be imperfect, and that is the design — it costs one correction', () => {
  // His real string is `UBER *BUSINESS EATS SAN FRANCISC`, which contains
  // "uber" but not "ubereats", so it suggests `Uber`. He corrects it once and
  // the alias — keyed on the exact raw string — never asks again. Pinned so
  // nobody later "fixes" this into fuzzy matching that would merge his
  // Hyatt Regency into a Grand Hyatt.
  assert.equal(suggestDisplayName('UBER *BUSINESS EATS SAN FRANCISC', KNOWN), 'Uber')
})

test('an already-clean payee suggests itself unchanged', () => {
  assert.equal(suggestDisplayName('Starbucks', KNOWN), 'Starbucks')
})

test('never returns empty, whatever the input', () => {
  assert.notEqual(suggestDisplayName('', KNOWN), '')
  assert.notEqual(suggestDisplayName('   ', KNOWN), '')
  assert.notEqual(suggestDisplayName('#### 1234 5678', []), '')
})
