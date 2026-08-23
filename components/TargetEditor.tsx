'use client'

import { useEffect, useId, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { formatAmount, parseUSD } from '@/lib/money'
import { isPlainDate } from '@/lib/dates'
import { FIELD_FULL } from '@/components/ui/field'
import { setCategoryTarget, clearCategoryTarget } from '@/app/money/budget/actions'

type Kind = 'monthly' | 'by_date'

/** Small pencil, drawn to match the app's other inline SVG glyphs (see
 *  MoneyRegister's LockIcon/ReceiptIcon) rather than an icon font. */
function PencilIcon() {
  return (
    <svg aria-hidden width="14" height="14" viewBox="0 0 14 14" className="h-3.5 w-3.5 shrink-0 fill-none stroke-current">
      <path d="M9.6 1.4 12.6 4.4 4.5 12.5 1 13l0.5-3.5z" strokeWidth="1.2" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

/**
 * The pencil trigger on a BudgetRow, and the dialog it opens — same
 * fixed-backdrop/centered-panel/Escape-Enter idiom as AddFlightDialog and
 * PunchClock's own dialogs, each instance owning its own open/closed state
 * so one row's editor never collides with another's.
 *
 * BudgetRow's props are frozen at `{ row, name }` (Task 7's own brief), and
 * `CategoryMonth` (lib/budget.ts) carries a target's amount but not its
 * `kind` or `dueDate` — those live only in `CategoryTarget`, which nothing
 * between the page and this row currently threads through. So opening this
 * editor on a category that already has a target pre-fills the one figure
 * BudgetRow actually has (the amount, via `targetCents`) and starts on
 * `monthly` with a blank date regardless of what's really stored — the
 * honest options given what's on hand, rather than guessing a kind/date
 * that might be wrong. Switching to "By date" always starts empty and
 * requires a fresh date before Save will take it; re-saving a `monthly`
 * amount round-trips cleanly since that's the only field it needs. Editing
 * just the amount of an EXISTING by-date target without re-entering its
 * due date isn't possible from here — a real gap worth closing later by
 * threading CategoryTarget through, not something this task's data model
 * can paper over.
 */
export default function TargetEditor({
  categoryId, categoryName, targetCents,
}: {
  categoryId: string
  categoryName: string
  /** From CategoryMonth.targetCents — null when this category has no
   *  target yet. The only piece of an existing target this row can see. */
  targetCents: number | null
}) {
  const router = useRouter()
  const uid = useId()
  const [open, setOpen] = useState(false)
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [kind, setKind] = useState<Kind>('monthly')
  const [amount, setAmount] = useState('')
  const [dueDate, setDueDate] = useState('')
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => { if (open) panelRef.current?.focus() }, [open])

  function openEditor() {
    setError(null)
    setKind('monthly')
    setAmount(targetCents !== null ? formatAmount(targetCents) : '')
    setDueDate('')
    setOpen(true)
  }

  function save() {
    setError(null)
    const cents = parseUSD(amount)
    if (cents === null || cents <= 0) {
      setError('Enter a target amount greater than zero.')
      return
    }
    if (kind === 'by_date' && !isPlainDate(dueDate)) {
      setError('Pick a target date.')
      return
    }
    start(async () => {
      const result = await setCategoryTarget(categoryId, kind, cents, kind === 'by_date' ? dueDate : null)
      if (!result.ok) { setError(result.error); return }
      setOpen(false)
      router.refresh()
    })
  }

  function clear() {
    setError(null)
    start(async () => {
      const result = await clearCategoryTarget(categoryId)
      if (!result.ok) { setError(result.error); return }
      setOpen(false)
      router.refresh()
    })
  }

  return (
    <>
      <button
        type="button"
        onClick={openEditor}
        aria-label={targetCents !== null ? `Edit target for ${categoryName}` : `Set target for ${categoryName}`}
        className="text-muted hover:text-ink transition-colors"
      >
        <PencilIcon />
      </button>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Target for ${categoryName}`}
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-4"
          onClick={(e) => { if (e.target === e.currentTarget && !pending) setOpen(false) }}
        >
          <div
            ref={panelRef}
            tabIndex={-1}
            className="w-full max-w-sm bg-bg border border-line rounded-field p-5 outline-none"
            onKeyDown={(e) => {
              if (e.key === 'Escape' && !pending) setOpen(false)
              if (e.key === 'Enter' && !pending) { e.preventDefault(); save() }
            }}
          >
            <h2 className="eyebrow mb-4">Target for {categoryName}</h2>

            <div className="flex gap-4 mb-3">
              <label className="flex items-center gap-1.5 text-xs text-ink">
                <input
                  type="radio"
                  name={`target-kind-${uid}`}
                  className="h-3.5 w-3.5 accent-accent"
                  checked={kind === 'monthly'}
                  disabled={pending}
                  onChange={() => setKind('monthly')}
                />
                Monthly
              </label>
              <label className="flex items-center gap-1.5 text-xs text-ink">
                <input
                  type="radio"
                  name={`target-kind-${uid}`}
                  className="h-3.5 w-3.5 accent-accent"
                  checked={kind === 'by_date'}
                  disabled={pending}
                  onChange={() => setKind('by_date')}
                />
                By date
              </label>
            </div>

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
              />
            </div>

            {kind === 'by_date' && (
              <div className="mb-3">
                <label className="eyebrow block mb-1.5" htmlFor={`${uid}-date`}>Target date</label>
                <input
                  id={`${uid}-date`}
                  type="date"
                  className={FIELD_FULL}
                  value={dueDate}
                  disabled={pending}
                  onChange={(e) => setDueDate(e.target.value)}
                />
              </div>
            )}

            {error && (
              <p role="alert" className="mb-4 text-sm text-danger border-l-2 border-danger pl-3 py-1">
                {error}
              </p>
            )}

            <div className="flex items-center gap-2">
              <button
                type="button" onClick={save} disabled={pending}
                className="px-5 py-2.5 bg-accent-surface text-accent-ink font-bold uppercase
                           tracking-wider text-sm rounded-field hover:opacity-90
                           transition-opacity disabled:opacity-50"
              >
                {pending ? 'Saving…' : 'Save'}
              </button>
              <button
                type="button" onClick={clear} disabled={pending || targetCents === null}
                className="px-4 py-2.5 text-xs font-semibold uppercase tracking-wider
                           rounded-field border border-line text-muted hover:text-ink
                           disabled:opacity-40"
              >
                Clear
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
