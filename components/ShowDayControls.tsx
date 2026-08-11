'use client'

import Link from 'next/link'
import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { addShowDay, billShows, unlinkShow } from '@/app/shows/actions'
import { todayInChicago } from '@/lib/dates'
import type { DayType } from '@/lib/punchTypes'

const field =
  'w-full px-3 py-2 bg-surface border border-line rounded-field text-ink text-sm ' +
  'focus:border-accent focus:outline-none'

export default function ShowDayControls({
  showId, status, invoiceId, hasLines,
}: {
  showId: string
  status: string
  invoiceId: string | null
  hasLines: boolean
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [date, setDate] = useState(todayInChicago())
  const [dayType, setDayType] = useState<DayType>('show')

  function addDay() {
    setError(null)
    start(async () => {
      const result = await addShowDay(showId, date, dayType)
      if ('error' in result) { setError(result.error); return }
      router.refresh()
    })
  }

  function bill() {
    setError(null)
    start(async () => {
      const result = await billShows([showId])
      if ('error' in result) { setError(result.error); return }
      router.push(`/invoices/${result.invoiceId}`)
      router.refresh()
    })
  }

  function unlink() {
    setError(null)
    start(async () => {
      const result = await unlinkShow(showId)
      if ('error' in result) { setError(result.error); return }
      router.refresh()
    })
  }

  if (status === 'billed') {
    return (
      <div>
        <div className="flex flex-wrap items-center gap-4">
          {invoiceId && (
            <Link href={`/invoices/${invoiceId}`}
                  className="text-sm font-semibold text-accent hover:opacity-80">
              View invoice →
            </Link>
          )}
          <button type="button" onClick={unlink} disabled={pending}
                  className="px-4 py-2 text-xs font-semibold uppercase tracking-wider rounded-field
                             border border-line text-muted hover:text-ink disabled:opacity-50">
            {pending ? 'Unlinking…' : 'Unlink'}
          </button>
        </div>
        {error && <p role="alert" className="mt-3 text-xs text-danger">{error}</p>}
      </div>
    )
  }

  return (
    <div>
      <div className="flex flex-wrap items-end gap-3 mb-6">
        <div>
          <label className="eyebrow block mb-1.5" htmlFor="showDayDate">Date</label>
          <input id="showDayDate" type="date" className={field} value={date}
                 onChange={(e) => setDate(e.target.value)} />
        </div>
        <div>
          <label className="eyebrow block mb-1.5" htmlFor="showDayType">Type</label>
          <select id="showDayType" className={field} value={dayType}
                  onChange={(e) => setDayType(e.target.value as DayType)}>
            <option value="show">Show</option>
            <option value="travel">Travel</option>
            <option value="pm">PM</option>
          </select>
        </div>
        <button type="button" onClick={addDay} disabled={pending}
                className="px-4 py-2 text-xs font-semibold uppercase tracking-wider rounded-field
                           border border-line text-muted hover:text-ink disabled:opacity-50">
          {pending ? 'Adding…' : '+ Add day'}
        </button>
      </div>

      <button type="button" onClick={bill} disabled={pending || !hasLines}
              className="px-5 py-2.5 bg-accent text-accent-ink font-bold uppercase tracking-wider
                         text-sm rounded-field hover:opacity-90 disabled:opacity-50">
        {pending ? 'Billing…' : 'Bill this show'}
      </button>
      {!hasLines && (
        <p className="text-xs text-muted mt-2">
          Complete at least one day&rsquo;s punches before billing.
        </p>
      )}

      {error && <p role="alert" className="mt-3 text-xs text-danger">{error}</p>}
    </div>
  )
}
