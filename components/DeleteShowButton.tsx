'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { deleteShow } from '@/app/shows/actions'

// Deleting a show cascades to its days, punches and PM log — all real
// recorded work — so this follows RemoveDayButton's shape exactly: a
// two-step control (Delete -> named confirm) rather than a one-click button
// or a browser confirm() dialog, with the same auto-disarm on a stray click
// or a few seconds of no follow-up.

const CONFIRM_TIMEOUT_MS = 4000

export default function DeleteShowButton({
  showId, locked, dayCount, punchCount, pmEntryCount,
}: {
  showId: string
  locked: boolean
  dayCount: number
  punchCount: number
  pmEntryCount: number
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
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
      const result = await deleteShow(showId)
      if ('error' in result) { setError(result.error); setConfirming(false); return }
      router.push('/shows')
      router.refresh()
    })
  }

  // A billed show can't be deleted (app/shows/actions.ts refuses it
  // server-side too) — hide the control entirely rather than show a button
  // that always errors, and say what to do instead.
  if (locked) {
    return (
      <p className="text-xs text-muted">
        This show is billed. Unlink it from its invoice before it can be deleted.
      </p>
    )
  }

  const dayLabel = `${dayCount} day${dayCount === 1 ? '' : 's'}`
  const punchLabel = `${punchCount} punch${punchCount === 1 ? '' : 'es'}`
  const pmLabel = `${pmEntryCount} PM ${pmEntryCount === 1 ? 'entry' : 'entries'}`

  return (
    <div ref={containerRef} className="inline-flex items-baseline">
      {confirming ? (
        <button
          type="button"
          disabled={pending}
          onClick={remove}
          className="text-danger hover:opacity-80 transition-opacity text-xs font-semibold disabled:opacity-40"
        >
          {pending
            ? 'Deleting…'
            : `Confirm delete? This removes ${dayLabel}, ${punchLabel} and ${pmLabel}.`}
        </button>
      ) : (
        <button
          type="button"
          disabled={pending}
          onClick={arm}
          className="text-muted hover:text-danger transition-colors text-xs disabled:opacity-40"
        >
          Delete this show
        </button>
      )}
      {error && <span role="alert" className="ml-2 text-xs text-danger">{error}</span>}
    </div>
  )
}
