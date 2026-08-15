'use client'

// One invoice, one client — billShows (app/shows/actions.ts) already refuses a
// mixed-client selection and an incomplete day server-side. This component's
// job is to make both states unreachable from the checkboxes rather than let
// the user hit that error: once anything is checked, other clients' shows
// disable with an inline reason, and a show with an incomplete day is never
// selectable at all.
//
// The server page ran computeShowLines per show and handed down each show's
// raw BucketLine[] alongside its own already-rounded totalCents. Per-row
// display uses totalCents (exact for a single show — computeShowLines never
// emits two lines with the same description and price within one show, so
// there is nothing to merge). The multi-show running total below is
// different: it calls mergeLines and lineTotal, the SAME audited functions
// billShows calls, rather than summing each show's rounded total, because
// round(a) + round(b) is not always round(a + b) once two shows' lines merge.
// That is calling the server's own money functions from the client bundle,
// not reimplementing money math in the browser.

import Link from 'next/link'
import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { billShows } from '@/app/shows/actions'
import { formatUSD, lineTotal } from '@/lib/money'
import { mergeLines, type BucketLine } from '@/lib/showBuckets'
import { formatDateShort } from '@/lib/dates'

export type UnbilledShow = {
  id: string
  name: string
  venue: string | null
  location: string | null
  clientId: string
  clientName: string
  dates: string[]
  totalCents: number
  lines: BucketLine[]
  incompleteDates: string[]
  /** where_spent of each expense missing a receipt — mirrors incompleteDates. */
  expensesNeedingReceipts: string[]
}

export default function UnbilledShows({ shows }: { shows: UnbilledShow[] }) {
  const router = useRouter()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const selectedShows = shows.filter((s) => selected.has(s.id))
  const activeClientId = selectedShows[0]?.clientId ?? null
  // Merge across shows BEFORE rounding to cents, then round each merged
  // line once — the exact order billShows uses server-side (mergeLines,
  // then lineTotal inside saveInvoice). Summing each show's already-rounded
  // totalCents instead can disagree with the invoice billShows actually
  // creates by a cent, because round(a) + round(b) is not always
  // round(a + b).
  const mergedSelectedLines = mergeLines(selectedShows.map((s) => s.lines))
  const total = mergedSelectedLines.reduce((sum, l) => sum + lineTotal(l.qty_hundredths, l.unit_price_cents), 0)

  function toggle(id: string) {
    setError(null)
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function bill() {
    setError(null)
    start(async () => {
      const result = await billShows([...selected])
      if ('error' in result) { setError(result.error); return }
      router.push(`/invoices/${result.invoiceId}`)
      router.refresh()
    })
  }

  return (
    <div>
      <ul className="border-t border-line mb-4">
        {shows.map((s) => {
          const incomplete = s.incompleteDates.length > 0
          // A day with no punches isn't "incomplete" (isIncompleteDay([]) is
          // false), so a show whose days are all punchless would otherwise
          // stay selectable at $0.00. Mirror ShowDayControls' !hasLines gate
          // so an empty show can never ride along on someone else's invoice
          // and get silently marked billed.
          const empty = s.lines.length === 0
          // Mirrors ShowDayControls' expensesNeedingReceipts gate and
          // billShows' own refusal (app/shows/actions.ts) — "every expense
          // has to have a receipt to bill" — so a show missing one can never
          // be selected here and fail only after the click.
          const receiptsMissing = s.expensesNeedingReceipts.length > 0
          const checked = selected.has(s.id)
          const wrongClient = activeClientId !== null && s.clientId !== activeClientId && !checked
          const disabled = incomplete || empty || receiptsMissing || wrongClient

          // The show name stays a real Link to /shows/id (e.g. to finish an
          // incomplete punch) so it lives outside the <label> below — a link
          // nested inside a label can double as a toggle in some browsers.
          // The rest of the row (client/venue/day-count line) is the
          // checkbox's label, giving it a larger, thumb-friendly tap target.
          const inputId = `unbilled-${s.id}`
          return (
            <li key={s.id} className={`border-b border-line py-4 px-2 -mx-2 ${disabled ? 'opacity-50' : ''}`}>
              <div className="flex items-start gap-3">
                <input
                  id={inputId}
                  type="checkbox"
                  className="mt-1 h-4 w-4 shrink-0"
                  checked={checked}
                  disabled={pending || disabled}
                  onChange={() => toggle(s.id)}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                    <Link href={`/shows/${s.id}`} className="font-semibold hover:text-accent">
                      {s.name}
                    </Link>
                    <span className="tabular text-sm font-semibold">{formatUSD(s.totalCents)}</span>
                  </div>
                  {/* Location, not venue — the same swap as the billed list on
                      this page. Venue is the long building name and already
                      shown on the show page; location (the city) is what Dan
                      scans for here, and this line also carries a day count
                      and date, so keeping it short matters more here than
                      there at 375px. */}
                  <label htmlFor={inputId} className={`block text-xs text-muted mt-1 ${disabled ? '' : 'cursor-pointer'}`}>
                    {s.clientName}{s.location ? ` · ${s.location}` : ''}
                    {s.dates.length > 0 &&
                      ` · ${s.dates.length} ${s.dates.length === 1 ? 'day' : 'days'} · ${formatDateShort(s.dates[0])}`}
                  </label>
                  {incomplete ? (
                    <p className="text-xs text-accent mt-1">
                      Finish punches for {s.incompleteDates.join(', ')} before this can be billed.
                    </p>
                  ) : receiptsMissing ? (
                    <p className="text-xs text-accent mt-1">
                      {s.expensesNeedingReceipts.length} {s.expensesNeedingReceipts.length === 1 ? 'expense needs' : 'expenses need'} a receipt: {s.expensesNeedingReceipts.join(', ')}.
                    </p>
                  ) : empty ? (
                    <p className="text-xs text-muted mt-1">Nothing to bill yet.</p>
                  ) : wrongClient ? (
                    <p className="text-xs text-muted mt-1">
                      Different client — one invoice can only bill one client at a time.
                    </p>
                  ) : null}
                </div>
              </div>
            </li>
          )
        })}
      </ul>

      <div className="flex flex-wrap items-center justify-between gap-4">
        <p className="tabular text-sm">
          {selected.size === 0 ? (
            <span className="text-muted">Select shows to bill.</span>
          ) : (
            <>
              <span className="text-muted">{selected.size} selected · </span>
              <span className="font-semibold">{formatUSD(total)}</span>
            </>
          )}
        </p>
        <button type="button" onClick={bill} disabled={pending || selected.size === 0}
                className="px-5 py-2.5 bg-accent-surface text-accent-ink font-bold uppercase tracking-wider
                           text-sm rounded-field hover:opacity-90 disabled:opacity-50">
          {pending ? 'Billing…' : 'Bill selected'}
        </button>
      </div>

      {error && <p role="alert" className="mt-3 text-xs text-danger">{error}</p>}
    </div>
  )
}
