'use client'

import { useState, useTransition, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { PUNCH_ORDER, PUNCH_LABELS, type PunchType } from '@/lib/punchTypes'
import { formatDateLong } from '@/lib/dates'
import { wallToInstant, instantToWall, nearest15, friendlyTime } from '@/lib/zonedTime'
import { recordPunch, deletePunch } from '@/app/shows/actions'
import { FIELD_FULL } from '@/components/ui/field'

// One row per day. The next expected punch is the prominent button; the rest
// stay available because a real show floor doesn't run in order.
//
// A punch opens a picker rather than stamping the current moment. Punching
// "now" only works if you are holding the phone at the moment it happens, which
// is exactly when you are busiest — and it makes entering a show after the fact,
// or testing one, impossible. The picker prefills the day being punched and the
// nearest quarter hour, so the common case is still two taps.


export default function PunchClock({
  showId, showDayId, date, timezone, punches, locked, highlighted = false,
}: {
  showId: string
  showDayId: string
  /** The day this row is for. Prefills the picker and anchors an overnight out. */
  date: string
  timezone: string
  punches: { id: string; punch_type: string; punched_at: string }[]
  locked: boolean
  /** True on the TODAY card: its amber wash swallows border-line, so the
      empty slots step up to border-muted there or they read as bare text. */
  highlighted?: boolean
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
    // Prefill NOW, rounded to the quarter hour, read in the show's zone — an
    // Orlando show billed from Chicago should offer Orlando's clock. A punch is
    // recorded at the moment it happens, so "now" is the right default even for
    // an out that follows a morning in: tapping Out at the end of the shift
    // should land on the current time, not jump back to the in. (It used to
    // prefill the previous punch's time, which put a 12:30 out at the 5:30 in.)
    const wall = instantToWall(new Date().toISOString(), timezone)
    setAtDate(date)
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
      {/* A uniform 3-column grid, every cell the same size — six punch slots
          read as one clock face instead of a ragged chip row. A recorded
          punch becomes a tile (label over time, × to remove); an empty slot
          stays a button; the next expected punch is the filled one. */}
      {/* 6-across from sm: — one clock-face row on anything iPad-portrait
          (744/768px) and wider; phones keep the 3x2. */}
      <div className="grid grid-cols-3 gap-2 max-w-md sm:grid-cols-6 sm:max-w-2xl">
        {PUNCH_ORDER.map((type) => {
          const hit = punches.find((p) => p.punch_type === type)
          if (hit) {
            return (
              <div
                key={type}
                className="relative min-h-[3.4rem] flex flex-col items-center justify-center
                           rounded-field border border-line bg-surface px-2 py-1.5"
              >
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted leading-tight">
                  {PUNCH_LABELS[type]}
                </span>
                <span className="tabular text-sm font-semibold leading-tight">{fmt(hit.punched_at)}</span>
                <button
                  type="button"
                  disabled={locked || pending}
                  onClick={() => remove(hit.id)}
                  aria-label={`Remove ${PUNCH_LABELS[type]}`}
                  className="absolute top-0 right-0 px-2 py-0.5 text-muted hover:text-danger
                             transition-colors text-sm leading-none disabled:opacity-40"
                >
                  ×
                </button>
              </div>
            )
          }
          const isNext = type === next
          return (
            <button
              key={type} type="button" disabled={locked || pending}
              onClick={() => open(type)}
              className={
                isNext
                  ? 'min-h-[3.4rem] px-2 py-1.5 text-xs font-bold uppercase tracking-wider rounded-field bg-accent-surface text-accent-ink disabled:opacity-50'
                  : `min-h-[3.4rem] px-2 py-1.5 text-xs font-semibold uppercase tracking-wider rounded-field border ${highlighted ? 'border-muted text-ink' : 'border-line text-muted'} hover:text-ink disabled:opacity-40`
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
                <input id="punch-date" type="date" className={FIELD_FULL} value={atDate}
                       disabled={pending} onChange={(e) => setAtDate(e.target.value)} />
              </div>
              <div>
                <label className="eyebrow block mb-1.5" htmlFor="punch-time">Time</label>
                <input id="punch-time" ref={timeRef} type="time" step={900}
                       className={`${FIELD_FULL} tabular`} value={atTime}
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
