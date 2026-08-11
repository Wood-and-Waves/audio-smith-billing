'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { setDayHalfDay } from '@/app/shows/actions'

/**
 * The half-day flag is a negotiated call, not a computed one: the page only
 * renders this control when the day's net hours are under 5 (see
 * app/shows/[id]/page.tsx), but a day that already HAS the flag set always
 * shows the control regardless of hours, so growing past 5 hours later can't
 * leave an invisible, unclearable half-day on the invoice.
 */
export default function HalfDayToggle({
  showDayId, checked, locked,
}: {
  showDayId: string
  checked: boolean
  locked: boolean
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)

  function toggle(value: boolean) {
    setError(null)
    start(async () => {
      const result = await setDayHalfDay(showDayId, value)
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
          disabled={locked || pending}
          onChange={(e) => toggle(e.target.checked)}
        />
        Half day
      </label>
      {error && <span role="alert" className="ml-2 text-xs text-danger">{error}</span>}
    </span>
  )
}
