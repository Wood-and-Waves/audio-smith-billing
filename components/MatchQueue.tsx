'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { formatUSD } from '@/lib/money'
import { formatDateShort } from '@/lib/dates'
import { acceptIncomeMatch, acceptExpenseMatch, dismissMatch } from '@/app/money/actions'

export type IncomeCard = {
  txn: { id: string; date: string; amountCents: number; payee: string }
  invoices: { id: string; number: number; clientName: string; totalCents: number; status: 'sent' | 'paid' }[]
  confidence: 'high' | 'low'
}
export type ExpenseCard = {
  txns: { id: string; date: string; amountCents: number; payee: string }[]
  expense: { id: string; amountCents: number; spentOn: string; whereSpent: string; showName: string }
  confidence: 'high' | 'low'
}

// A card has no id of its own — income keys off its (single) bank row,
// expense off its (single) expense — so these give every card in the queue a
// stable key for both React and the per-card error/pending bookkeeping
// below.
const incomeKey = (card: IncomeCard) => `income:${card.txn.id}`
const expenseKey = (card: ExpenseCard) => `expense:${card.expense.id}`

/** "$33.25 + $7.00 = $40.25" — only for a card whose summed side has more
 *  than one row; a single-item card gets no evidence line because the target
 *  line already says the whole story. This IS the explanation the UI copy
 *  otherwise withholds, so it always uses formatUSD, never a bare number. */
function evidenceLine(partsCents: number[], totalCents: number): string | null {
  if (partsCents.length < 2) return null
  return `${partsCents.map(formatUSD).join(' + ')} = ${formatUSD(totalCents)}`
}

/** Accent Accept idiom, shared by the per-card and accept-all buttons. */
function AcceptButton({ onClick, disabled, children }: {
  onClick: () => void
  disabled: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="text-xs font-bold uppercase tracking-wider text-accent hover:opacity-80 disabled:opacity-40"
    >
      {children}
    </button>
  )
}

/** Muted underline Dismiss idiom. */
function DismissButton({ onClick, disabled }: { onClick: () => void; disabled: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="text-xs text-muted hover:text-ink underline disabled:opacity-40"
    >
      Dismiss
    </button>
  )
}

/**
 * The `/money/matches` review queue: every proposal lib/ledgerMatch.ts's
 * proposeMatches came up with, for Dan to Accept or Dismiss by hand — never
 * auto-applied, per that module's own doc comment. Two eyebrow sections,
 * "Deposits" (income) then "Charges" (expense), each rendered only when it
 * has cards; an "Accept all N confident" control appears above a section
 * only once it has 2+ high-confidence cards (one confident match alone isn't
 * worth a bulk control, and low-confidence cards are never bulk-acceptable —
 * proposeMatches itself never marks an ambiguous pair 'high'). The two
 * sections get separate accept-all controls rather than one combined button:
 * income and expense accepts are different server actions with different
 * shapes, so a single sequential loop over both would have to branch on
 * every iteration anyway.
 */
export default function MatchQueue({ income, expense }: { income: IncomeCard[]; expense: ExpenseCard[] }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [errors, setErrors] = useState<Record<string, string>>({})

  function setError(key: string, message: string | null) {
    setErrors((prev) => {
      if (message === null) {
        if (!(key in prev)) return prev
        const next = { ...prev }
        delete next[key]
        return next
      }
      return { ...prev, [key]: message }
    })
  }

  function acceptIncome(card: IncomeCard) {
    const key = incomeKey(card)
    setError(key, null)
    start(async () => {
      const result = await acceptIncomeMatch({
        transactionId: card.txn.id,
        invoiceIds: card.invoices.map((i) => i.id),
      })
      if ('error' in result) { setError(key, result.error); return }
      router.refresh()
    })
  }

  function dismissIncome(card: IncomeCard) {
    const key = incomeKey(card)
    setError(key, null)
    start(async () => {
      const result = await dismissMatch(card.invoices.map((i) => ({ transactionId: card.txn.id, invoiceId: i.id })))
      if ('error' in result) { setError(key, result.error); return }
      router.refresh()
    })
  }

  function acceptExpense(card: ExpenseCard) {
    const key = expenseKey(card)
    setError(key, null)
    start(async () => {
      const result = await acceptExpenseMatch({
        expenseId: card.expense.id,
        transactionIds: card.txns.map((t) => t.id),
      })
      if ('error' in result) { setError(key, result.error); return }
      router.refresh()
    })
  }

  function dismissExpense(card: ExpenseCard) {
    const key = expenseKey(card)
    setError(key, null)
    start(async () => {
      const result = await dismissMatch(card.txns.map((t) => ({ transactionId: t.id, expenseId: card.expense.id })))
      if ('error' in result) { setError(key, result.error); return }
      router.refresh()
    })
  }

  // Accept-all: one transition, cards accepted in order, stopping the moment
  // one fails — its error lands in that card's own error slot (the same one
  // a single Accept would use) so Dan can see exactly which card needs a
  // by-hand look, and every card before it in the list is already
  // committed (this is a loop of real awaits, not a batch that could
  // partially roll back).
  function acceptAllIncome(cards: IncomeCard[]) {
    start(async () => {
      for (const card of cards) {
        const result = await acceptIncomeMatch({
          transactionId: card.txn.id,
          invoiceIds: card.invoices.map((i) => i.id),
        })
        if ('error' in result) { setError(incomeKey(card), result.error); return }
      }
      router.refresh()
    })
  }

  function acceptAllExpense(cards: ExpenseCard[]) {
    start(async () => {
      for (const card of cards) {
        const result = await acceptExpenseMatch({
          expenseId: card.expense.id,
          transactionIds: card.txns.map((t) => t.id),
        })
        if ('error' in result) { setError(expenseKey(card), result.error); return }
      }
      router.refresh()
    })
  }

  if (income.length === 0 && expense.length === 0) {
    return <p className="text-sm text-muted">Nothing waiting.</p>
  }

  const highIncome = income.filter((c) => c.confidence === 'high')
  const highExpense = expense.filter((c) => c.confidence === 'high')

  return (
    <div className="flex flex-col gap-10">
      {income.length > 0 && (
        <section>
          <div className="flex items-center justify-between gap-4 mb-3">
            <h2 className="eyebrow">Deposits</h2>
            {highIncome.length >= 2 && (
              <AcceptButton disabled={pending} onClick={() => acceptAllIncome(highIncome)}>
                Accept all {highIncome.length} confident
              </AcceptButton>
            )}
          </div>
          <ul className="border-t border-line">
            {income.map((card) => {
              const key = incomeKey(card)
              const evidence = evidenceLine(card.invoices.map((i) => i.totalCents), card.txn.amountCents)
              return (
                <li key={key} className="border-b border-line py-4 pl-3 -ml-3 pr-3">
                  <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className="tabular text-xs text-muted">{formatDateShort(card.txn.date)}</span>
                        <span className="font-medium truncate">{card.txn.payee || '—'}</span>
                        <span className="tabular font-semibold">{formatUSD(card.txn.amountCents)}</span>
                      </div>
                      <div className="mt-1 flex flex-wrap items-baseline gap-x-2 text-sm text-muted">
                        <span aria-hidden="true">→</span>
                        <span className="truncate">
                          {card.invoices
                            .map((i) => `#${i.number} · ${i.clientName} · ${formatUSD(i.totalCents)}`)
                            .join(', ')}
                        </span>
                      </div>
                      {evidence && <p className="mt-1 text-xs text-muted">{evidence}</p>}
                      {errors[key] && <p role="alert" className="mt-1 text-xs text-danger">{errors[key]}</p>}
                    </div>
                    <div className="flex items-center gap-4 shrink-0">
                      <AcceptButton disabled={pending} onClick={() => acceptIncome(card)}>Accept</AcceptButton>
                      <DismissButton disabled={pending} onClick={() => dismissIncome(card)} />
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        </section>
      )}

      {expense.length > 0 && (
        <section>
          <div className="flex items-center justify-between gap-4 mb-3">
            <h2 className="eyebrow">Charges</h2>
            {highExpense.length >= 2 && (
              <AcceptButton disabled={pending} onClick={() => acceptAllExpense(highExpense)}>
                Accept all {highExpense.length} confident
              </AcceptButton>
            )}
          </div>
          <ul className="border-t border-line">
            {expense.map((card) => {
              const key = expenseKey(card)
              const evidence = evidenceLine(card.txns.map((t) => -t.amountCents), card.expense.amountCents)
              return (
                <li key={key} className="border-b border-line py-4 pl-3 -ml-3 pr-3">
                  <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        {card.txns.map((t, idx) => (
                          <span key={t.id} className="flex items-baseline gap-x-2">
                            {idx > 0 && <span className="text-muted" aria-hidden="true">,</span>}
                            <span className="tabular text-xs text-muted">{formatDateShort(t.date)}</span>
                            <span className="font-medium truncate">{t.payee || '—'}</span>
                            <span className="tabular font-semibold">{formatUSD(-t.amountCents)}</span>
                          </span>
                        ))}
                      </div>
                      <div className="mt-1 flex flex-wrap items-baseline gap-x-2 text-sm text-muted">
                        <span aria-hidden="true">→</span>
                        <span className="truncate">
                          {card.expense.whereSpent} · {card.expense.showName} · {formatDateShort(card.expense.spentOn)}
                        </span>
                      </div>
                      {evidence && <p className="mt-1 text-xs text-muted">{evidence}</p>}
                      {errors[key] && <p role="alert" className="mt-1 text-xs text-danger">{errors[key]}</p>}
                    </div>
                    <div className="flex items-center gap-4 shrink-0">
                      <AcceptButton disabled={pending} onClick={() => acceptExpense(card)}>Accept</AcceptButton>
                      <DismissButton disabled={pending} onClick={() => dismissExpense(card)} />
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        </section>
      )}
    </div>
  )
}
