// The unbilled shows list — navigation only. Billing happens on a show's own
// detail page ("Bill this show"), never from here, so this is a plain list of
// links and the whole card opens the show. The inline reason (unfinished days,
// missing receipts) is still shown at a glance, so Dan can see which shows need
// work before they can be billed there — but it no longer gates a checkbox,
// because there is no longer a checkbox.

import Link from 'next/link'
import { formatUSD } from '@/lib/money'
import { formatDateShort } from '@/lib/dates'

export type UnbilledShow = {
  id: string
  name: string
  venue: string | null
  location: string | null
  clientName: string
  dates: string[]
  totalCents: number
  unfinishedDates: string[]
  /** where_spent of each expense missing a receipt. */
  expensesNeedingReceipts: string[]
  /** Today falls within the show's days — it is being worked right now. */
  inProgress: boolean
}

export default function UnbilledShows({ shows }: { shows: UnbilledShow[] }) {
  return (
    <ul className="border-t border-line">
      {shows.map((s) => {
        const unfinished = s.unfinishedDates.length > 0
        const receiptsMissing = s.expensesNeedingReceipts.length > 0
        // The show being worked right now gets the amber accent and an
        // "In progress" chip — the same treatment as the current day on the
        // show page — so it stands out rather than fading.
        return (
          <li key={s.id} className="border-b border-line">
            {/* The whole card is one link: a tap anywhere opens the show. The
                current show's amber highlight bleeds left into the gutter — the
                accent border's side, mirroring the current day on the show page
                — and never past the right margin, so the price and text keep
                their edge padding. */}
            <Link href={`/shows/${s.id}`} className={`block py-4 pl-3 -ml-3 pr-3 ${
              s.inProgress ? 'border-l-2 border-l-accent bg-accent-wash' : ''
            }`}>
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <span className="font-semibold">
                  {s.name}
                  {s.inProgress && (
                    <span className="ml-2 align-middle text-[11px] font-bold uppercase tracking-wider
                                     text-accent-ink bg-accent-surface rounded-field px-1.5 py-0.5">
                      In progress
                    </span>
                  )}
                </span>
                <span className="tabular text-sm font-semibold">{formatUSD(s.totalCents)}</span>
              </div>
              {/* Location, not venue — the city is what Dan scans for here, and
                  this line also carries a day count and date, so keeping it
                  short matters at 375px. */}
              <p className="text-xs text-muted mt-1">
                {s.clientName}{s.location ? ` · ${s.location}` : ''}
                {s.dates.length > 0 &&
                  ` · ${s.dates.length} ${s.dates.length === 1 ? 'day' : 'days'} · ${formatDateShort(s.dates[0])}`}
              </p>
              {unfinished ? (
                <p className="text-xs text-accent mt-1">
                  Finish {s.unfinishedDates.join(', ')} before billing — add punches, mark travel, or remove the day.
                </p>
              ) : receiptsMissing ? (
                <p className="text-xs text-accent mt-1">
                  {s.expensesNeedingReceipts.length} {s.expensesNeedingReceipts.length === 1 ? 'expense needs' : 'expenses need'} a receipt: {s.expensesNeedingReceipts.join(', ')}.
                </p>
              ) : null}
            </Link>
          </li>
        )
      })}
    </ul>
  )
}
