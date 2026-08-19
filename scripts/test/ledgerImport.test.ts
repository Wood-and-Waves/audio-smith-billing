// The dedupe/match brain. YNAB's rule, proven for a decade: an import row
// either already exists (import_id), adopts a manual twin (same amount,
// ±10 days), or is new. Pure, so every branch is pinned without a database.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planImport } from '../../lib/ledgerImport.ts'
import type { ParsedOfxTxn } from '../../lib/ofx.ts'

const row = (over: Partial<ParsedOfxTxn> = {}): ParsedOfxTxn => ({
  fitid: 'f1', date: '2026-08-10', amountCents: -4253,
  name: 'TEST DINER', memo: null, ...over,
})

test('a row whose import_id already exists is a duplicate', () => {
  const plan = planImport([row()], [{
    id: 'e1', date: '2026-08-10', amount_cents: -4253,
    import_id: 'OFX:f1', source: 'import',
  }])
  assert.equal(plan.duplicates.length, 1)
  assert.equal(plan.matches.length + plan.inserts.length, 0)
})

test('a manual twin within ±10 days is matched and adopts the import id', () => {
  const plan = planImport([row()], [{
    id: 'm1', date: '2026-08-06', amount_cents: -4253, import_id: null, source: 'manual',
  }])
  assert.deepEqual(plan.matches, [{
    row: row(), importId: 'OFX:f1', existingId: 'm1',
  }])
})

test('same amount 11 days away is NOT a match — it inserts', () => {
  const plan = planImport([row()], [{
    id: 'm1', date: '2026-07-30', amount_cents: -4253, import_id: null, source: 'manual',
  }])
  assert.equal(plan.matches.length, 0)
  assert.equal(plan.inserts.length, 1)
})

test('two candidates: the closest date wins; each manual row is claimed once', () => {
  const near = { id: 'near', date: '2026-08-09', amount_cents: -4253, import_id: null, source: 'manual' as const }
  const far = { id: 'far', date: '2026-08-01', amount_cents: -4253, import_id: null, source: 'manual' as const }
  const plan = planImport([row(), row({ fitid: 'f2' })], [near, far])
  assert.equal(plan.matches.length, 2)
  assert.equal(plan.matches[0].existingId, 'near', 'first row takes the closest')
  assert.equal(plan.matches[1].existingId, 'far', 'second row takes what remains')
})

test('two rows sharing one FITID within the same file: the first matches, the second is a duplicate', () => {
  // A bank file that carries the same FITID twice (rare, but seen). The
  // first occurrence claims the manual twin; the second must not double-claim
  // it or slip through to a second insert — issuedThisBatch catches what
  // existingImportIds (past imports only) can't.
  const plan = planImport([row({ fitid: 'z9' }), row({ fitid: 'z9' })], [
    { id: 'm1', date: '2026-08-10', amount_cents: -4253, import_id: null, source: 'manual' },
  ])
  assert.equal(plan.matches.length, 1)
  assert.equal(plan.duplicates.length, 1)
  assert.equal(plan.inserts.length, 0)
})

test('an import-sourced or already-linked row is never a match candidate', () => {
  const plan = planImport([row()], [
    { id: 'i1', date: '2026-08-10', amount_cents: -4253, import_id: 'OFX:other', source: 'import' },
  ])
  assert.equal(plan.inserts.length, 1)
})

test('inserts infer kind from the sign', () => {
  const plan = planImport([row({ amountCents: 60000, fitid: 'p' })], [])
  assert.equal(plan.inserts[0].kind, 'income')
})

test('missing fitid falls back to GEN ids with an occurrence counter', () => {
  const a = row({ fitid: null })
  const b = row({ fitid: null })
  const plan = planImport([a, b], [])
  assert.equal(plan.inserts[0].importId, 'GEN:-4253:2026-08-10:1')
  assert.equal(plan.inserts[1].importId, 'GEN:-4253:2026-08-10:2')
})

test('GEN occurrence counting respects existing GEN ids: a genuinely new occurrence still inserts', () => {
  // One GEN row already exists for this key (existingCount 1, maxN 1). The
  // batch has two: the first lines up with the one that's already there
  // (duplicate, a re-send), the second is beyond what exists and is new.
  const plan = planImport([row({ fitid: null }), row({ fitid: null })], [{
    id: 'e1', date: '2026-08-10', amount_cents: -4253,
    import_id: 'GEN:-4253:2026-08-10:1', source: 'import',
  }])
  assert.equal(plan.duplicates.length, 1)
  assert.equal(plan.inserts.length, 1)
  assert.equal(plan.inserts[0].importId, 'GEN:-4253:2026-08-10:2')
})

test('a zero-amount bank line is skipped, never inserted', () => {
  const plan = planImport([row({ amountCents: 0, fitid: 'z' })], [])
  assert.equal(plan.inserts.length, 0)
  assert.equal(plan.duplicates.length, 0)
  assert.deepEqual(plan.skipped.map((r) => r.fitid), ['z'])
})

test('GEN numbering survives gaps without dropping real transactions', () => {
  // :2 was deleted from the ledger, so existingCount is 2 (":1" and ":3"
  // survive) and maxN is 3. A batch of THREE identical rows: the first two
  // occurrence positions (1, 2) line up with what already exists and are
  // duplicates (a bank re-send); the third is beyond existingCount and is
  // genuinely new. Its id counts up from maxN, not from existingCount, so
  // it lands on :4 rather than colliding with the ":3" survivor.
  const plan = planImport([row({ fitid: null }), row({ fitid: null }), row({ fitid: null })], [
    { id: 'e1', date: '2026-08-10', amount_cents: -4253, import_id: 'GEN:-4253:2026-08-10:1', source: 'import' },
    { id: 'e3', date: '2026-08-10', amount_cents: -4253, import_id: 'GEN:-4253:2026-08-10:3', source: 'import' },
  ])
  assert.equal(plan.duplicates.length, 2)
  assert.equal(plan.inserts.length, 1)
  assert.equal(plan.inserts[0].importId, 'GEN:-4253:2026-08-10:4')
})

test('re-importing the same GEN-only file is a no-op (idempotence)', () => {
  // Two identical FITID-less rows, imported once: both are genuinely new,
  // numbered :1 and :2.
  const first = planImport([row({ fitid: null }), row({ fitid: null })], [])
  assert.equal(first.inserts.length, 2)
  assert.deepEqual(first.inserts.map((i) => i.importId), [
    'GEN:-4253:2026-08-10:1', 'GEN:-4253:2026-08-10:2',
  ])

  // The same two rows, imported again, now that the ledger holds both ids
  // from the first import: this is the spec invariant — re-importing the
  // same file is a no-op. Both line up with existing occurrences and are
  // duplicates; nothing is inserted a second time.
  const existing = first.inserts.map((i, idx) => ({
    id: `e${idx}`, date: '2026-08-10', amount_cents: -4253,
    import_id: i.importId, source: 'import' as const,
  }))
  const second = planImport([row({ fitid: null }), row({ fitid: null })], existing)
  assert.equal(second.duplicates.length, 2)
  assert.equal(second.inserts.length, 0)
})
