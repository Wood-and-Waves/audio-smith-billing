'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { setInvoiceStatus } from '@/app/invoices/actions'

/**
 * The only status control in the app. draft → sent happens on send, but until
 * this button nothing moved an invoice to paid — so an invoice, once emailed,
 * stayed "sent" forever and reminders never stopped.
 *
 * A void invoice shows no control: voiding is a separate decision this button
 * does not own. Unmarking returns the invoice to where it was — 'sent' if it
 * was ever emailed, otherwise 'draft' — so an invoice paid straight from a
 * draft (cash in hand before it was ever sent) does not acquire a send it never
 * had. Marking paid is reversible, so there is no confirm step.
 */
export default function MarkPaidButton({
  invoiceId, status, wasSent,
}: {
  invoiceId: string
  status: 'draft' | 'sent' | 'paid' | 'void'
  wasSent: boolean
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)

  if (status === 'void') return null

  const paid = status === 'paid'
  const target: 'draft' | 'sent' | 'paid' = paid ? (wasSent ? 'sent' : 'draft') : 'paid'

  function go() {
    setError(null)
    start(async () => {
      const result = await setInvoiceStatus(invoiceId, target)
      if ('error' in result) { setError(result.error); return }
      router.refresh()
    })
  }

  return (
    <span className="inline-flex items-center gap-2">
      {error && <span role="alert" className="text-xs text-danger">{error}</span>}
      <button
        type="button"
        onClick={go}
        disabled={pending}
        className={paid
          ? 'text-xs font-semibold uppercase tracking-wider text-muted hover:text-ink transition-colors'
          : 'text-xs font-semibold uppercase tracking-wider text-accent hover:opacity-80'}
      >
        {pending ? 'Saving…' : paid ? 'Mark as unpaid' : 'Mark as paid'}
      </button>
    </span>
  )
}
