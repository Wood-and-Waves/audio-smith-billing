// Expenses to invoice lines.
//
// Pure: no database, no images, no clock. This is the boundary where a list of
// receipts becomes money on an invoice, and it is deliberately the same shape
// as lib/showBuckets.ts — a bucket that is empty produces no line at all.
//
// The category owns the invoice-line label. That is the point of a fixed set:
// the label stops being typed, so it stops drifting. Five years of the old
// sheet produced Baggage, Baggage Fees, Baggage Expenses and Baggage Fee for
// one thing, which is also why none of it could be reported on.
//
// No '@/' imports and no JSX — this module runs under plain node --test.

import type { BucketLine } from './showBuckets.ts'

export type ExpenseCategory = 'meals' | 'rides' | 'baggage' | 'other'

export type ExpenseLike = {
  id: string
  category: ExpenseCategory
  where_spent: string
  amount_cents: number
  spent_on: string
  /** Storage key of the enhanced image, or null when not yet photographed. */
  receipt_path: string | null
  /**
   * true = billed to the client (invoice line, receipt gates billing, frozen
   * into the snapshot). false = Dan's own cost (per-diem meals): never reaches
   * the invoice or the client, never blocks billing, receipt optional.
   */
  billable: boolean
}

/** Wording taken from the invoices Dan already sends. */
export const CATEGORY_LABEL: Record<ExpenseCategory, string> = {
  meals: 'Meal Expenses',
  rides: 'Ride Expenses',
  baggage: 'Baggage Expenses',
  other: 'Expenses',
}

/** Fixed output order, so an invoice reads the same way every time. */
export const CATEGORY_ORDER: ExpenseCategory[] = ['meals', 'rides', 'baggage', 'other']

/**
 * One line per category that has anything in it.
 *
 * Quantity is always exactly 1 and the price is a sum of stored cents: an
 * expense is money already spent, so there is no rate and no quantity to
 * multiply. Nothing here is recomputed.
 *
 * A my-cost (`billable: false`) row is skipped: it is Dan's own expense, not
 * the client's, and must never turn into money on an invoice.
 *
 * `=== false`, not `!e.billable`, here and below — deliberately. The type
 * promises a boolean, but the value really comes from hand-written select
 * strings the compiler cannot check (every query result is cast). If a future
 * edit drops `billable` from a select, undefined must fail toward the OLD
 * behavior — the expense stays on the invoice and in the receipts gate, where
 * Dan can see it — never silently vanish from billing.
 */
export function expenseLines(expenses: ExpenseLike[]): BucketLine[] {
  const lines: BucketLine[] = []

  for (const category of CATEGORY_ORDER) {
    let total = 0
    for (const e of expenses) {
      if (e.billable === false) continue
      if (e.category === category) total += e.amount_cents
    }
    if (total > 0) {
      lines.push({
        description: CATEGORY_LABEL[category],
        qty_hundredths: 100,
        unit_price_cents: total,
      })
    }
  }

  return lines
}

/**
 * Which expenses cannot be billed yet.
 *
 * "Every expense has to have a receipt to bill." An expense may be LOGGED
 * without one — the amount is often noted before the photograph — but the show
 * cannot be billed until every one of them has a file behind it.
 *
 * A blank string is not a receipt: it would pass a null check and let a show
 * bill with nothing behind it.
 *
 * A my-cost (`billable: false`) row is skipped: it never reaches the client,
 * so a missing receipt on it can never block billing. (`!== false` for the
 * same dropped-select reason expenseLines gives: undefined must gate, not
 * silently pass.)
 */
export function expensesMissingReceipts(expenses: ExpenseLike[]): ExpenseLike[] {
  return expenses.filter(
    (e) => e.billable !== false && (!e.receipt_path || e.receipt_path.trim() === ''),
  )
}
