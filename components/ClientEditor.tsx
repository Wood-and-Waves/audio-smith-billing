'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { formatAmount, formatUSD, parseUSD, travelRateFrom, overtimeRateFrom } from '@/lib/money'
import { saveClient, type CardInput } from '@/app/clients/actions'
import { FIELD_FULL } from '@/components/ui/field'

export type RateCard = {
  id: string
  // NULL is the default (unnamed) card. See saveClient for why there can be
  // only one.
  name: string | null
  day_rate_cents: number
  ot_after_hours: number
  travel_full_day: boolean
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
  travelFullDay: boolean
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
    travelFullDay: card.travel_full_day,
  }
}

function blankDefaultRow(): CardRow {
  return { key: 'default', dayRate: '', otAfterHours: '10', travelFullDay: false, name: '' }
}

export default function ClientEditor({ initial }: { initial?: EditorClient }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)

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
      { key: tempKey(), name: '', dayRate: '', otAfterHours: '10', travelFullDay: false },
    ])
  }
  function removeNamedCard(key: string) {
    setNamedCards((cards) => cards.filter((c) => c.key !== key))
  }

  const hasAnyCard = defaultCard.dayRate.trim() !== '' || namedCards.length > 0

  // Preview only, same disclaimer as the day-rate preview this replaces:
  // parseUSD returns null on junk, which just hides the preview rather than
  // blocking typing. Real validation happens in saveClient.
  function preview(card: CardRow) {
    const cents = parseUSD(card.dayRate)
    if (cents === null || cents <= 0) return null
    const hours = Number(card.otAfterHours) || 0
    const travel = card.travelFullDay ? cents : travelRateFrom(cents)
    return { travel, ot: overtimeRateFrom(cents, hours), hours }
  }

  function submit() {
    setError(null)
    start(async () => {
      const cards: CardInput[] = [
        {
          id: defaultCard.id,
          name: null,
          day_rate: defaultCard.dayRate,
          ot_after_hours: Number(defaultCard.otAfterHours) || 0,
          travel_full_day: defaultCard.travelFullDay,
        },
        ...namedCards.map((c) => ({
          id: c.id,
          name: c.name,
          day_rate: c.dayRate,
          ot_after_hours: Number(c.otAfterHours) || 0,
          travel_full_day: c.travelFullDay,
        })),
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
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="eyebrow block mb-2" htmlFor="default-day-rate">Day rate</label>
              <input id="default-day-rate" inputMode="decimal" placeholder="e.g. 780"
                     className={FIELD_FULL} value={defaultCard.dayRate}
                     onChange={(e) => updateDefault({ dayRate: e.target.value })} />
            </div>
            <div>
              <label className="eyebrow block mb-2" htmlFor="default-ot-hours">OT after (hours)</label>
              <input id="default-ot-hours" type="number" min={0} step="0.1" className={FIELD_FULL}
                     value={defaultCard.otAfterHours}
                     onChange={(e) => updateDefault({ otAfterHours: e.target.value })} />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm text-muted mt-4">
            <input type="checkbox" className="h-4 w-4 accent-accent" checked={defaultCard.travelFullDay}
                   onChange={(e) => updateDefault({ travelFullDay: e.target.checked })} />
            Travel bills a full day rate
          </label>
          <p className="text-xs text-muted mt-1.5">
            Travel bills per leg, so this doubles a fly-in/fly-out trip from one day rate to two —
            unchecked, that trip bills a half rate each way instead.
          </p>
          {(() => {
            const p = preview(defaultCard)
            return p && (
              <p className="text-xs text-muted mt-1.5 tabular">
                Travel {formatUSD(p.travel)} · OT {formatUSD(p.ot)} after {p.hours}h
              </p>
            )
          })()}
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

            <div className="grid gap-4 sm:grid-cols-2 mt-4">
              <div>
                <label className="eyebrow block mb-2" htmlFor={`card-rate-${card.key}`}>Day rate</label>
                <input id={`card-rate-${card.key}`} inputMode="decimal" placeholder="e.g. 900"
                       className={FIELD_FULL} value={card.dayRate}
                       onChange={(e) => updateNamed(card.key, { dayRate: e.target.value })} />
              </div>
              <div>
                <label className="eyebrow block mb-2" htmlFor={`card-ot-${card.key}`}>OT after (hours)</label>
                <input id={`card-ot-${card.key}`} type="number" min={0} step="0.1" className={FIELD_FULL}
                       value={card.otAfterHours}
                       onChange={(e) => updateNamed(card.key, { otAfterHours: e.target.value })} />
              </div>
            </div>

            <label className="flex items-center gap-2 text-sm text-muted mt-4">
              <input type="checkbox" className="h-4 w-4 accent-accent" checked={card.travelFullDay}
                     onChange={(e) => updateNamed(card.key, { travelFullDay: e.target.checked })} />
              Travel bills a full day rate
            </label>
            <p className="text-xs text-muted mt-1.5">
              Travel bills per leg, so this doubles a fly-in/fly-out trip from one day rate to two —
              unchecked, that trip bills a half rate each way instead.
            </p>
            {(() => {
              const p = preview(card)
              return p && (
                <p className="text-xs text-muted mt-1.5 tabular">
                  Travel {formatUSD(p.travel)} · OT {formatUSD(p.ot)} after {p.hours}h
                </p>
              )
            })()}
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
