'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { formatAmount, formatUSD, parseUSD, overtimeRateFrom } from '@/lib/money'
import { deriveFromDayRate, isDerivableDayRate } from '@/lib/rateCards'
import { saveClient, type CardInput } from '@/app/clients/actions'
import { FIELD_FULL } from '@/components/ui/field'

export type RateCard = {
  id: string
  // NULL is the default (unnamed) card. See saveClient for why there can be
  // only one.
  name: string | null
  day_rate_cents: number
  ot_after_hours: number
  travel_rate_cents: number
  pm_rate_cents: number
  // null = no double time, matching shows.dt_after_hours and ShowSettings.
  dt_after_hours: number | null
  minimum_meal_break_minutes: number
  meal_break_deduction_cap: number
  meal_penalty_grace_hours: number
  meal_penalty_cents: number
  short_turn_rest_hours: number
  continuous_time_enabled: boolean
}

export type EditorClient = {
  id: string
  name: string
  billing_email: string | null
  contact_name: string | null
  phone: string | null
  address_line1: string | null
  address_line2: string | null
  city: string | null
  state: string | null
  postal_code: string | null
  terms_days: number
  notes: string | null
  archived: boolean
  show_hours_on_invoice: boolean
  cards: RateCard[]
}

// Local editing shape for one card row. `key` is stable for React even
// before a new card has an id; `id` is only set once the card exists in
// client_rate_cards, and its presence is what tells saveClient to update
// rather than insert.
type CardRow = {
  key: string
  id?: string
  name: string
  dayRate: string
  otAfterHours: string
  // Raw overrides, blank meaning "use half the day rate" / "use day rate ÷
  // OT hours" — same convention as createShow's own rate boxes. A card that
  // bills travel flat, or at the full day rate, is typed in directly rather
  // than picked from a switch (see lib/rateCards.ts).
  travelRate: string
  pmRate: string
  // Empty box, not "0" — see app/clients/actions.ts on why null and zero
  // must never be conflated here (same rule as ShowSettings).
  dtAfterHours: string
  minMealBreak: string
  mealBreakCap: string
  mealPenaltyGrace: string
  // Raw USD input; "0.00" (the DB default) is a real, legitimate zero here,
  // unlike travelRate/pmRate above — see the Meal penalty field's helper text.
  mealPenalty: string
  shortTurnRest: string
  continuousTime: boolean
}

let tempKeySeq = 0
function tempKey() {
  tempKeySeq += 1
  return `new-${tempKeySeq}`
}

function toCardRow(card: RateCard): CardRow {
  return {
    key: card.id,
    id: card.id,
    name: card.name ?? '',
    dayRate: formatAmount(card.day_rate_cents),
    otAfterHours: String(card.ot_after_hours),
    travelRate: formatAmount(card.travel_rate_cents),
    pmRate: formatAmount(card.pm_rate_cents),
    dtAfterHours: card.dt_after_hours != null ? String(card.dt_after_hours) : '',
    minMealBreak: String(card.minimum_meal_break_minutes),
    mealBreakCap: String(card.meal_break_deduction_cap),
    mealPenaltyGrace: String(card.meal_penalty_grace_hours),
    mealPenalty: formatAmount(card.meal_penalty_cents),
    shortTurnRest: String(card.short_turn_rest_hours),
    continuousTime: card.continuous_time_enabled,
  }
}

// Matches migration 0015's own column defaults, so a brand-new card comes
// out identical to a show created with none of these ever touched.
function blankRules() {
  return {
    dtAfterHours: '',
    minMealBreak: '60',
    mealBreakCap: '60',
    mealPenaltyGrace: '6',
    mealPenalty: '0.00',
    shortTurnRest: '10',
    continuousTime: false,
  }
}

function blankDefaultRow(): CardRow {
  return {
    key: 'default', dayRate: '', otAfterHours: '10', travelRate: '', pmRate: '', name: '',
    ...blankRules(),
  }
}

// Preview only, same disclaimer as before: parseUSD returns null on junk,
// which just hides the preview rather than blocking typing. Real validation
// (including the same "blank means use the default, not $0.00" rule)
// happens in saveClient. Pure — no component state — so both the default and
// named card blocks can share it via CardFields below.
function preview(card: CardRow) {
  const cents = parseUSD(card.dayRate)
  if (cents === null || cents <= 0) return null
  const hours = Number(card.otAfterHours) || 0
  const derived = deriveFromDayRate(cents, hours)
  const travelTyped = isDerivableDayRate(parseUSD(card.travelRate))
  const pmTyped = isDerivableDayRate(parseUSD(card.pmRate))
  const travel = travelTyped ? parseUSD(card.travelRate)! : derived.travel_rate_cents
  const pm = pmTyped ? parseUSD(card.pmRate)! : derived.pm_rate_cents
  return { travel, pm, ot: overtimeRateFrom(cents, hours), hours }
}

/**
 * One card's editable fields — Rates (always visible) then Rules (behind a
 * disclosure, same reasoning ShowSettings uses for its whole "Rates and
 * rules" section: a client can hold several cards on one screen, and the
 * common case is just checking or nudging a rate, not the rules underneath).
 * Shared between the default and named-card blocks so the six rule fields
 * exist in exactly one place in this file.
 */
function CardFields({
  card, idPrefix, onChange,
}: {
  card: CardRow
  idPrefix: string
  onChange: (patch: Partial<CardRow>) => void
}) {
  const p = preview(card)
  const dayRateCents = parseUSD(card.dayRate)

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="eyebrow block mb-2" htmlFor={`${idPrefix}-day-rate`}>Day rate</label>
          <input id={`${idPrefix}-day-rate`} inputMode="decimal" placeholder="e.g. 780"
                 className={FIELD_FULL} value={card.dayRate}
                 onChange={(e) => onChange({ dayRate: e.target.value })} />
        </div>
        <div>
          <label className="eyebrow block mb-2" htmlFor={`${idPrefix}-travel-rate`}>Travel rate</label>
          <input id={`${idPrefix}-travel-rate`} inputMode="decimal" placeholder="Half the day rate"
                 className={FIELD_FULL} value={card.travelRate}
                 onChange={(e) => onChange({ travelRate: e.target.value })} />
        </div>
        <div>
          <label className="eyebrow block mb-2" htmlFor={`${idPrefix}-pm-rate`}>PM rate (per hour)</label>
          <input id={`${idPrefix}-pm-rate`} inputMode="decimal" placeholder="Day rate ÷ OT hours"
                 className={FIELD_FULL} value={card.pmRate}
                 onChange={(e) => onChange({ pmRate: e.target.value })} />
        </div>
        <div>
          <label className="eyebrow block mb-2" htmlFor={`${idPrefix}-ot-after`}>OT after (hours)</label>
          <input id={`${idPrefix}-ot-after`} type="number" min={0} step="0.1" className={FIELD_FULL}
                 value={card.otAfterHours}
                 onChange={(e) => onChange({ otAfterHours: e.target.value })} />
        </div>
        <div>
          <label className="eyebrow block mb-2" htmlFor={`${idPrefix}-dt-after`}>DT after (hours)</label>
          <input id={`${idPrefix}-dt-after`} type="number" min={0} step="0.1" placeholder="No double time"
                 className={FIELD_FULL} value={card.dtAfterHours}
                 onChange={(e) => onChange({ dtAfterHours: e.target.value })} />
          <p className="text-xs text-muted mt-1.5">
            Leave blank for no double time. {dayRateCents !== null && dayRateCents > 0 && card.dtAfterHours.trim() !== ''
              ? 'Hours past this threshold bill at double the day rate.' : ''}
          </p>
        </div>
      </div>
      <p className="text-xs text-muted mt-1.5">
        Travel bills per leg, so a flat rate here doubles a fly-in/fly-out trip from one
        charge to two. Leave travel or PM blank to use the default shown below.
      </p>
      {p && (
        <p className="text-xs text-muted mt-1.5 tabular">
          Travel {formatUSD(p.travel)} · PM {formatUSD(p.pm)}/hr · OT {formatUSD(p.ot)} after {p.hours}h
        </p>
      )}

      <details className="mt-4 group">
        <summary className="eyebrow cursor-pointer select-none list-none flex items-center gap-2">
          <span className="transition-transform group-open:rotate-90">›</span>
          Rules
        </summary>
        <div className="grid gap-4 sm:grid-cols-2 mt-4">
          <div>
            <label className="eyebrow block mb-2" htmlFor={`${idPrefix}-min-meal-break`}>
              Minimum meal break (minutes)
            </label>
            <input id={`${idPrefix}-min-meal-break`} type="number" min={0} step="1" className={FIELD_FULL}
                   value={card.minMealBreak}
                   onChange={(e) => onChange({ minMealBreak: e.target.value })} />
          </div>
          <div>
            <label className="eyebrow block mb-2" htmlFor={`${idPrefix}-meal-break-cap`}>
              Meal break deduction cap (minutes)
            </label>
            <input id={`${idPrefix}-meal-break-cap`} type="number" min={0} step="1" className={FIELD_FULL}
                   value={card.mealBreakCap}
                   onChange={(e) => onChange({ mealBreakCap: e.target.value })} />
          </div>
          <div>
            <label className="eyebrow block mb-2" htmlFor={`${idPrefix}-meal-penalty-grace`}>
              Meal penalty grace (hours)
            </label>
            <input id={`${idPrefix}-meal-penalty-grace`} type="number" min={0} step="0.1" className={FIELD_FULL}
                   value={card.mealPenaltyGrace}
                   onChange={(e) => onChange({ mealPenaltyGrace: e.target.value })} />
          </div>
          <div>
            <label className="eyebrow block mb-2" htmlFor={`${idPrefix}-meal-penalty`}>Meal penalty</label>
            <input id={`${idPrefix}-meal-penalty`} inputMode="decimal" placeholder="0.00" className={FIELD_FULL}
                   value={card.mealPenalty}
                   onChange={(e) => onChange({ mealPenalty: e.target.value })} />
            <p className="text-xs text-muted mt-1.5">Zero disables meal penalties on this card.</p>
          </div>
          <div>
            <label className="eyebrow block mb-2" htmlFor={`${idPrefix}-short-turn-rest`}>
              Short-turn rest (hours)
            </label>
            <input id={`${idPrefix}-short-turn-rest`} type="number" min={0} step="0.1" className={FIELD_FULL}
                   value={card.shortTurnRest}
                   onChange={(e) => onChange({ shortTurnRest: e.target.value })} />
          </div>
          <div className="flex items-end pb-2.5">
            <label className="flex items-center gap-2 text-sm text-muted">
              <input type="checkbox" className="h-4 w-4 accent-accent" checked={card.continuousTime}
                     onChange={(e) => onChange({ continuousTime: e.target.checked })} />
              Continuous time (no meal deduction)
            </label>
          </div>
        </div>
      </details>
    </>
  )
}

export default function ClientEditor({ initial }: { initial?: EditorClient }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const [name, setName] = useState(initial?.name ?? '')
  const [contactName, setContactName] = useState(initial?.contact_name ?? '')
  const [billingEmail, setBillingEmail] = useState(initial?.billing_email ?? '')
  const [phone, setPhone] = useState(initial?.phone ?? '')
  const [addressLine1, setAddressLine1] = useState(initial?.address_line1 ?? '')
  const [addressLine2, setAddressLine2] = useState(initial?.address_line2 ?? '')
  const [city, setCity] = useState(initial?.city ?? '')
  const [stateField, setStateField] = useState(initial?.state ?? '')
  const [postalCode, setPostalCode] = useState(initial?.postal_code ?? '')
  const [termsDays, setTermsDays] = useState(String(initial?.terms_days ?? 30))
  const [notes, setNotes] = useState(initial?.notes ?? '')
  const [archived, setArchived] = useState(initial?.archived ?? false)
  const [showHours, setShowHours] = useState(initial?.show_hours_on_invoice ?? false)

  const initialDefault = initial?.cards.find((c) => c.name === null)
  const initialNamed = initial?.cards.filter((c) => c.name !== null) ?? []
  const [defaultCard, setDefaultCard] = useState<CardRow>(
    initialDefault ? toCardRow(initialDefault) : blankDefaultRow(),
  )
  const [namedCards, setNamedCards] = useState<CardRow[]>(initialNamed.map(toCardRow))

  function updateDefault(patch: Partial<CardRow>) {
    setDefaultCard((c) => ({ ...c, ...patch }))
  }
  function updateNamed(key: string, patch: Partial<CardRow>) {
    setNamedCards((cards) => cards.map((c) => (c.key === key ? { ...c, ...patch } : c)))
  }
  function addNamedCard() {
    setNamedCards((cards) => [
      ...cards,
      { key: tempKey(), name: '', dayRate: '', otAfterHours: '10', travelRate: '', pmRate: '', ...blankRules() },
    ])
  }
  function removeNamedCard(key: string) {
    setNamedCards((cards) => cards.filter((c) => c.key !== key))
  }

  const hasAnyCard = defaultCard.dayRate.trim() !== '' || namedCards.length > 0

  function submit() {
    setError(null)
    setSaved(false)
    start(async () => {
      // Money fields (dayRate, travelRate, pmRate, mealPenalty) travel to
      // saveClient as the raw strings the user typed — parseCards is where
      // parseUSD actually runs, so blank vs. zero is decided in exactly one
      // place. Everything else here is a plain number, same convention
      // ShowSettings already uses for its own submit.
      function toCardInput(c: CardRow, name: string | null): CardInput {
        return {
          id: c.id,
          name,
          day_rate: c.dayRate,
          ot_after_hours: Number(c.otAfterHours) || 0,
          travel_rate: c.travelRate,
          pm_rate: c.pmRate,
          dt_after_hours: c.dtAfterHours,
          minimum_meal_break_minutes: Number(c.minMealBreak) || 0,
          meal_break_deduction_cap: Number(c.mealBreakCap) || 0,
          meal_penalty_grace_hours: Number(c.mealPenaltyGrace) || 0,
          meal_penalty: c.mealPenalty,
          short_turn_rest_hours: Number(c.shortTurnRest) || 0,
          continuous_time_enabled: c.continuousTime,
        }
      }

      const cards: CardInput[] = [
        toCardInput(defaultCard, null),
        ...namedCards.map((c) => toCardInput(c, c.name)),
      ]

      const result = await saveClient({
        id: initial?.id,
        name,
        billing_email: billingEmail,
        contact_name: contactName,
        phone,
        address_line1: addressLine1,
        address_line2: addressLine2,
        city,
        state: stateField,
        postal_code: postalCode,
        // A cleared box is not "Net 0" — Number('') is 0, which would make
        // the due date equal to the issue date. Blank means "use the
        // default" the way it already does for ShowSettings' dt_after_hours.
        terms_days: termsDays.trim() === '' ? 30 : Number(termsDays),
        notes,
        archived,
        show_hours_on_invoice: showHours,
        cards,
      })
      if ('error' in result) { setError(result.error); return }
      setSaved(true)
      router.push(`/clients/${result.id}`)
      router.refresh()
    })
  }

  return (
    <div className="max-w-xl">
      <h1 className="display text-3xl font-bold mb-8">
        {initial ? initial.name : 'New client'}
      </h1>

      <h2 className="eyebrow mb-3">Details</h2>
      <div className="grid gap-4 sm:grid-cols-2 mb-8">
        <div className="sm:col-span-2">
          <label className="eyebrow block mb-2" htmlFor="name">Name</label>
          <input id="name" className={FIELD_FULL} value={name}
                 onChange={(e) => setName(e.target.value)} />
        </div>

        <div>
          <label className="eyebrow block mb-2" htmlFor="contact-name">Contact</label>
          <input id="contact-name" className={FIELD_FULL} value={contactName}
                 onChange={(e) => setContactName(e.target.value)} />
        </div>

        <div>
          <label className="eyebrow block mb-2" htmlFor="phone">Phone</label>
          <input id="phone" className={FIELD_FULL} value={phone}
                 onChange={(e) => setPhone(e.target.value)} />
        </div>

        <div className="sm:col-span-2">
          <label className="eyebrow block mb-2" htmlFor="billing-email">Billing email</label>
          <input id="billing-email" type="email" className={FIELD_FULL} value={billingEmail}
                 onChange={(e) => setBillingEmail(e.target.value)} />
        </div>

        <div>
          <label className="eyebrow block mb-2" htmlFor="address1">Address</label>
          <input id="address1" className={FIELD_FULL} value={addressLine1}
                 placeholder="Line 1"
                 onChange={(e) => setAddressLine1(e.target.value)} />
        </div>

        <div>
          <label className="eyebrow block mb-2 sm:invisible" htmlFor="address2">Address 2</label>
          <input id="address2" className={FIELD_FULL} value={addressLine2}
                 placeholder="Line 2 (optional)"
                 onChange={(e) => setAddressLine2(e.target.value)} />
          <p className="text-xs text-muted mt-1.5">
            If the city, state and ZIP are still here, move them to the fields below.
          </p>
        </div>

        <div>
          <label className="eyebrow block mb-2" htmlFor="city">City</label>
          <input id="city" className={FIELD_FULL} value={city}
                 onChange={(e) => setCity(e.target.value)} />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="eyebrow block mb-2" htmlFor="state">State</label>
            <input id="state" className={FIELD_FULL} value={stateField}
                   placeholder="IL"
                   onChange={(e) => setStateField(e.target.value)} />
          </div>
          <div>
            <label className="eyebrow block mb-2" htmlFor="postal-code">ZIP</label>
            <input id="postal-code" className={FIELD_FULL} value={postalCode}
                   onChange={(e) => setPostalCode(e.target.value)} />
          </div>
        </div>
      </div>

      <h2 className="eyebrow mb-3">Billing</h2>
      <div className="grid gap-4 sm:grid-cols-2 mb-8">
        <div>
          <label className="eyebrow block mb-2" htmlFor="terms">Terms (days)</label>
          <input id="terms" type="number" min={0} className={FIELD_FULL} value={termsDays}
                 onChange={(e) => setTermsDays(e.target.value)} />
          <p className="text-xs text-muted mt-1.5">Leave blank for the default of 30 days.</p>
        </div>
      </div>

      <h2 className="eyebrow mb-3">Rate cards</h2>
      <div className="mb-8 space-y-5">
        <div className="border border-line rounded-field p-4">
          <p className="eyebrow mb-3">Default rate</p>
          <CardFields card={defaultCard} idPrefix="default" onChange={updateDefault} />
        </div>

        {namedCards.map((card) => (
          <div key={card.key} className="border border-line rounded-field p-4">
            <div className="flex items-center justify-between gap-3 mb-3">
              <label className="eyebrow" htmlFor={`card-name-${card.key}`}>Name</label>
              <button type="button" onClick={() => removeNamedCard(card.key)}
                      className="text-xs font-semibold uppercase tracking-wider text-muted hover:text-danger">
                Remove
              </button>
            </div>
            <input id={`card-name-${card.key}`} className={FIELD_FULL} value={card.name}
                   placeholder="e.g. PM"
                   onChange={(e) => updateNamed(card.key, { name: e.target.value })} />

            <div className="mt-4">
              <CardFields card={card} idPrefix={`card-${card.key}`}
                          onChange={(patch) => updateNamed(card.key, patch)} />
            </div>
          </div>
        ))}

        <button type="button" onClick={addNamedCard}
                className="text-xs font-semibold uppercase tracking-wider text-accent hover:opacity-80">
          + Add rate card
        </button>

        {!hasAnyCard && (
          <p className="text-sm text-muted border-l-2 border-accent pl-4 py-1">
            No rate card yet — a show cannot be created for this client until one exists.
          </p>
        )}
      </div>

      <h2 className="eyebrow mb-3">Notes</h2>
      <div className="mb-8">
        <textarea id="notes" rows={3} className={FIELD_FULL} value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Anything about this client worth remembering." />

        <label className="flex items-center gap-2 text-sm text-muted mt-4">
          <input type="checkbox" className="h-4 w-4 accent-accent" checked={archived}
                 onChange={(e) => setArchived(e.target.checked)} />
          Archived — hidden from the active client list
        </label>

        <label className="flex items-center gap-2 text-sm text-muted mt-4">
          <input type="checkbox" className="h-4 w-4 accent-accent"
                 checked={showHours} disabled={pending}
                 onChange={(e) => setShowHours(e.target.checked)} />
          Attach an hours breakdown to this client&rsquo;s invoices
        </label>
        <p className="text-xs text-muted mt-1.5">
          Adds a page listing each day worked, with in and out times and the
          overtime split. Useful for production clients who reconcile against
          a call sheet.
        </p>
      </div>

      {error && (
        <p role="alert" className="mb-5 text-sm text-danger border-l-2 border-danger pl-3 py-1">
          {error}
        </p>
      )}
      {saved && !error && (
        <p className="mb-5 text-sm text-good">Saved.</p>
      )}

      <div className="flex items-center gap-3">
        <button type="button" onClick={submit} disabled={pending}
                className="px-5 py-2.5 bg-accent-surface text-accent-ink font-bold uppercase tracking-wider
                           text-sm rounded-field cursor-pointer hover:opacity-90 transition-opacity
                           disabled:opacity-50 disabled:cursor-not-allowed">
          {pending ? 'Saving…' : initial ? 'Save changes' : 'Create client'}
        </button>
        <button type="button" onClick={() => router.back()} disabled={pending}
                className="px-5 py-2.5 border border-line text-muted font-bold uppercase tracking-wider
                           text-sm rounded-field cursor-pointer hover:text-ink transition-colors">
          Cancel
        </button>
      </div>
    </div>
  )
}
