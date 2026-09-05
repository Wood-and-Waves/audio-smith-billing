'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { buildInvoiceEmailDefaults } from '@/lib/invoiceEmailBody'
import { parseRecipients } from '@/lib/invoiceRecipients'
import { sendInvoice } from '@/app/invoices/actions'
import { buildInvoicePdfBlob } from '@/components/DownloadInvoiceButton'
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
  invoiceId, data, to, status, hasW9 = false,
}: {
  invoiceId: string
  data: DocumentData
  /** The client's billing email, trimmed, or null. Prefills the To field. */
  to: string | null
  status: 'draft' | 'sent' | 'paid' | 'void'
  /**
   * Whether a W-9 is on file (settings.w9_path). Only the FACT is passed —
   * never the path, and never the file — because this is a client component
   * and everything it receives ships to the browser. The checkbox is hidden
   * entirely when false: an unusable control invites the question "why can't
   * I tick this?", which the Settings link answers instead.
   */
  hasW9?: boolean
}) {
  const router = useRouter()
  const defaults = buildInvoiceEmailDefaults({ invoice: data, status })

  const [open, setOpen] = useState(false)
  const [toField, setToField] = useState(to ?? '')
  const [subject, setSubject] = useState(defaults.subject)
  const [body, setBody] = useState(defaults.body)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)
  // A send that succeeded but could not file its Dropbox copy — shown beside
  // "Sent" so a quiet archive failure is never silent.
  const [warning, setWarning] = useState<string | null>(null)
  const [pending, start] = useTransition()

  const { emails, invalid } = parseRecipients(toField)
  const canSend = emails.length > 0 && subject.trim().length > 0 && invalid.length === 0

  const [previewBusy, setPreviewBusy] = useState(false)
  // Unchecked by default, every time. A W-9 carries an EIN and a signature, so
  // attaching one is always a deliberate act — never a setting that quietly
  // stays on from the last send to a different client.
  const [attachW9, setAttachW9] = useState(false)
  const receiptCount = data.backup?.expenses.filter((e) => e.receiptDataUri).length ?? 0
  const attachedParts = [
    'the invoice',
    ...(data.backup?.show_hours ? ['hours sheet'] : []),
    ...(receiptCount > 0 ? [`${receiptCount} receipt${receiptCount === 1 ? '' : 's'}`] : []),
    // Listed here too, so the one line Dan reads before sending names
    // everything the client will actually receive.
    ...(attachW9 ? ['your W-9'] : []),
  ]

  /** Opens the EXACT attachment in a new tab — same builder as the send. */
  async function viewAttachment() {
    setError(null)
    // The window opens synchronously, inside the click — Safari refuses a
    // window.open that arrives after an async gap, which is exactly where
    // the 2MB-renderer import puts us.
    const w = window.open('', '_blank')
    if (!w) {
      setError('The preview window was blocked — allow pop-ups for this site.')
      return
    }
    setPreviewBusy(true)
    try {
      const blob = await buildInvoicePdfBlob(data)
      const url = URL.createObjectURL(blob)
      w.location.href = url
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
    } catch (e) {
      w.close()
      setError(e instanceof Error ? e.message : 'Could not build the PDF.')
    } finally {
      setPreviewBusy(false)
    }
  }

  function send() {
    setError(null)
    start(async () => {
      // sendInvoice's contract is to return { error }, never throw — but
      // nothing enforces that at the type level, and a throw here would reject
      // the transition and hand it to the nearest error boundary, replacing
      // this whole page and losing sent/error state. Belt and braces.
      try {
        const result = await sendInvoice(invoiceId, { to: toField, subject, body, attachW9 })
        if ('error' in result) { setError(result.error); return }
        setWarning(result.warning ?? null)
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
        {sent && !warning && <span className="text-xs text-good">Sent</span>}
        {sent && warning && <span role="alert" className="text-xs text-danger">{warning}</span>}
        {error && <span role="alert" className="text-xs text-danger">{error}</span>}
        <button type="button" onClick={() => { setOpen(true); setSent(false); setWarning(null) }}
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

      {/* The final check. The PDF named here is built by the same code that
          builds the attachment, so viewing it IS viewing what the client
          gets — hours, receipts, everything. */}
      {hasW9 && (
        <label className="flex items-center gap-2 text-xs text-muted mb-3">
          <input
            type="checkbox" checked={attachW9} disabled={pending}
            onChange={(e) => setAttachW9(e.target.checked)}
          />
          Attach my W-9
        </label>
      )}

      <p className="text-xs text-muted mb-4 flex flex-wrap items-baseline gap-x-2">
        <span>Attached: {attachedParts.join(' · ')}.</span>
        <button
          type="button"
          onClick={() => void viewAttachment()}
          disabled={previewBusy || pending}
          className="font-semibold uppercase tracking-wider text-accent hover:opacity-80
                     disabled:opacity-50"
        >
          {previewBusy ? 'Building…' : 'View PDF'}
        </button>
        <span>A link to a read-only copy is added at the end.</span>
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
