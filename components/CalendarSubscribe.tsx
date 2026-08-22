'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { generateCalendarToken } from '@/app/calendar/actions'
import { FIELD_FULL } from '@/components/ui/field'

/**
 * No token yet -> one Generate button. With a token, the URL plus Copy and
 * Regenerate. Regenerating is the entire revocation story for the old link
 * (generateCalendarToken just overwrites the column, same as invoices'
 * public_token) — the one line of copy below says so plainly, because
 * there is no undo once the old URL stops working.
 */
export default function CalendarSubscribe({ feedUrl }: { feedUrl: string | null }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  function generate() {
    setError(null)
    start(async () => {
      const result = await generateCalendarToken()
      if ('error' in result) { setError(result.error); return }
      router.refresh()
    })
  }

  async function copy() {
    if (!feedUrl) return
    try {
      await navigator.clipboard.writeText(feedUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setError('Could not copy — select and copy the link by hand.')
    }
  }

  if (!feedUrl) {
    return (
      <div>
        <button
          type="button" onClick={generate} disabled={pending}
          className="px-4 py-2.5 text-xs font-semibold uppercase tracking-wider
                     rounded-field border border-line text-muted hover:text-ink disabled:opacity-40"
        >
          {pending ? 'Generating…' : 'Generate feed link'}
        </button>
        {error && <p role="alert" className="mt-1 text-xs text-danger">{error}</p>}
      </div>
    )
  }

  return (
    <div>
      <div className="flex items-center gap-2">
        <input
          readOnly value={feedUrl} onFocus={(e) => e.target.select()}
          className={`${FIELD_FULL} max-w-xs`}
        />
        <button
          type="button" onClick={copy}
          className="px-3 py-2 text-xs font-semibold uppercase tracking-wider
                     rounded-field border border-line text-muted hover:text-ink"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button
          type="button" onClick={generate} disabled={pending}
          className="px-3 py-2 text-xs font-semibold uppercase tracking-wider
                     rounded-field border border-line text-muted hover:text-ink disabled:opacity-40"
        >
          {pending ? 'Regenerating…' : 'Regenerate'}
        </button>
      </div>
      <p className="mt-1 text-xs text-muted">Regenerating kills the old link.</p>
      {error && <p role="alert" className="mt-1 text-xs text-danger">{error}</p>}
    </div>
  )
}
