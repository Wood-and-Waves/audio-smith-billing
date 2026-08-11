'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { deleteShowDay } from '@/app/shows/actions'
import { formatDateLong } from '@/lib/dates'

// Deleting a day cascades to its punches — real recorded work — so this is a
// two-step control (Remove -> Confirm?) rather than a one-click button or a
// browser confirm() dialog. The armed state self-disarms on a stray click
// anywhere outside the control, or after a few seconds of no follow-up, so a
// later unrelated click can never land on a live "Confirm?" by accident.

const CONFIRM_TIMEOUT_MS = 4000

export default function RemoveDayButton({
  showDayId, date, locked,
}: {
  showDayId: string
  date: string
  locked: boolean
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const containerRef = useRef<HTMLSpanElement>(null)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  function disarm() {
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    timeoutRef.current = null
    setConfirming(false)
  }

  useEffect(() => {
    if (!confirming) return
    function onPointerDown(e: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) disarm()
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [confirming])

  useEffect(() => () => { if (timeoutRef.current) clearTimeout(timeoutRef.current) }, [])

  function arm() {
    setError(null)
    setConfirming(true)
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    timeoutRef.current = setTimeout(disarm, CONFIRM_TIMEOUT_MS)
  }

  function remove() {
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    setError(null)
    start(async () => {
      const result = await deleteShowDay(showDayId)
      if ('error' in result) { setError(result.error); setConfirming(false); return }
      router.refresh()
    })
  }

  const label = formatDateLong(date)

  return (
    <span ref={containerRef} className="inline-flex items-baseline">
      {confirming ? (
        <button
          type="button"
          disabled={locked || pending}
          onClick={remove}
          aria-label={`Confirm remove ${label}`}
          className="text-danger hover:opacity-80 transition-opacity text-xs font-semibold disabled:opacity-40"
        >
          {pending ? 'Removing…' : 'Confirm?'}
        </button>
      ) : (
        <button
          type="button"
          disabled={locked || pending}
          onClick={arm}
          aria-label={`Remove ${label}`}
          className="text-muted hover:text-danger transition-colors text-xs disabled:opacity-40"
        >
          Remove
        </button>
      )}
      {error && <span role="alert" className="ml-2 text-xs text-danger">{error}</span>}
    </span>
  )
}
