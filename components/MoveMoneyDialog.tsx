'use client'

import { useEffect, useId, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { formatAmount, formatUSD } from '@/lib/money'
import { parseUSDMath } from '@/lib/moneyMath'
import { FIELD_FULL } from '@/components/ui/field'
import Select, { type SelectOption } from '@/components/ui/Select'
import { moveBetweenCategories } from '@/app/money/budget/actions'
import type { CategoryMonth } from '@/lib/budget'
import type { AssignableCategory } from '@/app/money/budget/page'

/** A checkmark drawn solid — "target met" in the Available pill. Moved here
 *  verbatim from BudgetRow's own prior AvailablePill (budget-phase-two Task
 *  3 turned the pill into this dialog's own trigger button, so the glyphs
 *  that dressed it moved with it). */
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

type Glyph = 'filled' | 'outline' | 'half' | null

function glyphFor(glyph: Glyph) {
  if (glyph === 'filled') return <CheckFilledIcon />
  if (glyph === 'outline') return <CheckIcon />
  if (glyph === 'half') return <HalfCircleIcon />
  return null
}

/**
 * The Available pill's own six-state read, unchanged from BudgetRow's prior
 * AvailablePill (see that file's git history for the table this was
 * originally dispatched against, and its own long comment for why "no
 * target" is pulled out as its own row rather than folded into "not met").
 * Pulled out to a plain function (rather than a component) because
 * MoveMoneyDialog needs the same three pieces — classes, glyph, label — for
 * BOTH the interactive `<button>` (editable rows) and the plain `<span>`
 * (hidden rows, see this component's own `editable` doc comment) branches
 * below, and a function is what lets both branches share one source of
 * truth without rendering the icon/text twice through two different paths.
 */
function pillLook(row: CategoryMonth): { classes: string; glyph: Glyph; label: string } {
  const cents = row.availableCents
  const hasTarget = row.targetCents !== null
  const met = row.status.kind === 'funded'

  if (cents < 0) {
    return { classes: 'bg-danger/15 text-danger', glyph: null, label: `Overspent by ${formatUSD(-cents)}` }
  }
  if (cents > 0 && met) {
    return { classes: 'bg-good/15 text-good', glyph: 'filled', label: `${formatUSD(cents)} available, target met` }
  }
  if (cents > 0 && hasTarget) {
    return { classes: 'bg-good/15 text-good', glyph: 'half', label: `${formatUSD(cents)} available` }
  }
  if (cents > 0) {
    return { classes: 'bg-good/15 text-good', glyph: null, label: `${formatUSD(cents)} available` }
  }
  if (hasTarget) {
    return { classes: 'bg-accent-wash text-muted', glyph: 'outline', label: 'Target met, nothing left available' }
  }
  return { classes: 'text-muted', glyph: null, label: 'Nothing available' }
}

const PILL_CLASSES =
  'inline-flex items-center gap-1 rounded-pill px-2.5 py-1 text-sm font-semibold tabular'

/**
 * The Available pill, and the move-money dialog it opens — budget-phase-two
 * Task 3. Same fixed-backdrop/centered-panel/Escape idiom as TargetEditor's
 * own dialog (which itself follows AddFlightDialog/PunchClock), one instance
 * per row so one category's dialog never collides with another's.
 *
 * The pill keeps its own six-state look and its own `aria-label` verbatim
 * (see `pillLook` above) — it becomes a real `<button>`, not new UI grafted
 * next to the old pill.
 *
 * `categories` is the page's own `AssignableCategory` list (every VISIBLE
 * spending category, with its current Available), passed all the way down
 * rather than refetched here — see that type's own doc comment
 * (app/money/budget/page.tsx) for why. `moveBetweenCategories` re-reads
 * nothing client-side either; it validates and computes everything
 * server-side the same way assignToCategory does.
 *
 * Preselection on open: the amount prefills with this row's own overspend
 * magnitude when it's negative (covering an overspent category is the
 * common case the dialog exists for) and starts blank otherwise. The
 * clicked category itself preselects as To when overspent, else as From —
 * the plan's own rule; the OTHER side defaults to Ready to Assign ('' in
 * Select's own value space, the same sentinel categoryOptions already uses
 * for "no category" elsewhere in this app) and is left for Dan to change.
 *
 * Same-category pairs are disabled in the UI (Save stays disabled, and an
 * inline note explains why) but the server is the real guard —
 * moveBetweenCategories re-checks the identical rule and refuses on its own
 * terms if this ever gets bypassed.
 *
 * `editable` is false for a hidden row, same reasoning and same
 * `row.hidden` flag as AssignedCell's own doc comment: moveBetweenCategories
 * refuses a hidden category as either side of a move, so the pill renders as
 * plain, inert text instead of a button that opens a dialog doomed to fail.
 *
 * `disabled` (final review, 2026-08-24) is BudgetRow's own shared
 * `assignPending` flag — true while the SAME row's AssignedCell has an
 * assign write in flight. It gates only the pill's own `<button
 * disabled>`, never the `editable` branch above (a hidden row's pill stays
 * plain text either way): a native `disabled` button does not fire
 * `onClick`, which is what closes the race AssignedCell's own doc comment
 * describes — clicking the pill mid-edit used to fire blur-commit AND
 * `openDialog()` in the same gesture, seeding this dialog from
 * `row.availableCents` before that commit's write had landed.
 */
export default function MoveMoneyDialog({
  row, categoryName, month, categories, editable, disabled = false,
}: {
  row: CategoryMonth
  categoryName: string
  /** 'YYYY-MM' — the viewed month, passed straight to moveBetweenCategories. */
  month: string
  categories: AssignableCategory[]
  editable: boolean
  /** See this component's own doc comment above. Defaults to false so a
   *  future caller with no sibling AssignedCell to race isn't forced to
   *  wire a constant `false`. */
  disabled?: boolean
}) {
  const router = useRouter()
  const uid = useId()
  const [open, setOpen] = useState(false)
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [amount, setAmount] = useState('')
  const [fromId, setFromId] = useState('')
  const [toId, setToId] = useState('')
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => { if (open) panelRef.current?.focus() }, [open])

  const look = pillLook(row)

  function openDialog() {
    setError(null)
    const overspent = row.availableCents < 0
    setAmount(overspent ? formatAmount(-row.availableCents) : '')
    setFromId(overspent ? '' : row.categoryId)
    setToId(overspent ? row.categoryId : '')
    setOpen(true)
  }

  const sameCategory = fromId === toId

  function save() {
    setError(null)
    const cents = parseUSDMath(amount)
    if (cents === null || cents <= 0) {
      setError('Enter an amount greater than zero.')
      return
    }
    const from = fromId === '' ? null : fromId
    const to = toId === '' ? null : toId
    // Matches `sameCategory` above EXACTLY — the Enter key on the amount
    // field calls save() directly, bypassing the disabled Save button, so a
    // narrower guard here would let RTA -> RTA reach the server for a
    // round-trip refusal instead of the immediate inline note.
    if (from === to) {
      setError('Pick two different categories.')
      return
    }
    start(async () => {
      const result = await moveBetweenCategories(from, to, month, cents)
      if (!result.ok) { setError(result.error); return }
      setOpen(false)
      router.refresh()
    })
  }

  // Ready to Assign first (categoryOptions' own "—" sentinel idiom
  // elsewhere in this app, but meaningful here rather than blank), then
  // every visible spending category with its own current Available beside
  // its name — so Dan picks a source or destination already knowing what
  // it holds, without a second lookup.
  const options: SelectOption[] = [
    { value: '', label: 'Ready to Assign' },
    ...categories.map((c) => ({ value: c.id, label: `${c.name} — ${formatUSD(c.availableCents)}` })),
  ]

  if (!editable) {
    return (
      <span aria-label={look.label} className={`${PILL_CLASSES} ${look.classes}`}>
        {glyphFor(look.glyph)}
        {formatUSD(row.availableCents)}
      </span>
    )
  }

  return (
    <>
      <button
        type="button"
        onClick={openDialog}
        disabled={disabled}
        aria-label={look.label}
        className={`${PILL_CLASSES} ${look.classes} hover:opacity-80 transition-opacity disabled:opacity-50 disabled:pointer-events-none`}
      >
        {glyphFor(look.glyph)}
        {formatUSD(row.availableCents)}
      </button>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Move money — ${categoryName}`}
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-4"
          onClick={(e) => { if (e.target === e.currentTarget && !pending) setOpen(false) }}
        >
          <div
            ref={panelRef}
            tabIndex={-1}
            // max-h-[85vh] overflow-y-auto: the punch dialog's own
            // precedent (PunchClock), added in the final review
            // (2026-08-24) — without it the phone-bottom-anchored layout
            // (`items-end` above `sm`) could push the panel's own bottom
            // edge (the Save/Cancel row) off-screen on a short viewport
            // with nothing to scroll it back into view, so the To select
            // was sometimes unreachable.
            className="w-full max-w-sm max-h-[85vh] overflow-y-auto bg-bg border border-line rounded-field p-5 outline-none"
            onKeyDown={(e) => { if (e.key === 'Escape' && !pending) setOpen(false) }}
          >
            <h2 className="eyebrow mb-4">Move money — {categoryName}</h2>

            <div className="mb-3">
              <label className="eyebrow block mb-1.5" htmlFor={`${uid}-amount`}>Amount</label>
              <input
                id={`${uid}-amount`}
                type="text"
                inputMode="decimal"
                className={FIELD_FULL}
                value={amount}
                disabled={pending}
                placeholder="0.00"
                onChange={(e) => setAmount(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !pending) { e.preventDefault(); save() } }}
              />
            </div>

            <div className="mb-3">
              <label className="eyebrow block mb-1.5">From</label>
              <Select
                value={fromId}
                options={options}
                onChange={setFromId}
                ariaLabel="Move money from"
                disabled={pending}
              />
            </div>

            <div className="mb-3">
              <label className="eyebrow block mb-1.5">To</label>
              <Select
                value={toId}
                options={options}
                onChange={setToId}
                ariaLabel="Move money to"
                disabled={pending}
              />
            </div>

            {sameCategory && (
              <p className="mb-3 text-xs text-muted">Pick two different categories.</p>
            )}

            {error && (
              <p role="alert" className="mb-4 text-sm text-danger border-l-2 border-danger pl-3 py-1">
                {error}
              </p>
            )}

            <div className="flex items-center gap-2">
              <button
                type="button" onClick={save} disabled={pending || sameCategory}
                className="px-5 py-2.5 bg-accent-surface text-accent-ink font-bold uppercase
                           tracking-wider text-sm rounded-field hover:opacity-90
                           transition-opacity disabled:opacity-50"
              >
                {pending ? 'Saving…' : 'Save'}
              </button>
              <button
                type="button" onClick={() => setOpen(false)} disabled={pending}
                className="ml-auto text-xs font-semibold uppercase tracking-wider
                           text-muted hover:text-ink disabled:opacity-40"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
