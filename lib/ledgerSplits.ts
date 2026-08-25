// The decisions behind Wave C's two "a transaction the model can't
// represent" gaps (splits, pending imports) — pulled out pure so
// node --test can pin them before app/money/actions.ts or any page ever
// touches Postgres. Same doctrine as lib/budgetMoves.ts and
// lib/incomeRoleGuard.ts: server actions are deliberately untested; extract
// their brains into pure libs instead.
//
// explodeForCategories is the load-bearing export: the design doc
// (docs/superpowers/specs/2026-08-24-splits-and-pending-design.md) names it
// as the ONE place every category-reading consumer explodes legs and drops
// pending — the budget's txn assembly, P&L, spend-by-category, monthly
// reports, the CPA export, the forecast's ledger reads, and
// scripts/parity/ynab-live.mjs all call THIS, never re-derive the rule.
// lib/budget.ts's own arithmetic stays untouched by this wave (per the
// plan's Global Constraints) — only what feeds it changes.
//
// No '@/' imports, no JSX, relative '.ts' imports, no clock reads —
// `statementDate` (like `todayYm` elsewhere) is always a parameter.
// Exercised by node --test (scripts/test/ledgerSplits.test.ts).

/** One leg as the split editor collects it, before a kind is derived. */
export type SplitLegInput = {
  categoryId: string | null
  amountCents: number
  note?: string | null
}

/**
 * validateLegs MIRRORS migration 0042's deferred constraint trigger
 * (scripts/sql/migrations/0042_splits_and_pending.sql,
 * ledger_transaction_splits_check()) EXACTLY: whenever any legs exist there
 * must be at least two, every leg's amount must be a nonzero integer, every
 * leg's sign must match the parent's, and the legs must sum exactly to
 * `parentAmountCents`. The two must move together — a change to one side's
 * rule without the matching change on the other reopens the gap this
 * function exists to close: the UI would accept a shape Postgres then
 * refuses (or worse, silently disagree with the trigger about what's
 * legal). This function exists so that refusal happens here, in the app's
 * own voice, before a doomed write ever reaches the database.
 *
 * Zero legs is valid (the trigger's own `leg_count = 0 -> continue` branch
 * — an unsplit transaction). This function is total over that case rather
 * than assuming a caller never passes it: `unsplitTransaction` (Task 3)
 * calls the RPC directly with `[]` and doesn't route through here, but a
 * caller that does still gets the correct answer.
 *
 * A zero-amount leg is never explicitly named as its own trigger check —
 * the trigger catches it as a side effect of `sign(0) <> sign(parent)`
 * (`sign(0)` is always `0`, and a real transaction's amount is never `0`,
 * so a zero-amount leg always fails the trigger's bad_sign check). This
 * function checks it explicitly instead, ahead of the sign comparison, so
 * the message names the actual problem ("enter an amount") rather than the
 * indirect symptom ("wrong sign") — same state refused, clearer reason.
 *
 * Returns a message string on refusal, or `null` when the legs are legal.
 */
export function validateLegs(parentAmountCents: number, legs: SplitLegInput[]): string | null {
  if (legs.length === 0) return null

  if (legs.length === 1) return 'A split needs at least 2 legs.'

  // Same Number.isInteger discipline as lib/budgetMoves.ts's assignmentDiff
  // and lib/ledgerRules.ts's validateTxnShape: NaN sails past an integer
  // check (Number.isInteger(NaN) is false, same as any non-integer), and a
  // fractional cent would otherwise reach the RPC's bigint cast as a type
  // error instead of a friendly refusal.
  if (legs.some((leg) => !Number.isInteger(leg.amountCents) || leg.amountCents === 0)) {
    return 'Enter a nonzero amount for every split leg.'
  }

  const parentSign = Math.sign(parentAmountCents)
  if (legs.some((leg) => Math.sign(leg.amountCents) !== parentSign)) {
    return "Every split leg must match the transaction's direction."
  }

  const legSum = legs.reduce((sum, leg) => sum + leg.amountCents, 0)
  if (legSum !== parentAmountCents) {
    return "Split legs must add up to the transaction's amount, to the cent."
  }

  return null
}

/** One category-shaped line of activity: what buildBudget's txn assembly,
 *  P&L, and every other category reader actually consume. */
export type CategoryLine = {
  month: string
  categoryId: string | null
  amountCents: number
}

/**
 * A row `explodeForCategories` can see: either an ordinary (possibly
 * uncategorized, possibly income) transaction, or a split parent carrying
 * its legs. `legs` is optional/may be empty — both mean "not split", and
 * must pass through untouched (the unsplit case is not suppression, it's
 * the ordinary case with zero legs).
 */
export type TxnForExplode = {
  month: string
  categoryId: string | null
  amountCents: number
  /** null = pending (migration 0042's `entered_at`). */
  enteredAt: string | null
  legs?: { categoryId: string | null; amountCents: number }[]
}

/**
 * THE single source every category-reading consumer calls. Contract,
 * precisely, per the design doc's balance semantics (Dan's option 1 —
 * pending counts in balances but nothing category-shaped):
 *
 * - `enteredAt === null` (pending): yields NOTHING. Not an activity line,
 *   not a null-category income/RTA line — the row contributes zero output
 *   lines, full stop. This applies even when the row also has legs: pending
 *   wins over split, because a pending row hasn't been approved yet and its
 *   legs are exactly as unconfirmed as the rest of it.
 * - Entered, with `legs` present and non-empty: yields one `CategoryLine`
 *   per leg (the leg's own category and amount, the PARENT's month) and
 *   suppresses the parent's own line — a split parent is never itself a
 *   category line, only its legs are.
 * - Every other row (entered, no legs or an empty legs array): passes
 *   through byte-identical — same month, categoryId (including `null`,
 *   which lib/budget.ts's own txn assembly reads as an income/RTA line),
 *   and amountCents.
 *
 * Order-preserving where it matters not: this walks `txns` in input order
 * and, for a split parent, emits its legs in the order given — a caller
 * that cares about order already re-sorts (lib/ledgerBalance.ts's
 * compareLedgerOrder is what orders the register; this function's job is
 * only which lines exist, not their eventual order).
 *
 * Totals-preserving where it DOES matter: for any set of ENTERED rows, the
 * sum of this function's output amounts equals the sum of those rows' own
 * amountCents — a split parent's legs sum to its own amountCents by the
 * trigger's own invariant (scripts/sql/migrations/0042_splits_and_pending.sql),
 * and this function trusts that the same way replace_transaction_splits
 * does, rather than re-validating it. Pending rows are the one deliberate
 * exception to conservation — their money is real (it's in the balances)
 * but not yet category-shaped, so it must vanish from THIS output
 * entirely, not merely net to zero. See the conservation-law test in
 * scripts/test/ledgerSplits.test.ts for both halves of that pinned
 * together.
 */
export function explodeForCategories(txns: TxnForExplode[]): CategoryLine[] {
  const lines: CategoryLine[] = []

  for (const txn of txns) {
    if (txn.enteredAt === null) continue // pending: yields nothing, legs included

    if (txn.legs && txn.legs.length > 0) {
      for (const leg of txn.legs) {
        lines.push({ month: txn.month, categoryId: leg.categoryId, amountCents: leg.amountCents })
      }
      continue // the parent's own line is suppressed
    }

    lines.push({ month: txn.month, categoryId: txn.categoryId, amountCents: txn.amountCents })
  }

  return lines
}

/**
 * Reconcile refuses while any pending row exists dated at or before the
 * statement date — the design doc's own reasoning: they're already in the
 * cleared balance the statement is being checked against, but unapproved;
 * locking them in would be dishonest, excluding them would break the
 * statement math. `<=` is deliberate, not `<`: a pending row dated the
 * statement date itself is still on that statement and must block.
 *
 * Plain string compare on `date` — house doctrine for YYYY-MM-DD dates
 * (lib/showOrder.ts, lib/ledgerBalance.ts's compareLedgerOrder,
 * lib/receiptRetention.ts): they're zero-padded ISO strings, so lexical
 * order and calendar order agree, and no Date parsing (with its timezone
 * hazards, see lib/dates.ts's own header) is needed at all.
 */
export function pendingBlocksReconcile(
  pending: { date: string }[],
  statementDate: string,
): boolean {
  return pending.some((row) => row.date <= statementDate)
}
