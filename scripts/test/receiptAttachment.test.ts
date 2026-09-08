// Which attachment to read, from the shapes real receipt mail arrives in.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickPrimaryAttachment, isReadable, isPdf, storageContentType, type MailAttachment } from '../../lib/receiptAttachment.ts'

const at = (filename: string, mimeType = 'application/pdf'): MailAttachment =>
  ({ filename, mimeType, attachmentId: filename, size: 1000 })

test("ElevenLabs' real pair: the receipt is chosen over the invoice", () => {
  // The message that prompted this rule, filenames exactly as they arrived.
  const picked = pickPrimaryAttachment([
    at('Invoice-6E5E5C06-0021.pdf'),
    at('Receipt-2336-3812-6513.pdf'),
  ])
  assert.equal(picked?.filename, 'Receipt-2336-3812-6513.pdf')
})

test('order in the mail does not decide it — the receipt wins either way', () => {
  const a = pickPrimaryAttachment([at('Receipt-1.pdf'), at('Invoice-1.pdf')])
  const b = pickPrimaryAttachment([at('Invoice-1.pdf'), at('Receipt-1.pdf')])
  assert.equal(a?.filename, 'Receipt-1.pdf')
  assert.equal(b?.filename, 'Receipt-1.pdf')
})

test('an unnamed PDF beats one that calls itself an invoice', () => {
  // Most vendors send document.pdf. That is likelier to be the thing than a
  // file explicitly labelled a request for payment.
  const picked = pickPrimaryAttachment([at('Invoice-99.pdf'), at('document.pdf')])
  assert.equal(picked?.filename, 'document.pdf')
})

test("Google Workspace's single unnamed PDF is chosen", () => {
  assert.equal(pickPrimaryAttachment([at('5672461144.pdf')])?.filename, '5672461144.pdf')
})

test('logos and signatures are not readable attachments', () => {
  assert.equal(isReadable(at('logo.svg', 'image/svg+xml')), true, 'an image by mime type')
  assert.equal(isReadable(at('smime.p7s', 'application/pkcs7-signature')), false)
  assert.equal(isReadable(at('calendar.ics', 'text/calendar')), false)
})

test('a mail with nothing readable returns null rather than a wrong guess', () => {
  assert.equal(pickPrimaryAttachment([at('smime.p7s', 'application/pkcs7-signature')]), null)
  assert.equal(pickPrimaryAttachment([]), null)
})

test('a PDF mislabelled application/octet-stream still counts, by extension', () => {
  assert.equal(isReadable(at('receipt.pdf', 'application/octet-stream')), true)
})

test('case does not matter — RECEIPT.PDF is still a receipt', () => {
  const picked = pickPrimaryAttachment([at('INVOICE.PDF'), at('RECEIPT.PDF')])
  assert.equal(picked?.filename, 'RECEIPT.PDF')
})

test('isPdf accepts a mislabelled PDF — a strict mime check skipped a real one', () => {
  // Netlify's invoice was passed over because the caller compared mimeType to
  // 'application/pdf' exactly. Extension is the backstop, same as isReadable.
  assert.equal(isPdf(at('Invoice-ESQSJT-00006.pdf', 'application/octet-stream')), true)
  assert.equal(isPdf(at('receipt.pdf')), true)
  assert.equal(isPdf(at('photo.jpg', 'image/jpeg')), false)
})

test("storageContentType corrects a sender's mislabelled PDF", () => {
  // Netlify sends application/octet-stream. The bucket accepts only
  // jpeg/png/pdf, so that label made storage refuse a real PDF and three
  // receipts arrived carrying no document.
  assert.equal(storageContentType(at('Invoice-1.pdf', 'application/octet-stream')), 'application/pdf')
  assert.equal(storageContentType(at('photo.JPG', 'application/octet-stream')), 'image/jpeg')
  assert.equal(storageContentType(at('scan.png', 'application/octet-stream')), 'image/png')
})

test('storageContentType passes through a type it cannot identify', () => {
  // Better refused by the bucket than stored under a guess.
  assert.equal(storageContentType(at('mystery.xyz', 'application/zip')), 'application/zip')
})
