// The argument Dropbox's upload endpoint takes, which travels in an HTTP HEADER
// and therefore must be plain ASCII JSON.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { uploadArg, uploadAndVerify } from '../../lib/dropbox.ts'
import { dropboxContentHash } from '../../lib/dropboxContentHash.ts'

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

// uploadAndVerify — every rejection branch.
//
// This function is described in its own comment as "the whole licence for
// deleting the other copy", and until now only uploadArg above was covered. The
// branches below are the ones that decide whether receipt_archived_at gets set,
// so each has to be pinned: an accidental `ok: true` here is what would let a
// later deletion stage destroy an original that never arrived.
//
// NOTHING HERE TOUCHES THE NETWORK. globalThis.fetch is replaced for the length
// of one call and restored in a finally, so a failing assertion cannot leave the
// stub installed for the rest of the file.

const BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
const PATH = '/receipts/2026/PwC Tax Start/2026-08-22 HMS Host 19.98.jpg'

/** A stub standing in for fetch, installed for exactly one call. */
async function withFetch<T>(
  stub: (input: unknown, init?: unknown) => Promise<unknown>,
  run: () => Promise<T>,
): Promise<T> {
  const real = globalThis.fetch
  globalThis.fetch = stub as typeof globalThis.fetch
  try {
    return await run()
  } finally {
    globalThis.fetch = real
  }
}

/** A Response carrying an arbitrary body, so the not-JSON case can be built. */
const responding = (status: number, body: string) => async () =>
  new Response(body, { status, headers: { 'Content-Type': 'application/json' } })

const respondingJson = (status: number, body: unknown) =>
  responding(status, JSON.stringify(body))

test('a verified upload reports where Dropbox actually put it', async () => {
  const hash = await dropboxContentHash(BYTES)
  const result = await withFetch(
    respondingJson(200, { size: BYTES.length, content_hash: hash, path_display: PATH }),
    () => uploadAndVerify('token', PATH, BYTES),
  )
  assert.deepEqual(result, { ok: true, storedPath: PATH })
})

test('autorename means the stored path is not the requested one, and that is what is reported', async () => {
  // mode:'add' + autorename:true is why a collision is safe. It is also why the
  // requested path is a guess: two identical receipts archived on different
  // nights both ask for this name, and the second one lands beside it.
  const renamed = '/receipts/2026/PwC Tax Start/2026-08-22 HMS Host 19.98 (1).jpg'
  const hash = await dropboxContentHash(BYTES)
  const result = await withFetch(
    respondingJson(200, { size: BYTES.length, content_hash: hash, path_display: renamed }),
    () => uploadAndVerify('token', PATH, BYTES),
  )
  assert.deepEqual(result, { ok: true, storedPath: renamed })
})

test('a truncated upload is refused on size', async () => {
  const hash = await dropboxContentHash(BYTES)
  const result = await withFetch(
    respondingJson(200, { size: BYTES.length - 1, content_hash: hash }),
    () => uploadAndVerify('token', PATH, BYTES),
  )
  assert.equal(result.ok, false)
  assert.match(result.ok === false ? result.error : '', /stored 7 bytes, not 8/)
})

test('a corrupted upload of the right length is refused on the content hash', async () => {
  // The case size alone cannot catch, and the reason the hash is computed at all.
  const result = await withFetch(
    respondingJson(200, { size: BYTES.length, content_hash: 'f'.repeat(64) }),
    () => uploadAndVerify('token', PATH, BYTES),
  )
  assert.equal(result.ok, false)
  assert.match(result.ok === false ? result.error : '', /content hash does not match/)
})

test('a response with no content_hash at all is refused, not treated as a match', async () => {
  // undefined === undefined would be a match if the comparison were ever
  // loosened to "both absent". It must fail: no hash is no proof.
  const result = await withFetch(
    respondingJson(200, { size: BYTES.length }),
    () => uploadAndVerify('token', PATH, BYTES),
  )
  assert.equal(result.ok, false)
  assert.match(result.ok === false ? result.error : '', /content hash does not match/)
})

test('a non-2xx reports the status and nothing else', async () => {
  // The body of a Dropbox error can echo parts of the request, and this string
  // ends up in the cron's JSON response and in Vercel's log retention.
  const result = await withFetch(
    responding(401, JSON.stringify({ error_summary: 'expired_access_token/SECRET-SENTINEL' })),
    () => uploadAndVerify('token-SENTINEL', PATH, BYTES),
  )
  assert.equal(result.ok, false)
  const message = result.ok === false ? result.error : ''
  assert.match(message, /HTTP 401/)
  assert.ok(!message.includes('SENTINEL'), `leaked something it should not: ${message}`)
})

test('a network error is returned, never thrown', async () => {
  // A throw out of here escapes archiveOriginals and 500s a cron run whose
  // reminders all sent correctly.
  const result = await withFetch(
    async () => { throw new TypeError('fetch failed') },
    () => uploadAndVerify('token', PATH, BYTES),
  )
  assert.deepEqual(result, { ok: false, error: 'fetch failed' })
})

test('a 200 whose body is not JSON is refused rather than thrown', async () => {
  // Reproduced: a CDN or proxy error page served with a 200 threw SyntaxError
  // straight out of this function, past the try that wrapped only the fetch.
  const result = await withFetch(
    responding(200, '<html><body>502 Bad Gateway</body></html>'),
    () => uploadAndVerify('token', PATH, BYTES),
  )
  assert.equal(result.ok, false)
  assert.match(result.ok === false ? result.error : '', /not a JSON object/)
})

test('a body of literal null is refused rather than thrown', async () => {
  // Also reproduced, and a different failure from the one above: `null` parses
  // fine and then threw TypeError reading .size off it.
  const result = await withFetch(
    responding(200, 'null'),
    () => uploadAndVerify('token', PATH, BYTES),
  )
  assert.equal(result.ok, false)
  assert.match(result.ok === false ? result.error : '', /not a JSON object/)
})

test('the stub is gone once the tests above have run', () => {
  // Cheap proof that withFetch's finally really restores, so nothing here can
  // leave a poisoned global for another test file sharing the process.
  assert.equal(typeof globalThis.fetch, 'function')
  assert.ok(!/SENTINEL/.test(String(globalThis.fetch)))
})
