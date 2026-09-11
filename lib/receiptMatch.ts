// Which bank row a forwarded receipt belongs to.
//
// Same shape as lib/ledgerMatch.ts's expense proposals, and the same
// discipline: this PROPOSES, it never decides. Dan confirms every one before
// a receipt is attached to anything.
//
// Pure: no database, no clock beyond the plain dates it is handed.

import { isPlainDate, dateInChicago } from './dates.ts'

export type ReceiptCandidateTxn = {
  id: string
  date: string          // YYYY-MM-DD
  /** Signed, as stored: a charge is negative. */
  amount_cents: number
  payee: string
  /** A row that already carries a receipt is still offered, but ranked last. */
  receipt_path: string | null
}

export type ReceiptMatch = {
  txnId: string
  date: string
  payee: string
  amountCents: number
  /** Whole days between the receipt's date and the bank row's. */
  daysApart: number
  /** True when the row already has a receipt — attaching would replace it. */
  alreadyHasReceipt: boolean
}

/**
 * How far apart a receipt and its bank row may sit.
 *
 * 10 days, the same window lib/ledgerMatch.ts uses for expense proposals —
 * one number for "these two events are the same purchase" rather than two that
 * drift apart. It covers the ordinary lag between buying something and the
 * charge posting, and it is the reason a hotel folio dated at check-in still
 * finds a charge that posted at checkout.
 */
export const RECEIPT_MATCH_DAYS = 10

const MS_PER_DAY = 86_400_000

/** Whole-day distance between two YYYY-MM-DD strings, via Date.UTC so no local zone leaks in. */
function daysApart(a: string, b: string): number {
  const utc = (d: string) => {
    const [y, m, day] = d.split('-').map(Number)
    return Date.UTC(y, m - 1, day)
  }
  return Math.abs(utc(a) - utc(b)) / MS_PER_DAY
}

/**
 * Bank rows that could be this receipt, nearest in date first.
 *
 * Matching is on the AMOUNT exactly and the date loosely, which is the pairing
 * a receipt actually supports: the figure printed on it is the figure that
 * left the account, while the date it carries is when Dan bought something and
 * the bank's is when the charge settled.
 *
 * A charge only — `amount_cents < 0`. A receipt is proof money left; a deposit
 * can never be the other side of one, and offering deposits here would repeat
 * the mistake the Link-a-payment panel made in the other direction.
 *
 * Rows that ALREADY carry a receipt are still returned, ranked last and
 * flagged. Hiding them would be wrong — replacing a bad scan with the emailed
 * original is a real thing to want — but they should never outrank a row that
 * has nothing.
 */
export function proposeReceiptMatches(
  receipt: { amountCents: number; spentOn: string },
  txns: readonly ReceiptCandidateTxn[],
): ReceiptMatch[] {
  const out: ReceiptMatch[] = []
  for (const t of txns) {
    if (t.amount_cents >= 0) continue
    if (-t.amount_cents !== receipt.amountCents) continue
    const gap = daysApart(t.date, receipt.spentOn)
    if (gap > RECEIPT_MATCH_DAYS) continue
    out.push({
      txnId: t.id,
      date: t.date,
      payee: t.payee,
      amountCents: t.amount_cents,
      daysApart: gap,
      alreadyHasReceipt: t.receipt_path !== null && t.receipt_path.trim() !== '',
    })
  }

  return out.sort((a, b) => {
    if (a.alreadyHasReceipt !== b.alreadyHasReceipt) return a.alreadyHasReceipt ? 1 : -1
    if (a.daysApart !== b.daysApart) return a.daysApart - b.daysApart
    // Deterministic tail, so a reload cannot reshuffle two equally close rows.
    return a.txnId < b.txnId ? -1 : 1
  })
}

/** The date a receipt should be matched on, and whether it had to be guessed. */
export type ReceiptMatchDate = { date: string; inferred: boolean }

/**
 * Which date to match a receipt on.
 *
 * Prefers the date the parser read off the document. Falls back to the day the
 * EMAIL ARRIVED when there is none — which is the case this exists for: an
 * order confirmation carries an expected-delivery date in the future,
 * normalizeSpentOn refuses a future date (rightly), and the receipt lands with
 * spent_on null. The page then short-circuited to an empty match list, so a
 * receipt whose charge was sitting in the ledger to the cent could never be
 * paired, no matter how many statements were imported. Dan hit exactly this
 * with a $193.90 NuPhy order on 2026-09-11.
 *
 * An inferred date is NOT as good as a read one, and the caller is expected to
 * say so on screen. It is safe to propose on because the other two gates do
 * not move: the amount must still match to the cent, and the gap must still be
 * inside RECEIPT_MATCH_DAYS. Nothing auto-files — Dan confirms every pairing —
 * so the worst case is a proposal he declines, against a present cost of a
 * receipt that can never be paired at all.
 */
export function matchDateFor(
  spentOn: string | null,
  receivedAt: string | null,
): ReceiptMatchDate | null {
  if (spentOn !== null && isPlainDate(spentOn)) return { date: spentOn, inferred: false }
  if (receivedAt === null) return null
  const fallback = dateInChicago(receivedAt)
  return fallback === null ? null : { date: fallback, inferred: true }
}
