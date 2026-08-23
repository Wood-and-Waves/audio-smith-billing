import { formatUSD } from '@/lib/money'
import type { CategoryMonth, TargetStatus } from '@/lib/budget'
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
 * (`targetCents` null means nothing to show progress toward). `funded` is
 * what has gone INTO the category so far this cycle, deliberately excluding
 * what came back out: `availableCents + max(0, -activityCents)` adds back
 * this month's spending (activity is negative when money leaves) so a
 * category that has since been drawn down still shows how much of its
 * target was actually funded, not how much is left sitting in it. Width is
 * clamped to [0, 100] — funded can be negative in edge cases (a large
 * category-to-category move out with little carried in), and the DB's own
 * `amount_cents > 0` check on targets rules out a divide-by-zero.
 *
 * The fill renders in `bg-danger` instead of `bg-good` when the row is
 * overspent — the one color signal the bar itself carries, beyond what the
 * status line already says in words. `aria-hidden` throughout: the status
 * line is the accessible version of this same information.
 */
function TargetProgressBar({ row }: { row: CategoryMonth }) {
  if (row.targetCents === null) return null
  const funded = row.availableCents + Math.max(0, -row.activityCents)
  const pct = Math.max(0, Math.min(100, Math.round((100 * funded) / row.targetCents)))
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
 * only one. Five states, straight off Task 7's own brief table:
 *
 *   available < 0            -> danger, no glyph (overspent is loud enough
 *                                on the status line above; this pill just
 *                                needs to read as "not good")
 *   available > 0, met       -> good, filled check
 *   available > 0, not met   -> good, half circle (this bucket is also
 *                                where a category with NO target at all
 *                                lands, per the brief's own table — it only
 *                                distinguishes "met" from everything else
 *                                when available is positive, so an
 *                                untargeted category with money in it gets
 *                                the same half-circle as a partly-funded
 *                                one. Implemented exactly as specified;
 *                                flagged in Task 7's report since a
 *                                progress glyph on a category with no
 *                                target to progress toward reads a little
 *                                oddly)
 *   available === 0, target  -> accent-wash, outline check
 *   available === 0, no goal -> plain muted text, no glyph
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
  } else if (cents > 0) {
    classes = 'bg-good/15 text-good'
    glyph = <HalfCircleIcon />
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
 * a category's figures land under the group's summed ones above it. Props
 * stay exactly `{ row, name }` (Task 7's own brief): BudgetTable renders
 * this and shouldn't need to change, and everything added here — the
 * pencil's categoryId, the pill's target-met read, the bar's target — comes
 * off `row` alone.
 */
export default function BudgetRow({ row, name }: { row: CategoryMonth; name: string }) {
  const status = statusLine(row.status)
  return (
    <div className="grid grid-cols-[1fr_7rem_7rem_8rem] gap-x-4 items-center py-2 text-sm">
      <div className="min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="truncate min-w-0">{name}</span>
          <span className="ml-auto inline-flex items-center gap-2 shrink-0">
            <TargetEditor categoryId={row.categoryId} categoryName={name} targetCents={row.targetCents} />
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
