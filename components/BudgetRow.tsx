import { formatUSD } from '@/lib/money'
import { progressPct, type CategoryMonth, type CategoryTarget, type TargetStatus } from '@/lib/budget'
import TargetEditor from '@/components/TargetEditor'
import AssignedCell from '@/components/AssignedCell'
import MoveMoneyDialog from '@/components/MoveMoneyDialog'
import type { AssignableCategory } from '@/app/money/budget/page'

/**
 * The status line's wording, verbatim from Dan's own YNAB (Task 7's brief) —
 * not paraphrased, not reworded to fit a template. Exhaustive over
 * TargetStatus's own discriminant, so a new status kind lib/budget.ts might
 * grow later fails to compile here instead of silently rendering nothing.
 * Every figure comes off the status variant itself (never recomputed from
 * `row`) — lib/budget.ts is this arithmetic's one home, validated against
 * 1,421 rows of Dan's real export; this file only formats what it's handed.
 */
function statusLine(status: TargetStatus): { text: string; className: string } | null {
  switch (status.kind) {
    case 'none':
      return null
    case 'funded':
      return {
        text: status.spentCents === 0
          ? 'Funded'
          : `Funded. Spent ${formatUSD(status.spentCents)} of ${formatUSD(status.targetCents)}`,
        className: 'text-xs text-muted',
      }
    case 'fully_spent':
      return { text: 'Fully Spent', className: 'text-xs text-muted' }
    case 'on_track':
      return { text: 'On Track', className: 'text-xs text-muted' }
    case 'underfunded':
      return { text: `${formatUSD(status.neededCents)} more needed`, className: 'text-xs text-muted' }
    case 'needed_eventually':
      return {
        text: `${formatUSD(status.remainingCents)} more needed eventually`,
        className: 'text-xs text-muted',
      }
    case 'overspent':
      return {
        text: `Overspent. ${formatUSD(status.spentCents)} of ${formatUSD(status.assignedCents)}`,
        className: 'text-xs text-danger',
      }
  }
}

/**
 * The 3px progress bar under a category's name — only when it has a target
 * (`targetCents` null means nothing to show progress toward, and
 * `progressPct` returns 0 for that case rather than this component ever
 * dividing by it). The fill's width is `progressPct(row)` — lib/budget.ts is
 * this arithmetic's one home, validated against 1,421 rows of Dan's real
 * export; this component only reads what it's handed.
 *
 * The fill renders in `bg-danger` instead of `bg-good` when the row is
 * overspent — the one color signal the bar itself carries, beyond what the
 * status line already says in words. `aria-hidden` throughout: the status
 * line is the accessible version of this same information.
 */
function TargetProgressBar({ row }: { row: CategoryMonth }) {
  if (row.targetCents === null) return null
  const pct = progressPct(row)
  const fillClass = row.status.kind === 'overspent' ? 'bg-danger' : 'bg-good'
  return (
    <div aria-hidden className="mt-1 h-[3px] w-full rounded-pill bg-accent-wash overflow-hidden">
      <div className={`h-full rounded-pill ${fillClass}`} style={{ width: `${pct}%` }} />
    </div>
  )
}

/**
 * One category's line in the month grid: name, target status, progress bar,
 * assigned/activity, and the Available pill — everything BudgetTable's grid
 * expects, still under the same `grid-cols-[1fr_7rem_7rem_8rem]` template at
 * `sm` and up so a category's figures land under the group's summed ones
 * above it.
 *
 * `target` is the fix for a real gap in Task 7's first pass: `row`
 * (CategoryMonth, from lib/budget.ts) carries a target's *amount* but never
 * its `kind` or `dueDate` — those exist only on CategoryTarget — so without
 * this prop the pencil below could never reopen a by-date target showing its
 * real kind and due date. `undefined`/`null` both mean "no target" (the
 * former lets a caller omit the prop entirely rather than write `null` at
 * every call site); `BudgetTable` is the only real caller and always passes
 * one or the other explicitly. `lib/budget.ts` itself is untouched — this is
 * presentation-path plumbing, not new arithmetic.
 *
 * Below `sm` the SAME markup reflows into a card, with responsive classes
 * rather than a forked second component that could drift from this one: the
 * grid collapses to a single column, so the name/status block — already its
 * own cell — becomes the card's first two lines (name+status, then the
 * progress bar) for free; the three desktop cells (`hidden sm:…`) drop out;
 * and one `sm:hidden` three-up row of Assigned/Activity/Available, each
 * with a small label above its figure, takes their place.
 *
 * `month` and `assignableCategories` are budget-phase-two Task 3's own
 * wire-through: the viewed month string (needed by both AssignedCell and
 * MoveMoneyDialog to call their own server actions) and the page's own
 * move-money option list (see AssignableCategory's doc comment,
 * app/money/budget/page.tsx), both threaded straight from BudgetTable
 * without this component touching either.
 */
export default function BudgetRow({
  row, name, target, month, assignableCategories,
}: {
  row: CategoryMonth
  name: string
  target?: CategoryTarget | null
  month: string
  assignableCategories: AssignableCategory[]
}) {
  const status = statusLine(row.status)
  // Hidden rows AND every row folded into BudgetTable's synthetic "Hidden"
  // section share this one flag (see AssignedCell's own doc comment for why
  // that's the same condition, not two) — neither Assigned nor Available is
  // editable for either, because assignToCategory/moveBetweenCategories both
  // refuse a hidden category server-side.
  const editable = !row.hidden
  return (
    <div className="grid grid-cols-1 sm:grid-cols-[1fr_7rem_7rem_8rem] gap-x-4 gap-y-2 items-center py-2 text-sm">
      <div className="min-w-0">
        {/* The name is this screen's primary content and must win any
         * squeeze — it carries no `truncate`/`min-w-0`, so its floor is its
         * own min-content (the widest single word), and anything narrower
         * than a one-line fit just wraps the name onto a second line rather
         * than shrinking it further. The status wrapper is what gives way:
         * it lost the `shrink-0` that used to make it refuse to shrink at
         * all (which was *why* 100% of the squeeze fell on the name below —
         * a 224px name column at desktop widths reduced `Software` to `So…`
         * and `Transportation` to `T`). `min-w-0` on both the wrapper and
         * the status text span lets that text truncate with an ellipsis
         * once it's out of room, instead of forcing an overflow. */}
        <div className="flex items-baseline gap-2">
          <span>{name}</span>
          <span className="ml-auto inline-flex items-center gap-2 min-w-0">
            <TargetEditor categoryId={row.categoryId} categoryName={name} target={target ?? null} />
            {status && <span className={`${status.className} min-w-0 truncate`}>{status.text}</span>}
          </span>
        </div>
        <TargetProgressBar row={row} />
      </div>

      <div className="hidden sm:block">
        <AssignedCell
          categoryId={row.categoryId}
          categoryName={name}
          month={month}
          assignedCents={row.assignedCents}
          editable={editable}
          align="right"
        />
      </div>
      <span className="hidden sm:block tabular text-right">{formatUSD(row.activityCents)}</span>
      <div className="hidden sm:flex justify-end">
        <MoveMoneyDialog
          row={row}
          categoryName={name}
          month={month}
          categories={assignableCategories}
          editable={editable}
        />
      </div>

      <div className="sm:hidden grid grid-cols-3 gap-2">
        <div>
          <p className="text-xs text-muted">Assigned</p>
          <AssignedCell
            categoryId={row.categoryId}
            categoryName={name}
            month={month}
            assignedCents={row.assignedCents}
            editable={editable}
            align="left"
          />
        </div>
        <div>
          <p className="text-xs text-muted">Activity</p>
          <p className="tabular">{formatUSD(row.activityCents)}</p>
        </div>
        <div>
          <p className="text-xs text-muted">Available</p>
          <MoveMoneyDialog
            row={row}
            categoryName={name}
            month={month}
            categories={assignableCategories}
            editable={editable}
          />
        </div>
      </div>
    </div>
  )
}
