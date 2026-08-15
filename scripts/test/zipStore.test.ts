// A zip with no compression, because JPEG and PDF are already compressed.
//
// The test that matters is the last one: the system `unzip` reads it. Testing a
// hand-rolled format only against its own reader proves nothing.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, buildZip, type ZipEntry } from '../../lib/zipStore.ts'

const bytes = (s: string) => new TextEncoder().encode(s)

test('crc32 matches the known vector for "123456789"', () => {
  // The standard CRC-32 check value, from the algorithm's own specification.
  assert.equal(crc32(bytes('123456789')) >>> 0, 0xcbf43926)
})

test('crc32 of nothing is zero', () => {
  assert.equal(crc32(new Uint8Array(0)) >>> 0, 0)
})

test('an empty archive is valid rather than corrupt', () => {
  const zip = buildZip([])
  // Just the end-of-central-directory record.
  assert.equal(zip.length, 22)
  assert.deepEqual(Array.from(zip.slice(0, 4)), [0x50, 0x4b, 0x05, 0x06])
})

test('the local header and central directory signatures are where they belong', () => {
  const zip = buildZip([{ name: 'a.txt', bytes: bytes('hello'), date: '2026-08-22' }])
  assert.deepEqual(Array.from(zip.slice(0, 4)), [0x50, 0x4b, 0x03, 0x04])
  // Stored, not deflated: the compression-method field is 0.
  assert.equal(zip[8] | (zip[9] << 8), 0)
})

test('the system unzip reads it, with byte-identical contents', () => {
  // The whole point. If `unzip` cannot open it, nothing else about this
  // module matters.
  const dir = mkdtempSync(join(tmpdir(), 'zipstore-'))
  try {
    const entries: ZipEntry[] = [
      { name: '2026-08-22 HMS Host 19.98.jpg', bytes: new Uint8Array([0xff, 0xd8, 0xff, 0x00, 0x11]), date: '2026-08-22' },
      { name: '2026-08-23 United 600.00.pdf', bytes: bytes('%PDF-1.4 not really'), date: '2026-08-23' },
      { name: 'empty.txt', bytes: new Uint8Array(0), date: '2026-01-01' },
    ]
    const path = join(dir, 'out.zip')
    writeFileSync(path, buildZip(entries))

    // -t tests the archive: non-zero exit or "cannot find" means we built junk.
    const listing = execFileSync('unzip', ['-t', path], { encoding: 'utf8' })
    assert.match(listing, /No errors detected/)

    execFileSync('unzip', ['-q', '-o', path, '-d', dir])
    for (const entry of entries) {
      const round = new Uint8Array(readFileSync(join(dir, entry.name)))
      assert.deepEqual(Array.from(round), Array.from(entry.bytes), entry.name)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a name with a space and a non-ASCII character survives the round trip', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zipstore-'))
  try {
    const name = '2026-08-22 Café Ubé 4.00.jpg'
    const path = join(dir, 'out.zip')
    writeFileSync(path, buildZip([{ name, bytes: bytes('x'), date: '2026-08-22' }]))
    execFileSync('unzip', ['-q', '-o', path, '-d', dir])
    assert.equal(readFileSync(join(dir, name), 'utf8'), 'x')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
