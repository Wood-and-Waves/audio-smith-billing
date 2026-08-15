// The argument Dropbox's upload endpoint takes, which travels in an HTTP HEADER
// and therefore must be plain ASCII JSON.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { uploadArg } from '../../lib/dropbox.ts'

test('the upload argument names the path and refuses to overwrite', () => {
  const arg = JSON.parse(uploadArg('/receipts/2026/PwC/a.jpg'))
  assert.equal(arg.path, '/receipts/2026/PwC/a.jpg')
  assert.equal(arg.mode, 'add')       // never overwrite — an archive is append-only
  assert.equal(arg.autorename, true)  // a name collision renames rather than fails
  assert.equal(arg.mute, true)        // no notification per receipt
})

test('a non-ASCII path is escaped, because this travels in a header', () => {
  // "Café" in a raw header makes Dropbox reject the request. The escape is not
  // cosmetic — it is why an accented vendor name works at all.
  const arg = uploadArg('/receipts/2026/Café/a.jpg')
  assert.ok(!/[^\x00-\x7f]/.test(arg), `not ASCII: ${arg}`)
  assert.equal(JSON.parse(arg).path, '/receipts/2026/Café/a.jpg')
})
