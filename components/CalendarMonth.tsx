'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { WEEKDAYS, formatDateLong } from '@/lib/dates'
import { instantToWall, friendlyTime, elapsedLabel } from '@/lib/zonedTime'
import { timezoneShortLabel } from '@/lib/timezones'
import { deleteFlight } from '@/app/calendar/actions'
import AddFlightDialog from '@/components/AddFlightDialog'
import { layOutWeek, type ShowRun } from '@/lib/showRuns'

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

/**
 * One leg's time, read back in ITS OWN airport's zone — never converted to a
 * single zone. That is the boarding-pass convention and the only one that
 * answers the question a traveller actually has: be at this gate at this
 * local time, land at that one.
 *
 * The zone LABEL is only shown when the zone is known. A flight typed by
 * hand carries no zone (the lookup is what supplies them), and its instants
 * were stored as Chicago wall time — so printing "Central" beside a time Dan
 * typed meaning Eastern would assert a fact the app does not have. Bare time
 * is honest; a wrong label is not.
 */
function FlightTime({ at, tz }: { at: string | null; tz: string | null }) {
  if (!at) return null
  const wall = instantToWall(at, tz ?? 'America/Chicago')
  return (
    <span className="tabular">
      {friendlyTime(wall.time)}{tz ? ` ${timezoneShortLabel(tz)}` : ''}
    </span>
  )
}

// The date number's own line, and one bar lane, in px. The bar overlay is
// positioned against these rather than guessed, so a bar can never sit on
// top of the date or the flight chips below it.
const DATE_ROW_H = 18
const LANE_GAP = 4
const LANE_H = 20

export default function CalendarMonth({
  grid, month, today, showsByDate, flightsByDate, runs,
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
  runs: ShowRun[]
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
      <div className="border-t border-l border-line">
        <div className="grid grid-cols-7">
          {WEEKDAYS.map((w) => (
            <div key={w} className="border-b border-r border-line px-1 py-1.5 text-center">
              <span className="eyebrow">{w}</span>
            </div>
          ))}
        </div>

        {grid.map((week, wi) => {
          const { bars, overflowByCol } = layOutWeek(runs, week)
          const laneCount = bars.length === 0 ? 0 : Math.max(...bars.map((b) => b.lane)) + 1
          const laneBlock = laneCount * LANE_H

          return (
            <div key={week[0]} className="relative">
              <div className="grid grid-cols-7">
                {week.map((date, di) => {
                  const flights = flightsByDate[date] ?? []
                  const visible = flights.slice(0, MAX_VISIBLE)
                  const overflow = flights.length - visible.length
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
                      <span
                        className="self-end tabular text-[11px] sm:text-xs"
                        style={{ height: DATE_ROW_H, lineHeight: `${DATE_ROW_H}px` }}
                      >
                        {dayNum}
                      </span>

                      {/* Reserves exactly the space the bar overlay occupies
                          in THIS week, so flights never render underneath a
                          bar and a bar-free week keeps its old height. */}
                      <div aria-hidden style={{ height: laneCount === 0 ? 0 : laneBlock + LANE_GAP }} />

                      {overflowByCol[di] > 0 && (
                        <div className="text-[10px] text-muted">+{overflowByCol[di]} more</div>
                      )}

                      {/* Tablet/desktop: readable flight chips. Shows have
                          left the cell entirely — they are bars now. */}
                      <div className="hidden sm:flex flex-col gap-0.5 mt-1 min-w-0">
                        {visible.map((f) => (
                          <div key={f.id} className="truncate text-[11px] text-ink">✈ {f.flightNo}</div>
                        ))}
                        {overflow > 0 && <div className="text-[10px] text-muted">+{overflow} more</div>}
                      </div>

                      {/* Phone: flights stay dots (bars carry the shows). */}
                      {flights.length > 0 && (
                        <div className="sm:hidden flex flex-wrap gap-0.5 mt-1">
                          {flights.slice(0, 4).map((f) => (
                            <span key={f.id} className="h-1.5 w-1.5 rounded-full bg-accent-surface" />
                          ))}
                        </div>
                      )}
                    </button>
                  )
                })}
              </div>

              {/* The bar layer. It floats ABOVE the day buttons rather than
                  living inside them, which is what lets a bar be a <Link>
                  without nesting an interactive element inside a <button>
                  (invalid HTML, and a real click-target conflict). The layer
                  itself is click-through; only the bars take pointer events. */}
              {bars.length > 0 && (
                <div
                  className="pointer-events-none absolute inset-x-0 grid grid-cols-7
                             top-[28px] sm:top-[30px]"
                  style={{ rowGap: LANE_H - 17 }}
                >
                  {bars.map((b) => (
                    <Link
                      key={`${b.showId}-${b.startCol}-${wi}`}
                      href={`/shows/${b.showId}`}
                      title={b.showName}
                      className={`pointer-events-auto truncate h-[17px] leading-[17px] mx-px px-1.5
                                  bg-accent-surface text-accent-ink text-[11px] font-semibold
                                  hover:opacity-80 transition-opacity
                                  ${b.continuesLeft ? 'rounded-l-none' : 'rounded-l-field'}
                                  ${b.continuesRight ? 'rounded-r-none' : 'rounded-r-field'}`}
                      style={{ gridColumn: `${b.startCol + 1} / span ${b.span}`, gridRow: b.lane + 1 }}
                    >
                      {b.showName}
                    </Link>
                  ))}
                </div>
              )}
            </div>
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
                    {(f.depAt || f.arrAt) ? (
                      <p className="text-sm text-muted">
                        <FlightTime at={f.depAt} tz={f.depTz} />
                        {f.depAt && f.arrAt && ' → '}
                        <FlightTime at={f.arrAt} tz={f.arrTz} />
                        {
                          // Elapsed only when BOTH zones are known, i.e. the
                          // times came from a lookup. Hand-typed times were
                          // both stored as Chicago wall time, so subtracting
                          // them would silently report the clock difference
                          // as a duration — the exact error this figure
                          // exists to correct.
                          f.depAt && f.arrAt && f.depTz && f.arrTz && (() => {
                            const elapsed = elapsedLabel(f.depAt, f.arrAt)
                            return elapsed ? <span> · {elapsed}</span> : null
                          })()
                        }
                      </p>
                    ) : (
                      // A flight saved with no times at all (the lookup was
                      // unavailable and none were typed) would otherwise
                      // render as a bare number and read as broken. Say what
                      // is missing, next to the Edit that fixes it.
                      <p className="text-sm text-muted">No times yet</p>
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
