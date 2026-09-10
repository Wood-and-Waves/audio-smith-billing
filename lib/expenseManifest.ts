// The expense spreadsheet Dan attaches to an invoice.
//
// When he bills Streamline for a show he sends one PDF: the invoice, then a
// page listing every expense in three columns — Food, Ride, Baggage — each with
// a stated total, then the receipt images themselves.
//
//     Food Total   Ride Total   Baggage Total   Total
//     $266.21      $0.00        $120.00         $386.21
//     Where              Amount   Where    Amount
//     The Well           $19.98   United   $60.00
//     Meritage Blend Cafe $8.98
//
// THE COLUMN TOTALS FOOT, exactly, on every bundle examined — and they match
// the invoice's expense line to the penny. That is what makes this worth
// parsing rather than reading with a model: the document checks itself, and a
// bundle that does not add up can be refused whole instead of half-filed.
//
// WHY POSITIONS AND NOT TEXT. The Ride column is empty on every bundle he has
// sent, so the flattened line
//
//     The Well $19.98 United $60.00
//
// is ambiguous — that second amount could be Ride or Baggage, and only its x
// says which. The two bundles also sit at different scales (Praxis puts its
// Food amounts near x=204, IllumiNations near x=164), so every anchor is read
// off the page and nothing is hardcoded.
//
// A column is decided by POSITION, never by the vendor's name: "United $10.00"
// in the Food column is an inflight snack, not a bag fee.
//
// Pure: no PDF, no database, no clock.

import { parseUSD } from './money.ts'

/** One text item from a PDF page: its text and its horizontal position. */
export type ManifestCell = { x: number; text: string }

export type ManifestColumn = 'food' | 'ride' | 'baggage'

export type ManifestItem = {
  vendor: string
  amountCents: number
  column: ManifestColumn
}

export type ManifestParse = {
  items: ManifestItem[]
  totals: {
    food: number
    ride: number
    baggage: number
    /** The fourth "Total" column, when the bundle has one. IllumiNations does not. */
    stated: number | null
  }
  /** Whether the items add up to the stated totals. Nothing files unless this is true. */
  foots: boolean
}

/** Strict: a vendor named "4.76" must never read as money. */
const MONEY = /^\$[\d,]+\.\d{2}$/

const COLUMNS: readonly ManifestColumn[] = ['food', 'ride', 'baggage']

const empty = (): ManifestParse => ({
  items: [],
  totals: { food: 0, ride: 0, baggage: 0, stated: null },
  foots: false,
})

type Group = { whereX: number; amountX: number }

/**
 * Which column a cell sits in.
 *
 * Distance to the NEARER of the column's two sub-anchors, because a vendor name
 * is left-aligned near "Where" while its amount sits under "Amount", and a long
 * name ("Meritage Blend Cafe") starts well left of the header it belongs to.
 */
function nearestColumn(x: number, groups: readonly Group[]): number {
  let best = 0
  let bestDistance = Infinity
  for (let i = 0; i < groups.length; i++) {
    const d = Math.min(Math.abs(x - groups[i].whereX), Math.abs(x - groups[i].amountX))
    if (d < bestDistance) {
      bestDistance = d
      best = i
    }
  }
  return best
}

/**
 * Read one page of cells as an expense manifest.
 *
 * Each row is the page's text items at one vertical position, x ascending. A
 * page that is not a manifest returns empty with `foots: false` rather than
 * throwing — the caller feeds it every page and keeps the one that parses.
 */
export function parseExpenseManifest(
  rows: readonly (readonly ManifestCell[])[],
): ManifestParse {
  const headerIndex = rows.findIndex(r => r.some(c => c.text === 'Food Total'))
  if (headerIndex === -1 || headerIndex + 1 >= rows.length) return empty()

  // "Baggage Total" ends in "Total" too, so these are matched whole, in order.
  const headerAnchors: { name: ManifestColumn | 'stated'; x: number }[] = []
  for (const cell of rows[headerIndex]) {
    if (cell.text === 'Food Total') headerAnchors.push({ name: 'food', x: cell.x })
    else if (cell.text === 'Ride Total') headerAnchors.push({ name: 'ride', x: cell.x })
    else if (cell.text === 'Baggage Total') headerAnchors.push({ name: 'baggage', x: cell.x })
    else if (cell.text === 'Total') headerAnchors.push({ name: 'stated', x: cell.x })
  }
  if (headerAnchors.length === 0) return empty()

  const result = empty()
  for (const cell of rows[headerIndex + 1]) {
    if (!MONEY.test(cell.text)) continue
    const cents = parseUSD(cell.text)
    if (cents === null) continue
    let best = headerAnchors[0]
    let bestDistance = Infinity
    for (const anchor of headerAnchors) {
      const d = Math.abs(cell.x - anchor.x)
      if (d < bestDistance) {
        bestDistance = d
        best = anchor
      }
    }
    if (best.name === 'stated') result.totals.stated = cents
    else result.totals[best.name] = cents
  }

  // The "Where / Amount / Rcpt" row defines the columns for every row below it.
  const subIndex = rows.findIndex((r, i) => i > headerIndex && r.some(c => c.text === 'Where'))
  if (subIndex === -1) return empty()

  const groups: Group[] = []
  const sub = rows[subIndex]
  for (let i = 0; i < sub.length && groups.length < COLUMNS.length; i++) {
    if (sub[i].text !== 'Where') continue
    const amount = sub.slice(i + 1).find(c => c.text === 'Amount')
    groups.push({ whereX: sub[i].x, amountX: amount ? amount.x : sub[i].x })
  }
  if (groups.length === 0) return empty()

  for (const row of rows.slice(subIndex + 1)) {
    const buckets: ManifestCell[][] = groups.map(() => [])
    for (const cell of row) buckets[nearestColumn(cell.x, groups)].push(cell)

    for (let i = 0; i < buckets.length; i++) {
      const column = COLUMNS[i]
      if (column === undefined) continue
      const amountCell = buckets[i].find(c => MONEY.test(c.text))
      if (amountCell === undefined) continue
      const amountCents = parseUSD(amountCell.text)
      if (amountCents === null) continue
      const vendor = buckets[i]
        .filter(c => c !== amountCell)
        .map(c => c.text)
        .join(' ')
        .trim()
      result.items.push({ vendor, amountCents, column })
    }
  }

  const summed = (column: ManifestColumn) =>
    result.items.reduce((n, i) => (i.column === column ? n + i.amountCents : n), 0)

  const { food, ride, baggage, stated } = result.totals
  result.foots =
    summed('food') === food
    && summed('ride') === ride
    && summed('baggage') === baggage
    && (stated === null || stated === food + ride + baggage)

  return result
}
