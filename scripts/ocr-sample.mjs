// Reads a receipt image through the real OCR path and prints what it found.
//
// Deliberately OUTSIDE the scripts/test/*.test.ts glob: this one costs money and
// needs a key, and `npm test` must stay runnable with neither.
//
//   node --env-file=.env.local scripts/ocr-sample.mjs path/to/receipt.jpg
//
// Takes a local file rather than a storage path so it needs no Supabase
// credentials at all — download the object first if you want to test a stored
// receipt.

import { readFileSync } from 'node:fs'
import { readReceiptImage } from '../lib/receiptOcr.ts'
import { todayInChicago } from '../lib/dates.ts'
import { formatUSD } from '../lib/money.ts'

const path = process.argv[2]
if (!path) {
  console.error('usage: node --env-file=.env.local scripts/ocr-sample.mjs <image>')
  process.exit(1)
}

const bytes = new Uint8Array(readFileSync(path))
console.log(`${path} — ${(bytes.length / 1024).toFixed(0)}KB`)

const started = Date.now()
const result = await readReceiptImage({ bytes, mediaType: 'image/jpeg', today: todayInChicago() })
const ms = Date.now() - started

if ('error' in result) {
  console.log(`\n  error: ${result.error}`)
  process.exit(1)
}

const { fields, unreadable } = result
console.log(`\n  vendor    ${fields.vendor ?? '—'}`)
console.log(`  amount    ${fields.amountCents === null ? '—' : formatUSD(fields.amountCents)}`)
console.log(`  date      ${fields.spentOn ?? '—'}`)
console.log(`  category  ${fields.category ?? '—'}`)
console.log(`  unreadable ${unreadable}`)
console.log(`\n  ${ms}ms`)
