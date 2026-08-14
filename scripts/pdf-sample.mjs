// Renders sample invoices to tmp/ so the layout can actually be looked at.
//
// Deliberately uses hardcoded figures rather than the database: this must be
// runnable by anyone, and the two cases that matter are a plain invoice and
// one carrying a deposit. It also proves the builder works under Node with
// renderToFile, which is the path the Phase 5 email attachment will use.
//
//   npm run pdf:sample

import { mkdirSync } from 'node:fs'
import { Document, Page, Text, View, Image, Font, renderToFile } from '@react-pdf/renderer'
import { buildInvoicePdf } from '../lib/invoicePdf.ts'

Font.register({ family: 'Oswald', src: 'public/fonts/Oswald-Bold.ttf', fontWeight: 700 })

const parts = { Document, Page, Text, View, Image }
const assets = { logoSrc: 'public/logo.png' }

const settings = {
  business_name: 'The Audio Smith',
  legal_name: 'Smith Audio, LLC',
  address_line1: '2610 Melbourne Lane',
  address_line2: 'Lake in the Hills, IL 60156',
  phone: '269.217.8400',
  email: 'dan@theaudiosmith.com',
  remit_to: 'Smith Audio, LLC\n2610 Melbourne Lane\nLake in the Hills, IL 60156',
}

// #386 as issued: one line, no deposit.
const simple = {
  number: 386,
  status: 'sent',
  issue_date: '2026-08-07',
  due_date: '2026-09-06',
  terms_days: 30,
  bill_to_snapshot: 'Journey Church',
  subtotal_cents: 50000,
  tax_bp: 0, tax_cents: 0,
  deposit_cents: 0,
  total_cents: 50000,
  notes: null,
  client: { name: 'Journey Church', address_line1: null, address_line2: null },
  lines: [{
    id: 'l1', description: 'Audio Training/Maintenance',
    qty_hundredths: 100, unit_price_cents: 50000, line_total_cents: 50000,
  }],
  settings,
}

// #340 as issued: several lines and a real deposit.
const withDeposit = {
  ...simple,
  number: 340,
  status: 'paid',
  bill_to_snapshot: 'Streamline Pictures',
  subtotal_cents: 688394,
  deposit_cents: 585000,
  total_cents: 103394,
  notes: 'Thanks for a great week.',
  client: { name: 'Streamline Pictures', address_line1: null, address_line2: null },
  lines: [
    { id: 'a', description: 'Day Rate', qty_hundredths: 600, unit_price_cents: 78000, line_total_cents: 468000 },
    { id: 'b', description: 'Travel Rate', qty_hundredths: 200, unit_price_cents: 39000, line_total_cents: 78000 },
    { id: 'c', description: 'Overtime', qty_hundredths: 1900, unit_price_cents: 10636, line_total_cents: 202084 },
    { id: 'd', description: 'PM Hours', qty_hundredths: 800, unit_price_cents: 7091, line_total_cents: 56728 },
  ],
}

mkdirSync('tmp', { recursive: true })
for (const [name, data] of [['simple', simple], ['deposit', withDeposit]]) {
  await renderToFile(buildInvoicePdf(parts, data, assets), `tmp/invoice-${name}.pdf`)
  console.log(`wrote tmp/invoice-${name}.pdf`)
}
