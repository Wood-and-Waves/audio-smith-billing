import { monthLabel } from '@/lib/dates'
import { formatUSD } from '@/lib/money'
import type { MonthBudget } from '@/lib/budget'
import AutoAssignButton from './AutoAssignButton'
import { BUDGET_GRID } from './BudgetTable'

/**
 * The right-hand month summary, Dan's own order: Left Over from Last Month,
 * Assigned in `<month>`, Activity, Available, then a rule, then Underfunded
 * (only when it's non-zero — a month with every target met has nothing to
 * show there). Every figure is read straight off `MonthBudget` — leftOverCents,
 * assignedCents, activityCents, availableCents, underfundedCents — never
 * recomputed here; lib/budget.ts is that arithmetic's one home, validated
 * against 1,421 rows of Dan's real export.
 *
 * These five figures describe the WHOLE month and must never be filtered.
 * BudgetTable's filter chips hide category ROWS, not the accounting behind
 * them — see that file's own comment on the same rule. If this panel ever
 * started reading a filtered subset of `month.rows` instead of `month`
 * itself, it would silently start lying about totals the instant Dan
 * clicked a chip, which defeats the one thing this whole screen exists to
 * do: reconcile against YNAB, cent for cent.
 */
export default function BudgetSummary({ month }: { month: MonthBudget }) {
  // Left Over from Last Month is gone (Dan, 2026-09-10). As a TOTAL row
  // under the table it was the one figure that is not a column below — the
  // other three are Assigned, Activity and Available summed — so it read as
  // an intruder in a line that otherwise adds up in front of you.
  const lines: { label: string; cents: number }[] = [
    { label: 'Assigned', cents: month.assignedCents },
    { label: 'Activity', cents: month.activityCents },
    { label: 'Available', cents: month.availableCents },
  ]

  return (
    <div className="mt-2 pt-3 border-t-2 border-line">
      {/* The month's TOTAL row, on the table's own columns and at the foot of
          it, where a total belongs. Assigned, Activity and Available are the
          three columns above, summed, so each figure sits under the one it
          totals — BUDGET_GRID is shared with BudgetTable so a column width
          cannot change in one place and break the alignment in the other.

          No horizontal padding, for the same reason the group bands have
          none: any inset and the totals stop lining up with the numbers they
          total. Available keeps the `pr-2.5` that matches MovePopover's pill.
          Below `sm` the table's grid is hidden entirely, so the phone gets a
          plain stack instead. */}
      <div className={BUDGET_GRID}>
        <p className="text-sm font-bold uppercase tracking-wider text-ink pl-2">
          {monthLabel(month.month)} total
        </p>
        {lines.map((line, i) => (
          <div key={line.label} className={i === 2 ? 'text-right pr-2.5' : 'text-right'}>
            <p className="text-xs text-muted">{line.label}</p>
            <p className="tabular text-base font-semibold mt-0.5">{formatUSD(line.cents)}</p>
          </div>
        ))}
      </div>

      <dl className="sm:hidden grid grid-cols-3 gap-x-4">
        {lines.map((line) => (
          <div key={line.label}>
            <dt className="text-xs text-muted">{line.label}</dt>
            <dd className="tabular text-base font-semibold mt-0.5">{formatUSD(line.cents)}</dd>
          </div>
        ))}
      </dl>

      {/* Clustered, not `justify-between`: stretched across the full width
          this put "Underfunded" at one edge and its figure at the other,
          which is the same wasted span the summary itself was fixed for.
          The button belongs beside the number it acts on. */}
      {month.underfundedCents !== 0 && (
        <div className="mt-3 pt-3 border-t border-line flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
          <span className="text-muted">Underfunded</span>
          <span className="tabular">{formatUSD(month.underfundedCents)}</span>
          {month.underfundedCents > 0 && (
            <AutoAssignButton month={month.month} underfundedCents={month.underfundedCents} />
          )}
        </div>
      )}
    </div>
  )
}
