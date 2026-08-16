// A post-login redirect target must stay on this origin. Every case below that
// returns HOME is one that, left alone, reaches a site the attacker controls.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { safeNext } from '../../lib/safeNext.ts'

test('an ordinary in-app path is kept', () => {
  assert.equal(safeNext('/invoices'), '/invoices')
  assert.equal(safeNext('/shows/abc?tab=days'), '/shows/abc?tab=days')
})

test('nothing falls back to home', () => {
  assert.equal(safeNext(null), '/shows')
  assert.equal(safeNext(undefined), '/shows')
  assert.equal(safeNext(''), '/shows')
})

test('a protocol-relative URL is refused — the browser reads it as a host', () => {
  assert.equal(safeNext('//evil.com'), '/shows')
  assert.equal(safeNext('//evil.com/invoices'), '/shows')
})

test('a backslash after the slash is refused — some parsers treat it as a slash', () => {
  assert.equal(safeNext('/\\evil.com'), '/shows')
})

test('an absolute URL is refused', () => {
  assert.equal(safeNext('https://evil.com'), '/shows')
  assert.equal(safeNext('http://evil.com'), '/shows')
})

test('userinfo and subdomain tricks are refused — they never start with a slash', () => {
  // These are the payloads that beat the auth-callback string concatenation:
  // `${origin}@evil.com` -> host evil.com, `${origin}.evil.com` -> a subdomain.
  assert.equal(safeNext('@evil.com'), '/shows')
  assert.equal(safeNext('.evil.com'), '/shows')
  assert.equal(safeNext('evil.com'), '/shows')
})
