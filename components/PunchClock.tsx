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
//
// Tapping a time IS the commit — there is no separate Save button on the chip
// path. The iOS native time picker's own checkmark already feels final, and a
// Save button after it invited walking away before the punch actually landed.
// Only the "exact time…" escape hatch (a raw <input type="time">) keeps a
// Save/Cancel pair, because there is no discrete value to tap there.

const HOURS = Array.from({ length: 24 }, (_, h) => h)

/** `7` -> `"7 AM"`, `13` -> `"1 PM"` — the hour grid's compact label. */
function hourLabel(h: number): string {
  return friendlyTime(`${String(h).padStart(2, '0')}:00`).replace(':00', '')
}

/** The four quarter-hours inside one hour, as `HH:MM` wall times. */
function quarterTimes(h: number): string[] {
  const hh = String(h).padStart(2, '0')
  return [`${hh}:00`, `${hh}:15`, `${hh}:30`, `${hh}:45`]
}

function toMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number)
  return h * 60 + m
}

function toHHMM(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`
}

/**
 * The quick row: the quarter-hour nearest `now`, plus its neighbors 15
 * minutes either side.
 *
 * Deliberately NOT built from `nearest15` — that helper wraps 23:53–23:59 to
 * `"00:00"` (its own docstring says so; it's the right call for its other,
 * editable-prefill caller). Reused here it would be wrong in a way the
 * `>= 0 && < 1440` filter below can't catch: by the time the filter sees a
 * wrapped center, it's already `0`, a perfectly legal minute, so a chip
 * labeled midnight would show under "Now" while the real time is 23:5x —
 * and tapping it saves `wallToInstant(atDate, '00:00', tz)` with `atDate`
 * still today, roughly 24 hours before the instant that actually happened.
 * So the rounding happens on raw, unwrapped minutes here, and ANY candidate
 * that lands at or past 1440 (not just negative ones) is dropped, not
 * relabeled — the dialog's date field does not travel with a chip, so a
 * chip for a different calendar day than `atDate` must not exist rather
 * than be wrapped. Costs at most one or two chips, only within 15 minutes of
 * midnight either direction; the hour grid covers the same time either way.
 */
function quickRowTimes(nowWallTime: string): string[] {
  const center = Math.round(toMinutes(nowWallTime) / 15) * 15
  return [center - 15, center, center + 15]
    .filter((m) => m >= 0 && m < 1440)
    .map(toHHMM)
}

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
  // Only read on the exact-time escape hatch — every chip path saves its own
  // tapped time directly, never this state.
  const [atTime, setAtTime] = useState('09:00')
  const [exact, setExact] = useState(false)
  // Which hour's quarter row is showing. Null means the grid is collapsed.
  const [selectedHour, setSelectedHour] = useState<number | null>(null)
  // "Now" in the show's zone, snapshotted when the dialog opens — it drives
  // the quick row and the hour grid's default, and deliberately does not
  // tick while the dialog is open.
  const [nowWall, setNowWall] = useState<{ date: string; time: string }>({ date, time: '09:00' })
  // Which chip's wall time is in flight, so that specific chip — not just
  // "everything is disabled" — can read "Saving…" the way the exact-time
  // Save button already does. A slow network otherwise leaves a chip tap
  // looking like nothing happened.
  const [savingTime, setSavingTime] = useState<string | null>(null)
  const timeRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)

  const recorded = new Set(punches.map((p) => p.punch_type))
  const next = PUNCH_ORDER.find((t) => !recorded.has(t))

  const fmt = (iso: string) =>
    new Intl.DateTimeFormat('en-US', {
      hour: 'numeric', minute: '2-digit', timeZone: timezone,
    }).format(new Date(iso))

  // Move focus into the dialog whenever it opens or switches modes. This
  // isn't just an a11y nicety: the dialog's Escape handler lives on its own
  // div, so if focus stays on the trigger button behind the backdrop,
  // Escape never reaches it. Exact mode focuses the input directly (there's
  // one field worth typing into); chip mode focuses the dialog shell itself,
  // since no single chip deserves focus over the rest.
  useEffect(() => {
    if (!editing) return
    if (exact) timeRef.current?.focus()
    else dialogRef.current?.focus()
  }, [editing, exact])

  function open(type: PunchType) {
    setError(null)
    // Read NOW in the show's zone — an Orlando show billed from Chicago
    // should offer Orlando's clock. A punch is recorded at the moment it
    // happens, so "now" is the right default even for an out that follows a
    // morning in: tapping Out at the end of the shift should land on the
    // current time, not jump back to the in.
    const wall = instantToWall(new Date().toISOString(), timezone)
    setNowWall(wall)
    setAtDate(date)
    setAtTime(nearest15(wall.time))
    setExact(false)
    // Default the hour grid open on today's near-now hour — the common late
    // punch is visible with zero grid taps. A back-filled past day starts
    // with nothing expanded; there's no "now" on it worth defaulting to.
    setSelectedHour(date === wall.date ? Number(nearest15(wall.time).split(':')[0]) : null)
    setSavingTime(null)
    setEditing(type)
  }

  /** Tapping any chip calls this directly — the tap IS the save. */
  function save(time: string) {
    if (!editing) return
    setError(null)
    setSavingTime(time)
    const type = editing
    start(async () => {
      const at = wallToInstant(atDate, time, timezone)
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

  // The date field is compared against the row's own `date` (has it been
  // touched at all) for the readback below, and separately against the
  // zone's actual today (`nowWall.date`) to decide whether "now" chips make
  // sense — a backfilled Tuesday punched in on Thursday keeps the short
  // readback once you touch nothing, even though it isn't "today" for chips.
  const dateChanged = atDate !== date
  const isToday = atDate === nowWall.date
  const zoneWord = timezone.split('/')[1]?.replace(/_/g, ' ') ?? timezone
  const zoneNote = exact
    ? dateChanged
      ? `${formatDateLong(atDate)}, ${friendlyTime(atTime)} · ${zoneWord} time`
      : `${friendlyTime(atTime)} · ${zoneWord} time`
    : dateChanged
      ? `${formatDateLong(atDate)} · ${zoneWord} time`
      : `${zoneWord} time`
  const quickTimes = isToday ? quickRowTimes(nowWall.time) : []

  const chipDisabled = locked || pending

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
            ref={dialogRef}
            tabIndex={-1}
            className="w-full max-w-sm bg-bg border border-line rounded-field p-5 max-h-[85vh] overflow-y-auto
                       focus:outline-none"
            onKeyDown={(e) => {
              if (e.key === 'Escape' && !pending) setEditing(null)
              // Chips commit themselves on tap; Enter only means "save" when
              // the exact-time input is the thing holding a pending value.
              if (exact && e.key === 'Enter' && !pending) { e.preventDefault(); save(atTime) }
            }}
          >
            <h2 className="eyebrow mb-1">{PUNCH_LABELS[editing]}</h2>
            <p className="text-xs text-muted mb-5">{formatDateLong(date)}</p>

            <div className="mb-4">
              <label className="eyebrow block mb-1.5" htmlFor="punch-date">Date</label>
              <input id="punch-date" type="date" className={FIELD_FULL} value={atDate}
                     disabled={pending} onChange={(e) => setAtDate(e.target.value)} />
            </div>

            {/* Read back what is about to be stored, in the show's own zone,
                BEFORE any chip below can be tapped — a punch is saved as an
                instant, and on an out-of-state show this line is the only
                place the distinction is visible, so it has to be seen before
                the tap that commits it, not after. */}
            <p className="text-xs text-muted mb-4">{zoneNote}</p>

            {error && (
              <p role="alert" className="mb-4 text-sm text-danger border-l-2 border-danger pl-3 py-1">
                {error}
              </p>
            )}

            {exact ? (
              <>
                <div className="mb-4">
                  <label className="eyebrow block mb-1.5" htmlFor="punch-time">Time</label>
                  <input id="punch-time" ref={timeRef} type="time" step={900}
                         className={`${FIELD_FULL} tabular`} value={atTime}
                         disabled={pending} onChange={(e) => setAtTime(e.target.value)} />
                </div>
                <div className="flex items-center gap-2">
                  <button type="button" onClick={() => save(atTime)} disabled={pending}
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
              </>
            ) : (
              <>
                {quickTimes.length > 0 && (
                  <div className="mb-4">
                    <p className="eyebrow mb-1.5">Now</p>
                    <div className="flex gap-2">
                      {quickTimes.map((t) => (
                        <button
                          key={t} type="button" disabled={chipDisabled}
                          onClick={() => save(t)}
                          aria-label={`Save ${PUNCH_LABELS[editing]} at ${friendlyTime(t)}`}
                          className="flex-1 px-2 py-2 text-sm font-semibold tabular rounded-field
                                     border border-line text-ink hover:border-accent hover:text-accent-ink
                                     disabled:opacity-40"
                        >
                          {pending && savingTime === t ? 'Saving…' : friendlyTime(t)}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <div className="mb-2">
                  <p className="eyebrow mb-1.5">Time</p>
                  <div className="grid grid-cols-4 sm:grid-cols-6 gap-1.5">
                    {HOURS.map((h) => {
                      const isSelected = selectedHour === h
                      return (
                        <button
                          key={h} type="button" disabled={chipDisabled}
                          onClick={() => setSelectedHour(h)}
                          aria-expanded={isSelected}
                          aria-controls={isSelected ? 'punch-quarter-row' : undefined}
                          className={
                            isSelected
                              ? 'min-h-[2.5rem] px-1 py-1.5 text-xs font-bold rounded-field bg-accent-surface text-accent-ink disabled:opacity-50'
                              : 'min-h-[2.5rem] px-1 py-1.5 text-xs font-semibold rounded-field border border-line text-muted hover:text-ink disabled:opacity-40'
                          }
                        >
                          {hourLabel(h)}
                        </button>
                      )
                    })}
                  </div>
                </div>

                {selectedHour !== null && (
                  <div id="punch-quarter-row" className="mb-2 flex gap-2">
                    {quarterTimes(selectedHour).map((t) => (
                      <button
                        key={t} type="button" disabled={chipDisabled}
                        onClick={() => save(t)}
                        aria-label={`Save ${PUNCH_LABELS[editing]} at ${friendlyTime(t)}`}
                        className="flex-1 px-2 py-2 text-sm font-semibold tabular rounded-field
                                   border border-line text-ink hover:border-accent hover:text-accent-ink
                                   disabled:opacity-40"
                      >
                        {pending && savingTime === t ? 'Saving…' : friendlyTime(t)}
                      </button>
                    ))}
                  </div>
                )}

                <button type="button" onClick={() => setExact(true)} disabled={chipDisabled}
                        className="mt-2 text-xs text-muted underline decoration-dotted
                                   hover:text-ink disabled:opacity-40">
                  Exact time…
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {error && !editing && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
    </div>
  )
}
