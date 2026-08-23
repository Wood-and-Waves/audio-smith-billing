import { formatUSD } from '@/lib/money'
import type { CategoryMonth } from '@/lib/budget'

/**
 * One category's line in the month grid. Deliberately bare for now — just
 * the name and its three figures, all `tabular` so the columns line up down
 * the page. No target status line, no progress bar, no pill: Task 7 adds
 * those on top of this same row (reading `row.status`, `row.neededCents`,
 * `row.targetCents`) without BudgetTable's grid or this component's props
 * having to change underneath it.
 *
 * Same grid template as BudgetTable's own header rows
 * (`grid-cols-[1fr_7rem_7rem_8rem]`) so a category's figures land directly
 * under the group's summed ones above it.
 */
export default function BudgetRow({ row, name }: { row: CategoryMonth; name: string }) {
  return (
    <div className="grid grid-cols-[1fr_7rem_7rem_8rem] gap-x-4 items-center py-2 text-sm">
      <span className="truncate">{name}</span>
      <span className="tabular text-right">{formatUSD(row.assignedCents)}</span>
      <span className="tabular text-right">{formatUSD(row.activityCents)}</span>
      <span className="tabular text-right font-semibold">{formatUSD(row.availableCents)}</span>
    </div>
  )
}
