// The brain of auto-assign (design: docs/superpowers/specs/
// 2026-08-25-auto-assign-design.md): which categories get funded and by
// how much, read straight off buildBudget's own rows — neededCents is the
// figure the summary's Underfunded total already sums, so the plan funds
// exactly what that figure promises, both target kinds included (a monthly
// target's top-up and a by-date target's monthly share both surface as
// neededCents > 0). Hidden rows are NOT filtered: hidden is presentation,
// the money is real (lib/budget.ts's own hidden doctrine).
import type { CategoryMonth } from './budget.ts'
import { formatUSD } from './money.ts'

export type PlannedAssign = { categoryId: string; amountCents: number }

export function underfundedPlan(rows: CategoryMonth[]): PlannedAssign[] {
  return rows
    .filter((r) => r.neededCents > 0)
    .map((r) => ({ categoryId: r.categoryId, amountCents: r.neededCents }))
}

/** The informed-Undo description of a batch — same voice as a single
 *  move's own label, used by the page's headMoveLabel when the head move
 *  carries a batch_id. */
export function autoAssignBatchLabel(count: number, totalCents: number): string {
  return `auto-assign (${count} ${count === 1 ? 'category' : 'categories'}, ${formatUSD(totalCents)})`
}
