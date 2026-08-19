'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { todayInChicago } from '@/lib/dates'
import { formatAmount, parseUSD } from '@/lib/money'
import { FIELD_FULL } from '@/components/ui/field'
import { reconcileAccount } from '@/app/money/actions'

/**
 * Collapsed "Reconcile" text-button that opens into a small panel, same
 * pattern as SendReminderButton: statement balance + date, submitted with
 * createAdjustment: false first. reconcileAccount's return is a discriminated
 * union rather than Fail-or-ok: a no-adjustment mismatch comes back as its
 * own `{ mismatch: true, ... }` variant (narrowed with `'mismatch' in
 * result`, not by matching words in an error string), which is what lets
 * this panel offer a second button that resubmits with createAdjustment:
 * true — without that button ever appearing for a real failure, or failing
 * to appear because someone reworded the message.
 */
export default function LedgerReconcile({
  accountId, prefill, onPrefillUsed,
}: {
  accountId: string
  /**
   * "Reconcile now" from LedgerImport, via the shared coordinator — the
   * statement's own ending balance, so Dan doesn't retype a number the file
   * already had. A fresh object literal every click (see
   * components/LedgerImportReconcile.tsx), which is what the effect below
   * keys off of.
   */
  prefill?: { balanceCents: number } | null
  /** Fired once the prefill above has been applied, so the coordinator can
   *  null it back out — otherwise a second identical statement balance
   *  wouldn't look like a new prefill at all. */
  onPrefillUsed?: () => void
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, start] = useTransition()
  const [balance, setBalance] = useState('')
  const [reconciledOn, setReconciledOn] = useState(todayInChicago())
  const [error, setError] = useState<string | null>(null)
  const [mismatch, setMismatch] = useState(false)
  const [done, setDone] = useState(false)

  // Opens the panel and fills both fields the moment a new prefill arrives.
  // Deliberately keyed on `prefill` alone (like DeleteShowButton's own
  // confirm-timeout effect, which omits its `disarm` callback from deps
  // too): onPrefillUsed is a fresh closure every render of the coordinator,
  // and tracking it here would refire this effect — stomping whatever Dan
  // had already typed — on any unrelated re-render, not just a genuine new
  // "Reconcile now" click.
  useEffect(() => {
    if (!prefill) return
    setOpen(true)
    setBalance(formatAmount(prefill.balanceCents))
    setReconciledOn(todayInChicago())
    setError(null)
    setMismatch(false)
    setDone(false)
    onPrefillUsed?.()
  }, [prefill])

  function collapse() {
    setOpen(false)
    setBalance('')
    setReconciledOn(todayInChicago())
    setError(null)
    setMismatch(false)
  }

  function submit(createAdjustment: boolean) {
    setError(null)
    // NOT parseUSD(balance) directly: parseUSD('') is 0, not null (see
    // lib/money.ts), so an untouched field would silently submit
    // statementBalanceCents: 0 — and a real cleared balance that isn't
    // already zero would then read as a mismatch against a $0 statement,
    // offering to book a phantom Balance Adjustment nobody asked for. Check
    // for blank before parsing so a genuine typed "$0.00" still gets through.
    if (!balance.trim()) { setError('Enter the statement balance.'); return }
    const cents = parseUSD(balance)
    if (cents === null) { setError('Enter the statement balance.'); return }
    if (!reconciledOn) { setError('Pick a reconciliation date.'); return }

    start(async () => {
      const result = await reconcileAccount({
        accountId, statementBalanceCents: cents, reconciledOn, createAdjustment,
      })
      if ('error' in result) {
        setError(result.error)
        setMismatch(false)
        return
      }
      if ('mismatch' in result) {
        setError(result.message)
        setMismatch(true)
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
