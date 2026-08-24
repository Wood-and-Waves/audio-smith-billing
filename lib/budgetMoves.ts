// The decisions behind the budget's first hand-write paths — typing a
// figure into Assigned, moving money between categories, and undo/redo —
// pulled out pure so node --test can pin them before app/money/budget/
// actions.ts ever touches Postgres. Same doctrine as lib/categoryOwnership.ts
// and lib/incomeRoleGuard.ts: "server actions are deliberately untested;
// extract their brains into pure libs instead." These three earn the
// exception the same way those two did — they are the first writes onto
// Dan's live budget, and each one guards a specific way that write could go
// wrong silently rather than loudly.
//
// No '@/' imports, no JSX, relative '.ts' imports, no clock reads — `today`
// (as `todayYm`) is always a parameter, same rule lib/budget.ts follows.

import { addMonths } from './dates.ts'

export type MoveWrite =
  | { fromCategoryId: string | null; toCategoryId: string | null; amountCents: number }
  | null

/**
 * Typing a figure into Assigned writes the DIFFERENCE between what's typed
 * and what's already assigned, never the figure itself — a move row has no
 * "set to" semantics, only "moved from X to Y" (0038's own doctrine: what a
 * category has assigned is nothing but the sum of its moves). Current $500,
 * typed $700 -> one RTA->category move of $200; typed $300 -> one
 * category->RTA move of $200; typed $500 -> no move at all, because writing
 * a zero-amount row would violate 0038's own `amount_cents > 0` check AND
 * clutter Recent Moves with a no-op every time someone clicks in and out of
 * a cell without changing it.
 *
 * `amountCents` is built from `Math.abs(diff)` and only ever returned on a
 * branch where `diff !== 0`, so it is strictly positive by construction —
 * not merely by the caller happening to pass sane numbers. This matters
 * because 0038's check constraint is the LAST line of defense against a
 * zero or negative insert, not the first; this function is the first.
 *
 * `typedCents < 0` is refused outright (null, same as "no write") rather
 * than clamped to zero or given a negative-amount move — the UI parses the
 * typed value with parseUSD first and would not normally produce a negative
 * number, but this function is the total decision underneath that UI, so it
 * must have a defined answer for every integer, including ones a well-
 * behaved caller should never send.
 */
export function assignmentDiff(
  categoryId: string,
  currentAssignedCents: number,
  typedCents: number,
): MoveWrite {
  // Same Number.isInteger discipline as lib/ledgerRules.ts's validateTxnShape,
  // for the same reason: NaN sails past a `< 0` check (NaN < 0 is false) and a
  // fractional cent would reach the DB as a type error instead of a refusal.
  if (!Number.isInteger(currentAssignedCents) || !Number.isInteger(typedCents)) return null
  if (typedCents < 0) return null

  const diff = typedCents - currentAssignedCents
  if (diff === 0) return null

  return diff > 0
    ? { fromCategoryId: null, toCategoryId: categoryId, amountCents: diff }
    : { fromCategoryId: categoryId, toCategoryId: null, amountCents: -diff }
}

const MONTH_SHAPE = /^\d{4}-(0[1-9]|1[0-2])$/

/**
 * A write to an out-of-range month is a bug (a stale query param on a
 * hand-built request) or a stale tab left open across a day boundary — not
 * a navigation intent — so this REFUSES rather than clamping, the opposite
 * of app/money/budget/page.tsx's own clamp on `?m=`. That clamp exists so
 * browsing to a silly month is harmless; this exists so WRITING to one is
 * impossible. Conflating the two would let a stale tab from last month
 * silently redirect a write onto whatever month the clamp lands on instead
 * of failing loudly.
 *
 * Reuses `addMonths` (./dates.ts) rather than re-deriving the ceiling
 * month's arithmetic here — one place owns month math, same as lib/budget.ts
 * does for FIRST_BUDGET_MONTH/MAX_MONTHS_AHEAD's own range.
 *
 * The shape check is strict past the regex: `MONTH_SHAPE` alone already
 * rejects `2026-13` and `2026-00` (the `(0[1-9]|1[0-2])` alternation), but
 * is spelled out as its own guard so a future edit to the regex can't
 * quietly widen what counts as a month without a test catching it (see the
 * '00'/'13' cases in scripts/test/budgetMoves.test.ts).
 */
export function validBudgetMonth(
  month: string,
  todayYm: string,
  firstMonth: string,
  maxAhead: number,
): string | null {
  if (!MONTH_SHAPE.test(month)) return null

  const ceiling = addMonths(todayYm, maxAhead)
  if (month < firstMonth || month > ceiling) return null

  return `${month}-01`
}

export type RedoCheck = {
  newestActive: { created_at: string; id: string } | null
  newestUndone: { created_at: string; id: string } | null
}

/** True when `a` sorts after `b` under the register's own tie-break order:
 *  `created_at` first, `id` second (mirrors `lbm_owner_created_idx`'s
 *  `created_at desc, id desc`, migration 0038) — string comparison on both,
 *  same as a Postgres ORDER BY on those two columns. Exported so the page's
 *  recency sort and this module's redo decision can never drift apart. */
export function isNewer(
  a: { created_at: string; id: string },
  b: { created_at: string; id: string },
): boolean {
  return a.created_at !== b.created_at ? a.created_at > b.created_at : a.id > b.id
}

/**
 * The undo/redo model settled in the phase-two plan's Global Constraints:
 * the stack is the owner's moves ordered by `(created_at, id)`. Redo clears
 * `undone_at` on the newest undone move — but only when no non-undone move
 * is newer than it. `'superseded'` is the standard editor rule (undo, then
 * make a fresh edit, and redo of the old branch is gone) applied to a
 * durable ledger instead of an in-memory stack: once ANY active move exists
 * that's newer than the undone one being offered for redo, resurrecting the
 * undone move would resurrect a state that predates something the caller
 * has already built on top of.
 *
 * `newestUndone === null` means there is nothing to redo regardless of what
 * else is active — checked first so it short-circuits before the tuple
 * comparison ever needs a non-null `newestUndone` to compare against.
 * `newestActive === null` means nothing has happened since the undo at
 * all, so redo is unconditionally clean.
 */
export function redoTarget(check: RedoCheck): 'ok' | 'nothing' | 'superseded' {
  const { newestActive, newestUndone } = check
  if (!newestUndone) return 'nothing'
  if (!newestActive) return 'ok'
  return isNewer(newestActive, newestUndone) ? 'superseded' : 'ok'
}
