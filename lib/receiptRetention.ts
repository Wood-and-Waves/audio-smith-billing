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
 * The date the grace period is counted from, or null when there isn't one.
 *
 * Payments are a table rather than a column, so the date is the latest payment.
 * An invoice hand-marked paid has none, and without the fallback its originals
 * would be archived forever and never reclaimed.
 *
 * Exported because the dry run reports which date it used. If the report worked
 * this out for itself it could agree with the guard today and drift from it
 * later — and the report exists precisely so a human can check the guard.
 */
export function settlementDate(row: RetentionRow): string | null {
  return row.paidOn ?? row.invoiceUpdatedAt?.slice(0, 10) ?? null
}

/**
 * Why this original may NOT be destroyed, or null when every rule is satisfied.
 *
 * mayDelete is defined in terms of this rather than the other way round, so the
 * dry run's explanation of a refusal and the guard that performs it cannot
 * become two pieces of logic that drift apart. A report that agrees with the
 * guard by coincidence is worth nothing.
 *
 * Every clause here is load-bearing; each one has a test that fails in the
 * destructive direction if it is removed.
 */
export function deletionBlocker(row: RetentionRow, today: string): string | null {
  // Nothing left to delete.
  if (row.receiptOriginal === null) return 'no original left to delete'

  // The rule the whole design rests on: no verified copy, no delete. A failed
  // or half-finished upload can therefore never lose the only untouched copy.
  if (row.receiptArchivedAt === null) return 'not archived — no verified copy in Dropbox'

  // Unbilled, or billed and not yet paid. 'void' is here too, and matters:
  // voiding an invoice frees the show to be rebilled, so those expenses are
  // live work again.
  if (row.invoiceStatus !== 'paid') {
    return `invoice is ${row.invoiceStatus ?? 'absent'}, not paid`
  }

  const settled = settlementDate(row)
  if (settled === null) return 'paid, but with no payment date and no updated_at to fall back on'

  const age = daysBetween(settled, today)
  if (age < GRACE_DAYS) return `settled ${age} of ${GRACE_DAYS} days ago`

  return null
}

/**
 * Whether this original may be destroyed.
 *
 * A thin reading of deletionBlocker on purpose — see the note there.
 */
export function mayDelete(row: RetentionRow, today: string): boolean {
  return deletionBlocker(row, today) === null
}

/**
 * Generic in the row so a caller carrying extra reporting fields alongside the
 * retention ones gets them back. The alternative was the deletion stage
 * re-joining its own candidates to the filtered result by id, which is a lookup
 * that can go wrong in a code path where going wrong means deleting the wrong
 * file.
 */
export function deletable<T extends RetentionRow>(rows: T[], today: string): T[] {
  return rows.filter((row) => mayDelete(row, today))
}

// ---------------------------------------------------------------------------
// Reading the deletion stage's query result
// ---------------------------------------------------------------------------

/** A retention row plus the facts a human needs to audit the decision. */
export type ReclaimCandidate = RetentionRow & {
  showName: string
  invoiceNumber: number | null
}

/**
 * An embedded relation as PostgREST may hand it back.
 *
 * A to-one embed arrives as an object and a to-many as an array, but which of
 * those PostgREST decides a relationship is depends on the foreign key it picks,
 * and this client is created without a generated Database type so nothing checks
 * the guess. Guessing wrong fails SAFE — an unreadable status reads as null and
 * deletionBlocker refuses it — but it fails safe SILENTLY, and a deletion stage
 * that quietly never deletes anything looks exactly like one that is working.
 * So both shapes are accepted rather than assumed.
 */
type Embedded<T> = T | T[] | null | undefined

function one<T>(e: Embedded<T>): T | null {
  return Array.isArray(e) ? (e[0] ?? null) : (e ?? null)
}

function many<T>(e: Embedded<T>): T[] {
  return Array.isArray(e) ? e : e ? [e] : []
}

/** The columns the deletion stage selects, and the only place their shape is understood. */
export type ReclaimQueryRow = {
  id: string
  receipt_original: string | null
  receipt_archived_at: string | null
  shows: Embedded<{
    name: string | null
    invoices: Embedded<{
      number: number | string | null
      status: string | null
      updated_at: string | null
      payments: Embedded<{ paid_on: string | null }>
    }>
  }>
}

/**
 * Turns query rows into candidates. Pure: it decides nothing about deletion,
 * it only reads. `deletable` still has to agree before anything is removed.
 */
export function toReclaimCandidates(rows: ReclaimQueryRow[]): ReclaimCandidate[] {
  return rows.map((r) => {
    const show = one(r.shows)
    const invoice = one(show?.invoices)

    // Narrowed against the check constraint rather than cast. A status this
    // code does not recognise — a value added to the constraint later, a typo
    // in a hand-run UPDATE — becomes null, and null is never 'paid', so an
    // unknown state can only ever make the guard more reluctant.
    const raw = invoice?.status
    const invoiceStatus = raw === 'draft' || raw === 'sent' || raw === 'paid' || raw === 'void'
      ? raw
      : null

    // The LATEST payment, not the first. Partial payments are why payments is a
    // table at all, and an invoice paid in two instalments is not settled until
    // the second one lands — taking the earliest date would start the 30-day
    // clock early and destroy originals for an invoice still being paid.
    const paidDates = many(invoice?.payments)
      .map((p) => p.paid_on)
      .filter((d): d is string => typeof d === 'string' && d.length > 0)

    return {
      expenseId: r.id,
      receiptOriginal: r.receipt_original,
      receiptArchivedAt: r.receipt_archived_at,
      invoiceStatus,
      paidOn: paidDates.length ? paidDates.reduce((a, b) => (a > b ? a : b)) : null,
      invoiceUpdatedAt: invoice?.updated_at ?? null,
      showName: show?.name ?? 'Unknown show',
      // number is int4, but Number() matches what the invoice sweep does rather
      // than trusting the JSON encoder to have handed back a number.
      invoiceNumber: invoice?.number == null ? null : Number(invoice.number),
    }
  })
}
