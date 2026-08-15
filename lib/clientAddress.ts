// Assembles a client's mailing address for the BILL TO block.
//
// One function, used everywhere an invoice needs to print a client's
// address, so the three places that build one — saveInvoice's frozen
// snapshot, and the two live-client fallbacks in InvoiceDocument.tsx and
// invoicePdf.ts — can never quietly disagree.
//
// clients gained city/state/postal_code (migration 0013) alongside the
// existing free-text address_line1/address_line2. Some clients still carry
// "Elgin, IL 60123" as line 2 — that convention keeps working — while a
// client edited after this shipped stores the same information in the
// structured columns instead. Both print; this just adds the structured
// columns as their own line rather than replacing anything.
//
// No 'use client', no hooks, no imports: pure data in, string out, so it
// runs in a plain `node` test the same as everywhere else it's called from.

export type CityStateZipLike = {
  city?: string | null
  state?: string | null
  postal_code?: string | null
}

/**
 * "Elgin, IL 60123" from whichever of the three are present. City and the
 * state/zip pair join with a comma; state and zip join with a space. A blank
 * field is dropped rather than leaving a stray comma or double space behind.
 * Null when all three are blank, so a caller can omit the line entirely
 * instead of printing an empty one.
 */
export function cityStateZip(c: CityStateZipLike): string | null {
  const city = c.city?.trim() || ''
  const stateZip = [c.state?.trim() || '', c.postal_code?.trim() || '']
    .filter(Boolean)
    .join(' ')
  const parts = [city, stateZip].filter(Boolean)
  return parts.length ? parts.join(', ') : null
}

export type BillToLike = CityStateZipLike & {
  name?: string | null
  address_line1?: string | null
  address_line2?: string | null
}

/** Every non-blank line of a client's BILL TO block, in print order. */
export function billToLines(c: BillToLike): string[] {
  return [c.name, c.address_line1, c.address_line2, cityStateZip(c)]
    .filter((l): l is string => !!l && l.trim() !== '')
}

/** The BILL TO block as the document prints it: one line per non-blank field. */
export function billToText(c: BillToLike): string {
  return billToLines(c).join('\n')
}
