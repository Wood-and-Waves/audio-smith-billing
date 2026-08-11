'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { createShow } from '@/app/shows/actions'

const field =
  'w-full px-3 py-2 bg-surface border border-line rounded-field text-ink text-sm ' +
  'focus:border-accent focus:outline-none'

type Client = { id: string; name: string; day_rate_cents: number | null }

export default function NewShowForm({ clients }: { clients: Client[] }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [clientId, setClientId] = useState('')
  const [name, setName] = useState('')
  const [venue, setVenue] = useState('')

  const client = clients.find((c) => c.id === clientId)
  // createShow refuses a client with no day rate on file — freezing a $0
  // rate onto the show would later print a "$0.00" invoice line. There is
  // no client editor yet, so we can only explain this, not fix it here.
  const noDayRate = !!client && client.day_rate_cents == null

  function submit() {
    setError(null)
    start(async () => {
      const result = await createShow({ client_id: clientId, name, venue })
      if ('error' in result) { setError(result.error); return }
      router.push(`/shows/${result.id}`)
      router.refresh()
    })
  }

  return (
    <div className="max-w-xl">
      <h1 className="display text-3xl font-bold mb-8">New show</h1>

      <div className="mb-4">
        <label className="eyebrow block mb-2" htmlFor="client">Client</label>
        <select id="client" className={field} value={clientId}
                onChange={(e) => setClientId(e.target.value)}>
          <option value="">Choose a client…</option>
          {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
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

      <div className="mb-4">
        <label className="eyebrow block mb-2" htmlFor="name">Name</label>
        <input id="name" className={field} value={name} placeholder="GLS 2026"
               onChange={(e) => setName(e.target.value)} />
      </div>

      <div className="mb-8">
        <label className="eyebrow block mb-2" htmlFor="venue">Venue (optional)</label>
        <input id="venue" className={field} value={venue}
               onChange={(e) => setVenue(e.target.value)} />
      </div>

      {error && (
        <p role="alert" className="mb-5 text-sm text-danger border-l-2 border-danger pl-3 py-1">
          {error}
        </p>
      )}

      <button type="button" onClick={submit} disabled={pending || noDayRate}
              className="px-5 py-2.5 bg-accent-surface text-accent-ink font-bold uppercase tracking-wider
                         text-sm rounded-field cursor-pointer hover:opacity-90 disabled:opacity-50">
        {pending ? 'Creating…' : 'Create show'}
      </button>
    </div>
  )
}
