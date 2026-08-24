'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { formatAmount, formatUSD, parseUSD } from '@/lib/money'
import { assignToCategory } from '@/app/money/budget/actions'

/**
 * The Assigned figure, click-to-edit — budget-phase-two Task 3. Rendered
 * from BOTH of BudgetRow's own call sites (the desktop grid cell, the phone
 * card's mini-card) as the SAME component, the same "call twice, don't fork
 * into two hand-maintained copies" precedent BudgetRow's own AvailablePill
 * (now MoveMoneyDialog) already set for a value cell that has to appear
 * twice. `align` is the one thing each call site supplies for itself,
 * mirroring how each already supplies its own wrapper classes.
 *
 * Typing a figure writes the DIFFERENCE, never the figure — that's
 * assignToCategory's own job (app/money/budget/actions.ts), computed
 * server-side against a fresh read so a stale tab can't double-assign; this
 * component only parses what was typed and hands it over. A no-op submit
 * (typed figure equals what's already assigned) is a real request that
 * comes back `{ ok: true, wrote: false }` — not something this component
 * short-circuits away, so Enter on an unchanged figure still round-trips and
 * still reports success, exactly as honest as any other submit.
 *
 * `editable` is false for a hidden row — BudgetTable folds a hidden
 * category with money or activity into the synthetic "Hidden" section, but
 * every row there (like every plainly-hidden, empty one it drops instead)
 * carries `row.hidden === true`, so that one flag is both cases at once.
 * assignToCategory's own ownership walk (`requireAssignable`) refuses a
 * hidden category server-side, so a button that opened an editor doomed to
 * fail on save has no honest reason to exist — the figure renders as plain
 * text instead.
 *
 * `onPendingChange` (final review, 2026-08-24) reports this cell's own
 * `pending` upward, unchanged — see this file's own `useEffect` below for
 * why mirroring `pending` itself (rather than toggling a second flag by
 * hand at each call site) is enough. `BudgetRow` lifts the one flag both of
 * its AssignedCell instances (desktop grid cell, phone mini-card) and both
 * of its MoveMoneyDialog instances share, and disables the Available pill
 * while it's true — the fix for a real race: clicking the pill while this
 * row's Assigned editor holds an uncommitted change fires blur-commit AND
 * opens the dialog in the same gesture, and the dialog used to seed itself
 * from `row.availableCents` before that commit's write had landed, showing
 * Dan pre-write figures. See MoveMoneyDialog's own doc comment for the
 * other half.
 */
export default function AssignedCell({
  categoryId, categoryName, month, assignedCents, editable, align = 'right', onPendingChange,
}: {
  categoryId: string
  categoryName: string
  /** 'YYYY-MM' — the viewed month, passed straight to assignToCategory. */
  month: string
  assignedCents: number
  editable: boolean
  /** 'right' for the desktop grid cell (tabular figures line up on their
   *  decimal there); 'left' for the phone card's own mini-cards, where
   *  every other figure is left-aligned under its label. */
  align?: 'left' | 'right'
  /** Reports this cell's own `pending` upward to BudgetRow — see this
   *  component's own doc comment above. Optional so a future caller that
   *  doesn't need the pill-race guard (there isn't one today; both of
   *  BudgetRow's own call sites always pass it) isn't forced to wire a
   *  no-op. */
  onPendingChange?: (pending: boolean) => void
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, start] = useTransition()
  const [value, setValue] = useState('')
  const [initial, setInitial] = useState('')
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Mirrors `pending` upward on every change, rather than each call site
  // (openEditor/commit/cancel) toggling `onPendingChange` by hand — one
  // source of truth, so the reported flag can never drift from what this
  // cell's own "Saving…" state already shows. `pending` (from
  // `useTransition`) stays true for the whole `start(async () => { …
  // router.refresh() })` in commit() below, including the refresh itself
  // (the same Next.js idiom BudgetHistory's own pending relies on) — so the
  // pill stays disabled until the fresh, post-write figures have actually
  // landed as props, not just until the network round-trip resolves.
  useEffect(() => {
    onPendingChange?.(pending)
  }, [pending, onPendingChange])

  useEffect(() => {
    if (!open) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [open])

  function openEditor() {
    setError(null)
    const seed = formatAmount(assignedCents)
    setValue(seed)
    setInitial(seed)
    setOpen(true)
  }

  function cancel() {
    setError(null)
    setOpen(false)
  }

  function commit() {
    const cents = parseUSD(value)
    if (cents === null || cents < 0) {
      setError('Enter an amount of zero or more.')
      return
    }
    start(async () => {
      const result = await assignToCategory(categoryId, month, cents)
      if (!result.ok) { setError(result.error); return }
      setOpen(false)
      router.refresh()
    })
  }

  const alignClass = align === 'right' ? 'text-right' : 'text-left'

  if (!editable) {
    return <p className={`tabular ${alignClass}`}>{formatUSD(assignedCents)}</p>
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={openEditor}
        aria-label={`Edit assigned for ${categoryName}`}
        className={`w-full tabular ${alignClass} hover:text-accent transition-colors`}
      >
        {formatUSD(assignedCents)}
      </button>
    )
  }

  return (
    <div className={alignClass}>
      <input
        ref={inputRef}
        type="text"
        inputMode="decimal"
        value={value}
        disabled={pending}
        aria-label={`Assigned for ${categoryName}`}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit() }
          if (e.key === 'Escape') { e.preventDefault(); cancel() }
        }}
        onBlur={() => {
          // "blur-when-changed": leaving the field without touching it just
          // closes it, the same as Escape — only an actually-edited value
          // round-trips through commit() on blur. Enter (above) always
          // commits, changed or not, because pressing it is an explicit
          // save — see this file's own doc comment on why an unchanged
          // Enter still round-trips rather than being short-circuited here.
          if (pending) return
          if (value === initial) { cancel(); return }
          commit()
        }}
        className={`w-full ${alignClass} tabular px-1.5 py-1 bg-surface border border-line
                   rounded-field text-ink text-sm focus:border-accent focus:outline-none
                   disabled:opacity-50`}
      />
      {pending && <p className="text-xs text-muted mt-0.5">Saving…</p>}
      {error && (
        <p role="alert" className="text-xs text-danger mt-0.5">{error}</p>
      )}
    </div>
  )
}
