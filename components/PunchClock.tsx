'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { PUNCH_ORDER, PUNCH_LABELS, type PunchType } from '@/lib/punchTypes'
import { recordPunch, deletePunch } from '@/app/shows/actions'

// One row per day. The next expected punch is the prominent button; the rest
// stay available because a real show floor doesn't run in order.

export default function PunchClock({
  showId, showDayId, timezone, punches, locked,
}: {
  showId: string
  showDayId: string
  timezone: string
  punches: { id: string; punch_type: string; punched_at: string }[]
  locked: boolean
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const recorded = new Set(punches.map((p) => p.punch_type))
  const next = PUNCH_ORDER.find((t) => !recorded.has(t))

  const fmt = (iso: string) =>
    new Intl.DateTimeFormat('en-US', {
      hour: 'numeric', minute: '2-digit', timeZone: timezone,
    }).format(new Date(iso))

  function punch(type: PunchType) {
    setError(null)
    start(async () => {
      const result = await recordPunch(showDayId, type, new Date().toISOString())
      if ('error' in result) { setError(result.error); return }
      router.refresh()
    })
  }

  function remove(punchId: string) {
    setError(null)
    start(async () => {
      const result = await deletePunch(punchId, showId)
      if ('error' in result) { setError(result.error); return }
      router.refresh()
    })
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        {PUNCH_ORDER.map((type) => {
          const hit = punches.find((p) => p.punch_type === type)
          if (hit) {
            return (
              <span key={type} className="inline-flex items-center gap-1 tabular text-sm text-muted">
                {PUNCH_LABELS[type]} {fmt(hit.punched_at)}
                <button
                  type="button"
                  disabled={locked || pending}
                  onClick={() => remove(hit.id)}
                  aria-label={`Remove ${PUNCH_LABELS[type]}`}
                  className="text-muted hover:text-danger transition-colors text-sm leading-none disabled:opacity-40"
                >
                  ×
                </button>
              </span>
            )
          }
          const isNext = type === next
          return (
            <button
              key={type} type="button" disabled={locked || pending}
              onClick={() => punch(type)}
              className={
                isNext
                  ? 'px-3 py-1.5 text-xs font-bold uppercase tracking-wider rounded-field bg-accent-surface text-accent-ink disabled:opacity-50'
                  : 'px-3 py-1.5 text-xs font-semibold uppercase tracking-wider rounded-field border border-line text-muted hover:text-ink disabled:opacity-40'
              }
            >
              {PUNCH_LABELS[type]}
            </button>
          )
        })}
      </div>
      {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
    </div>
  )
}
