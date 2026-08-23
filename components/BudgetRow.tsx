import { formatUSD } from '@/lib/money'
import { progressPct, type CategoryMonth, type CategoryTarget, type TargetStatus } from '@/lib/budget'
import TargetEditor from '@/components/TargetEditor'

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

/** A checkmark drawn solid — "target met" in the Available pill. */
function CheckFilledIcon() {
  return (
    <svg aria-hidden width="14" height="14" viewBox="0 0 14 14" className="h-3.5 w-3.5 shrink-0 fill-current">
      <path d="M5.3 10.4 2.1 7.2l1.1-1.1 2.1 2.1L10.8 2.7l1.1 1.1z" />
    </svg>
  )
}

/** The same checkmark, as a plain outline — the quieter "available === 0,
 *  target already met" state, where there's nothing left to draw attention
 *  to. */
function CheckIcon() {
  return (
    <svg aria-hidden width="14" height="14" viewBox="0 0 14 14" className="h-3.5 w-3.5 shrink-0 fill-none stroke-current">
      <path d="M3 7.3 5.8 10 11 4" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** A half-filled ring — progress toward a target that isn't met yet. */
function HalfCircleIcon() {
  return (
    <svg aria-hidden width="14" height="14" viewBox="0 0 14 14" className="h-3.5 w-3.5 shrink-0">
      <circle cx="7" cy="7" r="5.5" className="fill-none stroke-current opacity-30" strokeWidth="1.4" />
      <path d="M7 1.5a5.5 5.5 0 0 1 0 11z" className="fill-current" />
    </svg>
  )
}

/**
 * The Available figure, dressed as a pill whose color and glyph carry the
 * same read the status line gives in words — and only ever carry it
 * ALONGSIDE the words: `aria-label` restates the whole thing for a screen
 * reader, since color is exactly the kind of signal that must never be the
 * only one.
 *
 * Six states. Task 7's original brief table split `available > 0` into only
 * "target met" / "target not met", with no row for a category that carries
 * no target at all — by elimination that category fell into "not met" and
 * got the half-circle progress glyph, which points at progress toward
 * nothing. This is the corrected table (dispatched as a fix, not a
 * reinterpretation), with "no target" pulled out as its own row wherever it
 * changes the rendering:
 *
 *   available < 0                    -> danger, no glyph (overspent is loud
 *                                        enough on the status line above;
 *                                        this pill just needs to read as
 *                                        "not good")
 *   available > 0, target, met       -> good, filled check
 *   available > 0, target, not met   -> good, half circle
 *   available > 0, no target         -> good, no glyph — money sitting in a
 *                                        goalless category is a fine,
 *                                        ordinary state; it reads as plain,
 *                                        not as stalled progress
 *   available === 0, target          -> accent-wash, outline check
 *   available === 0, no target       -> plain muted text, no glyph
 *
 * "Met" is `status.kind === 'funded'` — the only TargetStatus variant that
 * can coexist with available > 0 AND a fully-satisfied target (see
 * lib/budget.ts's own statusFor: fully_spent already claims available === 0,
 * overspent already claims available < 0, so funded's available is always
 * positive when it appears at all).
 */
function AvailablePill({ row }: { row: CategoryMonth }) {
  const cents = row.availableCents
  const hasTarget = row.targetCents !== null
  const met = row.status.kind === 'funded'

  let classes: string
  let glyph: React.ReactNode = null
  let label: string

  if (cents < 0) {
    classes = 'bg-danger/15 text-danger'
    label = `Overspent by ${formatUSD(-cents)}`
  } else if (cents > 0 && met) {
    classes = 'bg-good/15 text-good'
    glyph = <CheckFilledIcon />
    label = `${formatUSD(cents)} available, target met`
  } else if (cents > 0 && hasTarget) {
    classes = 'bg-good/15 text-good'
    glyph = <HalfCircleIcon />
    label = `${formatUSD(cents)} available`
  } else if (cents > 0) {
    classes = 'bg-good/15 text-good'
    label = `${formatUSD(cents)} available`
  } else if (hasTarget) {
    classes = 'bg-accent-wash text-muted'
    glyph = <CheckIcon />
    label = 'Target met, nothing left available'
  } else {
    classes = 'text-muted'
    label = 'Nothing available'
  }

  return (
    <span
      aria-label={label}
      className={`inline-flex items-center gap-1 rounded-pill px-2.5 py-1 text-sm font-semibold tabular ${classes}`}
    >
      {glyph}
      {formatUSD(cents)}
    </span>
  )
}

/**
 * One category's line in the month grid: name, target status, progress bar,
 * assigned/activity, and the Available pill — everything BudgetTable's grid
 * expects, still under the same `grid-cols-[1fr_7rem_7rem_8rem]` template so
 * a category's figures land under the group's summed ones above it.
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
 */
export default function BudgetRow({
  row, name, target,
}: {
  row: CategoryMonth
  name: string
  target?: CategoryTarget | null
}) {
  const status = statusLine(row.status)
  return (
    <div className="grid grid-cols-[1fr_7rem_7rem_8rem] gap-x-4 items-center py-2 text-sm">
      <div className="min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="truncate min-w-0">{name}</span>
          <span className="ml-auto inline-flex items-center gap-2 shrink-0">
            <TargetEditor categoryId={row.categoryId} categoryName={name} target={target ?? null} />
            {status && <span className={status.className}>{status.text}</span>}
          </span>
        </div>
        <TargetProgressBar row={row} />
      </div>
      <span className="tabular text-right">{formatUSD(row.assignedCents)}</span>
      <span className="tabular text-right">{formatUSD(row.activityCents)}</span>
      <div className="flex justify-end">
        <AvailablePill row={row} />
      </div>
    </div>
  )
}
