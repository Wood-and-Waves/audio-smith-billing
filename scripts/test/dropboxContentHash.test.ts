// Dropbox's own hash scheme: SHA-256 over the concatenated SHA-256 of each
// 4MB block. Verified against independently computed values rather than
// against the implementation, because this is what licenses a delete.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { dropboxContentHash, BLOCK_SIZE } from '../../lib/dropboxContentHash.ts'

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest()
const filled = (n: number, byte: number) => new Uint8Array(n).fill(byte)

test('a file smaller than one block is the hash of its single block hash', () => {
  const bytes = new TextEncoder().encode('hello world')
  const expected = createHash('sha256').update(sha(bytes)).digest('hex')
  return dropboxContentHash(bytes).then((got) => assert.equal(got, expected))
})

test('an empty file hashes the empty concatenation', () => {
  // No blocks at all, so it is SHA-256 of nothing — not of one empty block.
  const expected = createHash('sha256').update(Buffer.alloc(0)).digest('hex')
  return dropboxContentHash(new Uint8Array(0)).then((got) => assert.equal(got, expected))
})

test('exactly one block is still one block', () => {
  const bytes = filled(BLOCK_SIZE, 0xab)
  const expected = createHash('sha256').update(sha(bytes)).digest('hex')
  return dropboxContentHash(bytes).then((got) => assert.equal(got, expected))
})

test('one byte over a block becomes two blocks', () => {
  // The boundary that a naive implementation gets wrong, and the one that
  // matters: every real receipt is a few MB.
  const bytes = filled(BLOCK_SIZE + 1, 0xcd)
  const expected = createHash('sha256')
    .update(Buffer.concat([sha(bytes.slice(0, BLOCK_SIZE)), sha(bytes.slice(BLOCK_SIZE))]))
    .digest('hex')
  return dropboxContentHash(bytes).then((got) => assert.equal(got, expected))
})

test('the hash is lowercase hex, which is what Dropbox returns', () => {
  return dropboxContentHash(new TextEncoder().encode('x')).then((got) => {
    assert.match(got, /^[0-9a-f]{64}$/)
  })
})
