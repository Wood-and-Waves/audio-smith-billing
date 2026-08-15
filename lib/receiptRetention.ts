// When an original may leave, and when it may be destroyed.
//
// Two rules, and they are not symmetric. Archiving is cheap and reversible, so
// it applies to everything. Deleting is neither, so it needs all three of:
// the invoice paid, the payment old enough to be settled, and a VERIFIED copy
// already in Dropbox.
//
// Pure — `today` is a parameter, never a clock, so these tests cannot drift
// when the suite runs on a different day. Dates are plain YYYY-MM-DD and
// compare lexically.

export type RetentionRow = {
  expenseId: string
  receiptOriginal: string | null
  /** Set only after an upload is verified by size AND content hash. */
  receiptArchivedAt: string | null
  invoiceStatus: 'draft' | 'sent' | 'paid' | 'void' | null
  /** max(payments.paid_on) for the invoice — payments are a table, so partial payments work. */
  paidOn: string | null
  /** Fallback for an invoice hand-marked paid with no payment row. */
  invoiceUpdatedAt: string | null
}

/** Long enough that a settled invoice is genuinely settled. */
export const GRACE_DAYS = 30

/** Days between two plain dates. Both are UTC-pinned, so this cannot drift. */
function daysBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number)
  const [ty, tm, td] = to.split('-').map(Number)
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000)
}

/**
 * Everything still holding an original that has not been copied out.
 *
 * Deliberately NOT gated on payment. Archiving early spreads the work across
 * many nightly runs, so by the time an invoice is 30 days paid its originals
 * went across weeks ago and the delete has nothing to wait for.
 */
export function needsArchiving(rows: RetentionRow[]): RetentionRow[] {
  return rows.filter((r) => r.receiptOriginal !== null && r.receiptArchivedAt === null)
}

/**
 * Whether this original may be destroyed.
 *
 * Every clause here is load-bearing; each one has a test that fails in the
 * destructive direction if it is removed.
 */
export function mayDelete(row: RetentionRow, today: string): boolean {
  // Nothing left to delete.
  if (row.receiptOriginal === null) return false

  // The rule the whole design rests on: no verified copy, no delete. A failed
  // or half-finished upload can therefore never lose the only untouched copy.
  if (row.receiptArchivedAt === null) return false

  // Unbilled, or billed and not yet paid. 'void' is here too, and matters:
  // voiding an invoice frees the show to be rebilled, so those expenses are
  // live work again.
  if (row.invoiceStatus !== 'paid') return false

  // Payments are a table rather than a column, so the date is the latest
  // payment. An invoice hand-marked paid has none, and without the fallback its
  // originals would be archived forever and never reclaimed.
  const settled = row.paidOn ?? row.invoiceUpdatedAt?.slice(0, 10) ?? null
  if (settled === null) return false

  return daysBetween(settled, today) >= GRACE_DAYS
}

export function deletable(rows: RetentionRow[], today: string): RetentionRow[] {
  return rows.filter((row) => mayDelete(row, today))
}
