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
  // EVERY short month is marked, not just the last row. Until 2026-09-09 the
  // walk stopped at the first uncovered month, so the array held at most one
  // and it was always last — `i === lastIndex && !m.covered` was a valid
  // shorthand. The walk now runs the whole horizon (one short month was
  // hiding every month after it), so that shorthand would mark a row red
  // only when the LAST of 24 months happens to be short. In the case this
  // table exists to show — September short, October recovering on booked
  // work — it would have marked nothing at all, silently dropping the very
  // warning the change was meant to surface. Read `!m.covered` per row.

  // bookedThrough names the month WORK ends (lib/forecast.ts), computed
  // independently of the walk. It can still fall past the last rendered row
  // when work is booked beyond the 24-month horizon; the check below simply
  // never matches then, so the marker is omitted rather than mismarking some
  // other row — the headline's own "Booked work runs out after…" line still
  // names the month correctly either way.

  const router = useRouter()
  const [, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  // Which row's save is in flight — NOT useTransition's own `pending`, which
  // is shared across every row's input. Disabling on that shared flag meant
  // blurring cell A disabled cell B the instant focus landed there, dropping
  // keystrokes when tabbing down the column. Only the row actually saving
  // should disable.
  const [savingMonth, setSavingMonth] = useState<string | null>(null)

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
            const uncovered = !m.covered
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
                  {/*
                    Key is deliberately stable (m.month, not tied to a
                    refresh) — a generation-bumped key was tried on
                    2026-09-09 and reverted the same day. Changing the key
                    remounts the input, and the save that triggers a refresh
                    is fire-and-forget: rows re-enable before the refreshed
                    `months` payload arrives, so the user can already be
                    typing into the NEXT cell when the remount lands. That
                    discards focus and whatever they'd typed since — a worse
                    bug than the one being fixed. Residual cost of reverting:
                    after clearing a month that had no saved plan, the box
                    shows blank while the model still charges the take-home
                    fallback, until the next full navigation re-mounts the
                    table from scratch.
                  */}
                  <input
                    key={m.month}
                    aria-label={`Planned draw for ${monthLabel(m.month)}`}
                    inputMode="decimal"
                    className={`${FIELD_FULL} tabular text-right`}
                    defaultValue={(m.plannedDrawCents / 100).toFixed(2)}
                    disabled={savingMonth === m.month}
                    onBlur={(e) => {
                      // Clear any stale error from a PRIOR row's failed save
                      // before anything else runs, so tabbing through
                      // unchanged cells starts from a clean banner instead
                      // of leaving yesterday's failure on screen.
                      setError(null)
                      const raw = e.target.value.trim()
                      const cents = raw === '' ? null : Math.round(Number(raw) * 100)
                      if (cents !== null && !Number.isFinite(cents)) return
                      // Dirty check: skip the round trip when nothing
                      // changed. `m.plannedDrawCents` is always a number
                      // (a saved plan, or the take-home fallback when none
                      // is saved), so `cents === m.plannedDrawCents` is
                      // only ever true when the field still reads the same
                      // amount — untouched-by-tab and reformatted-but-equal
                      // (e.g. "750.00" typed over "750") both land here.
                      // Clearing the field (cents === null) never equals a
                      // number, so it always falls through to the save —
                      // deliberately, even when no plan was saved yet (the
                      // field was only showing the fallback): we cannot
                      // tell "a plan existed" from "the fallback happens to
                      // be showing" from this data alone, and the delete
                      // this sends when no row exists is a harmless no-op,
                      // while skipping it would risk silently ignoring a
                      // real clear against an existing plan.
                      if (cents === m.plannedDrawCents) return
                      setSavingMonth(m.month)
                      startTransition(async () => {
                        const res = await setDrawPlan(m.month, cents)
                        if ('error' in res) setError(res.error)
                        else router.refresh()
                        setSavingMonth(null)
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
