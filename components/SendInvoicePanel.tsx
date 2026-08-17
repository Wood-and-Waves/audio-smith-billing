'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { buildInvoiceEmailDefaults } from '@/lib/invoiceEmailBody'
import { parseRecipients } from '@/lib/invoiceRecipients'
import { sendInvoice } from '@/app/invoices/actions'
import type { DocumentData } from '@/components/InvoiceDocument'

// Sending is irreversible, so nothing goes until Dan has seen and can edit the
// recipients, the subject and the body. This panel is the only place a wrong
// address can be caught before it leaves.
//
// The three fields prefill from buildInvoiceEmailDefaults (pure, no network,
// no key) and the client's billing email; Dan edits any of them. The public
// link and the PDF are NOT shown here as editable text — the server mints the
// link's token at send and appends it, so it can never be edited away. What
// Dan types is exactly what is sent, above that appended footer.
//
// parseRecipients here is live feedback only; the server action re-parses the
// To field and is the authoritative gate.

export default function SendInvoicePanel({
  invoiceId, data, to, status,
}: {
  invoiceId: string
  data: DocumentData
  /** The client's billing email, trimmed, or null. Prefills the To field. */
  to: string | null
  status: 'draft' | 'sent' | 'paid' | 'void'
}) {
  const router = useRouter()
  const defaults = buildInvoiceEmailDefaults({ invoice: data, status })

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
      // sendInvoice's contract is to return { error }, never throw — but
      // nothing enforces that at the type level, and a throw here would reject
      // the transition and hand it to the nearest error boundary, replacing
      // this whole page and losing sent/error state. Belt and braces.
      try {
        const result = await sendInvoice(invoiceId, { to: toField, subject, body })
        if ('error' in result) { setError(result.error); return }
        setSent(true)
        setOpen(false)
        router.refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : 'The invoice could not be sent.')
      }
    })
  }

  if (!open) {
    return (
      <div className="flex items-center gap-3">
        {sent && <span className="text-xs text-good">Sent</span>}
        {error && <span role="alert" className="text-xs text-danger">{error}</span>}
        <button type="button" onClick={() => { setOpen(true); setSent(false) }}
                className="text-xs font-semibold uppercase tracking-wider text-accent hover:opacity-80">
          Email invoice
        </button>
      </div>
    )
  }

  const fieldClass =
    'w-full px-3 py-2 bg-bg border border-line rounded-field text-ink text-sm ' +
    'focus:border-accent focus:outline-none'

  return (
    <div className="w-full mt-4 border border-line rounded-card p-4 bg-surface">
      <p className="eyebrow mb-3">Send this invoice</p>

      <label className="eyebrow block mb-2" htmlFor="to">To</label>
      <input id="to" type="text" value={toField} onChange={(e) => setToField(e.target.value)}
             placeholder="name@example.com, second@example.com"
             className={`${fieldClass} mb-1`} />
      <p className="text-xs text-muted mb-4">
        Separate several addresses with commas.
        {invalid.length > 0 && (
          <span className="text-danger"> Not a valid email: {invalid.join(', ')}.</span>
        )}
      </p>

      <label className="eyebrow block mb-2" htmlFor="subject">Subject</label>
      <input id="subject" type="text" value={subject} onChange={(e) => setSubject(e.target.value)}
             className={`${fieldClass} mb-4`} />

      <label className="eyebrow block mb-2" htmlFor="body">Message</label>
      <textarea id="body" rows={10} value={body} onChange={(e) => setBody(e.target.value)}
                className={`${fieldClass} mb-2`} />

      <p className="text-xs text-muted mb-4">
        A link to a read-only copy and the PDF are added automatically at the end,
        so you don&rsquo;t need to include them.
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
          {pending ? 'Sending…' : emails.length > 1 ? `Send to ${emails.length} recipients` : 'Send'}
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
