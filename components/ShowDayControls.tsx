'use client'

import Link from 'next/link'
import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { addShowDays, billShows, unlinkShow } from '@/app/shows/actions'
import { todayInChicago, addDays } from '@/lib/dates'
import { FIELD_FULL } from '@/components/ui/field'


// From defaults to the day after the show's last existing day, not today —
// on an in-progress multi-day trip "today" is nearly always wrong, and every
// add used to start by correcting the date. To matches From, so adding a
// single day is still one click.
function defaultRangeStart(lastDayDate: string | null): string {
  return lastDayDate ? addDays(lastDayDate, 1) : todayInChicago()
}

export default function ShowDayControls({
  showId, status, invoiceId, hasLines, incompleteDates, expensesNeedingReceipts, lastDayDate,
}: {
  showId: string
  status: string
  invoiceId: string | null
  hasLines: boolean
  incompleteDates: string[]
  /** where_spent of each expense missing a receipt — mirrors incompleteDates. */
  expensesNeedingReceipts: string[]
  lastDayDate: string | null
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [startDate, setStartDate] = useState(() => defaultRangeStart(lastDayDate))
  const [endDate, setEndDate] = useState(() => defaultRangeStart(lastDayDate))

  function addDayRange() {
    setError(null)
    setInfo(null)
    start(async () => {
      const result = await addShowDays(showId, startDate, endDate)
      if ('error' in result) { setError(result.error); return }
      const dayWord = (n: number) => `${n} day${n === 1 ? '' : 's'}`
      setInfo(
        result.skipped > 0
          ? `${dayWord(result.created)} added, ${result.skipped} ${result.skipped === 1 ? 'was' : 'were'} already there.`
          : `${dayWord(result.created)} added.`,
      )
      // Slide the range forward, so a second add right after (e.g. filling
      // in the rest of a trip) starts the day after what was just
      // requested rather than sitting on a now-stale date.
      const next = addDays(endDate, 1)
      setStartDate(next)
      setEndDate(next)
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
      <div className="mb-6">
        {/* A grid, not flex-wrap. The two date fields and the button used to
            sit in one wrapping flex row, and an iOS date control will not
            shrink below its intrinsic width (~130-160px) — so on a 375px
            phone, with 335px of usable width, it was the BUTTON that got
            squeezed rather than the row wrapping. Two columns for the dates,
            the button on its own full-width row beneath, and min-w-0 so the
            fields can actually give ground. */}
        <div className="grid grid-cols-2 gap-3 sm:flex sm:flex-wrap sm:items-end">
          <div className="min-w-0">
            <label className="eyebrow block mb-1.5" htmlFor="showDayStart">From</label>
            <input id="showDayStart" type="date" className={FIELD_FULL} value={startDate}
                   onChange={(e) => setStartDate(e.target.value)} />
          </div>
          <div className="min-w-0">
            <label className="eyebrow block mb-1.5" htmlFor="showDayEnd">To</label>
            <input id="showDayEnd" type="date" className={FIELD_FULL} value={endDate}
                   onChange={(e) => setEndDate(e.target.value)} />
          </div>
          {/* A date input can be cleared, which submits "". The action refuses
              that too — this just stops the pointless round trip.
              Styled as a real action, not the ghost treatment it had: muted
              grey on a border barely above the surface, and a size SMALLER
              than "Bill this show" below it, so the less obvious control was
              also the quieter one. */}
          <button type="button" onClick={addDayRange} disabled={pending || !startDate || !endDate}
                  className="col-span-2 w-full sm:w-auto px-5 py-2.5 bg-accent-surface text-accent-ink
                             font-bold uppercase tracking-wider text-sm rounded-field
                             hover:opacity-90 disabled:opacity-50">
            {pending ? 'Adding…' : '+ Add days'}
          </button>
        </div>
        {info && <p className="text-xs text-muted mt-2">{info}</p>}
      </div>

      <button type="button" onClick={bill}
              disabled={pending || !hasLines || incompleteDates.length > 0 || expensesNeedingReceipts.length > 0}
              className="px-5 py-2.5 bg-accent-surface text-accent-ink font-bold uppercase tracking-wider
                         text-sm rounded-field hover:opacity-90 disabled:opacity-50">
        {pending ? 'Billing…' : 'Bill this show'}
      </button>
      {incompleteDates.length > 0 ? (
        <p className="text-xs text-accent mt-2">
          Finish punches for {incompleteDates.join(', ')} before billing.
        </p>
      ) : expensesNeedingReceipts.length > 0 ? (
        <p className="text-xs text-accent mt-2">
          {expensesNeedingReceipts.length} {expensesNeedingReceipts.length === 1 ? 'expense needs' : 'expenses need'} a receipt: {expensesNeedingReceipts.join(', ')}.
        </p>
      ) : !hasLines ? (
        <p className="text-xs text-muted mt-2">
          Complete at least one day&rsquo;s punches before billing.
        </p>
      ) : null}

      {error && <p role="alert" className="mt-3 text-xs text-danger">{error}</p>}
    </div>
  )
}
