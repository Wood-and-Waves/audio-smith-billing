// The decision behind saveCategory's (app/money/actions.ts) refusal to flip
// a category to budget_role 'income' out from under its own history, pulled
// out pure so node --test can pin it — same doctrine as
// lib/categoryOwnership.ts: "server actions are deliberately untested;
// extract their brains into pure libs instead."
//
// Why this needs a guard at all: an 'income' category is not a budget row
// (see ledger_categories.budget_role's own comment, migration 0038) —
// buildBudget's spendingIds (lib/budget.ts) is built by filtering
// `budgetRole === 'spending'` BEFORE it ever sees a month, so flipping a
// category's role changes what that filter returns for every month the
// budget screen covers, not just going forward. The moment a category
// drops out of spendingIds: every ledger_budget_moves row that named it on
// either side stops counting toward `assigned` (the rows stay in the table,
// merely invisible to buildBudget); every transaction in it stops counting
// as that category's `activity` and becomes `income(m)` instead; its
// Available leaves every month's total; and Ready to Assign is rewritten
// for every month, past included. One tick on a category with eight months
// of history rewrites eight months of reconciliation with no way to tell
// after the fact that it happened.
//
// The precedent this follows was the 0030 envelope feature's own
// saveEnvelope, which refused server-side to hide an envelope that still
// held money — a strictly smaller version of the same hazard (money
// stranded in one place, versus months of arithmetic silently rewritten).
// That action has since been deleted along with the rest of the envelope
// write path, so the precedent is history rather than something to go and
// read; the rule it stood for is the one that matters, and it is this: a
// change that would silently rewrite money already recorded gets refused
// by the server, not merely warned about by the client.
//
// Only an actual transition (current role 'spending', new role 'income')
// is dangerous. A category that is already 'income' being saved again
// (renamed, regrouped, re-ticked) is not a transition — nothing about the
// budget's arithmetic changes on that save, so re-litigating its history
// every time it's touched would refuse saves that do nothing wrong.

export const INCOME_ROLE_CHANGE_REFUSAL =
  "Move this category's assigned amounts and its target to another " +
  'category first. An income category is not a budget row, so its ' +
  "assignments and its activity would silently drop out of every month's " +
  'Ready to Assign and Available.'

type RowsResult = { data: { id: string }[] | null; error: { message: string } | null }

/**
 * `moves` and `targets` are only read when `currentRole` is 'spending' —
 * the caller is expected to have already fetched them (or not bothered to,
 * for an already-income category; see the caller-side wrapper in
 * app/money/actions.ts). Each read's `error` is checked and returned on
 * BEFORE any presence or count test on its `data` — same fail-closed rule
 * this app applies to every guard read that gates a money write (see
 * CLAUDE.md, and decideCategoryOwnership's own comment): a blown-up query
 * must never be read as "no moves, go ahead."
 */
export function decideIncomeRoleChange(
  currentRole: 'spending' | 'income',
  moves: RowsResult,
  targets: RowsResult,
): { error: string } | null {
  if (currentRole === 'income') return null

  if (moves.error) return { error: moves.error.message }
  if (moves.data && moves.data.length > 0) return { error: INCOME_ROLE_CHANGE_REFUSAL }

  if (targets.error) return { error: targets.error.message }
  if (targets.data && targets.data.length > 0) return { error: INCOME_ROLE_CHANGE_REFUSAL }

  return null
}
