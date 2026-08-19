'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { todayInChicago } from '@/lib/dates'
import { parseUSD } from '@/lib/money'
import { FIELD_FULL } from '@/components/ui/field'
import { reconcileAccount } from '@/app/money/actions'

// reconcileAccount's no-adjustment mismatch path (app/money/actions.ts) always
// phrases its Fail the same way: "...is off from the statement by $X.XX...".
// Matching on that phrase — rather than the action returning a new, more
// structured shape — is what lets this panel tell "the statement doesn't
// match" apart from every other reason the call can fail (a blank balance, a
// bad date, an account that isn't the caller's).
const MISMATCH_PHRASE = 'is off from the statement by'

/**
 * Collapsed "Reconcile" text-button that opens into a small panel, same
 * pattern as SendReminderButton: statement balance + date, submitted with
 * createAdjustment: false first. A mismatch comes back as an ordinary error
 * message; recognizing that specific one adds a second button that resubmits
 * with createAdjustment: true to book the difference and close out anyway.
 */
export default function LedgerReconcile({ accountId }: { accountId: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, start] = useTransition()
  const [balance, setBalance] = useState('')
  const [reconciledOn, setReconciledOn] = useState(todayInChicago())
  const [error, setError] = useState<string | null>(null)
  const [mismatch, setMismatch] = useState(false)
  const [done, setDone] = useState(false)

  function collapse() {
    setOpen(false)
    setBalance('')
    setReconciledOn(todayInChicago())
    setError(null)
    setMismatch(false)
  }

  function submit(createAdjustment: boolean) {
    setError(null)
    const cents = parseUSD(balance)
    if (cents === null) { setError('Enter the statement balance.'); return }
    if (!reconciledOn) { setError('Pick a reconciliation date.'); return }

    start(async () => {
      const result = await reconcileAccount({
        accountId, statementBalanceCents: cents, reconciledOn, createAdjustment,
      })
      if ('error' in result) {
        setError(result.error)
        setMismatch(result.error.includes(MISMATCH_PHRASE))
        return
      }
      setDone(true)
      router.refresh()
      collapse()
    })
  }

  if (!open) {
    return (
      <div className="flex items-center gap-3">
        {done && <span className="text-xs text-good">Reconciled</span>}
        <button
          type="button"
          onClick={() => { setOpen(true); setDone(false) }}
          className="text-xs font-semibold uppercase tracking-wider text-muted
                     hover:text-ink transition-colors"
        >
          Reconcile
        </button>
      </div>
    )
  }

  return (
    <div className="w-full max-w-sm mt-4 border border-line rounded-card p-4 bg-surface text-left">
      <p className="eyebrow mb-3">Reconcile against a statement</p>

      <label className="text-xs text-muted block mb-3">
        Statement balance
        <input aria-label="Statement balance" inputMode="decimal" placeholder="0.00"
               className={`${FIELD_FULL} mt-1 tabular`} value={balance} disabled={pending}
               onChange={(e) => setBalance(e.target.value)} />
      </label>

      <label className="text-xs text-muted block mb-4">
        As of
        <input aria-label="Reconciled on" type="date" className={`${FIELD_FULL} mt-1`}
               value={reconciledOn} disabled={pending}
               onChange={(e) => setReconciledOn(e.target.value)} />
      </label>

      {error && (
        <p role="alert" className="mb-3 text-sm text-danger border-l-2 border-danger pl-3 py-1">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => submit(false)} disabled={pending}
                className="px-5 py-2.5 bg-accent-surface text-accent-ink font-bold uppercase tracking-wider
                           text-sm rounded-field cursor-pointer hover:opacity-90 transition-opacity
                           disabled:opacity-50 disabled:cursor-not-allowed">
          {pending ? 'Reconciling…' : 'Reconcile'}
        </button>
        {mismatch && (
          <button type="button" onClick={() => submit(true)} disabled={pending}
                  className="px-5 py-2.5 border border-line text-muted font-bold uppercase tracking-wider
                             text-sm rounded-field cursor-pointer hover:text-ink transition-colors
                             disabled:opacity-50">
            Add balance adjustment and reconcile
          </button>
        )}
        <button type="button" onClick={collapse} disabled={pending}
                className="px-5 py-2.5 border border-line text-muted font-bold uppercase tracking-wider
                           text-sm rounded-field cursor-pointer hover:text-ink transition-colors">
          Cancel
        </button>
      </div>
    </div>
  )
}
