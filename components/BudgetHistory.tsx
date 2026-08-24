'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { formatUSD } from '@/lib/money'
import { undoLastMove, redoLastMove } from '@/app/money/budget/actions'
import type { RecentMove } from '@/app/money/budget/page'

const HISTORY_BUTTON =
  'rounded-pill px-3 py-1.5 text-xs font-semibold border border-line text-muted ' +
  'hover:text-ink transition-colors disabled:opacity-40 disabled:hover:text-muted'

/**
 * Undo/Redo buttons plus the "Recent moves ▾" disclosure — budget-phase-two
 * Task 4. Renders beside the filter chips (see the page's own layout
 * comment); this component itself is dumb, exactly the way the plan states
 * it: both button states and every list entry arrive as props, computed
 * server-side in app/money/budget/page.tsx from data it already fetched
 * (fetchAllBudgetMoves, paged, already in hand for buildBudget) — no fetch
 * of its own, no client-side undo/redo arithmetic.
 *
 * `undoLastMove`/`redoLastMove` (app/money/budget/actions.ts) each
 * `revalidatePath('/money/budget')` on a real write; this component follows
 * the same pending/`router.refresh()` idiom as AssignedCell and
 * MovePopover to pick that up — no optimistic math anywhere, because a
 * move landing or lifting changes figures all over the page (Ready to
 * Assign, every affected category's Available), not just this list.
 *
 * Only the stack's head is ever undoable, and only through the Undo button
 * above — not through any entry in the list below, which is why the list
 * carries no per-row affordance. Keeping the list read-only is the plan's
 * own explicit call ("keep it honest rather than clever"): a past move
 * cannot be undone out of order without lying about what "undo" means for a
 * durable, append-only ledger (see lib/budgetMoves.ts's own redoTarget doc
 * comment on the 'superseded' case this same model produces).
 *
 * `headMoveLabel` (final review, 2026-08-24) is the head move's own
 * description — same string shape as a Recent Moves entry — carried in the
 * Undo button's `title` AND `aria-label`, so leaning on Undo is informed
 * rather than blind about what it is about to flip. `null` when there is
 * nothing to undo, which falls back to the plain "Undo" label — the visible
 * button text itself never changes; only the tooltip and the accessible
 * name do.
 */
export default function BudgetHistory({
  undoEnabled, redoEnabled, moves, headMoveLabel,
}: {
  undoEnabled: boolean
  redoEnabled: boolean
  /** Newest ~15 moves, already resolved to display strings by the page —
   *  see RecentMove's own doc comment (app/money/budget/page.tsx). */
  moves: RecentMove[]
  /** The newest active move's own description ("$412.00 · Ready to Assign
   *  → Insurance · Mar 2026"), or `null` when `undoEnabled` is false — see
   *  this component's own doc comment above. */
  headMoveLabel: string | null
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  // A brief note for the "nothing happened" case `wrote: false` describes —
  // no undone move to redo, nothing active to undo, or a benign double-
  // click race the server's own row filter turned into a no-op. Distinct
  // from `error`: this is not a failure (the request succeeded; there was
  // simply nothing to do), so it renders with muted, not danger, styling.
  const [note, setNote] = useState<string | null>(null)

  // One shared `pending` for both buttons (rather than one each): only one
  // of Undo/Redo can ever be the button just clicked, and disabling both
  // while either request is in flight is exactly what stops a second click
  // from racing the first — the same race app/money/budget/actions.ts's own
  // `.is('undone_at', null)` / `.not('undone_at', 'is', null)` filters
  // already turn into a harmless no-op server-side, this is just the
  // client-side belt to match that suspenders.
  function runUndo() {
    setError(null)
    setNote(null)
    start(async () => {
      const result = await undoLastMove()
      if (!result.ok) { setError(result.error); return }
      // wrote:false means our view was stale (nothing left, or a lost
      // race) — which is exactly when a refresh matters most, so do both.
      if (!result.wrote) setNote('Nothing to undo.')
      router.refresh()
    })
  }

  function runRedo() {
    setError(null)
    setNote(null)
    start(async () => {
      const result = await redoLastMove()
      if (!result.ok) { setError(result.error); return }
      // wrote:false means our view was stale (nothing left, or a lost
      // race) — which is exactly when a refresh matters most, so do both.
      if (!result.wrote) setNote('Nothing to redo.')
      router.refresh()
    })
  }

  return (
    <div className="flex flex-wrap items-start gap-2">
      <button
        type="button"
        onClick={runUndo}
        disabled={pending || !undoEnabled}
        title={headMoveLabel ? `Undo ${headMoveLabel}` : 'Undo'}
        aria-label={headMoveLabel ? `Undo ${headMoveLabel}` : 'Undo'}
        className={HISTORY_BUTTON}
      >
        Undo
      </button>
      <button
        type="button"
        onClick={runRedo}
        disabled={pending || !redoEnabled}
        className={HISTORY_BUTTON}
      >
        Redo
      </button>

      {/* Same `<details>`/`group`/rotating-glyph disclosure idiom as
          ShowSettings and ClientEditor's own "Rates and rules"/"Rules"
          sections — the app's existing pattern for "click a label to reveal
          more," reused rather than inventing a second one. Open by default
          (final review, 2026-08-24): the second belt alongside the head
          move's own description above — Recent Moves is right there to
          check an Undo/Redo against, not one more click away. */}
      <details className="group" open>
        <summary
          className="eyebrow cursor-pointer select-none list-none flex items-center gap-1
                     px-1 py-1.5 text-muted hover:text-ink transition-colors"
        >
          Recent moves
          <span className="transition-transform group-open:rotate-180">▾</span>
        </summary>
        <div className="mt-2 w-72 max-w-[80vw] rounded-card border border-line bg-surface p-3 shadow-edge">
          {moves.length === 0 ? (
            <p className="text-xs text-muted">No moves yet.</p>
          ) : (
            <ul className="space-y-1.5 text-xs">
              {moves.map((m) => (
                // Struck through when undone — the list's only visual cue
                // for "this move isn't in effect right now," since there is
                // no per-row control to explain it any other way.
                <li
                  key={m.id}
                  className={m.undone ? 'text-muted line-through' : 'text-ink'}
                >
                  <span className="tabular">{formatUSD(m.amountCents)}</span>
                  {' · '}{m.fromName} → {m.toName}{' · '}{m.monthLabel}
                  {/* The strikethrough is decoration; this is the signal a
                      screen reader actually gets (WCAG 1.3.1 — state must
                      not live in presentation alone). */}
                  {m.undone && <span className="sr-only"> (undone)</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      </details>

      {error && (
        <p role="alert" className="w-full text-xs text-danger">{error}</p>
      )}
      {!error && note && (
        <p role="status" className="w-full text-xs text-muted">{note}</p>
      )}
    </div>
  )
}
