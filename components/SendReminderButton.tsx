'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { formatDateShort } from '@/lib/dates'
import { sendClientReminder } from '@/app/invoices/actions'

// Chasing a client twice is legitimate, so a second send is never blocked.
// The date of the last one is shown instead — informative, never in the way.

export default function SendReminderButton({
  invoiceId, to, lastSentDate,
}: {
  invoiceId: string
  to: string | null
  /** YYYY-MM-DD of the most recent client reminder, or null. */
  lastSentDate: string | null
}) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)
  const [pending, start] = useTransition()

  if (!to) return null

  function send() {
    setError(null)
    start(async () => {
      try {
        const result = await sendClientReminder(invoiceId)
        if ('error' in result) { setError(result.error); return }
        setSent(true)
        router.refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : 'The reminder could not be sent.')
      }
    })
  }

  return (
    <div className="flex items-center gap-3">
      {error && <span role="alert" className="text-xs text-danger">{error}</span>}
      {sent && !error && <span className="text-xs text-good">Reminder sent</span>}
      <button type="button" onClick={send} disabled={pending}
              className="text-xs font-semibold uppercase tracking-wider text-muted
                         hover:text-ink transition-colors disabled:opacity-50
                         disabled:cursor-not-allowed">
        {pending
          ? 'Sending…'
          : lastSentDate
            ? `Send reminder · last ${formatDateShort(lastSentDate)}`
            : 'Send reminder'}
      </button>
    </div>
  )
}
