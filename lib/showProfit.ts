// One show's money, from Dan's side of the table.
//
// revenue − every dollar Dan paid = profit. Billable expenses appear in BOTH
// numbers (billed to the client, paid by Dan) so a reimbursement-style show
// nets them to zero by construction; my-cost (per-diem) expenses appear only
// as cost, which is exactly why per-diem margins finally become visible.
//
// The set-aside is an ESTIMATE: profit × a rate Dan (or his CPA) configured.
// S-Corp tax is annual and entity-level, not per-show — this is a jar to
// fill, not a tax computation. Rate 0 means "unset": nothing is estimated.
//
// No '@/' imports and no JSX — exercised by node --test.

import { roundCents } from './money.ts'

export function showProfit(input: {
  revenueCents: number
  expensesPaidCents: number
  /** Basis points, 3000 = 30%. 0 = unset. */
  setasideBp: number
}): { profitCents: number; setasideCents: number; takeHomeCents: number } {
  const profitCents = input.revenueCents - input.expensesPaidCents
  // Never on a loss: there is nothing to set aside out of.
  const setasideCents = profitCents > 0 && input.setasideBp > 0
    ? roundCents((profitCents * input.setasideBp) / 10000)
    : 0
  return { profitCents, setasideCents, takeHomeCents: profitCents - setasideCents }
}
