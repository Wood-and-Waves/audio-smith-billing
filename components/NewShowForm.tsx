'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { createShow } from '@/app/shows/actions'
import { formatUSD, formatAmount, parseUSD } from '@/lib/money'
import { deriveFromDayRate, isDerivableDayRate } from '@/lib/rateCards'
import { TIMEZONES } from '@/lib/timezones'
import { FIELD_FULL } from '@/components/ui/field'
import Select from '@/components/ui/Select'

export type RateCard = {
  id: string
  name: string | null
  day_rate_cents: number
  ot_after_hours: number
  travel_full_day: boolean
}

export type Client = { id: string; name: string; cards: RateCard[] }

/** "Default — $780.00" for the unnamed card; a named card is "PM — $900.00". */
function cardLabel(card: RateCard): string {
  const rate = formatUSD(card.day_rate_cents)
  return card.name ? `${card.name} — ${rate}` : `Default — ${rate}`
}

/** The travel/PM rates this card's own rules imply, formatted for the boxes. */
function ratesFor(card: RateCard) {
  const hours = Number(card.ot_after_hours) || 10
  const derived = deriveFromDayRate(card.day_rate_cents, hours, card.travel_full_day)
  return {
    day: formatAmount(card.day_rate_cents),
    travel: formatAmount(derived.travel_rate_cents),
    pm: formatAmount(derived.pm_rate_cents),
    ot: String(hours),
  }
}

export default function NewShowForm({ clients }: { clients: Client[] }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [clientId, setClientId] = useState('')
  const [rateCardId, setRateCardId] = useState('')
  const [name, setName] = useState('')
  const [venue, setVenue] = useState('')
  // No default — see lib/timezones.ts. A silent America/Chicago default is
  // the bug this screen exists to close; the field starts empty and the
  // button stays disabled until Dan actually picks one.
  const [timezone, setTimezone] = useState('')

  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  // Off by default, both of them: Dan was explicit that travel legs are a
  // choice, never automatic. They only do anything once a date range exists
  // for setTravelLeg to apply them to (see the disabled state below).
  const [travelIn, setTravelIn] = useState(false)
  const [travelOut, setTravelOut] = useState(false)

  const [dayRate, setDayRate] = useState('')
  const [travelRate, setTravelRate] = useState('')
  const [pmRate, setPmRate] = useState('')
  const [otAfterHours, setOtAfterHours] = useState('')
  // "Dirty" tracking, the same idea as a form library's touched-fields set:
  // once Dan types directly into travel or PM, a later day-rate edit must
  // leave that box alone. This is the fix for the bug rate cards exist to
  // prevent — an edited day rate silently leaving a stale travel/PM rate
  // behind — applied here instead of only at edit time.
  const [travelDirty, setTravelDirty] = useState(false)
  const [pmDirty, setPmDirty] = useState(false)

  // Set once createShow succeeds but reports a warning (e.g. the days could
  // not be added). The show already exists at that point — this hides the
  // rest of the form so a second click can't create a duplicate, and offers
  // a way to actually reach the show that was created.
  const [createdId, setCreatedId] = useState<string | null>(null)
  const [warning, setWarning] = useState<string | null>(null)

  const client = clients.find((c) => c.id === clientId)
  const cards = client?.cards ?? []
  // createShow refuses a client with no cards at all — freezing a $0 rate
  // onto the show would later print a "$0.00" invoice line.
  const noDayRate = !!client && cards.length === 0
  const needsCardChoice = cards.length > 1
  const selectedCard = needsCardChoice ? cards.find((c) => c.id === rateCardId) : cards[0]
  const hasRange = !!fromDate && !!toDate
  // Mirrors the ordering half of app/shows/actions.ts's walkDateRange
  // pre-flight, so the common typo (a swapped From/To, or a mistyped year
  // like 2062) is caught here instead of round-tripping to the server —
  // createShow still refuses it either way, this is only for faster
  // feedback.
  const dateOrderError = hasRange && toDate < fromDate
    ? 'End date must be on or after the start date.' : null
  // Neither blocks submission nor is sent anywhere — createShow's own
  // `hasRange` sends the pair or nothing, so a single date typed here is
  // otherwise silently dropped with no feedback at all. The show is still
  // valid without days, so this is informational, not an error.
  const partialRange = (!!fromDate) !== (!!toDate)

  function clearRates() {
    setDayRate('')
    setTravelRate('')
    setPmRate('')
    setOtAfterHours('')
    setTravelDirty(false)
    setPmDirty(false)
  }

  function applyCard(card: RateCard) {
    const rates = ratesFor(card)
    setDayRate(rates.day)
    setTravelRate(rates.travel)
    setPmRate(rates.pm)
    setOtAfterHours(rates.ot)
    setTravelDirty(false)
    setPmDirty(false)
  }

  function onClientChange(id: string) {
    setClientId(id)
    setRateCardId('')
    const next = clients.find((c) => c.id === id)
    const only = next && next.cards.length === 1 ? next.cards[0] : undefined
    if (only) applyCard(only); else clearRates()
  }

  function onRateCardChange(id: string) {
    setRateCardId(id)
    const card = cards.find((c) => c.id === id)
    if (card) applyCard(card); else clearRates()
  }

  // The one place "day rate changed" turns into "re-derive travel and PM" —
  // unless the user has typed into those boxes themselves, in which case
  // they keep exactly what was typed. See deriveFromDayRate in
  // lib/rateCards.ts, the same function createShow itself uses, so the
  // preview shown here can never disagree with what actually gets saved.
  function onDayRateChange(value: string) {
    setDayRate(value)
    if (!selectedCard) return
    const parsed = parseUSD(value)
    // Not `=== null`: parseUSD('') is 0, not null, so a cleared box would
    // otherwise pass this guard and re-derive travel/PM from $0.00 — the
    // exact bug rate cards exist to prevent. Leave both boxes as they are
    // until a real, positive day rate is typed again.
    if (!isDerivableDayRate(parsed)) return
    const hours = Number(otAfterHours) || Number(selectedCard.ot_after_hours) || 10
    const derived = deriveFromDayRate(parsed, hours, selectedCard.travel_full_day)
    if (!travelDirty) setTravelRate(formatAmount(derived.travel_rate_cents))
    if (!pmDirty) setPmRate(formatAmount(derived.pm_rate_cents))
  }

  function onTravelRateChange(value: string) {
    setTravelRate(value)
    setTravelDirty(true)
  }

  function onPmRateChange(value: string) {
    setPmRate(value)
    setPmDirty(true)
  }

  function submit() {
    setError(null)
    start(async () => {
      const result = await createShow({
        client_id: clientId,
        name,
        venue,
        timezone,
        // A client with one card sends no rate_card_id, exactly as before
        // cards existed — createShow falls back to that one card on its own.
        ...(needsCardChoice ? { rate_card_id: rateCardId } : {}),
        // Both or neither: a single date with nothing to pair it with is not
        // a range, so it is simply not sent rather than guessed at.
        ...(hasRange ? { start_date: fromDate, end_date: toDate } : {}),
        ...(hasRange && travelIn ? { travel_in: true } : {}),
        ...(hasRange && travelOut ? { travel_out: true } : {}),
        day_rate: dayRate,
        travel_rate: travelRate,
        pm_rate: pmRate,
        ot_after_hours: otAfterHours,
      })
      if ('error' in result) { setError(result.error); return }
      if (result.warning) {
        // The show exists — addShowDays or setTravelLeg came back with a
        // problem, but that is not the same thing as createShow failing.
        setCreatedId(result.id)
        setWarning(result.warning)
        router.refresh()
        return
      }
      router.push(`/shows/${result.id}`)
      router.refresh()
    })
  }

  const canSubmit = !pending && !noDayRate && !!timezone && (!needsCardChoice || !!rateCardId)
    && !dateOrderError

  if (createdId) {
    return (
      <div className="max-w-xl">
        <h1 className="display text-3xl font-bold mb-8">New show</h1>
        <p role="alert" className="mb-5 text-sm text-danger border-l-2 border-danger pl-3 py-1">
          {warning}
        </p>
        <Link href={`/shows/${createdId}`}
              className="inline-block px-5 py-2.5 bg-accent-surface text-accent-ink font-bold
                         uppercase tracking-wider text-sm rounded-field hover:opacity-90">
          Continue to the show →
        </Link>
      </div>
    )
  }

  return (
    <div className="max-w-xl">
      <h1 className="display text-3xl font-bold mb-8">New show</h1>

      <div className="mb-4">
        <label className="eyebrow block mb-2">Client</label>
        <Select
          ariaLabel="Client"
          value={clientId}
          onChange={onClientChange}
          options={[
            { value: '', label: 'Choose a client…' },
            ...clients.map((c) => ({ value: c.id, label: c.name })),
          ]}
        />
        <p className="text-xs text-muted mt-1.5">
          Their rate card is copied onto this show, so a later rate change
          won&rsquo;t alter what you bill here.
        </p>
        {noDayRate && (
          <p role="alert" className="text-xs text-danger mt-1.5 border-l-2 border-danger pl-3 py-1">
            {client!.name} has no day rate on file, so a show can&rsquo;t be tracked for them yet.
          </p>
        )}
      </div>

      {needsCardChoice && (
        <div className="mb-4">
          <label className="eyebrow block mb-2">Rate card</label>
          <Select
            ariaLabel="Rate card"
            value={rateCardId}
            onChange={onRateCardChange}
            options={[
              { value: '', label: 'Choose a rate card…' },
              ...cards.map((c) => ({ value: c.id, label: cardLabel(c) })),
            ]}
          />
        </div>
      )}

      {!needsCardChoice && cards.length === 1 && (
        <p className="text-xs text-muted mb-4">Rate: {formatUSD(cards[0].day_rate_cents)}</p>
      )}

      <div className="mb-4">
        <label className="eyebrow block mb-2" htmlFor="name">Name</label>
        <input id="name" className={FIELD_FULL} value={name} placeholder="GLS 2026"
               onChange={(e) => setName(e.target.value)} />
      </div>

      <div className="mb-4">
        <label className="eyebrow block mb-2" htmlFor="venue">Venue (optional)</label>
        <input id="venue" className={FIELD_FULL} value={venue}
               onChange={(e) => setVenue(e.target.value)} />
      </div>

      <div className="mb-8">
        <label className="eyebrow block mb-2">Timezone</label>
        <Select
          ariaLabel="Timezone"
          value={timezone}
          onChange={setTimezone}
          options={[
            { value: '', label: 'Choose a timezone…' },
            ...TIMEZONES.map((tz) => ({ value: tz.value, label: tz.label })),
          ]}
        />
        <p className="text-xs text-muted mt-1.5">
          Where the work happens, not where you bill from. Punch times display in this
          zone; hours billed are unaffected either way.
        </p>
      </div>

      <h2 className="eyebrow mb-3">Dates (optional)</h2>
      <div className="mb-4">
        {/* grid-cols-2 (not sm:grid-cols-2): the two date inputs need
            min-w-0 to actually shrink at 375px, the same fix ShowDayControls
            already uses for this exact pair of fields. */}
        <div className="grid grid-cols-2 gap-3">
          <div className="min-w-0">
            <label className="eyebrow block mb-2" htmlFor="from-date">From</label>
            <input id="from-date" type="date" className={FIELD_FULL} value={fromDate}
                   onChange={(e) => setFromDate(e.target.value)} />
          </div>
          <div className="min-w-0">
            <label className="eyebrow block mb-2" htmlFor="to-date">To</label>
            <input id="to-date" type="date" className={FIELD_FULL} value={toDate}
                   onChange={(e) => setToDate(e.target.value)} />
          </div>
        </div>
        <p className="text-xs text-muted mt-1.5">
          Give both to create the show&rsquo;s days now. Leave both blank to add days later.
        </p>
        {dateOrderError && (
          <p role="alert" className="text-xs text-danger mt-1.5 border-l-2 border-danger pl-3 py-1">
            {dateOrderError}
          </p>
        )}
        {!dateOrderError && partialRange && (
          <p className="text-xs text-muted mt-1.5 border-l-2 border-line pl-3 py-1">
            Give both dates, or neither.
          </p>
        )}
      </div>

      <div className="mb-8">
        <label className="flex items-center gap-2 text-sm text-muted mb-2">
          <input type="checkbox" className="h-4 w-4 accent-accent" checked={travelIn}
                 disabled={!hasRange} onChange={(e) => setTravelIn(e.target.checked)} />
          Mark the first day as a travel-in leg
        </label>
        <label className="flex items-center gap-2 text-sm text-muted">
          <input type="checkbox" className="h-4 w-4 accent-accent" checked={travelOut}
                 disabled={!hasRange} onChange={(e) => setTravelOut(e.target.checked)} />
          Mark the last day as a travel-out leg
        </label>
        {!hasRange && (
          <p className="text-xs text-muted mt-1.5">Give both dates above to use these.</p>
        )}
      </div>

      {selectedCard && (
        <>
          <h2 className="eyebrow mb-3">Rates</h2>
          <p className="text-xs text-muted mb-4 border-l-2 border-line pl-3 py-1">
            Pre-filled from the chosen rate card. Editing the day rate updates travel and PM
            with it, unless you edit those yourself.
          </p>
          <div className="grid gap-4 sm:grid-cols-2 mb-8">
            <div>
              <label className="eyebrow block mb-2" htmlFor="day-rate">Day rate</label>
              <input id="day-rate" inputMode="decimal" className={FIELD_FULL} value={dayRate}
                     onChange={(e) => onDayRateChange(e.target.value)} />
            </div>
            <div>
              <label className="eyebrow block mb-2" htmlFor="travel-rate">Travel rate</label>
              <input id="travel-rate" inputMode="decimal" className={FIELD_FULL} value={travelRate}
                     onChange={(e) => onTravelRateChange(e.target.value)} />
            </div>
            <div>
              <label className="eyebrow block mb-2" htmlFor="pm-rate">PM rate (per hour)</label>
              <input id="pm-rate" inputMode="decimal" className={FIELD_FULL} value={pmRate}
                     onChange={(e) => onPmRateChange(e.target.value)} />
            </div>
            <div>
              <label className="eyebrow block mb-2" htmlFor="ot-after">OT after (hours)</label>
              <input id="ot-after" type="number" min={0.1} step="0.1" className={FIELD_FULL}
                     value={otAfterHours} onChange={(e) => setOtAfterHours(e.target.value)} />
            </div>
          </div>
        </>
      )}

      {error && (
        <p role="alert" className="mb-5 text-sm text-danger border-l-2 border-danger pl-3 py-1">
          {error}
        </p>
      )}

      <button type="button" onClick={submit} disabled={!canSubmit}
              className="px-5 py-2.5 bg-accent-surface text-accent-ink font-bold uppercase tracking-wider
                         text-sm rounded-field cursor-pointer hover:opacity-90 disabled:opacity-50">
        {pending ? 'Creating…' : 'Create show'}
      </button>
    </div>
  )
}
