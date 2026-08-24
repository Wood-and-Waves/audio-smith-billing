'use client'

import Link from 'next/link'
import { useEffect, useId, useRef, useState } from 'react'
import { monthLabel } from '@/lib/dates'
import { FIRST_BUDGET_MONTH } from '@/lib/budget'
import { cn } from '@/lib/cn'

// The budget header's month label, turned into a YNAB-style popover: a year
// row (‹ 2026 ›) over a 4x3 grid of month abbreviations. Modelled on YNAB's
// own picker because that's the one Dan already uses daily — see this
// task's brief for why nine months of ‹ › clicking is fine today but
// fourteen clicks by next March isn't.

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const pad2 = (n: number) => String(n).padStart(2, '0')

/**
 * Does any month in `year` fall inside [FIRST_BUDGET_MONTH, lastMonth]?
 * Compared as plain zero-padded 'YYYY-MM' strings — same lexical trick
 * lib/budget.ts relies on elsewhere, and total here for the same reason: a
 * year with no overlap at either end has no overlap anywhere in between.
 */
function yearInRange(year: number, lastMonth: string): boolean {
  return `${year}-01` <= lastMonth && `${year}-12` >= FIRST_BUDGET_MONTH
}

/**
 * `month`'s label as a button; clicking it opens the popover described
 * above. Three states per month cell, and YNAB's own rule for the third one
 * (Dan's explicit instruction, not a guess): grey an unreachable month, do
 * not hide it, so the grid's shape never shifts under the pointer and a
 * greyed month still reads as "not yet, but not nothing" rather than simply
 * missing.
 *
 * - Selected — the month on screen: filled (`bg-accent-surface
 *   text-accent-ink`), same fill idiom as YNAB's current-month purple.
 * - Available — navigable. Split again by `today`: not-yet-arrived months
 *   read a little lighter (`text-ink/70`) than already-past ones
 *   (`text-ink`), matching YNAB, but every available month is a real
 *   `<Link>` — budgeting ahead is allowed here.
 * - Out of range — `text-muted`, no hover, a `disabled` `<button>` rather
 *   than a link, so it's unreachable by keyboard too and colour is never
 *   the only signal.
 *
 * `today` and `lastMonth` arrive as props (both 'YYYY-MM') instead of being
 * computed in here: `lib/dates.ts`'s `todayInChicago()` reads the clock, and
 * this component has to agree with the exact range the server component
 * already committed to when it rendered the page around it, not take a
 * second, possibly different, read of "now" on the client. `FIRST_BUDGET_MONTH`
 * is imported straight from `lib/budget.ts` instead, per that file's own
 * "do not redefine this" — it's a constant, not a moment, so there's no
 * clock-skew reason to thread it through as a prop too.
 */
export default function MonthPicker({
  month, today, lastMonth, filter,
}: {
  /** The month on screen, 'YYYY-MM'. Renders filled in the grid. */
  month: string
  /** Today's month, 'YYYY-MM' — splits Available into past (full strength) and future (subdued). */
  today: string
  /** Upper bound of the viewable range, 'YYYY-MM' — the page's `addMonths(today, MAX_MONTHS_AHEAD)`. */
  lastMonth: string
  /** The active filter chip, e.g. 'overspent', if one is on. Carried onto every month link so picking a month never silently resets it back to All. */
  filter?: string
}) {
  const [open, setOpen] = useState(false)
  const [viewYear, setViewYear] = useState(() => Number(month.slice(0, 4)))
  const wrapRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const panelId = useId()

  // Reopening always lands on the year of the month actually on screen, not
  // wherever a previous visit left the year stepper.
  useEffect(() => {
    if (open) setViewYear(Number(month.slice(0, 4)))
  }, [open, month])

  // Escape and a click outside both close the popover; Escape also hands
  // focus back to the trigger — a keyboard user who dismissed the popover
  // that way has nowhere else for focus to go. A click outside does NOT
  // return focus (see onDown's own comment below for why not) — same
  // outside-click idiom as MobileNav's and Select.tsx's own dropdowns,
  // neither of which returns focus on an outside click either. Only wired
  // while open, so the listeners aren't live for nothing.
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false)
        buttonRef.current?.focus()
      }
    }
    function onDown(e: MouseEvent) {
      // Closes the popover, same as Select.tsx's and MobileNav's own
      // outside-click handlers — but unlike the Escape branch above, focus
      // is NOT returned to the trigger here. A mousedown's own default
      // action is what focuses whatever was actually clicked; preventing
      // that default to force focus back onto the trigger would steal every
      // outside click page-wide while this popover happens to be open — the
      // first click into an unrelated input would focus the trigger instead
      // of the input, and a stray Space there would reopen this popover.
      // Select.tsx has no such preventDefault on ITS outside-click listener
      // either (its only preventDefault is a different mechanism: keeping
      // focus on ITS OWN trigger while clicking one of ITS OWN options, via
      // onMouseDown on the listbox, never document-wide).
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
    }
  }, [open])

  const filterQuery = filter && filter !== 'all' ? `&f=${filter}` : ''
  const prevYearOk = yearInRange(viewYear - 1, lastMonth)
  const nextYearOk = yearInRange(viewYear + 1, lastMonth)

  return (
    <div ref={wrapRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
        className="eyebrow text-ink flex items-center gap-1.5 hover:text-accent transition-colors"
      >
        {monthLabel(month)}
        <svg
          aria-hidden="true"
          width="8" height="6" viewBox="0 0 8 6"
          className={cn('shrink-0 fill-current transition-transform', open && 'rotate-180')}
        >
          <path d="M0 0h8L4 6z" />
        </svg>
      </button>

      {open && (
        <div
          id={panelId}
          role="group"
          aria-label="Choose a month"
          className="absolute left-1/2 top-full z-30 mt-2 w-60 -translate-x-1/2 rounded-card
                     border border-line bg-surface p-3 shadow-edge"
        >
          <div className="flex items-center justify-between mb-3">
            <button
              type="button"
              disabled={!prevYearOk}
              aria-label="Previous year"
              onClick={() => setViewYear((y) => y - 1)}
              className={cn(
                'px-2 py-1 text-base leading-none transition-colors',
                prevYearOk ? 'text-muted hover:text-ink' : 'text-muted',
              )}
            >
              ‹
            </button>
            <span className="eyebrow text-ink">{viewYear}</span>
            <button
              type="button"
              disabled={!nextYearOk}
              aria-label="Next year"
              onClick={() => setViewYear((y) => y + 1)}
              className={cn(
                'px-2 py-1 text-base leading-none transition-colors',
                nextYearOk ? 'text-muted hover:text-ink' : 'text-muted',
              )}
            >
              ›
            </button>
          </div>

          <div className="grid grid-cols-4 gap-1.5">
            {MONTH_ABBR.map((label, i) => {
              const ym = `${viewYear}-${pad2(i + 1)}`
              const available = ym >= FIRST_BUDGET_MONTH && ym <= lastMonth

              if (!available) {
                return (
                  <button
                    key={ym}
                    type="button"
                    disabled
                    aria-label={monthLabel(ym)}
                    className="block w-full rounded-field py-1.5 text-sm text-muted"
                  >
                    {label}
                  </button>
                )
              }

              const selected = ym === month
              const future = ym > today

              return (
                <Link
                  key={ym}
                  href={`/money/budget?m=${ym}${filterQuery}`}
                  aria-label={monthLabel(ym)}
                  aria-current={selected ? 'true' : undefined}
                  onClick={() => setOpen(false)}
                  className={cn(
                    'block w-full rounded-field py-1.5 text-sm text-center transition-colors',
                    selected
                      ? 'bg-accent-surface text-accent-ink font-semibold'
                      : future
                        ? 'text-ink/70 hover:bg-accent-wash hover:text-ink'
                        : 'text-ink hover:bg-accent-wash',
                  )}
                >
                  {label}
                </Link>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
