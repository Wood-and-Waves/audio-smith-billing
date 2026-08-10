// Parses the "Smith Audio - Invoice" Google Sheet export into clean JSON for
// migration. One-time-ish, but kept reproducible so the import can be re-run
// after Dan corrects anything in the sheet.
//
// Input:  raw/smith-audio-invoice-sheet.json  — {fileContent: "<markdown tables>"}
//         (gitignored: the Notes column carries bank account details)
// Output: out/invoices.json, out/items.json, out/clients.json, out/report.txt
//
// The Notes column is DROPPED on purpose. Every historical note is the same
// remit-to boilerplate containing routing/account numbers; in the new system
// that lives in one settings row, not on 94 invoices.

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const RAW = join(here, 'raw', 'smith-audio-invoice-sheet.json')
const OUT = join(here, 'out')

// --- Client name variants observed in the sheet. Each group collapses to its
// first entry. Only unambiguous misspellings are merged here.
const CLIENT_ALIASES = [
  ['Streamline Pictures', 'Streamline', 'Streamline Productions', 'Streamline Production', 'Streamline Pictures - GLS 2026'],
  ['JRP Live', 'JRP'],
  ['Willow Creek Community Church', 'Willow Creek Commnunity Church', 'Willow Creek Comunity Church'],
  ['Signature Production Group', 'Sigranture Production Group', 'SIgnature Production Group'],
  // Confirmed by Dan 2026-08-09: the campus/project suffixes below are the
  // same client, not separate ones. Canonical form drops the suffix.
  ['Journey Church', 'Joirney Church', 'Journey Church - Kenosha'],
  ['Sardis Media', 'Sardis'],
  ['The Orchard Church', 'The Orchard', 'The Orchard Church - Barrington'],
]

const canonicalClient = (raw) => {
  const name = (raw || '').trim()
  for (const group of CLIENT_ALIASES) {
    if (group.some((v) => v.toLowerCase() === name.toLowerCase())) return group[0]
  }
  return name
}

// Money in, integer cents out. Never let a dollar value become a float we keep.
const toCents = (v) => {
  const s = String(v ?? '').replace(/[$,\s]/g, '')
  if (!s || s === '-') return 0
  const neg = s.startsWith('(') && s.endsWith(')')
  const n = Number(neg ? s.slice(1, -1) : s)
  if (!Number.isFinite(n)) return 0
  return Math.round(n * 100) * (neg ? -1 : 1)
}

const toISO = (mdy) => {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec((mdy || '').trim())
  if (!m) return null
  const [, mo, d, y] = m
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`
}

const unescapeCell = (s) => (s || '').replace(/\\([#*_|])/g, '$1').trim()

// --- Parse the markdown tables the Drive export produces.
const content = JSON.parse(readFileSync(RAW, 'utf8')).fileContent
const rows = content
  .split('\n')
  .filter((ln) => ln.trim().startsWith('|'))
  .map((ln) => ln.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(unescapeCell))

const isInvoiceNo = (s) => /^\d{3}$/.test(s || '')
const isDate = (s) => /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s || '')

// Invoice header rows: 12 columns, numeric invoice #, real date.
// Columns: #, Date, Customer, Addr1, Addr2, Contact1, Contact2, Subtotal,
//          Tax %, Discount %, Total, Notes  <- Notes deliberately not read.
const invoices = []
const noteShapes = new Set()
for (const r of rows) {
  if (r.length !== 12 || !isInvoiceNo(r[0]) || !isDate(r[1])) continue
  noteShapes.add((r[11] || '').replace(/\s+/g, ' ').trim().slice(0, 40))
  invoices.push({
    number: Number(r[0]),
    issue_date: toISO(r[1]),
    client_name: canonicalClient(r[2]),
    client_name_raw: (r[2] || '').trim(),
    address_line1: r[3] || '',
    address_line2: r[4] || '',
    contact_line1: r[5] || '',
    contact_line2: r[6] || '',
    subtotal_cents: toCents(r[7]),
    tax_rate: r[8] || '0.00%',
    // The template's "Discount %" column is not a percentage. Dan repurposed
    // the cell as "Deposit ($)" and left the % number format on it, so the
    // sheet displays the dollar value x100: "330000.00%" means $3,300.00.
    // The displayed number therefore already IS the value in cents.
    deposit_cents: Math.round(Number(String(r[9] || '0').replace(/[%,\s$]/g, '')) || 0),
    total_cents: toCents(r[10]),
  })
}

// Item rows: 5 columns — #, Description, Qty, Price, Total
const items = []
for (const r of rows) {
  if (r.length !== 5 || !isInvoiceNo(r[0])) continue
  if (!r[1] && !r[3]) continue // blank template row
  items.push({
    invoice_number: Number(r[0]),
    description: r[1] || '',
    qty: Number(r[2] || 0),
    unit_price_cents: toCents(r[3]),
    line_total_cents: toCents(r[4]),
  })
}

invoices.sort((a, b) => a.number - b.number)
items.sort((a, b) => a.invoice_number - b.invoice_number)

// --- Clients, derived from the invoices themselves.
const clientMap = new Map()
for (const inv of invoices) {
  const c = clientMap.get(inv.client_name) || {
    name: inv.client_name,
    aliases: new Set(),
    address_line1: '',
    address_line2: '',
    contact_line1: '',
    contact_line2: '',
    billing_email: null, // NOT in the sheet — Dan must supply these
    invoice_count: 0,
    total_billed_cents: 0,
  }
  c.aliases.add(inv.client_name_raw)
  c.invoice_count += 1
  c.total_billed_cents += inv.total_cents
  // Keep the most complete address seen for this client.
  for (const f of ['address_line1', 'address_line2', 'contact_line1', 'contact_line2']) {
    if (!c[f] && inv[f]) c[f] = inv[f]
  }
  clientMap.set(inv.client_name, c)
}
const clients = [...clientMap.values()]
  .map((c) => ({ ...c, aliases: [...c.aliases].filter(Boolean).sort() }))
  .sort((a, b) => b.invoice_count - a.invoice_count)

// --- Reconciliation report. This is the thing that proves the import is honest.
const lines = []
const say = (s = '') => lines.push(s)

say('SMITH AUDIO INVOICE SHEET — EXTRACTION REPORT')
say('='.repeat(58))
say(`invoices parsed : ${invoices.length}`)
say(`line items      : ${items.length}`)
say(`clients (merged): ${clients.length}`)
say()

const nums = invoices.map((i) => i.number)
const lo = Math.min(...nums)
const hi = Math.max(...nums)
const gaps = []
for (let n = lo; n <= hi; n++) if (!nums.includes(n)) gaps.push(n)
say(`numbering       : ${lo} -> ${hi}`)
say(`gaps (${gaps.length})       : ${gaps.join(', ')}`)
say(`next number     : ${hi + 1}`)
say()

const dupes = nums.filter((n, i) => nums.indexOf(n) !== i)
say(`duplicate numbers: ${dupes.length ? dupes.join(', ') : 'none'}`)

// Items whose invoice has no header row, and vice versa.
const invSet = new Set(nums)
const itemInvSet = new Set(items.map((i) => i.invoice_number))
const orphanItems = [...itemInvSet].filter((n) => !invSet.has(n)).sort((a, b) => a - b)
const emptyInvoices = [...invSet].filter((n) => !itemInvSet.has(n)).sort((a, b) => a - b)
say(`items w/o an invoice row : ${orphanItems.length ? orphanItems.join(', ') : 'none'}`)
say(`invoices w/o line items  : ${emptyInvoices.length ? emptyInvoices.join(', ') : 'none'}`)
say()

// The accounting identity that must hold for every invoice:
//     sum(line items) - deposit = stated total
say('RECONCILIATION:  sum(lines) - deposit == stated total')
let mismatches = 0
let depositCount = 0
for (const inv of invoices) {
  const sum = items
    .filter((i) => i.invoice_number === inv.number)
    .reduce((t, i) => t + i.line_total_cents, 0)
  if (sum === 0) continue // header row with no items in the sheet
  if (inv.deposit_cents) depositCount++
  const expected = sum - inv.deposit_cents
  if (expected !== inv.total_cents) {
    mismatches++
    if (mismatches <= 10) {
      say(
        `  #${inv.number}  lines $${(sum / 100).toFixed(2)} - deposit $${(inv.deposit_cents / 100).toFixed(2)}` +
          ` = $${(expected / 100).toFixed(2)}  but total says $${(inv.total_cents / 100).toFixed(2)}`,
      )
    }
  }
}
say(`  invoices carrying a deposit: ${depositCount}`)
say(`  UNRECONCILED: ${mismatches}${mismatches > 10 ? ' (first 10 shown)' : ''}`)
say()

say('TOTAL BILLED BY YEAR')
const byYear = {}
for (const inv of invoices) {
  const y = (inv.issue_date || '????').slice(0, 4)
  byYear[y] = byYear[y] || { count: 0, cents: 0 }
  byYear[y].count++
  byYear[y].cents += inv.total_cents
}
for (const y of Object.keys(byYear).sort()) {
  const { count, cents } = byYear[y]
  say(`  ${y}   ${String(count).padStart(3)} invoices   $${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`)
}
const grand = invoices.reduce((t, i) => t + i.total_cents, 0)
say(`  TOTAL ${String(invoices.length).padStart(3)} invoices   $${(grand / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`)
say()

say('CLIENTS (merged; aliases shown where the sheet disagreed with itself)')
for (const c of clients) {
  const alias = c.aliases.length > 1 ? `   <- ${c.aliases.filter((a) => a !== c.name).join(' / ')}` : ''
  say(
    `  ${String(c.invoice_count).padStart(3)}x  $${(c.total_billed_cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 }).padStart(12)}  ${c.name}${alias}`,
  )
}
say()

say(`distinct Notes shapes: ${noteShapes.size} (dropped — remit-to lives in settings)`)
say(`clients missing a billing email: ${clients.filter((c) => !c.billing_email).length} of ${clients.length}`)

writeFileSync(join(OUT, 'invoices.json'), JSON.stringify(invoices, null, 2))
writeFileSync(join(OUT, 'items.json'), JSON.stringify(items, null, 2))
writeFileSync(join(OUT, 'clients.json'), JSON.stringify(clients, null, 2))
writeFileSync(join(OUT, 'report.txt'), lines.join('\n') + '\n')
console.log(lines.join('\n'))
