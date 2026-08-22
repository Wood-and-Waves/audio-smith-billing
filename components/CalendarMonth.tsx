'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { WEEKDAYS, formatDateLong } from '@/lib/dates'
import { instantToWall, friendlyTime } from '@/lib/zonedTime'
import { timezoneShortLabel } from '@/lib/timezones'
import { deleteFlight } from '@/app/calendar/actions'
import AddFlightDialog from '@/components/AddFlightDialog'

export type DayEntry = {
  id: string
  showId: string
  showName: string
  venue: string | null
  location: string | null
  clientName: string | null
  travelIn: boolean
  travelOut: boolean
  payAsHalfDay: boolean
}

export type FlightEntry = {
  id: string
  flightNo: string
  flightDate: string
  depAirport: string | null
  arrAirport: string | null
  depAt: string | null
  arrAt: string | null
  depTz: string | null
  arrTz: string | null
  note: string | null
}

// A cell shows at most this many entries before collapsing to "+N more" —
// the detail dialog is the real reader either way, this is just a preview.
const MAX_VISIBLE = 3

/** One leg's time, read back in its own zone — falls back to Chicago the
 *  same way the DB column comment (migration 0033) says display should. */
function FlightTime({ at, tz }: { at: string | null; tz: string | null }) {
  if (!at) return null
  const wall = instantToWall(at, tz ?? 'America/Chicago')
  return (
    <span className="tabular">
      {friendlyTime(wall.time)} {timezoneShortLabel(tz ?? 'America/Chicago')}
    </span>
  )
}

export default function CalendarMonth({
  grid, month, today, showsByDate, flightsByDate,
}: {
  grid: string[][]
  /** 'YYYY-MM' being viewed — dates outside it (the padded leading/trailing
   *  cells) render dimmed. */
  month: string
  /** todayInChicago(), computed server-side — no client clock, so the
   *  highlighted cell can never drift from what the server just rendered. */
  today: string
  showsByDate: Record<string, DayEntry[]>
  flightsByDate: Record<string, FlightEntry[]>
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  // Focus moves into the panel on open so Escape reaches the handler below
  // — without it, focus stays on whatever cell button was last clicked and
  // the keydown never bubbles through the dialog (the bug CornerAdjuster's
  // own comment calls out).
  useEffect(() => { if (selectedDate) panelRef.current?.focus() }, [selectedDate])

  function remove(id: string) {
    setError(null)
    start(async () => {
      const result = await deleteFlight(id)
      if ('error' in result) { setError(result.error); return }
      router.refresh()
    })
  }

  const dayShows = selectedDate ? (showsByDate[selectedDate] ?? []) : []
  const dayFlights = selectedDate ? (flightsByDate[selectedDate] ?? []) : []

  return (
    <div>
      <div className="grid grid-cols-7 border-t border-l border-line">
        {WEEKDAYS.map((w) => (
          <div key={w} className="border-b border-r border-line px-1 py-1.5 text-center">
            <span className="eyebrow">{w}</span>
          </div>
        ))}

        {grid.flat().map((date) => {
          const shows = showsByDate[date] ?? []
          const flights = flightsByDate[date] ?? []
          const chips = [
            ...shows.map((s) => ({
              key: `s-${s.id}`,
              node: (
                <div className="truncate rounded-field bg-accent-surface text-accent-ink px-1 py-0.5 text-[11px] font-semibold">
                  {s.showName}
                </div>
              ),
            })),
            ...flights.map((f) => ({
              key: `f-${f.id}`,
              node: <div className="truncate text-[11px] text-ink">✈ {f.flightNo}</div>,
            })),
          ]
          const visible = chips.slice(0, MAX_VISIBLE)
          const overflow = chips.length - visible.length
          const isCurrentMonth = date.slice(0, 7) === month
          const isToday = date === today
          const dayNum = Number(date.slice(8, 10))

          return (
            <button
              key={date}
              type="button"
              onClick={() => setSelectedDate(date)}
              className={`min-h-[5.5rem] sm:min-h-[7rem] flex flex-col items-stretch
                          border-b border-r border-line p-1.5 sm:p-2 text-left
                          ${isCurrentMonth ? 'text-ink' : 'text-muted opacity-60'}
                          ${isToday ? 'bg-accent-wash border-l-2 border-l-accent' : ''}`}
            >
              <span className="self-end tabular text-[11px] sm:text-xs">{dayNum}</span>

              {/* Tablet/desktop: readable chips. */}
              <div className="hidden sm:flex flex-col gap-0.5 mt-1 min-w-0">
                {visible.map((c) => <div key={c.key}>{c.node}</div>)}
                {overflow > 0 && <div className="text-[10px] text-muted">+{overflow} more</div>}
              </div>

              {/* Phone: no room for text, so entries collapse to dots — the
                  day-tap dialog is the actual reader below sm. */}
              {chips.length > 0 && (
                <div className="sm:hidden flex flex-wrap gap-0.5 mt-1">
                  {chips.slice(0, 4).map((c) => (
                    <span key={c.key} className="h-1.5 w-1.5 rounded-full bg-accent-surface" />
                  ))}
                </div>
              )}
            </button>
          )
        })}
      </div>

      {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}

      {selectedDate && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={formatDateLong(selectedDate)}
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-4"
          onClick={(e) => { if (e.target === e.currentTarget) setSelectedDate(null) }}
        >
          <div
            ref={panelRef}
            tabIndex={-1}
            className="w-full max-w-md bg-bg border border-line rounded-field p-5 outline-none max-h-[85vh] overflow-y-auto"
            onKeyDown={(e) => { if (e.key === 'Escape') setSelectedDate(null) }}
          >
            <div className="flex items-center justify-between mb-4">
              <h2 className="eyebrow">{formatDateLong(selectedDate)}</h2>
              <button
                type="button"
                onClick={() => setSelectedDate(null)}
                className="text-xs font-semibold uppercase tracking-wider text-muted hover:text-ink"
              >
                Close
              </button>
            </div>

            {dayShows.length === 0 && dayFlights.length === 0 && (
              <p className="text-sm text-muted">Nothing on the books.</p>
            )}

            {dayShows.length > 0 && (
              <ul className="space-y-3 mb-4">
                {dayShows.map((s) => {
                  const badges = [
                    s.travelIn && 'travel in',
                    s.travelOut && 'travel out',
                    s.payAsHalfDay && 'half day',
                  ].filter(Boolean).join(' · ')
                  return (
                    <li key={s.id} className="border-b border-line pb-3">
                      <Link href={`/shows/${s.showId}`} className="font-semibold hover:text-accent transition-colors">
                        {s.showName}
                      </Link>
                      <p className="text-sm text-muted">
                        {[s.venue, s.location, s.clientName].filter(Boolean).join(' · ')}
                      </p>
                      {badges && <p className="eyebrow mt-1">{badges}</p>}
                    </li>
                  )
                })}
              </ul>
            )}

            {dayFlights.length > 0 && (
              <ul className="space-y-3">
                {dayFlights.map((f) => (
                  <li key={f.id} className="border-b border-line pb-3">
                    <p className="font-semibold">
                      ✈ {f.flightNo}
                      {(f.depAirport || f.arrAirport) && (
                        <span className="text-muted font-normal">
                          {' '}· {f.depAirport ?? '???'} → {f.arrAirport ?? '???'}
                        </span>
                      )}
                    </p>
                    {(f.depAt || f.arrAt) && (
                      <p className="text-sm text-muted">
                        <FlightTime at={f.depAt} tz={f.depTz} />
                        {f.depAt && f.arrAt && ' → '}
                        <FlightTime at={f.arrAt} tz={f.arrTz} />
                      </p>
                    )}
                    {f.note && <p className="text-sm text-muted mt-1">{f.note}</p>}
                    <div className="flex items-center gap-3 mt-2">
                      <AddFlightDialog mode="edit" flight={f} />
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => remove(f.id)}
                        className="text-xs font-semibold uppercase tracking-wider text-muted hover:text-danger disabled:opacity-40"
                      >
                        Delete
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
