// Ledger transaction rules, pure. Three independent checks live here:
//
// validateTxnShape mirrors the DB's own check constraints (lt_income_positive,
// lt_outflow_negative, lt_nocat_for_transfer) so a bad row is refused with a
// message a human can read, before it ever reaches Postgres's raw
// constraint-violation text. lt_nocat_for_transfer (migration 0038) replaced
// the old lt_nocat_for_owner_or_transfer (migration 0027): owner pay got its
// own budget category in 0038/0040 (it is Dan's largest budget line, and the
// screen cannot add up without it), so only transfer still forbids one. Moved
// out of app/money/actions.ts
// so the whole matrix — every valid kind/sign/category combination, and every
// way to violate it — is pinned by node --test instead of only exercised
// through a live Server Action.
//
// deriveKind is the register's kind dropdown, retired (Wave B Task 5, Dan's
// approved call, 2026-08-24) — kind is no longer a choice the form offers,
// it is computed from which category is selected and which box (Outflow/
// Inflow) carries the amount. validateTxnShape above stays the real backstop
// after it: a caller that skips deriveKind (or gets it wrong) still can't
// post a shape the DB itself would reject.
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
  // A transfer moves money between your own accounts, never a category (the
  // DB still enforces this: lt_nocat_for_transfer, migration 0038). Owner pay
  // USED to be nocat too, but 0038 relaxed that — it is a real budget
  // category now (0040 backfilled it onto every existing owner_pay row), so
  // it is deliberately absent from this check.
  if (input.kind === 'transfer' && input.categoryId !== null) {
    return { error: 'Transfers do not use a category.' }
  }
  return null
}

/** Which of the register's two boxes carried the amount — the other half of
 *  deriveKind's input, alongside the category. */
export type LedgerDirection = 'inflow' | 'outflow'

/**
 * The category info deriveKind reasons about — never a raw category id.
 * The caller (MoneyRegister) resolves a picker value into this shape first —
 * `'payment-transfer'` for its own pinned Payment/Transfer row, a plain
 * object for a real category, or `null` for Uncategorized — so this file
 * never has to know about a sentinel id that lives in a client component.
 */
export type CategoryForKind =
  | 'payment-transfer'
  | { budgetRole: 'spending' | 'income'; grp: string }
  | null

// The one category group this file keys behavior on by NAME rather than an
// explicit column: a deliberate, narrow exception to the budget's own
// doctrine ("budget_role says which categories are budget rows. It is an
// explicit column, never inferred from the group name, which is
// user-editable text" — CLAUDE.md, the budget section) and to
// lib/ynabRegister.ts's own OWNER_GROUP, which keys the same way for the
// same reason on the YNAB-import side. The failure mode if Dan ever renames
// this group in /money/categories: an owner draw (outflow) stops matching
// the branch below and falls through to "any other spending category",
// silently posting as `expense` instead of `owner_pay` — wrong, but LOUD,
// not silent: it shows up immediately as an inflated expense line in the
// P&L (lib/ledgerReports.ts branches on kind directly), the same day it
// happens, not months later as a quietly wrong Ready to Assign. The fix if
// it ever bites: give ledger_categories an explicit boolean column (an
// `is_owner_group`, say) and point this one lookup at it instead — one
// migration, one line here.
const OWNER_TRANSACTIONS_GROUP = 'Owner Transactions'

/**
 * Kind is no longer picked from a dropdown (Wave B Task 5) — it's derived
 * from WHICH category is selected and WHICH box the amount landed in. Every
 * branch below is one row of the task's own derivation table, read top to
 * bottom in that order:
 *
 *   Payment/Transfer, either direction        -> transfer, no category
 *   an income-role category, inflow            -> income
 *   an income-role category, outflow           -> refused — an income
 *     category (buildBudget's own spendingIds excludes it) has no outflow
 *     side to book against
 *   Owner Transactions group, outflow          -> owner_pay
 *   Owner Transactions group, inflow           -> refused — money coming IN
 *     from the owner has always been a transfer in this data model (see
 *     mapYnabRow's own isOwnerLike branch, lib/ynabRegister.ts), never income
 *   any other spending category, or none       -> income on inflow (a
 *     refund — the category is carried, today's own behaviour), expense on
 *     outflow
 */
export function deriveKind(
  category: CategoryForKind,
  direction: LedgerDirection,
): { kind: LedgerKind } | { error: string } {
  if (category === 'payment-transfer') {
    return { kind: 'transfer' }
  }
  if (category !== null && category.budgetRole === 'income') {
    return direction === 'inflow'
      ? { kind: 'income' }
      : { error: 'Income categories take inflows.' }
  }
  if (category !== null && category.grp === OWNER_TRANSACTIONS_GROUP) {
    return direction === 'outflow'
      ? { kind: 'owner_pay' }
      : { error: 'Money in from you is a transfer — use Payment/Transfer.' }
  }
  return { kind: direction === 'inflow' ? 'income' : 'expense' }
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
