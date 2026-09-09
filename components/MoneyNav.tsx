import Link from 'next/link'

/**
 * One nav strip for the whole Money section, on every Money screen.
 *
 * Dan (2026-09-09): "The ledger is the only screen in money where I can get
 * to all the submenus for Money. I always have to click back to ledger."
 * He was right, and it was worse than that: the seven links lived only in
 * the register's own headerActions, while each sub-screen hand-rolled its
 * own way back — four pages defined a local `BackLink`, two inlined one,
 * and they did not even agree on the words ("← Ledger" on receipts,
 * "← Back to the ledger" on categories).
 *
 * This REPLACES that back link rather than sitting above it, so it costs no
 * vertical space — the row was already spent, and Dan had just finished
 * telling me the iPad wastes too much of it.
 *
 * No badge counts, by his decision ("No numbers, just nav"). That is what
 * lets this be a plain server component with no data of its own: the
 * receipts count would have been one cheap query, but the Matches count is
 * not a query at all — it only exists after proposeMatches has run over
 * every candidate transaction, invoice, expense and dismissal, so putting
 * it here would have made six screens pay for a number.
 *
 * Chips, not a row of underlined links, to match the budget screen's own
 * filter chips; horizontally scrollable so a phone never wraps it to two
 * lines. The negative margin lets it bleed to the screen edges while its
 * padding keeps the first and last chip clear of them.
 */

const ITEMS = [
  { key: 'ledger', href: '/money', label: 'Ledger' },
  { key: 'budget', href: '/money/budget', label: 'Budget' },
  { key: 'matches', href: '/money/matches', label: 'Matches' },
  { key: 'receipts', href: '/money/receipts', label: 'Receipts' },
  { key: 'forecast', href: '/money/forecast', label: 'Forecast' },
  { key: 'reports', href: '/money/reports', label: 'Reports' },
  { key: 'categories', href: '/money/categories', label: 'Categories' },
] as const

export type MoneyNavKey = (typeof ITEMS)[number]['key']

export default function MoneyNav({ current }: { current: MoneyNavKey }) {
  return (
    <nav aria-label="Money sections" className="-mx-6 px-6 mb-8 overflow-x-auto">
      {/* -ml-3 cancels the first chip's own px-3 so its TEXT lines up with the
          page title and every row beneath it, instead of sitting 12px inside
          the page's left edge. The active pill still keeps its padding and
          bleeds those 12px leftward, which is how a chip nav is meant to sit.
          Dan spotted it across five screenshots (2026-09-09): the offset is
          constant, but because the highlighted pill moves from page to page,
          it reads as the alignment changing. */}
      <div className="flex items-center gap-2 min-w-max -ml-3">
        {ITEMS.map((item) => {
          const active = item.key === current
          return (
            <Link
              key={item.key}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className={`rounded-pill px-3 py-1.5 text-xs font-semibold uppercase tracking-wider
                          transition-colors ${
                            active ? 'bg-accent-wash text-accent' : 'text-muted hover:text-ink'
                          }`}
            >
              {item.label}
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
