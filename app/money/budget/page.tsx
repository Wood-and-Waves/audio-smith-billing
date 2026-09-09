import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { todayInChicago, addMonths, monthLabel } from '@/lib/dates'
import { formatUSD } from '@/lib/money'
import { redoTarget, isNewer, isNewerUndone } from '@/lib/budgetMoves'
import { autoAssignBatchLabel } from '@/lib/budgetAutoAssign'
import { FIRST_BUDGET_MONTH, MAX_MONTHS_AHEAD } from '@/lib/budget'
import { assembleBudget, type RawMoveRow } from './data'
import AppShell from '@/components/AppShell'
import BudgetTable, { parseBudgetFilter, type BudgetFilter } from '@/components/BudgetTable'
import BudgetSummary from '@/components/BudgetSummary'
import BudgetHistory from '@/components/BudgetHistory'
import MonthPicker from '@/components/MonthPicker'

export const dynamic = 'force-dynamic'

// The reports/calendar idiom (app/calendar/page.tsx): a bad or absent `m`
// falls back to the current month rather than 404ing or crashing a date
// helper on garbage input. `f` (Task 8's filter chips) follows the same
// idiom one level down, in parseBudgetFilter (components/BudgetTable.tsx):
// anything unrecognised reads as All rather than 404ing.
// The month component is constrained to 01-12 (not just \d{2}) so a value
// like "2026-13" reads as malformed rather than as a real month greater
// than every legitimate one — that used to slip past the FIRST_BUDGET_MONTH
// clamp below and fall straight into buildBudget as toMonth.
const MONTH_KEY = /^\d{4}-(0[1-9]|1[0-2])$/

// The five chips above the table, in Dan's own order (design doc: "All,
// Overspent, Underfunded, Overfunded, Money Available"). `all` renders
// without an `f` param at all — cleaner URL, and parseBudgetFilter already
// treats a missing `f` the same as an explicit `all`.
const FILTER_CHIPS: { key: BudgetFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'overspent', label: 'Overspent' },
  { key: 'underfunded', label: 'Underfunded' },
  { key: 'overfunded', label: 'Overfunded' },
  { key: 'available', label: 'Money Available' },
]

/**
 * One visible spending category, with its current-month Available figure —
 * MovePopover's own To/From option list (budget-phase-two Task 3; directional
 * since Wave B Task 3b). This page is where the type is defined because this
 * page is where the list is built (see `assignableCategories` below):
 * `lib/budget.ts` stays untouched, so this is presentation-path plumbing, the
 * same status TargetEditor's own `target?: CategoryTarget | null` prop
 * carries.
 *
 * `grp` joined the shape in Task 3b — CategoryPicker (Task 3) groups its
 * option list by it, and MovePopover hands this same array straight to
 * CategoryPicker as its `options` prop, so without it every category in the
 * move popover would render under one blank group heading instead of the
 * budget page's own sections.
 */
export type AssignableCategory = { id: string; name: string; grp: string; availableCents: number }

/**
 * One entry in BudgetHistory's own Recent Moves list (budget-phase-two Task
 * 4) — already resolved to display strings by the page (category names,
 * the move's own month label) so BudgetHistory stays the same kind of dumb
 * presentation component AssignableCategory's own doc comment describes:
 * built once here from data this page already fetched (fetchAllBudgetMoves,
 * categories), never refetched or re-derived lower in the tree. `id` is the
 * move row's own primary key, used only as a React list key — the list is
 * read-only (see BudgetHistory's own doc comment for why only the stack
 * head is ever undoable).
 */
export type RecentMove = {
  id: string
  amountCents: number
  fromName: string
  toName: string
  monthLabel: string
  undone: boolean
}

function LoadError({ message }: { message: string }) {
  return (
    <AppShell current="money">
      <p role="alert" className="text-danger border-l-2 border-danger pl-4 py-2">
        Couldn&rsquo;t load the budget: {message}
      </p>
    </AppShell>
  )
}

const BackLink = () => (
  <Link
    href="/money"
    className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wider
               text-muted hover:text-ink transition-colors mb-8"
  >
    ← Back to the ledger
  </Link>
)

export default async function MoneyBudgetPage({
  searchParams,
}: {
  searchParams: Promise<{ m?: string; f?: string }>
}) {
  const params = await searchParams
  const supabase = await createClient()

  const today = todayInChicago()
  const requested = params.m && MONTH_KEY.test(params.m) ? params.m : today.slice(0, 7)
  // Below the first month there is no ledger, so there is nothing honest to
  // show; above the ceiling there is nothing to plan for yet either, and
  // without this a viewable month like "9999-12" would still be a real
  // month — see MAX_MONTHS_AHEAD's own comment for the cost of that.
  const ceiling = addMonths(today.slice(0, 7), MAX_MONTHS_AHEAD)
  const month =
    requested < FIRST_BUDGET_MONTH ? FIRST_BUDGET_MONTH :
    requested > ceiling ? ceiling :
    requested

  // The ONE budget assembly (page + auto-assign action, ./data.ts): the
  // accountRow read, the five paged fetches, the split-leg map, the
  // categories/moves mapping, the explode + opening-balance seed, and the
  // buildBudget call itself all moved there verbatim — this page keeps only
  // display work from here down. See assembleBudget's own doc comment for
  // why a null accountRow surfaces as `ok: true` rather than an error.
  const assembled = await assembleBudget(supabase, month)
  if (!assembled.ok) return <LoadError message={assembled.error} />

  if (!assembled.assembly) {
    return (
      <AppShell current="money">
        <BackLink />
        <h1 className="display text-3xl font-bold mb-4">Budget</h1>
        <p className="text-muted border-l-2 border-line pl-4 py-2">
          There&rsquo;s no checking account yet.{' '}
          <Link href="/money" className="font-semibold text-accent hover:opacity-80">
            Set one up on the ledger
          </Link>{' '}
          first, then come back to budget it.
        </p>
      </AppShell>
    )
  }

  const { categories, moveRows, months, targets } = assembled.assembly

  // BudgetHistory's own Undo/Redo button states and Recent Moves list
  // (budget-phase-two Task 4) — derived here, from moveRows this page
  // already fetched paged above, never a new query. `moveRows` itself stays
  // in fetchAllBudgetMoves' own ascending order (buildBudget only sums it,
  // so order there is irrelevant); this is a separate newest-first copy for
  // display and for the undo decision, ordered by the register's own
  // tie-break (`created_at desc, id desc` — `lbm_owner_created_idx`,
  // migration 0038), the same order app/money/budget/actions.ts's own
  // newestActiveMove reads by — via the SAME exported isNewer the redo
  // decision's active side uses, so the two can never drift.
  const movesByRecency = [...moveRows].sort((a, b) =>
    isNewer(a, b) ? -1 : 1,
  )
  const newestActiveMoveRow = movesByRecency.find((m) => m.undone_at === null) ?? null

  // The redo CANDIDATE, by contrast, is NOT `movesByRecency`'s own first
  // undone row — the final review (2026-08-24) caught that picking it that
  // way orders by `created_at desc, id desc`, and the backfill writes every
  // imported move inside one transaction, so every imported row shares one
  // `created_at`. Once undo walks past the hand-entered moves into the
  // backfill, that order falls to comparing random UUIDs and would pick an
  // ARBITRARY backfill row — not the one actually undone most recently, so
  // Redo would stop being Undo's own inverse there. `isNewerUndone` orders
  // by `undone_at desc` first instead (see its own doc comment,
  // lib/budgetMoves.ts) — the SAME comparator newestUndoneMove's own SQL
  // ORDER BY uses (app/money/budget/actions.ts), so the two can never
  // drift. `redoTarget` itself still only ever sees the winning row's
  // `(created_at, id)` tuple below, unchanged.
  type UndoneMoveRow = RawMoveRow & { undone_at: string }
  const undoneMoveRows = moveRows.filter((m): m is UndoneMoveRow => m.undone_at !== null)
  const newestUndoneMoveRow: UndoneMoveRow | null = undoneMoveRows.length === 0
    ? null
    : undoneMoveRows.reduce((newest, m) => (isNewerUndone(m, newest) ? m : newest))

  // Undo enabled iff any move has undone_at === null — exactly what
  // `newestActiveMoveRow` not being null already means, since it's the
  // FIRST such row in newest-first order (there is one iff there is at
  // least one). Redo enabled iff redoTarget (lib/budgetMoves.ts, the one
  // pure decision this exact case is for) says 'ok' for the newest-active /
  // newest-undone pair.
  const undoEnabled = newestActiveMoveRow !== null
  const redoEnabled = redoTarget({
    newestActive: newestActiveMoveRow
      ? { created_at: newestActiveMoveRow.created_at, id: newestActiveMoveRow.id }
      : null,
    newestUndone: newestUndoneMoveRow
      ? { created_at: newestUndoneMoveRow.created_at, id: newestUndoneMoveRow.id }
      : null,
  }) === 'ok'

  // Names for the Recent Moves list come from the categories this page
  // already fetched — never a category lookup BudgetHistory does itself
  // (that component stays dumb; see RecentMove's own doc comment above).
  // Categories are only ever hidden, never deleted (grep the repo: there is
  // no delete path onto ledger_categories), so every id a move references
  // resolves here — the `?? 'Unknown category'` fallback is defensive only,
  // the same belt-and-suspenders spirit as this file's other `?? []` reads.
  const nameById = new Map(categories.map((c) => [c.id, c.name]))
  const categoryDisplayName = (id: string | null) =>
    id === null ? 'Ready to Assign' : nameById.get(id) ?? 'Unknown category'

  // Newest ~15, matching BudgetHistory's own spec — the recency order
  // computed above, sliced rather than re-sorted.
  const recentMoves: RecentMove[] = movesByRecency.slice(0, 15).map((m) => ({
    id: m.id,
    amountCents: m.amount_cents,
    fromName: categoryDisplayName(m.from_category_id),
    toName: categoryDisplayName(m.to_category_id),
    monthLabel: monthLabel(m.month.slice(0, 7)),
    undone: m.undone_at !== null,
  }))

  // Undo's own button (BudgetHistory) carries a description of the move it
  // is about to touch — the final review's own ask, so leaning on Undo is
  // informed rather than blind. Built from the SAME newestActiveMoveRow
  // that already decides `undoEnabled` above, the same string shape
  // Recent Moves' own entries use (amount · from → to · month), so the
  // button's title never says anything the list itself wouldn't. `null`
  // when there is nothing to undo — BudgetHistory falls back to the plain
  // "Undo" label in that case.
  const headMoveLabel = (() => {
    if (!newestActiveMoveRow) return null
    if (newestActiveMoveRow.batch_id !== null) {
      const batch = moveRows.filter(
        (m) => m.batch_id === newestActiveMoveRow.batch_id && m.undone_at === null,
      )
      return autoAssignBatchLabel(batch.length, batch.reduce((s, m) => s + m.amount_cents, 0))
    }
    return `${formatUSD(newestActiveMoveRow.amount_cents)} · ${categoryDisplayName(newestActiveMoveRow.from_category_id)} → ${categoryDisplayName(newestActiveMoveRow.to_category_id)} · ${monthLabel(newestActiveMoveRow.month.slice(0, 7))}`
  })()

  const current = months.get(month)!

  // A month that has ENDED has no Ready to Assign of its own. On the first of
  // the next month whatever was left rolled forward, and those same dollars
  // are already counted in the current month's figure — so showing August's
  // $2,380.46 on the August screen both presents money that has since moved
  // and reads it twice across two screens. YNAB reports exactly 0.00 for
  // every past month; verified against Dan's own budget on 2026-09-08, where
  // May, June, July and August all return to_be_budgeted 0.00 while only
  // September carries a real number.
  //
  // Deliberately a VIEW rule, not an arithmetic one: lib/budget.ts must keep
  // computing each month's true figure, because that is precisely what feeds
  // the next month's rollover (August's 2,380.46 + September's 2,340.00
  // deposit - 97.89 of August overspending = September's 4,622.57). Zeroing
  // it in the lib would break the chain it is the head of.
  const thisMonth = today.slice(0, 7)
  const monthClosed = month < thisMonth
  const rta = monthClosed ? 0 : current.readyToAssignCents
  const filter = parseBudgetFilter(params.f)
  // Carried onto both header arrows and the month picker below so stepping
  // months (or picking one from the popover) never silently resets an
  // active filter chip back to All — before this fix the arrows linked to
  // `?m=…` alone and dropped `f` on every click. Walking months with
  // Overspent held on is exactly how you find when a category went red.
  const filterQuery = filter === 'all' ? '' : `&f=${filter}`
  // Overspent is the one chip that shows a count (Dan's own "3 Overspent").
  // Counted over the whole month's rows, same as every other total on this
  // page — never the filtered subset, and never affected by which chip (if
  // any) happens to be active right now.
  const overspentCount = current.rows.filter((r) => r.availableCents < 0).length

  // Every visible spending category this month, with its current Available —
  // what MovePopover's To/From CategoryPicker lists (budget-phase-two Task 3:
  // clicking a category's Available pill opens the move popover; Wave B Task
  // 3b made it directional). Built once here from data this page already
  // fetched (categories, current.rows) so MovePopover — a client component —
  // never refetches it, and threaded down through BudgetTable/BudgetRow as an
  // explicit prop rather than re-derived lower in the tree, the same "the
  // page already holds every row's figures — pass them down" rule the plan
  // states for this list. Hidden categories are excluded: moveBetweenCategories's own
  // ownership walk (`requireAssignable`) refuses a hidden category as either
  // side of a move, so one has no honest reason to appear as a source or
  // target option.
  const rowByCategoryId = new Map(current.rows.map((r) => [r.categoryId, r]))
  const assignableCategories: AssignableCategory[] = categories
    .filter((c) => c.budgetRole === 'spending' && !c.hidden)
    .sort((a, b) => a.sort - b.sort)
    .map((c) => ({ id: c.id, name: c.name, grp: c.grp, availableCents: rowByCategoryId.get(c.id)?.availableCents ?? 0 }))

  return (
    /* `wide` for the same reason the register takes it: this is a table, and
       at the default max-w-5xl the grid below used to hand a third of 1024px
       to a summary column too short to fill it, leaving Dan's iPad table
       about 624px wide with the right third blank (his screenshot,
       2026-09-09). */
    <AppShell current="money" wide>
      <BackLink />
      <h1 className="display text-3xl font-bold mb-8">Budget</h1>

      <header className="flex flex-col items-center gap-5 mb-10">
        <div className="flex items-center gap-3">
          {/* Rendered always, greyed and non-interactive at the boundary
              rather than vanishing (YNAB greys these too, and a control
              that disappears shifts the layout right under the pointer). A
              `disabled` `<button>` instead of a link at the boundary — same
              "not a link" idiom MonthPicker's own out-of-range months use —
              so it's unreachable by keyboard, not merely grey. */}
          {month !== FIRST_BUDGET_MONTH ? (
            <Link
              href={`/money/budget?m=${addMonths(month, -1)}${filterQuery}`}
              aria-label="Previous month"
              className="text-muted hover:text-ink transition-colors text-lg leading-none"
            >
              ‹
            </Link>
          ) : (
            <button
              type="button"
              disabled
              aria-label="Previous month"
              className="text-muted transition-colors text-lg leading-none"
            >
              ‹
            </button>
          )}
          <MonthPicker
            month={month}
            today={today.slice(0, 7)}
            lastMonth={ceiling}
            filter={filter === 'all' ? undefined : filter}
          />
          {month !== ceiling ? (
            <Link
              href={`/money/budget?m=${addMonths(month, 1)}${filterQuery}`}
              aria-label="Next month"
              className="text-muted hover:text-ink transition-colors text-lg leading-none"
            >
              ›
            </Link>
          ) : (
            <button
              type="button"
              disabled
              aria-label="Next month"
              className="text-muted transition-colors text-lg leading-none"
            >
              ›
            </button>
          )}
        </div>

        {rta > 0 && (
          <div className="rounded-card border border-good/40 bg-good/15 text-good px-8 py-4 text-center">
            <p className="tabular text-2xl font-bold">{formatUSD(rta)}</p>
            <p className="eyebrow text-good">Ready to Assign</p>
          </div>
        )}
        {/* A closed month gets its own wording. "All Money Assigned" would be
            a small lie on a month like August, where the remainder was not
            assigned at all — it rolled forward. */}
        {rta === 0 && monthClosed && (
          <div className="rounded-card border border-line bg-accent-wash text-muted px-8 py-4 text-center">
            <p className="tabular text-2xl font-bold">{formatUSD(0)}</p>
            <p className="eyebrow text-muted mt-1">Rolled Forward</p>
          </div>
        )}
        {rta === 0 && !monthClosed && (
          <div className="rounded-card border border-line bg-accent-wash text-muted px-8 py-4 text-center">
            <p className="text-2xl font-bold leading-none">✓</p>
            <p className="eyebrow text-muted mt-1">All Money Assigned</p>
          </div>
        )}
        {rta < 0 && (
          <div className="rounded-card border border-danger/40 bg-danger/15 text-danger px-8 py-4 text-center">
            <p className="tabular text-2xl font-bold">{formatUSD(rta)}</p>
            <p className="eyebrow text-danger">More Assigned Than You Have</p>
          </div>
        )}
      </header>

      {/* The summary reads as a strip above the table at EVERY width now.
          It used to become a 20rem right-hand column at `lg`, which the
          original design doc called the "Right panel" — but Dan, seeing it
          on an iPad (2026-09-09): "I don't really need the summary
          available all the time. It can live at the top." That column cost
          the table a third of the page to show four short figures, and the
          summary scrolled out of view almost immediately anyway. One column
          for everyone: no `lg:order-*` reassignment, and the table gets the
          whole width. */}
      <div className="grid gap-8">
        {/* Capped at the 20rem the right-hand column used to give it. Its rows
            are `justify-between` label/value pairs, so at the page's full
            1536px each figure would sit a hand's width from its own label —
            the same wasted space this change set out to remove, pointed the
            other way. Full width below `sm`, where a phone IS ~20rem. */}
        <div className="sm:max-w-xs">
          <BudgetSummary month={current} />
        </div>

        <div className="min-w-0">
          {/* Undo/Redo + Recent Moves (budget-phase-two Task 4) render
              beside the filter chips, not above or below them — `flex-wrap`
              on the OUTER row (not just the nav's own) is what lets
              BudgetHistory drop to its own line under the chips on a phone
              instead of squeezing both onto one crowded row. `items-start`
              keeps the chips from stretching to match BudgetHistory's own
              height once its Recent Moves disclosure opens and grows tall. */}
          <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
            <nav aria-label="Filter categories" className="flex flex-wrap gap-2">
              {FILTER_CHIPS.map((chip) => {
                const active = chip.key === filter
                const label =
                  chip.key === 'overspent' && overspentCount > 0
                    ? `${overspentCount} Overspent`
                    : chip.label
                const href =
                  chip.key === 'all'
                    ? `/money/budget?m=${month}`
                    : `/money/budget?m=${month}&f=${chip.key}`
                return (
                  <Link
                    key={chip.key}
                    href={href}
                    aria-current={active ? 'true' : undefined}
                    className={`rounded-pill px-3 py-1.5 text-xs font-semibold transition-colors ${
                      active ? 'bg-accent-wash text-accent' : 'text-muted hover:text-ink'
                    }`}
                  >
                    {label}
                  </Link>
                )
              })}
            </nav>

            <BudgetHistory
              undoEnabled={undoEnabled}
              redoEnabled={redoEnabled}
              moves={recentMoves}
              headMoveLabel={headMoveLabel}
            />
          </div>

          <BudgetTable
            month={current}
            categories={categories}
            targets={targets}
            filter={filter}
            assignableCategories={assignableCategories}
          />
        </div>
      </div>
    </AppShell>
  )
}
