// Money for an invoice, which is a document someone pays against — so every
// amount is an integer number of CENTS and never a float.
//
// CrewTracker stores money as Postgres `numeric` and computes in JS floats.
// That's fine for a payroll estimate. It is not fine here: 0.1 + 0.2 is
// 0.30000000000000004, and an invoice that disagrees with itself by a cent is
// a phone call from a client.
//
// No 'use client', no hooks, no imports: this renders in server and client
// trees alike, and in a plain `node` test. Keep it that way.

/** Rounding rule, stated once: half away from zero (0.5 -> 1, -0.5 -> -1). */
export function roundCents(x: number): number {
  return x < 0 ? -Math.round(-x) : Math.round(x)
}

/**
 * Parse user/sheet input into cents. Accepts "$1,234.56", "1234.56", "(5.75)"
 * for negatives, "" -> 0. Returns null on anything it can't read, so a caller
 * can tell "nothing entered" from "zero".
 */
export function parseUSD(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined) return null
  if (typeof input === 'number') return Number.isFinite(input) ? roundCents(input * 100) : null

  let s = input.trim()
  if (s === '') return 0

  let negative = false
  if (s.startsWith('(') && s.endsWith(')')) {
    negative = true
    s = s.slice(1, -1)
  }
  if (s.startsWith('-')) {
    negative = !negative
    s = s.slice(1)
  }
  s = s.replace(/[$,\s]/g, '')
  if (!/^\d*(\.\d*)?$/.test(s) || s === '' || s === '.') return null

  // Split on the decimal point rather than multiplying a float by 100 —
  // parseFloat("19.99") * 100 is 1998.9999999999998.
  const [whole, frac = ''] = s.split('.')
  const cents = Number(whole || '0') * 100 + Number((frac + '00').slice(0, 2))
  if (!Number.isSafeInteger(cents)) return null
  return negative ? -cents : cents
}

const USD = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

/** "$1,234.56" — always two decimals, for anything a client reads. */
export function formatUSD(cents: number): string {
  return USD.format(cents / 100)
}

/** "1234.56" — bare, for CSV and form field values. */
export function formatAmount(cents: number): string {
  return (cents / 100).toFixed(2)
}

/**
 * Quantity is stored as hundredths so fractional hours (4.5, 0.25) stay exact.
 * "4.5" -> 450. Returns null if unparseable.
 */
export function parseQty(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined) return null
  const s = String(input).trim()
  if (s === '') return 0
  if (!/^-?\d*(\.\d*)?$/.test(s) || s === '.' || s === '-') return null
  const negative = s.startsWith('-')
  const [whole, frac = ''] = (negative ? s.slice(1) : s).split('.')
  const q = Number(whole || '0') * 100 + Number((frac + '00').slice(0, 2))
  if (!Number.isSafeInteger(q)) return null
  return negative ? -q : q
}

export function formatQty(qtyHundredths: number): string {
  const n = qtyHundredths / 100
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0$/, '')
}

/**
 * A line's total. Both inputs are integers, so the product is exact and only
 * the final divide needs rounding.
 *
 *   lineTotal(450, 10636) -> 4.5 x $106.36 = $478.62
 */
export function lineTotal(qtyHundredths: number, unitPriceCents: number): number {
  return roundCents((qtyHundredths * unitPriceCents) / 100)
}

/** Tax rate lives in basis points so it's an integer too. 8.25% -> 825. */
export function taxOn(subtotalCents: number, rateBasisPoints: number): number {
  if (!rateBasisPoints) return 0
  return roundCents((subtotalCents * rateBasisPoints) / 10_000)
}

export type InvoiceLineInput = { qtyHundredths: number; unitPriceCents: number }

export type InvoiceTotals = {
  subtotalCents: number
  taxCents: number
  depositCents: number
  totalCents: number
}

/**
 * The one place invoice arithmetic happens.
 *
 * Deposit is subtracted AFTER tax — it's money already received against the
 * bill, not a discount on the goods. This matches the sheet, where
 * `sum(lines) - deposit = total` reconciles to the cent on 93 of 94 invoices.
 */
export function computeTotals(
  lines: InvoiceLineInput[],
  opts: { taxBasisPoints?: number; depositCents?: number } = {},
): InvoiceTotals {
  const subtotalCents = lines.reduce((sum, l) => sum + lineTotal(l.qtyHundredths, l.unitPriceCents), 0)
  const taxCents = taxOn(subtotalCents, opts.taxBasisPoints ?? 0)
  const depositCents = opts.depositCents ?? 0
  return {
    subtotalCents,
    taxCents,
    depositCents,
    totalCents: subtotalCents + taxCents - depositCents,
  }
}

/** What's still owed after payments recorded against the invoice. */
export function balanceCents(totalCents: number, paymentsCents: number[]): number {
  return totalCents - paymentsCents.reduce((a, b) => a + b, 0)
}

// --- Derived rates -------------------------------------------------------
// Dan's history shows Travel = 50% of the day rate, and Overtime = the hourly
// rate x1.5 where hourly = day rate / the client's overtime threshold.
//
// These are SUGGESTIONS. The number actually used gets stored on the line,
// because the sheet contains both $106.36 and $106.37 for the same computed
// rate — rounded differently on different days. Recomputing on read would
// silently rewrite history.

export function travelRateFrom(dayRateCents: number): number {
  return roundCents(dayRateCents / 2)
}

export function overtimeRateFrom(dayRateCents: number, overtimeAfterHours: number): number {
  if (!overtimeAfterHours) return 0
  return roundCents((dayRateCents / overtimeAfterHours) * 1.5)
}

export function doubleTimeRateFrom(dayRateCents: number, overtimeAfterHours: number): number {
  if (!overtimeAfterHours) return 0
  return roundCents((dayRateCents / overtimeAfterHours) * 2)
}
