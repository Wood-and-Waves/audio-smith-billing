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

// Canonical ledger order: date asc, then created_at asc, then id asc. Every
// field here is a plain string compare — that's safe because date and
// created_at are ISO strings ('YYYY-MM-DD' / timestamptz text), which sort
// lexicographically in the same order they sort chronologically, and id (a
// uuid) doesn't need to mean anything as an order — it only has to break
// ties the same way every time, and a string compare does that. The result
// is total and deterministic: any two keys compare consistently, so sorting
// by this comparator always converges on the same order no matter where you
// start (display sort is this same comparator, called in reverse).
export type LedgerOrderKey = { date: string; created_at: string; id: string }

export function compareLedgerOrder(a: LedgerOrderKey, b: LedgerOrderKey): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1
  if (a.id !== b.id) return a.id < b.id ? -1 : 1
  return 0
}

// Prefix sums: result[i] is the balance AFTER txnsInLedgerOrder[i]. Caller
// must have already sorted by compareLedgerOrder — this function trusts the
// order it's given and does no sorting of its own. Invariant, for non-empty
// input: result.at(-1) === workingBalance(openingCents, txns) — the last
// running balance and the working balance are the same number, computed two
// different ways. (Empty input returns [], not [openingCents]; workingBalance
// of an empty list is openingCents, so the invariant only applies once
// there's at least one row.)
export function runningBalances(
  openingCents: number, txnsInLedgerOrder: { amount_cents: number }[],
): number[] {
  const balances: number[] = []
  let running = openingCents
  for (const txn of txnsInLedgerOrder) {
    running += txn.amount_cents
    balances.push(running)
  }
  return balances
}
