'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { formatAmount, formatUSD, parseUSD } from '@/lib/money'
import { updateShow } from '@/app/shows/actions'
import { TIMEZONES, DEFAULT_TIMEZONE } from '@/lib/timezones'
import { FIELD_FULL } from '@/components/ui/field'
import Select from '@/components/ui/Select'


export type EditorShow = {
  id: string
  name: string
  venue: string | null
  /** Free text, "San Diego, CA" — where the show is, for scanning a list.
   *  Separate from venue (the building). Nothing computes on it; see
   *  migration 0017. */
  location: string | null
  notes: string | null
  timezone: string
  // The rate card this show was created from (migration 0013), frozen at
  // creation and never rewritten by updateShow — it re-derives nothing from
  // the rates below, so editing them can leave this label describing a card
  // the show no longer resembles. Null for a show created from the client's
  // unnamed default, which decorates no invoice line.
  rate_card_name: string | null
  day_rate_cents: number
  travel_rate_cents: number
  pm_rate_cents: number
  ot_after_hours: number
  dt_after_hours: number | null
  minimum_meal_break_minutes: number
  meal_break_deduction_cap: number
  meal_penalty_grace_hours: number
  meal_penalty_cents: number
  short_turn_rest_hours: number
  continuous_time_enabled: boolean
  bill_hourly: boolean
}

export default function ShowSettings({ initial, locked }: { initial: EditorShow; locked: boolean }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const [name, setName] = useState(initial.name)
  const [venue, setVenue] = useState(initial.venue ?? '')
  const [location, setLocation] = useState(initial.location ?? '')
  const [notes, setNotes] = useState(initial.notes ?? '')
  // Punch times are stored as instants and displayed in this zone. Getting it
  // wrong does not change the hours billed — a duration is a duration — but
  // every time you read back is shifted, which matters most on site.
  const [timezone, setTimezone] = useState(initial.timezone ?? DEFAULT_TIMEZONE)

  const [dayRate, setDayRate] = useState(formatAmount(initial.day_rate_cents))
  const [travelRate, setTravelRate] = useState(formatAmount(initial.travel_rate_cents))
  const [pmRate, setPmRate] = useState(formatAmount(initial.pm_rate_cents))
  const [otAfterHours, setOtAfterHours] = useState(String(initial.ot_after_hours))
  // Empty box, not "0" — see app/shows/actions.ts on why null and zero must
  // never be conflated here.
  const [dtAfterHours, setDtAfterHours] = useState(
    initial.dt_after_hours != null ? String(initial.dt_after_hours) : '',
  )

  const [minMealBreak, setMinMealBreak] = useState(String(initial.minimum_meal_break_minutes))
  const [mealBreakCap, setMealBreakCap] = useState(String(initial.meal_break_deduction_cap))
  const [mealPenaltyGrace, setMealPenaltyGrace] = useState(String(initial.meal_penalty_grace_hours))
  const [mealPenalty, setMealPenalty] = useState(formatAmount(initial.meal_penalty_cents))
  const [shortTurnRest, setShortTurnRest] = useState(String(initial.short_turn_rest_hours))
  const [continuousTime, setContinuousTime] = useState(initial.continuous_time_enabled)
  const [billHourly, setBillHourly] = useState(initial.bill_hourly)

  // Preview only, mirroring ClientEditor: parseUSD returns null on junk,
  // which just hides the hint rather than blocking typing. Real validation
  // happens server-side in updateShow.
  const dayRateCents = parseUSD(dayRate)
  const otHours = Number(otAfterHours) || 0

  function submit() {
    setError(null)
    setSaved(false)
    start(async () => {
      const result = await updateShow({
        id: initial.id,
        name,
        venue,
        location,
        notes,
        day_rate: dayRate,
        travel_rate: travelRate,
        pm_rate: pmRate,
        ot_after_hours: Number(otAfterHours),
        dt_after_hours: dtAfterHours,
        minimum_meal_break_minutes: Number(minMealBreak),
        meal_break_deduction_cap: Number(mealBreakCap),
        meal_penalty_grace_hours: Number(mealPenaltyGrace),
        meal_penalty: mealPenalty,
        timezone,
        short_turn_rest_hours: Number(shortTurnRest),
        continuous_time_enabled: continuousTime,
        // Always sent, never omitted — updateShow treats an absent value as
        // "leave it alone" (see app/shows/actions.ts), so a save meaning to
        // turn this off must still send `false` explicitly.
        bill_hourly: billHourly,
      })
      if ('error' in result) { setError(result.error); return }
      setSaved(true)
      router.refresh()
    })
  }

  return (
    <details className="mb-10 group">
      <summary className="eyebrow cursor-pointer select-none list-none flex items-center gap-2">
        <span className="transition-transform group-open:rotate-90">›</span>
        Rates and rules
      </summary>

      <div className="mt-5 max-w-xl">
        <p className="text-xs text-muted mb-6 border-l-2 border-line pl-3 py-1">
          These values were copied from the client&rsquo;s rate card when this show was created.
          Changing the client&rsquo;s rate card later will not alter this show — edit it here instead.
          {locked && ' This show is billed, so it is locked until you unlink it.'}
        </p>

        <div className="grid gap-4 sm:grid-cols-2 mb-8">
          <div className="sm:col-span-2">
            <label className="eyebrow block mb-2" htmlFor="show-name">Name</label>
            <input id="show-name" className={FIELD_FULL} value={name} disabled={locked || pending}
                   onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <label className="eyebrow block mb-2" htmlFor="show-venue">Venue</label>
            <input id="show-venue" className={FIELD_FULL} value={venue} disabled={locked || pending}
                   onChange={(e) => setVenue(e.target.value)} />
          </div>
          <div>
            <label className="eyebrow block mb-2" htmlFor="show-location">Location</label>
            <input id="show-location" className={FIELD_FULL} value={location} disabled={locked || pending}
                   placeholder="San Diego, CA" onChange={(e) => setLocation(e.target.value)} />
            <p className="text-xs text-muted mt-1.5">
              The city, for scanning the shows list — venue is the building.
            </p>
          </div>
          <div className="sm:col-span-2">
            <label className="eyebrow block mb-2">Timezone</label>
            <Select
              ariaLabel="Timezone"
              value={timezone}
              disabled={locked || pending}
              onChange={setTimezone}
              options={TIMEZONES.map((tz) => ({ value: tz.value, label: tz.label }))}
            />
            <p className="text-xs text-muted mt-1.5">
              Where the work happens, not where you bill from. Punch times display in this
              zone; hours billed are unaffected either way.
            </p>
          </div>
        </div>

        <h2 className="eyebrow mb-3">Rates</h2>
        <p className="text-xs text-muted mb-4 border-l-2 border-line pl-3 py-1">
          {initial.rate_card_name ? (
            <>
              Frozen from the <strong className="text-ink">&ldquo;{initial.rate_card_name}&rdquo;</strong> rate
              card — every line this show bills prints with that name attached
              (&ldquo;Day Rate — {initial.rate_card_name}&rdquo;). Editing the rates below changes what is
              billed, not this label.
            </>
          ) : (
            <>
              Frozen from the client&rsquo;s <strong className="text-ink">default</strong> rate card, which
              decorates no invoice line. Editing the rates below changes what is billed, not that.
            </>
          )}
        </p>
        <div className="grid gap-4 sm:grid-cols-2 mb-8">
          <div>
            <label className="eyebrow block mb-2" htmlFor="day-rate">Day rate</label>
            <input id="day-rate" inputMode="decimal" className={FIELD_FULL} value={dayRate}
                   disabled={locked || pending} onChange={(e) => setDayRate(e.target.value)} />
          </div>
          <div>
            <label className="eyebrow block mb-2" htmlFor="travel-rate">Travel rate</label>
            <input id="travel-rate" inputMode="decimal" className={FIELD_FULL} value={travelRate}
                   disabled={locked || pending} onChange={(e) => setTravelRate(e.target.value)} />
          </div>
          <div>
            <label className="eyebrow block mb-2" htmlFor="pm-rate">PM rate (per hour)</label>
            <input id="pm-rate" inputMode="decimal" className={FIELD_FULL} value={pmRate}
                   disabled={locked || pending} onChange={(e) => setPmRate(e.target.value)} />
          </div>
          <div>
            <label className="eyebrow block mb-2" htmlFor="ot-after">OT after (hours)</label>
            <input id="ot-after" type="number" min={0.1} step="0.1" className={FIELD_FULL}
                   value={otAfterHours} disabled={locked || pending}
                   onChange={(e) => setOtAfterHours(e.target.value)} />
          </div>
          <div>
            <label className="eyebrow block mb-2" htmlFor="dt-after">DT after (hours)</label>
            <input id="dt-after" type="number" min={0} step="0.1" placeholder="No double time"
                   className={FIELD_FULL} value={dtAfterHours} disabled={locked || pending}
                   onChange={(e) => setDtAfterHours(e.target.value)} />
            <p className="text-xs text-muted mt-1.5">
              Leave blank for no double time. {dayRateCents !== null && dayRateCents > 0 && dtAfterHours.trim() !== ''
                ? 'Hours past this threshold bill at double the day rate.' : ''}
            </p>
          </div>
        </div>

        <h2 className="eyebrow mb-3">Rules</h2>
        <div className="grid gap-4 sm:grid-cols-2 mb-8">
          <div>
            <label className="eyebrow block mb-2" htmlFor="min-meal-break">
              Minimum meal break (minutes)
            </label>
            <input id="min-meal-break" type="number" min={0} step="1" className={FIELD_FULL}
                   value={minMealBreak} disabled={locked || pending}
                   onChange={(e) => setMinMealBreak(e.target.value)} />
          </div>
          <div>
            <label className="eyebrow block mb-2" htmlFor="meal-break-cap">
              Meal break deduction cap (minutes)
            </label>
            <input id="meal-break-cap" type="number" min={0} step="1" className={FIELD_FULL}
                   value={mealBreakCap} disabled={locked || pending}
                   onChange={(e) => setMealBreakCap(e.target.value)} />
          </div>
          <div>
            <label className="eyebrow block mb-2" htmlFor="meal-penalty-grace">
              Meal penalty grace (hours)
            </label>
            <input id="meal-penalty-grace" type="number" min={0} step="0.1" className={FIELD_FULL}
                   value={mealPenaltyGrace} disabled={locked || pending}
                   onChange={(e) => setMealPenaltyGrace(e.target.value)} />
          </div>
          <div>
            <label className="eyebrow block mb-2" htmlFor="meal-penalty">Meal penalty</label>
            <input id="meal-penalty" inputMode="decimal" placeholder="0.00" className={FIELD_FULL}
                   value={mealPenalty} disabled={locked || pending}
                   onChange={(e) => setMealPenalty(e.target.value)} />
            <p className="text-xs text-muted mt-1.5">Zero disables meal penalties for this show.</p>
          </div>
          <div>
            <label className="eyebrow block mb-2" htmlFor="short-turn-rest">
              Short-turn rest (hours)
            </label>
            <input id="short-turn-rest" type="number" min={0} step="0.1" className={FIELD_FULL}
                   value={shortTurnRest} disabled={locked || pending}
                   onChange={(e) => setShortTurnRest(e.target.value)} />
          </div>
          <div className="flex items-end pb-2.5">
            <label className="flex items-center gap-2 text-sm text-muted">
              <input type="checkbox" className="h-4 w-4 accent-accent" checked={continuousTime}
                     disabled={locked || pending}
                     onChange={(e) => setContinuousTime(e.target.checked)} />
              Continuous time (no meal deduction)
            </label>
          </div>
          <div className="flex items-end pb-2.5">
            <div>
              <label className="flex items-center gap-2 text-sm text-muted">
                <input type="checkbox" className="h-4 w-4 accent-accent" checked={billHourly}
                       disabled={locked || pending}
                       onChange={(e) => setBillHourly(e.target.checked)} />
                Bill by the hour under the overtime threshold
              </label>
              {billHourly && otHours > 0 && dayRateCents !== null && dayRateCents > 0 && (
                <p className="text-xs text-muted mt-1.5">
                  Days under {otHours}h bill at {formatUSD(Math.round(dayRateCents / otHours))}/hr
                  ({formatUSD(dayRateCents)} ÷ {otHours}). {otHours}h+ days bill the day rate plus overtime.
                </p>
              )}
            </div>
          </div>
        </div>

        <h2 className="eyebrow mb-3">Notes</h2>
        <div className="mb-8">
          <textarea id="show-notes" rows={3} className={FIELD_FULL} value={notes}
                    disabled={locked || pending}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Anything about this show worth remembering." />
        </div>

        {error && (
          <p role="alert" className="mb-5 text-sm text-danger border-l-2 border-danger pl-3 py-1">
            {error}
          </p>
        )}
        {saved && !error && (
          <p className="mb-5 text-sm text-good">Saved.</p>
        )}

        <button type="button" onClick={submit} disabled={locked || pending}
                className="px-5 py-2.5 bg-accent-surface text-accent-ink font-bold uppercase tracking-wider
                           text-sm rounded-field cursor-pointer hover:opacity-90 transition-opacity
                           disabled:opacity-50 disabled:cursor-not-allowed">
          {pending ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </details>
  )
}
