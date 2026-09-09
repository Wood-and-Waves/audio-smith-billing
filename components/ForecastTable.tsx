'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { monthLabel } from '@/lib/dates'
import { formatUSD } from '@/lib/money'
import { FIELD_FULL } from '@/components/ui/field'
import { setDrawPlan } from '@/app/money/forecast/actions'
import type { ForecastMonth } from '@/lib/forecast'

// This became a client component (Task 5) only so the Draw column can be
// edited in place — the register's established idiom: useTransition,
// router.refresh() on success, an {error} line the user can actually see.
// A real <table> (not the register's CSS-grid rows) because every row here
// is uniform and short; the header idiom is still the app's own:
// eyebrow-style labels over a border-line rule, same as the rest of /money.

export default function ForecastTable({
  months,
  bookedThrough,
}: {
  months: ForecastMonth[]
  /** YYYY-MM — the last month carrying booked work, or null. */
  bookedThrough: string | null
}) {
  // buildForecast's month walk stops the instant it hits an uncovered month
  // (lib/forecast.ts, the `if (!covered) { ...; break }`), so the returned
  // array holds at most one uncovered month and it is always the last row —
  // no separate search needed.
  const lastIndex = months.length - 1

  // bookedThrough now names the month WORK ends (lib/forecast.ts), which is
  // computed independently of the walk and can fall on a month past the
  // last rendered row when the walk broke early on an uncovered month first
  // (a thin balance biting before the calendar does). The check below
  // (`m.month === bookedThrough`) simply never matches in that case, so the
  // marker is silently omitted rather than mismarking some other row or
  // needing a fallback — the headline's own "Booked work runs out after…"
  // line still names the month correctly either way, so nothing is lost.

  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-line">
            <th className="eyebrow pb-2 pr-3 text-left font-semibold">Month</th>
            <th className="eyebrow px-3 pb-2 text-right font-semibold">In</th>
            <th className="eyebrow px-3 pb-2 text-right font-semibold">Overhead</th>
            <th className="eyebrow px-3 pb-2 text-right font-semibold">Tax set-aside</th>
            <th className="eyebrow px-3 pb-2 text-right font-semibold">Draw</th>
            <th className="eyebrow pb-2 pl-3 text-right font-semibold">Ending balance</th>
          </tr>
        </thead>
        <tbody>
          {months.map((m, i) => {
            const uncovered = i === lastIndex && !m.covered
            const isBookedThrough = m.month === bookedThrough
            return (
              <tr
                key={m.month}
                className={`border-b border-line ${uncovered ? 'text-danger' : ''}`}
              >
                <td className="py-2.5 pr-3 whitespace-nowrap">
                  {monthLabel(m.month)}
                  {uncovered && (
                    <span className="ml-2 text-[10px] font-semibold uppercase tracking-wider">
                      Short
                    </span>
                  )}
                  {isBookedThrough && (
                    <span className="ml-2 text-[10px] font-semibold uppercase tracking-wider text-muted">
                      Booked work ends
                    </span>
                  )}
                </td>
                <td className="tabular px-3 py-2.5 text-right">{formatUSD(m.incomeCents)}</td>
                <td className="tabular px-3 py-2.5 text-right">{formatUSD(m.overheadCents)}</td>
                <td className="tabular px-3 py-2.5 text-right">{formatUSD(m.taxCents)}</td>
                <td className="tabular px-3 py-2.5 text-right">
                  {/*
                    Editing the PLAN, not the net draw. For month 0,
                    drawCents is already net of what's been drawn this month
                    (lib/forecast.ts) — showing that as the editable value
                    would mean an owner typing $2,000 over a displayed $0.00
                    actually saves a plan that redisplays as something else
                    entirely. plannedDrawCents is the pre-subtraction figure,
                    so it's what the input shows and what setDrawPlan saves;
                    the net "left to take" figure is shown alongside it,
                    read-only, only for the current month.
                  */}
                  <input
                    aria-label={`Planned draw for ${monthLabel(m.month)}`}
                    inputMode="decimal"
                    className={`${FIELD_FULL} tabular text-right`}
                    defaultValue={(m.plannedDrawCents / 100).toFixed(2)}
                    disabled={pending}
                    onBlur={(e) => {
                      const raw = e.target.value.trim()
                      const cents = raw === '' ? null : Math.round(Number(raw) * 100)
                      if (cents !== null && !Number.isFinite(cents)) return
                      startTransition(async () => {
                        const res = await setDrawPlan(m.month, cents)
                        if ('error' in res) setError(res.error)
                        else { setError(null); router.refresh() }
                      })
                    }}
                  />
                  {i === 0 && (
                    <div className="text-xs text-muted mt-1">
                      {formatUSD(m.drawCents)} left to take
                    </div>
                  )}
                </td>
                <td className="tabular py-2.5 pl-3 text-right font-semibold">
                  {formatUSD(m.endingBalanceCents)}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {error && <p role="alert" className="text-danger text-xs mt-2">{error}</p>}
    </div>
  )
}
