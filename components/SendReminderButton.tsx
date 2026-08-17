'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { formatDateShort } from '@/lib/dates'
import { buildReminderDefaults } from '@/lib/reminderEmailBody'
import { parseRecipients } from '@/lib/invoiceRecipients'
import { sendClientReminder } from '@/app/invoices/actions'

// Chasing a client is a manual, editable nudge. The button opens a form —
// recipients (several allowed), subject and body — prefilled from the current
// reminder wording and the client's billing email. The read-only link is
// appended by the server at send, so it is not part of the editable body.
// A second send is never blocked; the date of the last one is shown instead.

export default function SendReminderButton({
  invoiceId, to, lastSentDate, number, totalCents, dueDate, legalName,
}: {
  invoiceId: string
  /** The client's billing email, trimmed, or null. Prefills the To field. */
  to: string | null
  /** YYYY-MM-DD of the most recent client reminder, or null. */
  lastSentDate: string | null
  number: number
  totalCents: number
  dueDate: string
  legalName: string
}) {
  const router = useRouter()
  const defaults = buildReminderDefaults({
    number, total_cents: totalCents, due_date: dueDate, legalName,
  })

  const [open, setOpen] = useState(false)
  const [toField, setToField] = useState(to ?? '')
  const [subject, setSubject] = useState(defaults.subject)
  const [body, setBody] = useState(defaults.body)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)
  const [pending, start] = useTransition()

  const { emails, invalid } = parseRecipients(toField)
  const canSend = emails.length > 0 && subject.trim().length > 0 && invalid.length === 0

  function send() {
    setError(null)
    start(async () => {
      try {
        const result = await sendClientReminder(invoiceId, { to: toField, subject, body })
        if ('error' in result) { setError(result.error); return }
        setSent(true)
        setOpen(false)
        router.refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : 'The reminder could not be sent.')
      }
    })
  }

  if (!open) {
    return (
      <div className="flex items-center gap-3">
        {error && <span role="alert" className="text-xs text-danger">{error}</span>}
        {sent && !error && <span className="text-xs text-good">Reminder sent</span>}
        <button type="button" onClick={() => { setOpen(true); setSent(false) }}
                className="text-xs font-semibold uppercase tracking-wider text-muted
                           hover:text-ink transition-colors disabled:opacity-50">
          {lastSentDate ? `Send reminder · last ${formatDateShort(lastSentDate)}` : 'Send reminder'}
        </button>
      </div>
    )
  }

  const fieldClass =
    'w-full px-3 py-2 bg-bg border border-line rounded-field text-ink text-sm ' +
    'focus:border-accent focus:outline-none'

  return (
    <div className="w-full mt-4 border border-line rounded-card p-4 bg-surface text-left">
      <p className="eyebrow mb-3">Send a reminder</p>

      <label className="eyebrow block mb-2" htmlFor="reminder-to">To</label>
      <input id="reminder-to" type="text" value={toField} onChange={(e) => setToField(e.target.value)}
             placeholder="name@example.com, second@example.com"
             className={`${fieldClass} mb-1`} />
      <p className="text-xs text-muted mb-4">
        Separate several addresses with commas.
        {invalid.length > 0 && (
          <span className="text-danger"> Not a valid email: {invalid.join(', ')}.</span>
        )}
      </p>

      <label className="eyebrow block mb-2" htmlFor="reminder-subject">Subject</label>
      <input id="reminder-subject" type="text" value={subject} onChange={(e) => setSubject(e.target.value)}
             className={`${fieldClass} mb-4`} />

      <label className="eyebrow block mb-2" htmlFor="reminder-body">Message</label>
      <textarea id="reminder-body" rows={8} value={body} onChange={(e) => setBody(e.target.value)}
                className={`${fieldClass} mb-2`} />

      <p className="text-xs text-muted mb-4">
        A link to a read-only copy is added automatically at the end.
      </p>

      {error && (
        <p role="alert" className="mb-3 text-sm text-danger border-l-2 border-danger pl-3 py-1">
          {error}
        </p>
      )}

      <div className="flex items-center gap-3">
        <button type="button" onClick={send} disabled={pending || !canSend}
                className="px-5 py-2.5 bg-accent-surface text-accent-ink font-bold uppercase tracking-wider
                           text-sm rounded-field cursor-pointer hover:opacity-90 transition-opacity
                           disabled:opacity-50 disabled:cursor-not-allowed">
          {pending ? 'Sending…' : emails.length > 1 ? `Send to ${emails.length} recipients` : 'Send reminder'}
        </button>
        <button type="button" onClick={() => setOpen(false)} disabled={pending}
                className="px-5 py-2.5 border border-line text-muted font-bold uppercase tracking-wider
                           text-sm rounded-field cursor-pointer hover:text-ink transition-colors">
          Cancel
        </button>
      </div>
    </div>
  )
}
