// Whether a receipt files itself, or waits for Dan.
//
// The rule is deliberately narrow. His decision (2026-09-10) was "auto-file
// exact matches, queue the rest", and the measurement behind it is the reason
// this refuses to be clever:
//
//   Six of IllumiNations' fourteen receipts have NO bank row, because a single
//   $25.00 Starbucks card reload on 2026-05-04 covers five of them. The
//   receipts are spend off a prepaid balance and never hit the bank
//   individually.
//
// So a receipt with no charge is a NORMAL outcome, not a failure to explain,
// and never a near-miss to force onto the closest row. Attaching a Starbucks
// receipt to some unrelated $4.76 would be worse than leaving the row bare:
// the books would look complete and be wrong.
//
// The other refusal is ties. proposeReceiptMatches sorts nearest-date-first, so
// a caller could be tempted to take the head of the list. It must not: two
// Auntie Anne's charges four days apart at $11.16 are genuinely
// indistinguishable, and only Dan knows which meal was which.
//
// Pure: no database, no clock.

import { type ReceiptMatch } from './receiptMatch.ts'

export type FilingDecision =
  | { action: 'file'; txnId: string }
  /**
   * `no-charge` — nothing matched; often prepaid spend, and expected.
   * `ambiguous` — several charges fit; a tie Dan breaks.
   * `taken` — the one candidate already carries a receipt.
   */
  | { action: 'queue'; reason: 'no-charge' | 'ambiguous' | 'taken' }

export function decideReceiptFiling(matches: readonly ReceiptMatch[]): FilingDecision {
  if (matches.length === 0) return { action: 'queue', reason: 'no-charge' }
  if (matches.length > 1) return { action: 'queue', reason: 'ambiguous' }

  const only = matches[0]
  if (only.alreadyHasReceipt) return { action: 'queue', reason: 'taken' }
  return { action: 'file', txnId: only.txnId }
}
