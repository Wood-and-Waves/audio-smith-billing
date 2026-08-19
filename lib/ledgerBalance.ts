// Balance math for the register header and reconcile. Pure integer cents.
//
// Working balance counts every transaction — it answers "what will the bank
// say once everything lands". Cleared balance counts only what the bank has
// confirmed (cleared or reconciled) — it is the number reconcile compares to
// the statement. No '@/' imports and no JSX — exercised by node --test.

export type BalanceLike = {
  amount_cents: number
  cleared: 'uncleared' | 'cleared' | 'reconciled'
}

export function workingBalance(openingCents: number, txns: BalanceLike[]): number {
  return txns.reduce((t, x) => t + x.amount_cents, openingCents)
}

export function clearedBalance(openingCents: number, txns: BalanceLike[]): number {
  return txns.reduce(
    (t, x) => t + (x.cleared === 'uncleared' ? 0 : x.amount_cents), openingCents)
}
