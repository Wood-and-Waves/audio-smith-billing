'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { formatAmount, formatUSD, parseUSD, travelRateFrom, overtimeRateFrom } from '@/lib/money'
import { saveClient } from '@/app/clients/actions'

const field =
  'w-full px-3 py-2 bg-surface border border-line rounded-field text-ink text-sm ' +
  'focus:border-accent focus:outline-none'

export type EditorClient = {
  id: string
  name: string
  billing_email: string | null
  contact_name: string | null
  phone: string | null
  address_line1: string | null
  address_line2: string | null
  terms_days: number
  day_rate_cents: number | null
  ot_after_hours: number
  notes: string | null
  archived: boolean
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
  const [termsDays, setTermsDays] = useState(String(initial?.terms_days ?? 30))
  const [dayRate, setDayRate] = useState(
    initial?.day_rate_cents != null ? formatAmount(initial.day_rate_cents) : '',
  )
  const [otAfterHours, setOtAfterHours] = useState(String(initial?.ot_after_hours ?? 10))
  const [notes, setNotes] = useState(initial?.notes ?? '')
  const [archived, setArchived] = useState(initial?.archived ?? false)

  // Preview only — parseUSD returns null on junk, which just hides the
  // preview rather than blocking typing. The real validation happens in
  // saveClient when the form is submitted.
  const rateCents = useMemo(() => parseUSD(dayRate), [dayRate])
  const otHours = Number(otAfterHours) || 0

  function submit() {
    setError(null)
    start(async () => {
      const result = await saveClient({
        id: initial?.id,
        name,
        billing_email: billingEmail,
        contact_name: contactName,
        phone,
        address_line1: addressLine1,
        address_line2: addressLine2,
        // A cleared box is not "Net 0" — Number('') is 0, which would make
        // the due date equal to the issue date. Blank means "use the
        // default" the way it already does for ShowSettings' dt_after_hours.
        terms_days: termsDays.trim() === '' ? 30 : Number(termsDays),
        day_rate: dayRate,
        ot_after_hours: Number(otAfterHours),
        notes,
        archived,
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
          <input id="name" className={field} value={name}
                 onChange={(e) => setName(e.target.value)} />
        </div>

        <div>
          <label className="eyebrow block mb-2" htmlFor="contact-name">Contact</label>
          <input id="contact-name" className={field} value={contactName}
                 onChange={(e) => setContactName(e.target.value)} />
        </div>

        <div>
          <label className="eyebrow block mb-2" htmlFor="phone">Phone</label>
          <input id="phone" className={field} value={phone}
                 onChange={(e) => setPhone(e.target.value)} />
        </div>

        <div className="sm:col-span-2">
          <label className="eyebrow block mb-2" htmlFor="billing-email">Billing email</label>
          <input id="billing-email" type="email" className={field} value={billingEmail}
                 onChange={(e) => setBillingEmail(e.target.value)} />
        </div>

        <div>
          <label className="eyebrow block mb-2" htmlFor="address1">Address</label>
          <input id="address1" className={field} value={addressLine1}
                 placeholder="Line 1"
                 onChange={(e) => setAddressLine1(e.target.value)} />
        </div>

        <div>
          <label className="eyebrow block mb-2 sm:invisible" htmlFor="address2">Address 2</label>
          <input id="address2" className={field} value={addressLine2}
                 placeholder="Line 2 (optional)"
                 onChange={(e) => setAddressLine2(e.target.value)} />
        </div>
      </div>

      <h2 className="eyebrow mb-3">Billing</h2>
      <div className="grid gap-4 sm:grid-cols-2 mb-8">
        <div>
          <label className="eyebrow block mb-2" htmlFor="terms">Terms (days)</label>
          <input id="terms" type="number" min={0} className={field} value={termsDays}
                 onChange={(e) => setTermsDays(e.target.value)} />
          <p className="text-xs text-muted mt-1.5">Leave blank for the default of 30 days.</p>
        </div>

        <div>
          <label className="eyebrow block mb-2" htmlFor="ot-hours">OT after (hours)</label>
          <input id="ot-hours" type="number" min={0} step="0.1" className={field}
                 value={otAfterHours} onChange={(e) => setOtAfterHours(e.target.value)} />
        </div>

        <div className="sm:col-span-2">
          <label className="eyebrow block mb-2" htmlFor="day-rate">Day rate</label>
          <input id="day-rate" inputMode="decimal" placeholder="e.g. 780" className={field}
                 value={dayRate} onChange={(e) => setDayRate(e.target.value)} />
          {rateCents !== null && rateCents > 0 && (
            <p className="text-xs text-muted mt-1.5 tabular">
              Travel {formatUSD(travelRateFrom(rateCents))} · OT{' '}
              {formatUSD(overtimeRateFrom(rateCents, otHours))} after {otHours}h
            </p>
          )}
          {dayRate.trim() === '' && (
            <p className="text-xs text-muted mt-1.5">
              No rate card — this client is billed ad hoc. Shows can&rsquo;t be tracked for them
              until a day rate is set here.
            </p>
          )}
        </div>
      </div>

      <h2 className="eyebrow mb-3">Notes</h2>
      <div className="mb-8">
        <textarea id="notes" rows={3} className={field} value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Anything about this client worth remembering." />

        <label className="flex items-center gap-2 text-sm text-muted mt-4">
          <input type="checkbox" className="h-4 w-4 accent-accent" checked={archived}
                 onChange={(e) => setArchived(e.target.checked)} />
          Archived — hidden from the active client list
        </label>
      </div>

      {error && (
        <p role="alert" className="mb-5 text-sm text-danger border-l-2 border-danger pl-3 py-1">
          {error}
        </p>
      )}

      <div className="flex items-center gap-3">
        <button type="button" onClick={submit} disabled={pending}
                className="px-5 py-2.5 bg-accent text-accent-ink font-bold uppercase tracking-wider
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
