'use client'

// What payroll owes and when — the answer to "am I behind".
//
// This sits at the TOP of the page, above the calculator and the register,
// because it is the only part with a deadline. Dan: "I want to pay what I'm
// due so I don't ever get behind."

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { formatUSD, formatAmount } from '@/lib/money'
import { parseUSDMath } from '@/lib/moneyMath'
import { formatDateShort, isPlainDate } from '@/lib/dates'
import { FIELD_FULL } from '@/components/ui/field'
import { recordTaxPayment } from '@/app/money/payroll/actions'
import type { Obligation, ObligationStatus } from '@/lib/payrollObligations'

const STATUS_CLASS: Record<ObligationStatus, string> = {
  overdue: 'text-danger font-semibold',
  due: 'text-info font-semibold',
  upcoming: 'text-muted',
  done: 'text-good',
}

const STATUS_LABEL = (o: Obligation): string => {
  if (o.status === 'done') return o.kind === 'filing' ? 'Filed' : 'Paid'
  if (o.status === 'overdue') return 'Overdue'
  if (o.status === 'due') return 'Due soon'
  return 'Upcoming'
}

export default function PayrollDue({
  obligations, today,
}: { obligations: Obligation[]; today: string }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [openKey, setOpenKey] = useState<string | null>(null)
  const [amount, setAmount] = useState('')
  const [paidOn, setPaidOn] = useState(today)
  const [confirmation, setConfirmation] = useState('')
  const [error, setError] = useState<string | null>(null)

  const outstanding = obligations.filter((o) => o.status !== 'done')
  const behind = obligations.filter((o) => o.status === 'overdue')
  const behindCents = behind.reduce((sum, o) => sum + Math.max(0, o.balanceCents), 0)

  const keyOf = (o: Obligation) => `${o.code}:${o.periodStart}`

  function open(o: Obligation) {
    setOpenKey(keyOf(o))
    setAmount(o.kind === 'filing' ? '0' : formatAmount(Math.max(0, o.balanceCents)))
    setPaidOn(today)
    setConfirmation('')
    setError(null)
  }

  function save(o: Obligation) {
    setError(null)
    const cents = parseUSDMath(amount.trim() === '' ? '0' : amount)
    if (cents === null || cents < 0) { setError('Enter what you paid.'); return }
    if (!isPlainDate(paidOn)) { setError('Pick the date you paid it.'); return }
    start(async () => {
      const result = await recordTaxPayment({
        obligation: o.code,
        periodStart: o.periodStart,
        periodEnd: o.periodEnd,
        amountCents: cents,
        paidOn,
        confirmation: confirmation.trim() === '' ? null : confirmation.trim(),
      })
      if ('error' in result) { setError(result.error); return }
      setOpenKey(null)
      router.refresh()
    })
  }

  return (
    <section className="mb-12">
      <h2 className="eyebrow mb-3">What&rsquo;s due</h2>

      {obligations.length === 0 ? (
        <p className="text-muted text-sm border-l-2 border-line pl-4 py-2">
          Nothing owed &mdash; no paychecks recorded yet. Payroll creates the deposits
          and returns below as soon as the first one is.
        </p>
      ) : (
        <>
          {behind.length > 0 && (
            <p role="alert" className="text-danger border-l-2 border-danger pl-4 py-2 mb-4 text-sm">
              {behind.length === 1 ? '1 item is' : `${behind.length} items are`} past due
              {behindCents > 0 && <> &mdash; {formatUSD(behindCents)} outstanding</>}.
            </p>
          )}

          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-line">
                  <th className="eyebrow pb-2 pr-3 text-left font-semibold">Obligation</th>
                  <th className="eyebrow pb-2 px-3 text-left font-semibold">Due</th>
                  <th className="eyebrow pb-2 px-3 text-right font-semibold">Amount</th>
                  <th className="eyebrow pb-2 px-3 text-right font-semibold">Paid</th>
                  <th className="eyebrow pb-2 px-3 text-left font-semibold">Status</th>
                  <th className="pb-2" />
                </tr>
              </thead>
              <tbody>
                {obligations.map((o) => {
                  const key = keyOf(o)
                  return (
                    <tr key={key} className="border-b border-line align-top">
                      <td className="py-2.5 pr-3">{o.label}</td>
                      <td className="tabular px-3 py-2.5">{formatDateShort(o.dueOn)}</td>
                      <td className="tabular px-3 py-2.5 text-right">
                        {o.kind === 'filing' ? <span className="text-muted">&mdash;</span> : formatUSD(o.amountDueCents)}
                      </td>
                      <td className="tabular px-3 py-2.5 text-right">
                        {o.amountPaidCents > 0 ? formatUSD(o.amountPaidCents) : <span className="text-muted">&mdash;</span>}
                      </td>
                      <td className={`px-3 py-2.5 ${STATUS_CLASS[o.status]}`}>{STATUS_LABEL(o)}</td>
                      <td className="px-3 py-2.5 text-right">
                        {openKey === key ? (
                          <div className="flex flex-col gap-2 items-end min-w-56">
                            {o.kind === 'payment' && (
                              <input
                                type="text" inputMode="decimal" className={FIELD_FULL}
                                aria-label="Amount paid" placeholder="0.00"
                                value={amount} onChange={(e) => setAmount(e.target.value)}
                              />
                            )}
                            <input
                              type="date" className={FIELD_FULL} aria-label="Date paid"
                              value={paidOn} onChange={(e) => setPaidOn(e.target.value)}
                            />
                            <input
                              type="text" className={FIELD_FULL} aria-label="Confirmation number"
                              placeholder="Confirmation (optional)"
                              value={confirmation} onChange={(e) => setConfirmation(e.target.value)}
                            />
                            {error !== null && (
                              <p role="alert" className="text-danger text-xs text-left w-full">{error}</p>
                            )}
                            <div className="flex gap-2">
                              <button
                                type="button" disabled={pending} onClick={() => save(o)}
                                className="px-4 py-2 bg-accent-surface text-accent-ink font-bold uppercase tracking-wider text-xs rounded-field hover:opacity-90 transition-opacity disabled:opacity-50"
                              >
                                {pending ? 'Saving…' : 'Save'}
                              </button>
                              <button
                                type="button" disabled={pending} onClick={() => setOpenKey(null)}
                                className="px-4 py-2 border border-line text-muted hover:text-ink font-bold uppercase tracking-wider text-xs rounded-field transition-colors disabled:opacity-50"
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          <button
                            type="button" onClick={() => open(o)}
                            className="rounded-pill px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-muted hover:text-ink transition-colors"
                          >
                            {o.kind === 'filing' ? 'Mark filed' : 'Record'}
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {outstanding.length === 0 && (
            <p className="text-good text-sm mt-4">Everything on file is paid and filed.</p>
          )}
        </>
      )}
    </section>
  )
}
