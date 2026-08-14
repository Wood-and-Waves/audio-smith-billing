'use client'

import { useState, useTransition, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { PUNCH_ORDER, PUNCH_LABELS, type PunchType } from '@/lib/punchTypes'
import { formatDateLong } from '@/lib/dates'
import { wallToInstant, instantToWall, nearest15, friendlyTime } from '@/lib/zonedTime'
import { recordPunch, deletePunch } from '@/app/shows/actions'

// One row per day. The next expected punch is the prominent button; the rest
// stay available because a real show floor doesn't run in order.
//
// A punch opens a picker rather than stamping the current moment. Punching
// "now" only works if you are holding the phone at the moment it happens, which
// is exactly when you are busiest — and it makes entering a show after the fact,
// or testing one, impossible. The picker prefills the day being punched and the
// nearest quarter hour, so the common case is still two taps.

const field =
  'w-full px-3 py-2 bg-surface border border-line rounded-field text-ink text-sm ' +
  'focus:border-accent focus:outline-none disabled:opacity-50'

export default function PunchClock({
  showId, showDayId, date, timezone, punches, locked,
}: {
  showId: string
  showDayId: string
  /** The day this row is for. Prefills the picker and anchors an overnight out. */
  date: string
  timezone: string
  punches: { id: string; punch_type: string; punched_at: string }[]
  locked: boolean
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)

  // Which punch is being entered, plus the values in the picker.
  const [editing, setEditing] = useState<PunchType | null>(null)
  const [atDate, setAtDate] = useState(date)
  const [atTime, setAtTime] = useState('09:00')
  const timeRef = useRef<HTMLInputElement>(null)

  const recorded = new Set(punches.map((p) => p.punch_type))
  const next = PUNCH_ORDER.find((t) => !recorded.has(t))

  const fmt = (iso: string) =>
    new Intl.DateTimeFormat('en-US', {
      hour: 'numeric', minute: '2-digit', timeZone: timezone,
    }).format(new Date(iso))

  // Focus the time when the picker opens: the date is nearly always already
  // right, so the time is the field actually being changed.
  useEffect(() => {
    if (editing) timeRef.current?.focus()
  }, [editing])

  function open(type: PunchType) {
    setError(null)
    // Prefill from the last punch already on this day where there is one, so a
    // 6pm out follows a 9am in rather than jumping back to the current clock.
    // Otherwise use now, rounded, read in the SHOW's zone — an Orlando show
    // billed from Chicago should offer Orlando's clock.
    const previous = PUNCH_ORDER
      .filter((t) => recorded.has(t))
      .map((t) => punches.find((p) => p.punch_type === t)!)
      .sort((a, b) => a.punched_at.localeCompare(b.punched_at))
      .at(-1)

    const wall = previous
      ? instantToWall(previous.punched_at, timezone)
      : instantToWall(new Date().toISOString(), timezone)

    setAtDate(previous ? wall.date : date)
    setAtTime(nearest15(wall.time))
    setEditing(type)
  }

  function save() {
    if (!editing) return
    setError(null)
    const type = editing
    start(async () => {
      const at = wallToInstant(atDate, atTime, timezone)
      const result = await recordPunch(showDayId, type, at)
      if ('error' in result) { setError(result.error); return }
      setEditing(null)
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
              onClick={() => open(type)}
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

      {editing && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`${PUNCH_LABELS[editing]} time`}
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-4"
          onClick={(e) => { if (e.target === e.currentTarget && !pending) setEditing(null) }}
        >
          <div
            className="w-full max-w-sm bg-bg border border-line rounded-field p-5"
            onKeyDown={(e) => {
              if (e.key === 'Escape' && !pending) setEditing(null)
              if (e.key === 'Enter' && !pending) { e.preventDefault(); save() }
            }}
          >
            <h2 className="eyebrow mb-1">{PUNCH_LABELS[editing]}</h2>
            <p className="text-xs text-muted mb-5">{formatDateLong(date)}</p>

            <div className="grid gap-3 grid-cols-[1fr_auto] mb-2">
              <div>
                <label className="eyebrow block mb-1.5" htmlFor="punch-date">Date</label>
                <input id="punch-date" type="date" className={field} value={atDate}
                       disabled={pending} onChange={(e) => setAtDate(e.target.value)} />
              </div>
              <div>
                <label className="eyebrow block mb-1.5" htmlFor="punch-time">Time</label>
                <input id="punch-time" ref={timeRef} type="time" step={900}
                       className={`${field} tabular`} value={atTime}
                       disabled={pending} onChange={(e) => setAtTime(e.target.value)} />
              </div>
            </div>

            {/* Read back what is about to be stored, in the show's own zone.
                A punch is saved as an instant, so on an out-of-state show this
                line is the only place the distinction is visible. */}
            <p className="text-xs text-muted mb-5">
              {atDate === date
                ? friendlyTime(atTime)
                : `${formatDateLong(atDate)}, ${friendlyTime(atTime)}`}
              {' '}&middot; {timezone.split('/')[1]?.replace(/_/g, ' ') ?? timezone} time
            </p>

            {error && (
              <p role="alert" className="mb-4 text-sm text-danger border-l-2 border-danger pl-3 py-1">
                {error}
              </p>
            )}

            <div className="flex items-center gap-2">
              <button type="button" onClick={save} disabled={pending}
                      className="px-5 py-2.5 bg-accent-surface text-accent-ink font-bold uppercase
                                 tracking-wider text-sm rounded-field hover:opacity-90
                                 transition-opacity disabled:opacity-50">
                {pending ? 'Saving…' : 'Save'}
              </button>
              <button type="button" onClick={() => setEditing(null)} disabled={pending}
                      className="px-4 py-2.5 text-xs font-semibold uppercase tracking-wider
                                 rounded-field border border-line text-muted hover:text-ink
                                 disabled:opacity-40">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {error && !editing && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
    </div>
  )
}
