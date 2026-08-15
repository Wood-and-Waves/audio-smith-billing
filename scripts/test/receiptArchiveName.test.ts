// Names that survive being looked at in a folder two years later, with no
// database in front of you.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  sanitizeSegment, archiveNames, type ArchiveEntry,
} from '../../lib/receiptArchiveName.ts'

const e = (
  spentOn: string, vendor: string | null, amountCents: number, originalPath = 'x/y/1-original.jpg',
): ArchiveEntry => ({ spentOn, vendor, amountCents, originalPath })

test('an ordinary receipt reads as date, vendor and amount', () => {
  assert.deepEqual(archiveNames([e('2026-08-22', 'HMS Host', 1998)]), ['2026-08-22 HMS Host 19.98.jpg'])
})

test('the original keeps its own extension', () => {
  // An emailed airline receipt is a PDF. Naming it .jpg would make it open
  // in nothing.
  assert.deepEqual(
    archiveNames([e('2026-08-22', 'United', 60000, 'a/b/17-original.pdf')]),
    ['2026-08-22 United 600.00.pdf'],
  )
})

test('characters that are illegal in a filename are removed', () => {
  // A slash is the dangerous one: it would create a subfolder, or escape the
  // show's folder entirely.
  assert.deepEqual(
    archiveNames([e('2026-08-22', 'Hertz / LAX: "Rental"', 12345)]),
    ['2026-08-22 Hertz LAX Rental 123.45.jpg'],
  )
})

test('a vendor OCR never read still produces a usable name', () => {
  assert.deepEqual(archiveNames([e('2026-08-22', null, 1998)]), ['2026-08-22 Receipt 19.98.jpg'])
  assert.deepEqual(archiveNames([e('2026-08-22', '   ', 1998)]), ['2026-08-22 Receipt 19.98.jpg'])
})

test('two identical receipts on one day do not collide', () => {
  // Two $6 coffees at the same airport Starbucks is a real thing that happens.
  assert.deepEqual(
    archiveNames([e('2026-08-22', 'Starbucks', 632), e('2026-08-22', 'Starbucks', 632)]),
    ['2026-08-22 Starbucks 6.32.jpg', '2026-08-22 Starbucks 6.32 (2).jpg'],
  )
})

test('the suffix goes before the extension, not after', () => {
  const names = archiveNames([
    e('2026-08-22', 'Uber', 4310, 'a/b/1-original.pdf'),
    e('2026-08-22', 'Uber', 4310, 'a/b/2-original.pdf'),
  ])
  assert.equal(names[1], '2026-08-22 Uber 43.10 (2).pdf')
})

test('sanitizeSegment protects a show name used as a folder', () => {
  assert.equal(sanitizeSegment('PwC Tax Start', 'Show'), 'PwC Tax Start')
  assert.equal(sanitizeSegment('../../etc', 'Show'), 'etc')
  assert.equal(sanitizeSegment('GLS 2926 / PwC', 'Show'), 'GLS 2926 PwC')
  assert.equal(sanitizeSegment('   ', 'Show'), 'Show')
  assert.equal(sanitizeSegment('Trailing dots...', 'Show'), 'Trailing dots')
})

test('a very long vendor is trimmed rather than making an unopenable path', () => {
  const [name] = archiveNames([e('2026-08-22', 'A'.repeat(300), 1998)])
  assert.ok(name.length <= 120, `got ${name.length}`)
  assert.ok(name.startsWith('2026-08-22 AAA'))
  assert.ok(name.endsWith(' 19.98.jpg'))
})

test('spentOn is sanitized the same as vendor', () => {
  // spentOn was interpolated into the stem raw while vendor went through
  // sanitizeSegment -- not reachable today because expenses.spent_on is a
  // Postgres `date not null` and the driver only ever returns YYYY-MM-DD, but
  // the parameter type is a bare string with no static guarantee of that.
  assert.deepEqual(
    archiveNames([e('2026/08/22', 'Vendor', 100)]),
    ['2026 08 22 Vendor 1.00.jpg'],
  )
  assert.deepEqual(
    archiveNames([e('../../etc', 'Vendor', 100)]),
    ['etc Vendor 1.00.jpg'],
  )
})

test('bidi override and zero-width characters do not survive sanitizeSegment', () => {
  // U+202E (right-to-left override) is a known filename-spoofing trick; U+200B
  // (zero-width space) is invisible and would silently pass through unnoticed.
  assert.equal(sanitizeSegment(`Right\u202EOverride`, 'Show'), 'Right Override')
  assert.equal(sanitizeSegment(`Zero\u200BWidth`, 'Show'), 'Zero Width')
})

test('truncation drops a trailing unpaired surrogate instead of corrupting it', () => {
  // 79 ASCII characters followed by one emoji (a surrogate pair) sliced at
  // MAX_SEGMENT=80 lands exactly between the pair. A lone high surrogate isn't
  // a real character -- Buffer.from(str, 'utf8') silently rewrites it to
  // U+FFFD, which would corrupt the name instead of raising anything visible.
  const raw = 'A'.repeat(79) + `\u{1F600}`
  const cleaned = sanitizeSegment(raw, 'fallback')
  assert.equal(cleaned, 'A'.repeat(79))
  const lastCode = cleaned.charCodeAt(cleaned.length - 1)
  assert.ok(lastCode < 0xd800 || lastCode > 0xdfff, `got surrogate ${lastCode.toString(16)}`)
})
