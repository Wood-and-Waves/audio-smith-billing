// The decisions behind Wave C's "a transaction the model can't represent"
// gap (splits) — pulled out pure so node --test can pin them before
// app/money/actions.ts or any page ever touches Postgres. Same doctrine as
// lib/budgetMoves.ts and lib/incomeRoleGuard.ts: server actions are
// deliberately untested; extract their brains into pure libs instead.
//
// explodeForCategories is the load-bearing export: the design doc
// (docs/superpowers/specs/2026-08-24-splits-and-pending-design.md) names it
// as the ONE place every KIND-BLIND category-reading consumer explodes
// legs — the budget's txn assembly (app/money/budget/page.tsx,
// app/money/page.tsx's own CategoryPicker balance map) and
// scripts/parity/ynab-live.mjs all call THIS, never re-derive the rule.
// lib/budget.ts's own arithmetic stays untouched by this wave (per the
// plan's Global Constraints) — only what feeds it changes.
//
// These helpers no longer read `entered_at` at all. Wave C had them drop
// unreviewed (pending) rows, so an imported charge stayed out of the budget
// until Dan clicked Enter; on 2026-08-25 he reversed that — imported rows
// count immediately, and entered_at is a review marker ("I have looked at
// this"), never an accounting gate. Because every category-shaped consumer
// goes through these two functions, that reversal lives here and nowhere
// else.
//
// explodeForReports (below) is its kind-aware sibling for the readers that
// branch on kind — P&L, spend-by-category, monthly reports, and the CPA
// export (all one read path: lib/ledgerReports.ts, fed by
// app/money/reports/page.tsx) — plus the forecast's overhead-average read
// (app/money/forecast/page.tsx's computeOverheadCents call), which sums by
// kind the same way P&L does. Two exports, same split contract, because a
// split leg's own kind can differ from its parent's (the $400 case) and
// CategoryLine was never meant to carry kind — see explodeForReports' own
// doc comment for why that's a second function rather than an optional
// field.
//
// No '@/' imports, no JSX, relative '.ts' imports, no clock reads — any
// date these functions need (like `todayYm` elsewhere) is a parameter.
// Exercised by node --test (scripts/test/ledgerSplits.test.ts).

/** One leg as the split editor collects it, before a kind is derived. */
export type SplitLegInput = {
  categoryId: string | null
  amountCents: number
  note?: string | null
}

/**
 * The parent-row edit that rides along with a split save (migration 0045)
 * — the register's own edit-row fields, so "change the total AND the legs"
 * lands as ONE atomic RPC call instead of two writes the 0042 triggers
 * refuse in either order. Always the FULL field set, never a sparse diff:
 * the save persists what the edit row shows, same as saveEdit. category is
 * deliberately absent — a split parent has no single category (0042), and
 * the RPC only ever clears it.
 */
export type SplitParentPatch = {
  date: string
  payee: string
  memo: string | null
  showId: string | null
  amountCents: number
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
  legs?: { categoryId: string | null; amountCents: number }[]
}

/**
 * THE single source every category-reading consumer calls. Contract,
 * precisely:
 *
 * Every row yields its line. An UNREVIEWED row (entered_at null) is no
 * exception — Dan's 2026-08-25 decision: imported rows count in the budget
 * the moment they land, and entered_at means only "I have looked at this".
 * Wave C had this the other way round, which kept real spending out of his
 * budget until he clicked Enter.
 *
 * - With `legs` present and non-empty: yields one `CategoryLine` per leg
 *   (the leg's own category and amount, the PARENT's month) and suppresses
 *   the parent's own line — a split parent is never itself a category
 *   line, only its legs are.
 * - Every other row (no legs or an empty legs array): passes through
 *   byte-identical — same month, categoryId (including `null`, which
 *   lib/budget.ts's own txn assembly reads as an income/RTA line), and
 *   amountCents.
 *
 * Order-preserving where it matters not: this walks `txns` in input order
 * and, for a split parent, emits its legs in the order given — a caller
 * that cares about order already re-sorts (lib/ledgerBalance.ts's
 * compareLedgerOrder is what orders the register; this function's job is
 * only which lines exist, not their eventual order).
 *
 * Totals-preserving where it DOES matter, with no exception at all: the
 * sum of this function's output amounts equals the sum of the input rows'
 * own amountCents — a split parent's legs sum to its own amountCents by the
 * trigger's own invariant (scripts/sql/migrations/0042_splits_and_pending.sql),
 * and this function trusts that the same way replace_transaction_splits
 * does, rather than re-validating it. Conservation used to carve out
 * pending rows; removing that carve-out is exactly what the 2026-08-25
 * decision above amounts to. See the conservation-law test in
 * scripts/test/ledgerSplits.test.ts.
 */
export function explodeForCategories(txns: TxnForExplode[]): CategoryLine[] {
  const lines: CategoryLine[] = []

  for (const txn of txns) {
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

/** One kind-shaped line of activity: what lib/ledgerReports.ts's P&L,
 *  spend-by-category, and monthly readers actually consume (they branch on
 *  `kind`, which explodeForCategories' CategoryLine doesn't carry — that
 *  helper's only caller, buildBudget's txn assembly, is kind-blind by
 *  design, see lib/budget.ts's own `activity(c,m)` comment). `date` (not
 *  `month`) matches ReportTxn's own field (lib/ledgerReports.ts) — that lib
 *  slices its own month out of a full date, unlike buildBudget which wants
 *  the month pre-sliced. */
export type ReportLine = {
  date: string
  amountCents: number
  kind: string
  categoryId: string | null
}

/**
 * explodeForCategories' kind-aware sibling, not a rewrite of it: same
 * contract (every row yields its line, unreviewed rows included — a split
 * parent's legs replace its own line; everything else passes through
 * byte-identical) but every emitted line carries `kind` — and for a split
 * parent's legs, THAT
 * LEG's own kind (`ledger_transaction_splits.kind`, written per leg through
 * deriveKind at split time — see replace_transaction_splits' doc comment,
 * scripts/sql/migrations/0042_splits_and_pending.sql), never the parent's.
 * That distinction is the whole reason this is a separate function rather
 * than bolting an optional `kind` onto CategoryLine: the $400 acceptance
 * case (design doc, plan Task 5) splits an owner_pay parent into an
 * owner_pay leg and an expense leg — plSummary (lib/ledgerReports.ts) must
 * see the Temporary Transfer leg as an EXPENSE, which is only true reading
 * kind off the leg. explodeForCategories itself stays kind-blind on
 * purpose: buildBudget's own activity(c,m) sums every transaction carrying
 * a category "regardless of kind" (lib/budget.ts's own doc comment) — a
 * kind field would be dead weight on that read path, not a convenience.
 *
 * Seam choice (stated per the plan's own instruction): callers explode
 * ONCE, in the page, before handing rows to lib/ledgerReports.ts's pure
 * functions (plSummary/spendByCategory/monthlyTotals) — mirroring the
 * "lib/budget.ts stays untouched, only its txn assembly changes" rule from
 * the plan's Global Constraints. lib/ledgerReports.ts's own ReportTxn type
 * (snake_case, straight off a Supabase row) is intentionally NOT this
 * function's input or output shape — the page owns the one conversion
 * step between "row this app fetched" and "line a pure lib consumes",
 * same division of labor lib/budget.ts's callers already use.
 */
export type ReportTxnForExplode = {
  date: string
  amountCents: number
  kind: string
  categoryId: string | null
  legs?: { categoryId: string | null; amountCents: number; kind: string }[]
}

export function explodeForReports(txns: ReportTxnForExplode[]): ReportLine[] {
  const lines: ReportLine[] = []

  for (const txn of txns) {
    if (txn.legs && txn.legs.length > 0) {
      for (const leg of txn.legs) {
        lines.push({ date: txn.date, categoryId: leg.categoryId, amountCents: leg.amountCents, kind: leg.kind })
      }
      continue // the parent's own line is suppressed
    }

    lines.push({ date: txn.date, categoryId: txn.categoryId, amountCents: txn.amountCents, kind: txn.kind })
  }

  return lines
}
