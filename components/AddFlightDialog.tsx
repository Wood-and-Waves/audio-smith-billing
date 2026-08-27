'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { isPlainDate } from '@/lib/dates'
import { wallToInstant, instantToWall } from '@/lib/zonedTime'
import { timezoneShortLabel } from '@/lib/timezones'
import { lookupFlight, saveFlight, updateFlight } from '@/app/calendar/actions'
import { legChoiceLabel, type CandidateLeg } from '@/lib/flightLookup'
import { FIELD_FULL } from '@/components/ui/field'

export type FlightForEdit = {
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

type Form = {
  flightNo: string
  date: string
  depAirport: string
  arrAirport: string
  note: string
  depDate: string
  depTime: string
  arrDate: string
  arrTime: string
  depTz: string | null
  arrTz: string | null
}

/** Optional strings go over the wire trimmed-or-null, never a blank string —
 *  Task 4 stores dep_tz/arr_tz (and the airports) as-received, so a stray
 *  "" here would persist as a value instead of reading as "nothing given". */
const optStr = (v: string | null): string | null => (v == null ? null : v.trim() || null)

/** date + time -> the leg's instant, or null if either half is missing. A
 *  flight with blank time fields has to save cleanly — lookup misses and
 *  hand entry both leave times blank routinely, and that's not an error. */
function computeAt(date: string, time: string, tz: string | null): string | null {
  if (!date || !time) return null
  return wallToInstant(date, time, tz ?? 'America/Chicago')
}

function emptyForm(defaultDate: string): Form {
  return {
    flightNo: '', date: defaultDate,
    depAirport: '', arrAirport: '', note: '',
    depDate: '', depTime: '', arrDate: '', arrTime: '',
    depTz: null, arrTz: null,
  }
}

function formFromFlight(flight: FlightForEdit): Form {
  const dep = flight.depAt ? instantToWall(flight.depAt, flight.depTz ?? 'America/Chicago') : null
  const arr = flight.arrAt ? instantToWall(flight.arrAt, flight.arrTz ?? 'America/Chicago') : null
  return {
    flightNo: flight.flightNo, date: flight.flightDate,
    depAirport: flight.depAirport ?? '', arrAirport: flight.arrAirport ?? '', note: flight.note ?? '',
    depDate: dep?.date ?? '', depTime: dep?.time ?? '',
    arrDate: arr?.date ?? '', arrTime: arr?.time ?? '',
    depTz: flight.depTz, arrTz: flight.arrTz,
  }
}

/**
 * The PunchClock dialog idiom (fixed backdrop, panel, Escape/Enter on the
 * panel's own onKeyDown) doing double duty as both the page's "Add flight"
 * trigger (mode="create", rendered directly in app/calendar/page.tsx's
 * header) and a flight row's "Edit" trigger (mode="edit", rendered from
 * CalendarMonth). Each instance owns its own open/closed state and its own
 * copy of the form, so two flight rows can each carry an Edit trigger
 * without stepping on each other.
 */
export default function AddFlightDialog({
  mode = 'create', flight, defaultDate,
}: {
  mode?: 'create' | 'edit'
  flight?: FlightForEdit
  /** Create mode only — todayInChicago(), passed from the server page so a
   *  new flight defaults to today rather than whatever month is being
   *  viewed. */
  defaultDate?: string
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, start] = useTransition()
  const [looking, startLookup] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState<Form>(() =>
    mode === 'edit' && flight ? formFromFlight(flight) : emptyForm(defaultDate ?? ''))
  // Non-null only while a lookup came back with MORE THAN ONE leg and Dan
  // hasn't chosen yet. A single result never sets this — it fills the form
  // outright, exactly as before — so the picker appears only when there is
  // a real ambiguity to resolve.
  const [choices, setChoices] = useState<CandidateLeg[] | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const busy = pending || looking

  // Focus moves into the panel on open so Escape/Enter reach the handler
  // below — copied from CornerAdjuster's own panelRef/tabIndex pattern
  // (components/CornerAdjuster.tsx:150-156); without it, focus stays
  // outside the dialog and neither key does anything.
  useEffect(() => { if (open) panelRef.current?.focus() }, [open])

  function openDialog() {
    setError(null)
    setChoices(null)
    setForm(mode === 'edit' && flight ? formFromFlight(flight) : emptyForm(defaultDate ?? ''))
    setOpen(true)
  }

  /** One chosen leg -> the form's airport/date/time/zone fields. Shared by
   *  the single-result path and the picker, so a leg Dan taps lands in the
   *  form through exactly the same code as a leg that arrived alone. */
  function applyLeg(leg: CandidateLeg) {
    const dep = leg.depAt ? instantToWall(leg.depAt, leg.depTz ?? 'America/Chicago') : null
    const arr = leg.arrAt ? instantToWall(leg.arrAt, leg.arrTz ?? 'America/Chicago') : null
    setChoices(null)
    setForm((f) => ({
      ...f,
      depAirport: leg.depAirport ?? '', arrAirport: leg.arrAirport ?? '',
      depDate: dep?.date ?? '', depTime: dep?.time ?? '',
      arrDate: arr?.date ?? '', arrTime: arr?.time ?? '',
      depTz: leg.depTz, arrTz: leg.arrTz,
    }))
  }

  function lookup() {
    setError(null)
    setChoices(null)
    startLookup(async () => {
      if (!isPlainDate(form.date)) { setError('Enter a valid flight date.'); return }
      const result = await lookupFlight({ flightNo: form.flightNo, date: form.date })
      if ('error' in result) { setError(result.error); return }
      const [first, ...rest] = result.candidates
      if (!first) { setError('No flight found for that number and date.'); return }
      // A flight number can fly the same date twice (Dan, 2026-08-27:
      // UA1382 on 8/28). Taking candidates[0] silently handed him the
      // earlier one with nothing on screen admitting the later one existed
      // — and no way to reach it. More than one leg now asks instead of
      // guessing; exactly one still fills the form outright.
      if (rest.length > 0) { setChoices(result.candidates); return }
      applyLeg(first)
    })
  }

  function save() {
    setError(null)
    start(async () => {
      const payload = {
        flightNo: form.flightNo,
        flightDate: form.date,
        depAirport: optStr(form.depAirport),
        arrAirport: optStr(form.arrAirport),
        depAt: computeAt(form.depDate, form.depTime, form.depTz),
        arrAt: computeAt(form.arrDate, form.arrTime, form.arrTz),
        depTz: optStr(form.depTz),
        arrTz: optStr(form.arrTz),
        note: form.note,
      }
      const result = mode === 'edit' && flight
        ? await updateFlight({ id: flight.id, ...payload })
        : await saveFlight(payload)
      if ('error' in result) { setError(result.error); return }
      setOpen(false)
      router.refresh()
    })
  }

  return (
    <>
      {mode === 'create' ? (
        <button
          type="button"
          onClick={openDialog}
          className="px-4 py-2.5 bg-accent-surface text-accent-ink font-bold uppercase
                     tracking-wider text-sm rounded-field hover:opacity-90 transition-opacity"
        >
          Add flight
        </button>
      ) : (
        <button
          type="button"
          onClick={openDialog}
          className="text-xs font-semibold uppercase tracking-wider text-muted hover:text-ink"
        >
          Edit
        </button>
      )}

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={mode === 'edit' ? 'Edit flight' : 'Add flight'}
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-4"
          onClick={(e) => { if (e.target === e.currentTarget && !busy) setOpen(false) }}
        >
          <div
            ref={panelRef}
            tabIndex={-1}
            className="w-full max-w-sm bg-bg border border-line rounded-field p-5 outline-none max-h-[85vh] overflow-y-auto"
            onKeyDown={(e) => {
              if (e.key === 'Escape' && !busy) setOpen(false)
              // Enter is deliberately inert while the picker is up: the form
              // still holds whatever the previous lookup left in it, so
              // saving here would store a flight Dan never chose.
              if (e.key === 'Enter' && !busy && !choices) { e.preventDefault(); save() }
            }}
          >
            <h2 className="eyebrow mb-4">{mode === 'edit' ? 'Edit flight' : 'Add flight'}</h2>

            <div className="grid gap-3 grid-cols-[1fr_auto] mb-3">
              <div>
                <label className="eyebrow block mb-1.5" htmlFor="flight-no">Flight #</label>
                <input
                  id="flight-no" type="text" className={FIELD_FULL} value={form.flightNo}
                  disabled={busy} placeholder="AA1234"
                  /* Editing either half of the query drops a pending pick:
                     the list belongs to the number and date it was looked
                     up with, and tapping a leg from the previous query
                     would fill the form with the wrong flight. */
                  onChange={(e) => { setChoices(null); setForm((f) => ({ ...f, flightNo: e.target.value })) }}
                />
              </div>
              <div>
                <label className="eyebrow block mb-1.5" htmlFor="flight-date">Date</label>
                <input
                  id="flight-date" type="date" className={FIELD_FULL} value={form.date}
                  disabled={busy}
                  onChange={(e) => { setChoices(null); setForm((f) => ({ ...f, date: e.target.value })) }}
                />
              </div>
            </div>

            <button
              type="button" onClick={lookup} disabled={busy || !form.flightNo}
              className="mb-4 px-3 py-1.5 text-xs font-semibold uppercase tracking-wider
                         rounded-field border border-line text-muted hover:text-ink disabled:opacity-40"
            >
              {looking ? 'Looking up…' : 'Look up'}
            </button>

            {choices && (
              <div className="mb-4 border border-line rounded-field p-3">
                <p className="eyebrow mb-2">
                  {choices.length} flights that day — which one?
                </p>
                <div className="flex flex-col gap-1.5">
                  {choices.map((leg, i) => {
                    const { route, when } = legChoiceLabel(leg)
                    return (
                      <button
                        /* Index as key: the provider gives legs no id, and
                           this list is replaced wholesale by the next lookup
                           rather than reordered or spliced. */
                        key={i}
                        type="button"
                        onClick={() => applyLeg(leg)}
                        disabled={busy}
                        className="text-left px-3 py-2 rounded-field border border-line
                                   hover:border-accent disabled:opacity-40"
                      >
                        <span className="block text-sm font-semibold">{route}</span>
                        <span className="block text-xs text-muted tabular">{when}</span>
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3 mb-3">
              <div>
                <label className="eyebrow block mb-1.5" htmlFor="dep-airport">From</label>
                <input
                  id="dep-airport" type="text" className={FIELD_FULL} value={form.depAirport}
                  disabled={busy} placeholder="ORD"
                  onChange={(e) => setForm((f) => ({ ...f, depAirport: e.target.value }))}
                />
              </div>
              <div>
                <label className="eyebrow block mb-1.5" htmlFor="arr-airport">To</label>
                <input
                  id="arr-airport" type="text" className={FIELD_FULL} value={form.arrAirport}
                  disabled={busy} placeholder="MCO"
                  onChange={(e) => setForm((f) => ({ ...f, arrAirport: e.target.value }))}
                />
              </div>
            </div>

            <div className="grid gap-3 grid-cols-2 mb-1">
              <div>
                <label className="eyebrow block mb-1.5" htmlFor="dep-date">Departs</label>
                <input
                  id="dep-date" type="date" className={FIELD_FULL} value={form.depDate}
                  disabled={busy}
                  onChange={(e) => setForm((f) => ({ ...f, depDate: e.target.value }))}
                />
              </div>
              <div>
                <label className="eyebrow block mb-1.5" htmlFor="dep-time">Time</label>
                <input
                  id="dep-time" type="time" className={`${FIELD_FULL} tabular`} value={form.depTime}
                  disabled={busy}
                  onChange={(e) => setForm((f) => ({ ...f, depTime: e.target.value }))}
                />
              </div>
            </div>
            <p className="text-xs text-muted mb-3">{timezoneShortLabel(form.depTz ?? 'America/Chicago')} time</p>

            <div className="grid gap-3 grid-cols-2 mb-1">
              <div>
                <label className="eyebrow block mb-1.5" htmlFor="arr-date">Arrives</label>
                <input
                  id="arr-date" type="date" className={FIELD_FULL} value={form.arrDate}
                  disabled={busy}
                  onChange={(e) => setForm((f) => ({ ...f, arrDate: e.target.value }))}
                />
              </div>
              <div>
                <label className="eyebrow block mb-1.5" htmlFor="arr-time">Time</label>
                <input
                  id="arr-time" type="time" className={`${FIELD_FULL} tabular`} value={form.arrTime}
                  disabled={busy}
                  onChange={(e) => setForm((f) => ({ ...f, arrTime: e.target.value }))}
                />
              </div>
            </div>
            <p className="text-xs text-muted mb-4">{timezoneShortLabel(form.arrTz ?? 'America/Chicago')} time</p>

            <div className="mb-5">
              <label className="eyebrow block mb-1.5" htmlFor="flight-note">Note</label>
              <input
                id="flight-note" type="text" className={FIELD_FULL} value={form.note}
                disabled={busy}
                onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
              />
            </div>

            {error && (
              <p role="alert" className="mb-4 text-sm text-danger border-l-2 border-danger pl-3 py-1">
                {error}
              </p>
            )}

            <div className="flex items-center gap-2">
              <button
                type="button" onClick={save} disabled={busy}
                className="px-5 py-2.5 bg-accent-surface text-accent-ink font-bold uppercase
                           tracking-wider text-sm rounded-field hover:opacity-90
                           transition-opacity disabled:opacity-50"
              >
                {pending ? 'Saving…' : 'Save'}
              </button>
              <button
                type="button" onClick={() => setOpen(false)} disabled={busy}
                className="px-4 py-2.5 text-xs font-semibold uppercase tracking-wider
                           rounded-field border border-line text-muted hover:text-ink
                           disabled:opacity-40"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
