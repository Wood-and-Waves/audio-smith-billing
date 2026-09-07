// Gmail's payload is a recursive tree whose shape depends on the sending
// client. These fixtures are the three shapes that actually arrive: a plain
// text receipt, an html-only one (Amazon, Uber), and a forward carrying a PDF.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseGmailMessage, htmlToText, decodeBody, headerValue, type GmailApiMessage,
} from '../../lib/gmailMessage.ts'

const b64 = (s: string) =>
  Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

const headers = (from: string, subject: string) => [
  { name: 'From', value: from },
  { name: 'Subject', value: subject },
]

test('a plain-text receipt yields its body, sender and subject', () => {
  const msg: GmailApiMessage = {
    id: 'm1',
    internalDate: '1788700000000',
    payload: {
      mimeType: 'text/plain',
      headers: headers('Spotify <no-reply@spotify.com>', 'Your receipt'),
      body: { data: b64('Spotify Premium\nTotal $11.99\nSep 1, 2026') },
    },
  }
  const p = parseGmailMessage(msg)
  assert.match(p.text, /Total \$11\.99/)
  assert.equal(p.from, 'Spotify <no-reply@spotify.com>')
  assert.equal(p.subject, 'Your receipt')
  assert.equal(p.receivedAt, 1788700000000)
  assert.deepEqual(p.attachments, [])
})

test('PLAIN TEXT wins over html when a message carries both', () => {
  // multipart/alternative: the text half is what the sender meant a plain
  // reader to see, and it needs no stripping.
  const msg: GmailApiMessage = {
    id: 'm2',
    payload: {
      mimeType: 'multipart/alternative',
      headers: headers('a@b.com', 'Receipt'),
      parts: [
        { mimeType: 'text/plain', body: { data: b64('TOTAL 41.51') } },
        { mimeType: 'text/html', body: { data: b64('<p>TOTAL <b>41.51</b></p>') } },
      ],
    },
  }
  assert.equal(parseGmailMessage(msg).text, 'TOTAL 41.51')
})

test('an html-only receipt is stripped to readable text — Amazon and Uber send these', () => {
  const html = '<html><head><style>.x{color:red}</style></head><body>'
    + '<table><tr><td>Order Total</td><td>$41.51</td></tr>'
    + '<tr><td>Placed</td><td>Aug 12, 2026</td></tr></table></body></html>'
  const msg: GmailApiMessage = {
    id: 'm3',
    payload: {
      mimeType: 'text/html',
      headers: headers('auto-confirm@amazon.com', 'Your order'),
      body: { data: b64(html) },
    },
  }
  const { text } = parseGmailMessage(msg)
  assert.match(text, /Order Total/)
  assert.match(text, /\$41\.51/)
  assert.match(text, /Aug 12, 2026/)
  assert.doesNotMatch(text, /color:red/, 'style CONTENT must not become body text')
  assert.doesNotMatch(text, /<td>/, 'no tags survive')
})

test('a forwarded receipt with a PDF reports the attachment', () => {
  const msg: GmailApiMessage = {
    id: 'm4',
    payload: {
      mimeType: 'multipart/mixed',
      headers: headers('dan@theaudiosmith.com', 'Fwd: Invoice'),
      parts: [
        {
          mimeType: 'multipart/alternative',
          parts: [{ mimeType: 'text/plain', body: { data: b64('see attached') } }],
        },
        {
          mimeType: 'application/pdf',
          filename: 'receipt.pdf',
          body: { attachmentId: 'att-1', size: 8421 },
        },
      ],
    },
  }
  const p = parseGmailMessage(msg)
  assert.equal(p.text, 'see attached')
  assert.deepEqual(p.attachments, [
    { filename: 'receipt.pdf', mimeType: 'application/pdf', attachmentId: 'att-1', size: 8421 },
  ])
})

test('a filename makes it an attachment even when the mime type is octet-stream', () => {
  // Some senders label a PDF application/octet-stream. Gmail's own signal that
  // a part is an attachment is the filename, so that is what this keys on.
  const msg: GmailApiMessage = {
    id: 'm5',
    payload: {
      mimeType: 'multipart/mixed',
      headers: headers('a@b.com', 's'),
      parts: [{
        mimeType: 'application/octet-stream',
        filename: 'scan.pdf',
        body: { attachmentId: 'att-9', size: 10 },
      }],
    },
  }
  assert.equal(parseGmailMessage(msg).attachments[0].filename, 'scan.pdf')
})

test('a message with no usable body yields empty text, never a crash', () => {
  assert.equal(parseGmailMessage({ id: 'm6' }).text, '')
  assert.equal(parseGmailMessage({ id: 'm6' }).from, '')
  assert.equal(parseGmailMessage({ id: 'm6' }).receivedAt, null)
})

test('headers are matched case-insensitively — senders capitalise inconsistently', () => {
  const part = { headers: [{ name: 'from', value: 'x@y.com' }] }
  assert.equal(headerValue(part, 'From'), 'x@y.com')
})

test('base64url decodes without padding, and handles the - and _ substitutions', () => {
  assert.equal(decodeBody(b64('a+b/c?')), 'a+b/c?')
})

test('htmlToText keeps rows on separate lines rather than running them together', () => {
  const out = htmlToText('<tr><td>Subtotal 38.18</td></tr><tr><td>Tax 3.33</td></tr>')
  assert.match(out, /Subtotal 38\.18\n/)
  assert.match(out, /Tax 3\.33/)
})

test('htmlToText decodes the entities that appear in receipt mail', () => {
  assert.equal(htmlToText('<p>Ben &amp; Jerry&#39;s &nbsp;$5</p>'), "Ben & Jerry's $5")
})
