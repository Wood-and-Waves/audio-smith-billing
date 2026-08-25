'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { formatUSD } from '@/lib/money'
import { autoAssignUnderfunded } from '@/app/money/budget/actions'

/** One tap funds every underfunded target this month (design doc:
 *  2026-08-25-auto-assign-design.md) — no confirm dialog, because a batch
 *  Undo is the safety. The figure is display only; the server recomputes
 *  its own plan. wrote:false = a stale button (someone already funded the
 *  month) — the refresh that follows makes the button disappear. */
export default function AutoAssignButton({
  month, underfundedCents,
}: { month: string; underfundedCents: number }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)

  function run() {
    setError(null)
    start(async () => {
      const result = await autoAssignUnderfunded(month)
      if (!result.ok) { setError(result.error); return }
      router.refresh()
    })
  }

  return (
    <div className="mt-3">
      <button
        type="button" onClick={run} disabled={pending}
        className="w-full rounded-field border border-line px-3 py-2 text-xs font-semibold
                   uppercase tracking-wider text-muted hover:text-ink transition-colors
                   disabled:opacity-40"
      >
        {pending ? 'Assigning…' : `Auto-assign ${formatUSD(underfundedCents)}`}
      </button>
      {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
    </div>
  )
}
