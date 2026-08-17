// parseRecipients is pure: it turns the raw To field into validated
// addresses with no network and no state. The server calls it as the
// authoritative gate on who an invoice is sent to, so its edge cases —
// blank, duplicate, malformed — are all pinned here.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseRecipients } from '../../lib/invoiceRecipients.ts'

test('two good addresses parse to two emails and no invalids', () => {
  const { emails, invalid } = parseRecipients('a@x.com, b@y.com')
  assert.deepEqual(emails, ['a@x.com', 'b@y.com'])
  assert.deepEqual(invalid, [])
})

test('a malformed address is separated out, the good one still parses', () => {
  const { emails, invalid } = parseRecipients('a@x.com, nope')
  assert.deepEqual(emails, ['a@x.com'])
  assert.deepEqual(invalid, ['nope'])
})

test('an address with no dot in the domain is invalid', () => {
  const { emails, invalid } = parseRecipients('a@localhost')
  assert.deepEqual(emails, [])
  assert.deepEqual(invalid, ['a@localhost'])
})

test('blank and whitespace-only inputs yield no recipients', () => {
  assert.deepEqual(parseRecipients(''), { emails: [], invalid: [] })
  assert.deepEqual(parseRecipients('   ,  '), { emails: [], invalid: [] })
})

test('duplicates are removed case-insensitively, first casing kept', () => {
  const { emails } = parseRecipients('A@x.com, a@x.com, b@Y.com')
  assert.deepEqual(emails, ['A@x.com', 'b@Y.com'])
})

test('a trailing comma is tolerated', () => {
  const { emails, invalid } = parseRecipients('a@x.com,')
  assert.deepEqual(emails, ['a@x.com'])
  assert.deepEqual(invalid, [])
})
