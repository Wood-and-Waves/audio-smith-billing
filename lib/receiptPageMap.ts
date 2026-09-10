// Which page of a bundle holds which receipt.
//
// A Streamline bundle is one PDF: the invoice, the expense spreadsheet, then a
// page per receipt image. lib/expenseManifest.ts says WHAT was spent; this says
// WHERE each receipt lives, so the right single page lands on the right bank
// row instead of a sixteen-page document landing on all of them.
//
// The mapping is the one part of the backfill a model has to do — the receipt
// images carry no structure to parse. So this module is the schema plus a
// validator, and the model call itself stays in the import script, the way
// scripts/import/ynab-backfill.mjs keeps its I/O in the shell. The fragile part
// is here, where tests can hold it still.
//
// It REFUSES rather than repairs. A wrong page map attaches a stranger's
// receipt to a real charge, and that error is invisible afterwards — the row
// looks documented. A bundle whose map does not validate queues whole and Dan
// files it by hand, which is slower and correct.
//
// Pure: no network, no database, no clock.

import { normalizeAmountCents, normalizeVendor } from './receiptExtraction.ts'

export type PageEntry = {
  /** 1-based, as a person counts pages. */
  page: number
  vendor: string
  amountCents: number
}

export const PAGE_MAP_SCHEMA: { type: 'json_schema'; schema: Record<string, unknown> } = {
  type: 'json_schema',
  schema: {
    type: 'object',
    properties: {
      pages: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            page: { type: 'integer' },
            vendor: { type: 'string' },
            amount: { type: 'string' },
          },
          required: ['page', 'vendor', 'amount'],
          additionalProperties: false,
        },
      },
    },
    required: ['pages'],
    additionalProperties: false,
  },
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

export function readPageMap(
  raw: unknown,
  opts: { pageCount: number },
): { pages: PageEntry[] } | { error: string } {
  if (!isRecord(raw)) return { error: 'The page map is not an object.' }
  if (!Array.isArray(raw.pages)) return { error: 'The page map has no pages array.' }

  const pages: PageEntry[] = []
  const seen = new Set<number>()

  for (const entry of raw.pages) {
    if (!isRecord(entry)) return { error: 'A page entry is not an object.' }

    const page = entry.page
    if (typeof page !== 'number' || !Number.isInteger(page)) {
      return { error: `A page entry has no whole page number: ${JSON.stringify(page)}.` }
    }
    if (page < 1 || page > opts.pageCount) {
      return { error: `Page ${page} is outside a document of ${opts.pageCount} pages.` }
    }
    if (seen.has(page)) return { error: `Page ${page} is claimed twice.` }
    seen.add(page)

    const vendor = normalizeVendor(entry.vendor)
    if (vendor === null) return { error: `Page ${page} has no readable vendor.` }

    const amountCents = normalizeAmountCents(entry.amount)
    if (amountCents === null) {
      return { error: `Page ${page} has no readable amount: ${JSON.stringify(entry.amount)}.` }
    }

    pages.push({ page, vendor, amountCents })
  }

  return { pages }
}
