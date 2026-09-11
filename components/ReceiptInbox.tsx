'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { formatUSD } from '@/lib/money'
import { formatDateShort } from '@/lib/dates'
import type { ReceiptMatch } from '@/lib/receiptMatch'
import {
  syncReceiptInbox, fileReceiptToTransaction, dismissReceipt,
} from '@/app/money/receipts/actions'

export type InboxItem = {
  id: string
  subject: string
  fromEmail: string
  receivedAt: string | null
  vendor: string | null
  amountCents: number | null
  spentOn: string | null
  /** The date matching actually used — the arrival date when the document had none. */
  matchDate: string | null
  /** True when matchDate is the arrival date rather than one read off the receipt. */
  dateInferred: boolean
  attachments: { filename: string; mimeType: string; path: string; size: number
    /** Signed on the server. Null when the file is missing from storage. */
    url: string | null }[]
  primaryPath: string | null
  matches: ReceiptMatch[]
}

/**
 * Receipts forwarded from Gmail, waiting to be filed.
 *
 * Nothing files itself. Each item shows what extraction read and the bank rows
 * that could be it, and Dan picks — the same judgement the Matches queue makes
 * about invoices and expenses, for the same reason: an exact amount within ten
 * days is strong evidence and not a decision.
 *
 * An item with no amount still appears, with its matches empty. Extraction
 * failing is not a reason to hide a receipt he can still file by hand, and
 * hiding it would leave him wondering where the mail went. The same is true of
 * a whole EXPENSE BUNDLE — one email holding a dozen receipts has no single
 * amount to match on, which is a shape rather than a failure.
 */
export default function ReceiptInbox({ items }: { items: InboxItem[] }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  function sync() {
    setError(null); setNotice(null)
    start(async () => {
      const r = await syncReceiptInbox()
      if ('error' in r) { setError(r.error); return }
      setNotice(
        r.added === 0
          ? 'Nothing new in the label.'
          : `${r.added} receipt${r.added === 1 ? '' : 's'} added.`
        + (r.failed > 0 ? ` ${r.failed} could not be read — they stay in the label and will be retried.` : ''),
      )
      router.refresh()
    })
  }

  function file(itemId: string, txnId: string) {
    setError(null); setNotice(null)
    start(async () => {
      const r = await fileReceiptToTransaction(itemId, txnId)
      if ('error' in r) { setError(r.error); return }
      router.refresh()
    })
  }

  function dismiss(itemId: string) {
    setError(null); setNotice(null)
    start(async () => {
      const r = await dismissReceipt(itemId)
      if ('error' in r) { setError(r.error); return }
      router.refresh()
    })
  }

  return (
    <section>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <p className="text-sm text-muted">
          {items.length === 0
            ? 'Nothing waiting.'
            : `${items.length} waiting`}
        </p>
        <button
          type="button" onClick={sync} disabled={pending}
          className="px-3 py-1.5 text-xs font-bold uppercase tracking-wider rounded-field
                     bg-accent-surface text-accent-ink disabled:opacity-50"
        >
          {pending ? 'Checking…' : 'Check Gmail'}
        </button>
      </div>

      {error && (
        <p role="alert" className="mb-4 text-sm text-danger border-l-2 border-danger pl-3 py-1">{error}</p>
      )}
      {notice && <p className="mb-4 text-sm text-good border-l-2 border-line pl-3 py-1">{notice}</p>}

      {items.length === 0 ? (
        <p className="text-muted border-l-2 border-line pl-4 py-2">
          Label a receipt <span className="text-ink font-semibold">audiosmith_receipts</span> in
          Gmail, then check again.
        </p>
      ) : (
        <ul className="border-t border-line">
          {items.map((item) => (
            <li key={item.id} className="border-b border-line py-4">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <span className="font-semibold min-w-0 truncate">
                  {item.vendor ?? item.subject ?? '(no subject)'}
                </span>
                <span className="tabular font-semibold shrink-0">
                  {item.amountCents !== null ? formatUSD(item.amountCents) : '—'}
                </span>
              </div>
              <p className="mt-1 text-xs text-muted truncate">
                {/* An inferred date SAYS so. It is the day the email arrived,
                    used because the document carried none — weaker evidence
                    than a date read off a receipt, and Dan is the one deciding
                    whether the match below is really his purchase. */}
                {item.spentOn
                  ? formatDateShort(item.spentOn)
                  : item.matchDate !== null
                    ? <>{formatDateShort(item.matchDate)}{' '}<span className="italic">(from the email)</span></>
                    : 'no date read'}
                {/* The subject IS the heading when nothing read a vendor, so
                    repeating it here just prints the same line twice. */}
                {item.vendor !== null && <>{' · '}{item.subject}</>}
              </p>

              {item.attachments.length > 0 && (
                <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                  {item.attachments.map((a) => (
                    a.url === null ? (
                      <span key={a.path} className="text-muted line-through" title="Missing from storage">
                        {a.filename}
                      </span>
                    ) : (
                      <a
                        key={a.path} href={a.url} target="_blank" rel="noopener noreferrer"
                        className={`underline hover:opacity-80 ${
                          a.path === item.primaryPath ? 'text-accent font-semibold' : 'text-muted'
                        }`}
                      >
                        {a.filename}
                      </a>
                    )
                  ))}
                </p>
              )}

              <div className="mt-3">
                {item.matches.length === 0 ? (
                  <p className="text-xs text-muted">
                    {item.amountCents === null
                      ? 'No single amount to match on — open the document above and file it from the register.'
                      : 'No matching charge in the last 180 days.'}
                  </p>
                ) : (
                  <ul className="flex flex-col gap-1">
                    {item.matches.map((m) => (
                      <li key={m.txnId}>
                        <button
                          type="button" disabled={pending} onClick={() => file(item.id, m.txnId)}
                          className="w-full flex items-baseline justify-between gap-3 rounded-field
                                     px-2 py-1.5 text-left text-sm hover:bg-surface-2
                                     disabled:opacity-40"
                        >
                          <span className="truncate">
                            {formatDateShort(m.date)} · {m.payee || '—'}
                            {m.alreadyHasReceipt && (
                              <span className="text-muted"> · already has one</span>
                            )}
                          </span>
                          <span className="tabular shrink-0">{formatUSD(-m.amountCents)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <button
                type="button" disabled={pending} onClick={() => dismiss(item.id)}
                className="mt-2 text-xs font-semibold uppercase tracking-wider text-muted
                           hover:text-ink disabled:opacity-40"
              >
                Dismiss
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
