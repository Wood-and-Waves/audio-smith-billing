'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { setDayTravelWorks } from '@/app/shows/actions'

/**
 * Forecast-only. A travel day Dan also works bills both in reality — the
 * travel legs bill outside the punch gate, the day rate bills once punches
 * exist — so this toggle exists purely to tell the projection before any
 * punches exist, not to change what billing itself does.
 */
export default function TravelWorksToggle({
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
      const result = await setDayTravelWorks(showDayId, value)
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
        Also working
      </label>
      {error && <span role="alert" className="ml-2 text-xs text-danger">{error}</span>}
    </span>
  )
}
