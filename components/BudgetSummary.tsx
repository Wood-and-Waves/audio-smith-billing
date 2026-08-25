import { monthLabel } from '@/lib/dates'
import { formatUSD } from '@/lib/money'
import type { MonthBudget } from '@/lib/budget'
import AutoAssignButton from './AutoAssignButton'

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
  const lines: { label: string; cents: number }[] = [
    { label: 'Left Over from Last Month', cents: month.leftOverCents },
    { label: `Assigned in ${monthLabel(month.month)}`, cents: month.assignedCents },
    { label: 'Activity', cents: month.activityCents },
    { label: 'Available', cents: month.availableCents },
  ]

  return (
    <div className="rounded-card border border-line bg-surface p-5">
      <dl className="space-y-2 text-sm">
        {lines.map((line) => (
          <div key={line.label} className="flex items-baseline justify-between gap-3">
            <dt className="text-muted">{line.label}</dt>
            <dd className="tabular text-right">{formatUSD(line.cents)}</dd>
          </div>
        ))}
      </dl>

      {month.underfundedCents !== 0 && (
        <>
          <hr className="my-3 border-line" />
          <dl className="text-sm">
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-muted">Underfunded</dt>
              <dd className="tabular text-right">{formatUSD(month.underfundedCents)}</dd>
            </div>
          </dl>

          {month.underfundedCents > 0 && <AutoAssignButton month={month.month} underfundedCents={month.underfundedCents} />}
        </>
      )}
    </div>
  )
}
