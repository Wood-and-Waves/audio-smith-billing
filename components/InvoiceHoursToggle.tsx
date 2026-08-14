'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { setInvoiceHours } from '@/app/invoices/actions'

/**
 * The escape hatch for a frozen backup: billing an invoice and then learning
 * the client wanted an hours breakdown would otherwise be a dead end, since
 * `show_hours` is frozen into the snapshot at bill time. This flips only that
 * flag — the hours, clock times and expense itemisation inside the snapshot
 * never change, only whether the hours page prints.
 *
 * Rendered only when the invoice actually has a snapshot (see
 * app/invoices/[id]/page.tsx) — an invoice with none has nothing to toggle.
 */
export default function InvoiceHoursToggle({
  invoiceId, checked,
}: {
  invoiceId: string
  checked: boolean
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)

  function toggle(value: boolean) {
    setError(null)
    start(async () => {
      const result = await setInvoiceHours(invoiceId, value)
      if ('error' in result) { setError(result.error); return }
      router.refresh()
    })
  }

  return (
    <span>
      <label className="inline-flex items-center gap-1.5 text-xs text-muted">
        <input
          type="checkbox"
          className="h-3.5 w-3.5 accent-accent"
          checked={checked}
          disabled={pending}
          onChange={(e) => toggle(e.target.checked)}
        />
        Include the hours breakdown in the PDF
      </label>
      {error && <span role="alert" className="ml-2 text-xs text-danger">{error}</span>}
    </span>
  )
}
