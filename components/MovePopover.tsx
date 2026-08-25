'use client'

import { useEffect, useId, useLayoutEffect, useRef, useState, useTransition } from 'react'
import { createPortal } from 'react-dom'
import { useRouter } from 'next/navigation'
import { formatAmount, formatUSD } from '@/lib/money'
import { parseUSDMath } from '@/lib/moneyMath'
import CategoryPicker from '@/components/CategoryPicker'
import { moveBetweenCategories } from '@/app/money/budget/actions'
import type { CategoryMonth } from '@/lib/budget'
import type { AssignableCategory } from '@/app/money/budget/page'

/** A checkmark drawn solid — "target met" in the Available pill. Ported
 *  verbatim from the prior MoveMoneyDialog (itself ported from BudgetRow's
 *  even earlier AvailablePill) — Task 3b (Dan's YNAB screenshots, 2026-08-24)
 *  only replaces the fixed-backdrop modal this pill used to open; the pill
 *  itself, its six-state look, and these glyphs are unchanged. */
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
 * The Available pill's own six-state read, unchanged from MoveMoneyDialog's
 * (see that file's git history for the table this was originally dispatched
 * against, and its own long comment for why "no target" is pulled out as its
 * own row rather than folded into "not met"). Pulled out to a plain function
 * (rather than a component) because this component needs the same three
 * pieces — classes, glyph, label — for BOTH the interactive `<button>`
 * (editable rows) and the plain `<span>` (hidden rows, see this component's
 * own `editable` doc comment) branches below.
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

const POPOVER_MARGIN = 8

/** Where the popover panel should render, in viewport (fixed) coordinates.
 *  `null` until the first measurement lands post-mount. */
type Placement = { top: number; left: number }

/**
 * The Available pill, and the directional move popover it opens — Wave B
 * Task 3b (Dan's YNAB screenshots, 2026-08-24), replacing budget-phase-two
 * Task 3's MoveMoneyDialog (see that file's git history). Dan's finding: the
 * fixed-backdrop modal's Select listbox fought the panel's own
 * `max-h-[85vh] overflow-y-auto` scroll container (clipped, stray
 * scrollbars) — the SAME bug both `overflow-y-auto` boundaries in that file
 * existed to work around. YNAB's own move flow doesn't have a scroll
 * container to fight: it's a small popover anchored at the pill, directional
 * rather than a bidirectional From/To form, and that's what this component
 * is.
 *
 * **Directional, not bidirectional** (the owner's exact YNAB screenshots):
 *   - `available > 0` (green) or `=== 0` (zero, no distinct owner spec —
 *     "green-style popover with an empty amount" per the plan's own
 *     implementer's-call clause, since a zero pill still has a
 *     "move some money in" reading and no shortfall to speak of): titled
 *     "Move", an amount field prefilled with the full available when
 *     positive (selected, so typing replaces — `amountRef.select()` below)
 *     or blank at zero, and a **To** picker (Ready to Assign + every visible
 *     spending category). Commits `moveBetweenCategories(thisCategory,
 *     chosen, month, amount)`.
 *   - `available < 0` (red): titled "Cover overspending from", a **From**
 *     picker offering ONLY Ready to Assign and categories with
 *     `availableCents > 0` — CategoryPicker's `options` prop is pre-filtered
 *     to that set below, not merely disabled in the UI, since offering an
 *     already-empty category as a source would just bounce off the server's
 *     own `assignedCents/availableCents` check. No amount field: the amount
 *     is the exact shortfall, shown as a static (non-editable) figure for
 *     confirmation only. Commits `moveBetweenCategories(chosen,
 *     thisCategory, month, |available|)`.
 *
 * **Ready to Assign, both directions:** CategoryPicker's own `pinnedOptions`
 * prop (generalized from Task 3's original single `blankOption` by this same
 * review, so Task 5's still-undispatched Payment/Transfer row has somewhere
 * to land as a second standing entry) already does exactly this — a pinned
 * row above "+ New Category" that sets the picker's value back to `''`, the
 * same sentinel this app already uses everywhere else for "no category".
 * `pinnedOptions={[{ id: '', label: 'Ready to Assign' }]}` is the whole
 * mechanism, on both the To and From pickers below.
 *
 * **Anchored, not modal.** `anchorRef` wraps the pill `<button>`, the same
 * span MonthPicker's own `relative` wrapper plays for its month grid — but
 * unlike that always-below popover, this one can open from a row anywhere
 * in a long table, so it has to pick a side. The panel itself is portaled to
 * `document.body` (no other popover in this app needs one — CategoryPicker's
 * own dropdown and MonthPicker's own grid both stay `position: absolute`
 * inside their trigger's parent, which is exactly the CLIPPING risk this
 * task exists to remove: an `overflow` or a future `transform` on any
 * ancestor between the pill and the page root would clip or mis-place an
 * absolutely-positioned panel, but a `position: fixed` element portaled
 * straight to `<body>` answers to nothing between it and the viewport).
 * `placement()` below measures the anchor's `getBoundingClientRect()` against
 * `window.innerHeight` at open time — "flipping above when the row sits in
 * the lower half of the viewport" is the plan's own rule, applied literally
 * (`rect.top > innerHeight / 2`) rather than measuring the panel's own
 * (not-yet-rendered-at-that-instant) height against the remaining space.
 * Horizontally the panel's RIGHT edge aligns to the pill's right edge by
 * default (the pill already sits at the right edge of its own grid cell on
 * desktop, and of its own card column on phone — see BudgetRow's
 * `justify-end`/grid-cols-3), then both axes are clamped into
 * `[POPOVER_MARGIN, viewport - panelSize - POPOVER_MARGIN]` using the
 * panel's OWN measured size (a second read, `panelRef.current
 * .getBoundingClientRect()`, taken after the first render so the real
 * rendered width/height — which differs between the "Move" and "Cover"
 * layouts — is what gets clamped, not a guessed constant). Recomputed on
 * `resize`/`scroll` (capture phase, so an ancestor's own internal scroll —
 * this app has none today, but the guard costs nothing) while open, so the
 * panel tracks the pill instead of drifting off it.
 *
 * No backdrop, no `max-height` scroll container — the two things that used
 * to make the old dialog's Select fight for space are simply gone. Escape
 * and an outside `mousedown` both close the popover; `stopPropagation`
 * while CategoryPicker's OWN internal listbox is open is already that
 * component's contract (its own comment, ported from Select.tsx), so an
 * Escape meant to close just the category list never also closes this
 * popover — verified by NOT calling `preventDefault`/`stopPropagation` on
 * Escape here beyond the ordinary `setOpen(false)`, letting React's event
 * bubbling (which portals preserve along the REACT tree, not the DOM tree —
 * this panel is a DOM child of `<body>` but a React child of this component)
 * carry a picker-internal Escape's `stopPropagation` up to this same
 * `onKeyDown` before it would otherwise fire.
 *
 * `row`, `categories` (now carrying `grp` — CategoryPicker groups by it),
 * `editable`, and `disabled` (BudgetRow's own `assignPending` race guard)
 * are otherwise byte-identical in contract to MoveMoneyDialog's own props;
 * see BudgetRow's doc comment for the pending-lift race those last two
 * close.
 */
export default function MovePopover({
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
  const [chosenId, setChosenId] = useState('')
  const [placement, setPlacement] = useState<Placement | null>(null)
  const anchorRef = useRef<HTMLSpanElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const amountRef = useRef<HTMLInputElement>(null)

  const look = pillLook(row)
  const isRed = row.availableCents < 0
  const shortfallCents = -row.availableCents // only meaningful/positive when isRed
  const sameCategory = chosenId !== '' && chosenId === row.categoryId

  function openDialog() {
    setError(null)
    setChosenId('')
    if (!isRed) setAmount(row.availableCents > 0 ? formatAmount(row.availableCents) : '')
    setOpen(true)
  }

  function save() {
    setError(null)
    if (sameCategory) {
      setError('Pick two different categories.')
      return
    }
    const chosen = chosenId === '' ? null : chosenId
    if (isRed) {
      start(async () => {
        const result = await moveBetweenCategories(chosen, row.categoryId, month, shortfallCents)
        if (!result.ok) { setError(result.error); return }
        setOpen(false)
        router.refresh()
      })
      return
    }
    const cents = parseUSDMath(amount)
    if (cents === null || cents <= 0) {
      setError('Enter an amount greater than zero.')
      return
    }
    start(async () => {
      const result = await moveBetweenCategories(row.categoryId, chosen, month, cents)
      if (!result.ok) { setError(result.error); return }
      setOpen(false)
      router.refresh()
    })
  }

  // Focus lands on the amount field (selected, so typing replaces) when
  // there is one; otherwise the panel itself, matching TargetEditor/the old
  // MoveMoneyDialog's own `panelRef.current?.focus()` idiom so Escape works
  // the instant the popover opens even before any child is clicked into.
  useEffect(() => {
    if (!open) return
    if (!isRed && amountRef.current) {
      amountRef.current.focus()
      amountRef.current.select()
    } else {
      panelRef.current?.focus()
    }
    // isRed is read once per open — it can't change while THIS popover is
    // open (the row prop it derives from only changes via router.refresh(),
    // which only ever follows a save that already closed the popover).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Anchor + flip. See this component's own doc comment above for the exact
  // rule and why it's a portal rather than an `absolute` child.
  useLayoutEffect(() => {
    if (!open) { setPlacement(null); return }
    function place() {
      const anchor = anchorRef.current
      const panel = panelRef.current
      if (!anchor || !panel) return
      const rect = anchor.getBoundingClientRect()
      const panelRect = panel.getBoundingClientRect()
      const flipAbove = rect.top > window.innerHeight / 2
      const rawTop = flipAbove
        ? rect.top - panelRect.height - POPOVER_MARGIN
        : rect.bottom + POPOVER_MARGIN
      const rawLeft = rect.right - panelRect.width
      const top = Math.min(
        Math.max(rawTop, POPOVER_MARGIN),
        window.innerHeight - panelRect.height - POPOVER_MARGIN,
      )
      const left = Math.min(
        Math.max(rawLeft, POPOVER_MARGIN),
        window.innerWidth - panelRect.width - POPOVER_MARGIN,
      )
      setPlacement({ top, left })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open, isRed, chosenId])

  useEffect(() => {
    if (!open) return
    function onOutside(e: MouseEvent) {
      const target = e.target as Node
      if (anchorRef.current?.contains(target)) return
      if (panelRef.current?.contains(target)) return
      if (!pending) setOpen(false)
    }
    document.addEventListener('mousedown', onOutside)
    return () => document.removeEventListener('mousedown', onOutside)
  }, [open, pending])

  if (!editable) {
    return (
      <span aria-label={look.label} className={`${PILL_CLASSES} ${look.classes}`}>
        {glyphFor(look.glyph)}
        {formatUSD(row.availableCents)}
      </span>
    )
  }

  // Ready to Assign is offered through CategoryPicker's own `pinnedOptions`
  // (see this component's own doc comment above) rather than injected into
  // `options` — the red picker's own list is filtered to positive-Available
  // categories ONLY, never including a synthetic RTA row that would need
  // filtering back out.
  const toOptions = categories.map((c) => ({ id: c.id, name: c.name, grp: c.grp, availableCents: c.availableCents }))
  const fromOptions = toOptions.filter((c) => c.availableCents > 0)

  return (
    <span ref={anchorRef} className="relative inline-flex">
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

      {open && createPortal(
        <div
          ref={panelRef}
          tabIndex={-1}
          role="dialog"
          aria-label={isRed ? `Cover overspending from — ${categoryName}` : `Move money — ${categoryName}`}
          className="fixed z-40 w-72 bg-bg border border-line rounded-field p-4 shadow-edge outline-none"
          style={placement ? { top: placement.top, left: placement.left } : { top: 0, left: -9999 }}
          onKeyDown={(e) => { if (e.key === 'Escape' && !pending) setOpen(false) }}
        >
          <h2 className="eyebrow mb-3">{isRed ? 'Cover overspending from' : 'Move'}</h2>

          {!isRed && (
            <div className="mb-3">
              <label className="eyebrow block mb-1.5" htmlFor={`${uid}-amount`}>Amount</label>
              <input
                ref={amountRef}
                id={`${uid}-amount`}
                type="text"
                inputMode="decimal"
                className="w-full px-3 py-2.5 bg-surface border border-line rounded-field text-ink text-sm focus:border-accent focus:outline-none disabled:opacity-50"
                value={amount}
                disabled={pending}
                placeholder="0.00"
                onChange={(e) => setAmount(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !pending) { e.preventDefault(); save() } }}
              />
            </div>
          )}

          {isRed && (
            <p className="mb-3 tabular text-2xl font-bold text-danger">{formatUSD(shortfallCents)}</p>
          )}

          <div className="mb-3">
            {!isRed && <label className="eyebrow block mb-1.5">To</label>}
            <CategoryPicker
              value={chosenId}
              onChange={setChosenId}
              options={isRed ? fromOptions : toOptions}
              ariaLabel={isRed ? 'Cover overspending from' : 'Move money to'}
              disabled={pending}
              pinnedOptions={[{ id: '', label: 'Ready to Assign' }]}
            />
          </div>

          {sameCategory && (
            <p className="mb-3 text-xs text-muted">Pick two different categories.</p>
          )}

          {error && (
            <p role="alert" className="mb-3 text-sm text-danger border-l-2 border-danger pl-3 py-1">
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
        </div>,
        document.body,
      )}
    </span>
  )
}
