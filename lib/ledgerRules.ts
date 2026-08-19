// Ledger transaction rules, pure. Two independent checks live here:
//
// validateTxnShape mirrors the DB's own check constraints (lt_income_positive,
// lt_outflow_negative, lt_nocat_for_owner_or_transfer — migration 0027) so a
// bad row is refused with a message a human can read, before it ever reaches
// Postgres's raw constraint-violation text. Moved out of app/money/actions.ts
// so the whole matrix — every valid kind/sign/category combination, and every
// way to violate it — is pinned by node --test instead of only exercised
// through a live Server Action.
//
// isSaneLedgerDate is a second, unrelated guard: a plain YYYY-MM-DD date is
// already validated upstream by lib/dates.ts's isPlainDate, which only checks
// the string is a REAL calendar date. It does nothing about the year itself —
// a fat-fingered 0206 or 2206 for 2026 is still a real date, still lands in
// balances, and is invisible to every report until someone notices the
// account is off by two centuries. isSaneLedgerDate bounds the year to a
// sane range instead.
//
// No '@/' imports and no JSX — exercised by node --test, same as
// lib/ledgerBalance.ts.

export type LedgerKind = 'income' | 'expense' | 'owner_pay' | 'transfer'
export const VALID_KINDS: readonly LedgerKind[] = ['income', 'expense', 'owner_pay', 'transfer']

export function validateTxnShape(input: {
  amountCents: number
  kind: string
  categoryId: string | null
}): { error: string } | null {
  if (!VALID_KINDS.includes(input.kind as LedgerKind)) {
    return { error: `"${input.kind}" is not a transaction kind.` }
  }
  if (!Number.isInteger(input.amountCents) || input.amountCents === 0) {
    return { error: 'Enter a nonzero amount.' }
  }
  if (input.kind === 'income' && input.amountCents <= 0) {
    return { error: 'Income must be a positive amount.' }
  }
  if (input.kind === 'expense' && input.amountCents >= 0) {
    return { error: 'Expenses must be a negative amount.' }
  }
  if (input.kind === 'owner_pay' && input.amountCents >= 0) {
    return { error: 'Owner pay must be a negative amount.' }
  }
  // Paying yourself is not a deduction, and a transfer moves money between
  // your own accounts — neither ever carries a category (the DB agrees: see
  // lt_nocat_for_owner_or_transfer).
  if ((input.kind === 'owner_pay' || input.kind === 'transfer') && input.categoryId !== null) {
    return { error: 'Owner pay and transfers do not use a category.' }
  }
  return null
}

/**
 * Is this plain date's year within the ledger's sane range?
 *
 * Callers run this AFTER isPlainDate has already confirmed the string is a
 * real YYYY-MM-DD calendar date — this only reads the leading four digits, it
 * does not re-check the shape. 1990 is well before this app or the S-Corp it
 * tracks existed; 2100 is generously past any statement anyone will import.
 * Either end being reachable in practice means a value outside it is a typo,
 * not a real transaction.
 */
export function isSaneLedgerDate(date: string): boolean {
  const year = Number(date.slice(0, 4))
  return year >= 1990 && year <= 2100
}
