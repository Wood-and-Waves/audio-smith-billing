'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { formatUSD } from '@/lib/money'
import { formatDateShort } from '@/lib/dates'
import { acceptIncomeMatch } from '@/app/money/actions'
import { settlementFor } from '@/lib/invoicePayment'

export type PaymentCandidate = {
  id: string
  date: string
  payee: string
  amountCents: number
}

/**
 * Linking the deposit that actually paid this invoice — including when it
 * does not match to the penny (design: docs/superpowers/specs/
 * 2026-08-25-short-paid-settlement-design.md).
 *
 * Dan's #385 was paid $10 short because the client keyed the wrong amount.
 * The matcher only ever proposes an EXACT amount match, so that deposit
 * never surfaced in the Matches queue and the invoice sat unpaid forever.
 * This is the by-hand path: pick the deposit, see the gap stated plainly,
 * confirm once.
 *
 * It also appears on an invoice already marked paid that carries no link —
 * the ones hand-marked during the 2026-08-21 cleanup, whose `paid_at` is
 * the day of the cleanup rather than a real payment date. Attaching the
 * true deposit fixes the date and leaves an audit trail.
 *
 * The write is the EXISTING `acceptIncomeMatch`: it validates the row is a
 * real deposit, refuses a double link, requires the invoice be sent or
 * paid, and marks it paid on the DEPOSIT'S own date. It DOES compare
 * amounts, and refuses a mismatch unless the caller says otherwise — which
 * is what `settleMismatch: true` below is for, and the only reason settling
 * short is possible from here. The Matches queue omits it and stays strict.
 * Getting back out needs nothing new either — unlinking the transaction in
 * the register restores the invoice to sent.
 */
export default function LinkPaymentPanel({
  invoiceId, invoiceNumber, totalCents, candidates,
}: {
  invoiceId: string
  invoiceNumber: number
  totalCents: number
  candidates: PaymentCandidate[]
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [picked, setPicked] = useState<PaymentCandidate | null>(null)

  // invoiceCount is 1 by construction: this panel only ever links ONE
  // invoice, so a combo cannot arise from here.
  const settlement = picked
    ? settlementFor(totalCents, { amountCents: picked.amountCents, invoiceCount: 1 })
    : null

  function confirm() {
    if (!picked) return
    setError(null)
    start(async () => {
      const result = await acceptIncomeMatch({ transactionId: picked.id, invoiceIds: [invoiceId], settleMismatch: true })
      if ('error' in result) { setError(result.error); return }
      setPicked(null)
      router.refresh()
    })
  }

  return (
    <section className="mb-8 rounded-card border border-line bg-surface p-5">
      <h2 className="eyebrow mb-3">Link a payment</h2>

      {candidates.length === 0 ? (
        <p className="text-sm text-muted">
          No unlinked deposits to choose from. Import or add the deposit on the ledger first.
        </p>
      ) : (
        <ul className="space-y-1">
          {candidates.map((c) => {
            const isPicked = picked?.id === c.id
            return (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => setPicked(isPicked ? null : c)}
                  disabled={pending}
                  className={`w-full flex items-baseline justify-between gap-3 rounded-field px-2 py-1.5
                              text-left text-sm transition-colors disabled:opacity-40
                              ${isPicked ? 'bg-accent-surface text-accent-ink' : 'hover:bg-surface-2'}`}
                >
                  <span className="truncate">
                    {formatDateShort(c.date)} · {c.payee}
                  </span>
                  <span className="tabular shrink-0">{formatUSD(c.amountCents)}</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}

      {settlement && (
        <div className="mt-4 border-t border-line pt-3">
          <p className="text-sm">
            {settlement.state === 'exact'
              ? `Settle #${invoiceNumber} — ${formatUSD(totalCents)}.`
              : `${formatUSD(Math.abs(settlement.deltaCents))} ${
                  settlement.state === 'short' ? 'short of' : 'over'
                } ${formatUSD(totalCents)}. Settle #${invoiceNumber} anyway?`}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={confirm}
              disabled={pending}
              className="px-4 py-2 text-xs font-semibold uppercase tracking-wider rounded-field
                         border border-line text-muted hover:text-ink disabled:opacity-40"
            >
              {pending ? 'Settling…' : settlement.state === 'exact' ? 'Settle' : `Settle ${settlement.state}`}
            </button>
            <button
              type="button"
              onClick={() => setPicked(null)}
              disabled={pending}
              className="text-xs text-muted hover:text-ink underline disabled:opacity-40"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && <p role="alert" className="mt-3 text-xs text-danger">{error}</p>}
    </section>
  )
}
