'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { generateCalendarToken } from '@/app/calendar/actions'
import { FIELD_FULL } from '@/components/ui/field'

/**
 * No token yet -> one Generate button. With a token AND a usable URL, the
 * URL plus Copy and Regenerate. Regenerating is the entire revocation story
 * for the old link (generateCalendarToken just overwrites the column, same
 * as invoices' public_token) — the one line of copy below says so plainly,
 * because there is no undo once the old URL stops working.
 *
 * A token can exist with no usable URL — APP_URL unset in this environment —
 * and that is a different state from no token at all: showing the Generate
 * button there would read as "you have no feed yet," which is false and
 * would prompt a needless regenerate. `hasToken` (defaulted from feedUrl for
 * any other caller) distinguishes the two; with a token but no URL this
 * renders Regenerate only, with a muted dash standing in for the missing link.
 */
export default function CalendarSubscribe({
  feedUrl,
  hasToken = feedUrl !== null,
}: {
  feedUrl: string | null
  hasToken?: boolean
}) {
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

  if (!hasToken) {
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
        {feedUrl ? (
          <input
            readOnly value={feedUrl} onFocus={(e) => e.target.select()}
            className={`${FIELD_FULL} max-w-xs`}
          />
        ) : (
          <span className="text-xs text-muted" aria-label="Feed link unavailable">—</span>
        )}
        <button
          type="button" onClick={copy} disabled={!feedUrl}
          className="px-3 py-2 text-xs font-semibold uppercase tracking-wider
                     rounded-field border border-line text-muted hover:text-ink disabled:opacity-40"
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
