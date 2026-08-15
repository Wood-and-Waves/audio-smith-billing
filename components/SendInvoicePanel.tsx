'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { buildInvoiceEmail } from '@/lib/invoiceEmailBody'
import { sendInvoice } from '@/app/invoices/actions'
import type { DocumentData } from '@/components/InvoiceDocument'

// Sending is irreversible, so nothing goes until Dan has seen the actual
// recipient, subject and body. This panel is the only place a wrong address can
// be caught.
//
// buildInvoiceEmail is imported for the PREVIEW only — it is a pure function
// with no key and no network. The send itself happens in the server action.
//
// Honesty about that guarantee: `to`, `data` and `status` are all page-load
// state, passed down as props from app/invoices/[id]/page.tsx. The server
// action re-reads the invoice, the client and settings fresh at send time. If
// someone edits the client's billing email, the invoice, or Settings in
// another tab between opening this panel and pressing Send, the preview here
// and the email that actually goes out can differ. That window is not
// synchronised — doing so would mean re-fetching on every keystroke in the
// note field for a case that in practice means re-opening the invoice.
//
// That caveat used to live only in this comment, where nobody pressing Send
// could read it: the panel presented the preview as the email. It is now said
// in the UI as well (see the note under the body below), because a preview
// that can quietly be wrong is only safe if the person trusting it knows it
// can be.

export default function SendInvoicePanel({
  invoiceId, data, to, status, publicUrlBase,
}: {
  invoiceId: string
  data: DocumentData
  to: string | null
  status: 'draft' | 'sent' | 'paid' | 'void'
  publicUrlBase: string
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)
  const [pending, start] = useTransition()

  if (!to) {
    return (
      <span className="text-xs text-muted">
        No billing email for this client — add one to send.
      </span>
    )
  }

  // The token is minted by the server on first send, so the preview shows the
  // shape of the link rather than the link itself. Deliberate: inventing a
  // token here would either be wrong or would have to be persisted before Dan
  // has agreed to send anything.
  const preview = buildInvoiceEmail({
    to,
    invoice: data,
    status,
    publicUrl: `${publicUrlBase}/i/[link generated when you send]`,
    note,
    replyTo: data.settings?.email ?? 'dan@theaudiosmith.com',
  })

  function send() {
    setError(null)
    start(async () => {
      // sendInvoice's own contract is to return { error }, never throw — but
      // nothing enforces that at the type level, and a throw here would
      // reject the transition and hand it to the nearest error boundary,
      // replacing this whole page and losing sent/error state. Belt and
      // braces.
      try {
        const result = await sendInvoice(invoiceId, note)
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

  return (
    <div className="w-full mt-4 border border-line rounded-card p-4 bg-surface">
      <p className="eyebrow mb-3">Send this invoice</p>

      <dl className="text-sm mb-4">
        <div className="flex gap-3 py-1">
          <dt className="text-muted w-20 shrink-0">To</dt>
          <dd className="tabular">{to}</dd>
        </div>
        <div className="flex gap-3 py-1">
          <dt className="text-muted w-20 shrink-0">Subject</dt>
          <dd>{preview.subject}</dd>
        </div>
      </dl>

      <label className="eyebrow block mb-2" htmlFor="note">Add a message (optional)</label>
      <textarea id="note" rows={3} value={note} onChange={(e) => setNote(e.target.value)}
                placeholder="e.g. Invoice for the last two visits."
                className="w-full px-3 py-2 bg-bg border border-line rounded-field text-ink text-sm
                           focus:border-accent focus:outline-none mb-4" />

      <p className="eyebrow mb-2">They will receive</p>
      <pre className="text-xs text-muted whitespace-pre-wrap border-l-2 border-line pl-3 mb-4">
        {preview.text}
      </pre>

      <p className="text-xs text-muted mb-4">
        The PDF is attached, and the link goes to a read-only copy they can open in a browser.
      </p>

      {/* The preview is built from what this page loaded; the send re-reads
          everything. Saying so is the whole fix — anyone who has just edited
          Settings or a billing email in another tab now knows to reload before
          trusting what is above. */}
      <p className="text-xs text-muted mb-4">
        This preview was built when the page loaded. Sending re-reads the invoice,
        the client and your business details, so if you&rsquo;ve changed any of them
        since, reload before you send.
      </p>

      {error && (
        <p role="alert" className="mb-3 text-sm text-danger border-l-2 border-danger pl-3 py-1">
          {error}
        </p>
      )}

      <div className="flex items-center gap-3">
        <button type="button" onClick={send} disabled={pending}
                className="px-5 py-2.5 bg-accent-surface text-accent-ink font-bold uppercase tracking-wider
                           text-sm rounded-field cursor-pointer hover:opacity-90 transition-opacity
                           disabled:opacity-50 disabled:cursor-not-allowed">
          {pending ? 'Sending…' : `Send to ${to}`}
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
