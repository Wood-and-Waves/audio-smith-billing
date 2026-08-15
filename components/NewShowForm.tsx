'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { createShow } from '@/app/shows/actions'
import { formatUSD } from '@/lib/money'
import { FIELD_FULL } from '@/components/ui/field'
import Select from '@/components/ui/Select'

export type RateCard = { id: string; name: string | null; day_rate_cents: number }

export type Client = { id: string; name: string; cards: RateCard[] }

/** "Default — $780.00" for the unnamed card; a named card is "PM — $900.00". */
function cardLabel(card: RateCard): string {
  const rate = formatUSD(card.day_rate_cents)
  return card.name ? `${card.name} — ${rate}` : `Default — ${rate}`
}

export default function NewShowForm({ clients }: { clients: Client[] }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [clientId, setClientId] = useState('')
  const [rateCardId, setRateCardId] = useState('')
  const [name, setName] = useState('')
  const [venue, setVenue] = useState('')

  const client = clients.find((c) => c.id === clientId)
  const cards = client?.cards ?? []
  // createShow refuses a client with no cards at all — freezing a $0 rate
  // onto the show would later print a "$0.00" invoice line.
  const noDayRate = !!client && cards.length === 0
  const needsCardChoice = cards.length > 1

  function onClientChange(id: string) {
    setClientId(id)
    setRateCardId('')
  }

  function submit() {
    setError(null)
    start(async () => {
      const result = await createShow({
        client_id: clientId,
        name,
        venue,
        // A client with one card sends no rate_card_id, exactly as before
        // cards existed — createShow falls back to that one card on its own.
        ...(needsCardChoice ? { rate_card_id: rateCardId } : {}),
      })
      if ('error' in result) { setError(result.error); return }
      router.push(`/shows/${result.id}`)
      router.refresh()
    })
  }

  const canSubmit = !pending && !noDayRate && (!needsCardChoice || !!rateCardId)

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
            onChange={setRateCardId}
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

      <div className="mb-8">
        <label className="eyebrow block mb-2" htmlFor="venue">Venue (optional)</label>
        <input id="venue" className={FIELD_FULL} value={venue}
               onChange={(e) => setVenue(e.target.value)} />
      </div>

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
