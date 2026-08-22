import { monthLabel } from '@/lib/dates'
import { formatUSD } from '@/lib/money'
import type { ForecastMonth } from '@/lib/forecast'

// No hooks, no client-only behavior — this is a plain server component. A
// real <table> (not the register's CSS-grid rows) because every row here is
// uniform and short; the header idiom is still the app's own: eyebrow-style
// labels over a border-line rule, same as the rest of /money.

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
                <td className="tabular px-3 py-2.5 text-right">{formatUSD(m.drawCents)}</td>
                <td className="tabular py-2.5 pl-3 text-right font-semibold">
                  {formatUSD(m.endingBalanceCents)}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
