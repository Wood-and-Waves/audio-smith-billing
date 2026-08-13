'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { setTravelLeg } from '@/app/shows/actions'

/**
 * Travel is a flag on a day, not a day type (migration 0005) — a day can be
 * flown in AND worked the same day, so this sits alongside PunchClock and
 * HalfDayToggle rather than replacing either. One instance covers one leg;
 * the show page renders two, 'in' and 'out', per day.
 */
export default function TravelLegToggle({
  showDayId, leg, checked, locked,
}: {
  showDayId: string
  leg: 'in' | 'out'
  checked: boolean
  locked: boolean
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)

  function toggle(value: boolean) {
    setError(null)
    start(async () => {
      const result = await setTravelLeg(showDayId, leg, value)
      if ('error' in result) { setError(result.error); return }
      router.refresh()
    })
  }

  const label = leg === 'in' ? 'Travelled in' : 'Travelled out'

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
        {label}
      </label>
      {error && <span role="alert" className="ml-2 text-xs text-danger">{error}</span>}
    </span>
  )
}
