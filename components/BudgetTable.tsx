import { formatUSD } from '@/lib/money'
import BudgetRow from '@/components/BudgetRow'
import type { MonthBudget, BudgetCategory, CategoryMonth, CategoryTarget } from '@/lib/budget'

type Entry = { row: CategoryMonth; name: string; sort: number; target: CategoryTarget | null }
// `key` is a React key, distinct from `name` (which is display text and
// duplicable — see the synthetic "Hidden" section below): every real group's
// key is prefixed `group:`, which a section built from `category.grp` can
// never collide with the sentinel `synthetic:hidden` key used for the
// catch-all section, even if an owner names a real group "Hidden" verbatim.
type Section = { key: string; name: string; sort: number; entries: Entry[] }

/** The five chips above the table. Anything unrecognised (missing param,
 *  typo, a stale link) reads as All — the same fallback idiom the page's
 *  own `m` param already uses rather than 404ing on a bad query string. */
export type BudgetFilter = 'all' | 'overspent' | 'underfunded' | 'overfunded' | 'available'

/** Parses `searchParams.f`. */
export function parseBudgetFilter(f: string | undefined): BudgetFilter {
  return f === 'overspent' || f === 'underfunded' || f === 'overfunded' || f === 'available' ? f : 'all'
}

/**
 * Which rows a chip keeps. Overfunded reads `row.targetCents` straight off
 * the row rather than looking its category up in `targets` a second time —
 * `targetCents` is null exactly when a category carries no target, and a
 * category with no target can never be overfunded, so there's nothing left
 * to check once that's true.
 *
 * Overfunded also requires `row.neededCents === 0`. Without it, Overfunded
 * and Underfunded aren't mutually exclusive: `availableCents` counts this
 * month's activity (e.g. a refund landing today), while `neededCents` is
 * measured from what carried in plus what's been assigned — so a category
 * can out-earn its target on `available` while `neededCents` still says it
 * needs money by the target's own reckoning. Without this clause such a row
 * would show up under the Overfunded chip with its own status line reading
 * "$X.XX more needed" — a filter contradicting the row it selected, which is
 * worse than no filter at all. Keep this clause; it came out of the plan for
 * exactly this reason, not by accident.
 */
export function matchesBudgetFilter(row: CategoryMonth, filter: BudgetFilter): boolean {
  switch (filter) {
    case 'overspent': return row.availableCents < 0
    case 'underfunded': return row.neededCents > 0
    case 'overfunded':
      return row.targetCents !== null && row.availableCents > row.targetCents && row.neededCents === 0
    case 'available': return row.availableCents > 0
    case 'all': return true
  }
}

// Same grid every row in this table uses (BudgetRow's own template, repeated
// here rather than imported so a group header's four cells line up under a
// category row's four cells without either file reaching into the other).
// `hidden sm:grid`: this four-cell layout doesn't fit the phone card idiom
// BudgetRow's own rows collapse into below `sm`, so it's hidden there — but
// the group boundary itself (name and totals) still has to render somehow,
// or a phone reader loses the section headers entirely (a bug this table
// used to have: see the `sm:hidden` header rendered just above this grid,
// which is what fills that gap with the same 3-up small-label idiom
// BudgetRow uses for a row's own figures). The rest of GRID's classes are
// harmless while hidden and take over once `sm:grid` turns display back on.
const GRID = 'hidden sm:grid grid-cols-[1fr_7rem_7rem_8rem] gap-x-4 items-center'

/**
 * The month's category rows, grouped by `grp` and ordered by each group's
 * lowest `sort`. A server component — no client state, no interactivity;
 * Task 7's status pill and a future editing pass are what need a client
 * boundary, and neither has landed on this table yet.
 *
 * Hidden categories: `buildBudget` returns a row for every spending
 * category, hidden ones included, each still carrying its real
 * assigned/activity/available cents — hiding is a presentation concern, not
 * an accounting one (see lib/budget.ts's own comment on CategoryMonth.hidden).
 * That makes the filtering below this table's job, not buildBudget's:
 *
 *   - a hidden row that is completely empty this month (nothing assigned, no
 *     activity, nothing available) is simply dropped. This is the common
 *     case for a retired category, though not a guaranteed one — migration
 *     0040's own comment notes an owner whose Subscriptions row still holds
 *     transactions keeps it visible instead, via the branch right below.
 *   - a hidden row that still holds money or saw activity is kept, folded
 *     into a synthetic "Hidden" section at the bottom, so the rendered rows
 *     still sum to the month's own totals instead of a reader checking the
 *     arithmetic by hand finding money that appears from nowhere.
 *
 * `targets` is the page's own `ledger_category_targets` fetch, passed
 * through rather than discarded — each entry looks its own category up in
 * it and hands the real `CategoryTarget` (kind, amount, due date) to
 * BudgetRow, which threads it on to TargetEditor. This is presentation-path
 * plumbing only: `lib/budget.ts` and `CategoryMonth.targetCents` (still what
 * the progress bar reads) are untouched by it.
 *
 * `filter` (Task 8) hides ROWS ONLY. A section's `sums` below are always
 * folded over its full, unfiltered `entries` — never the visible subset —
 * and BudgetSummary (the right-hand panel) reads `month` directly and never
 * sees `filter` at all. This isn't a style choice: the whole reason this
 * screen exists is to reconcile against YNAB figure for figure, and a total
 * that silently narrowed to whatever happens to be on screen would make
 * that check lie the instant Dan clicked a chip — the same reasoning
 * `CategoryMonth.hidden`'s own comment in lib/budget.ts gives for why
 * hiding a category never touches what buildBudget sums. A section with no
 * row left standing after the filter is dropped from the render entirely
 * (its header would otherwise show real totals above zero visible rows,
 * which reads as broken rather than filtered); if every section drops out,
 * the "nothing matches" message below stands in for the grid.
 */
export default function BudgetTable({
  month, categories, targets, filter,
}: {
  month: MonthBudget
  categories: BudgetCategory[]
  targets: CategoryTarget[]
  filter: BudgetFilter
}) {
  const catById = new Map(categories.map((c) => [c.id, c]))
  const targetByCategoryId = new Map(targets.map((t) => [t.categoryId, t]))

  const sectionsByGroup = new Map<string, Section>()
  const hiddenEntries: Entry[] = []

  for (const row of month.rows) {
    const category = catById.get(row.categoryId)
    if (!category) continue // every row's id comes from `categories` itself

    const isEmpty = row.assignedCents === 0 && row.activityCents === 0 && row.availableCents === 0
    if (row.hidden && isEmpty) continue

    const entry: Entry = {
      row, name: category.name, sort: category.sort,
      target: targetByCategoryId.get(row.categoryId) ?? null,
    }

    if (row.hidden) {
      hiddenEntries.push(entry)
      continue
    }

    const existing = sectionsByGroup.get(category.grp)
    if (existing) {
      existing.entries.push(entry)
      existing.sort = Math.min(existing.sort, category.sort)
    } else {
      sectionsByGroup.set(category.grp, {
        key: `group:${category.grp}`, name: category.grp, sort: category.sort, entries: [entry],
      })
    }
  }

  const sections = [...sectionsByGroup.values()].sort((a, b) => a.sort - b.sort)
  for (const section of sections) section.entries.sort((a, b) => a.sort - b.sort)

  // Always last, regardless of what sort value its members carry — it isn't
  // a real category group, it's a catch-all for whatever hidden rows still
  // have money in them this month. `key: 'synthetic:hidden'` (not `name`,
  // which is what actually renders): a real group can be named "Hidden" by
  // hand, and every real section's key is prefixed `group:`, so the two can
  // never collide the way two sections keyed on `name` would.
  if (hiddenEntries.length > 0) {
    sections.push({
      key: 'synthetic:hidden',
      name: 'Hidden',
      sort: Infinity,
      entries: hiddenEntries.sort((a, b) => a.sort - b.sort),
    })
  }

  const rendered = sections
    .map((section) => {
      // Full month, not the filtered subset — see this component's own doc
      // comment above for why that isn't negotiable.
      const sums = section.entries.reduce(
        (acc, e) => ({
          assigned: acc.assigned + e.row.assignedCents,
          activity: acc.activity + e.row.activityCents,
          available: acc.available + e.row.availableCents,
        }),
        { assigned: 0, activity: 0, available: 0 },
      )
      const visible = section.entries.filter((e) => matchesBudgetFilter(e.row, filter))
      return { section, sums, visible }
    })
    // A group whose filter leaves zero visible rows is dropped from the
    // render entirely — a decision beyond the brief, made here rather than
    // left implicit: the alternative is a group header still showing its
    // real (whole-month) totals sitting above zero rows, which reads as a
    // broken table rather than a filtered one.
    .filter(({ visible }) => visible.length > 0)

  if (rendered.length === 0) {
    return (
      <p className="text-muted border-l-2 border-line pl-4 py-2">
        {filter === 'all' ? 'No categories yet.' : 'No categories match this filter.'}
      </p>
    )
  }

  return (
    <div className="overflow-x-auto">
      <div className="sm:min-w-[34rem]">
        {/* Column headers — desktop only: GRID is `hidden sm:grid`, and the phone
            cards already label each figure inline. Named after YNAB's own header
            row, which is what Dan reads this screen against. */}
        <div className={`${GRID} border-b border-line pb-1.5 mb-2`}>
          <span className="eyebrow">Category</span>
          <span className="eyebrow text-right">Assigned</span>
          <span className="eyebrow text-right">Activity</span>
          <span className="eyebrow text-right">Available</span>
        </div>
        {rendered.map(({ section, sums, visible }) => (
          <section key={section.key} className="mb-6 last:mb-0">
            {/* Phone: BudgetRow's own card layout collapses to one column
                below `sm`, and GRID (below) is hidden there too — without a
                phone header, the group boundary disappears entirely: name
                included, so the screen becomes an unlabelled flat list and
                the synthetic "Hidden" section reads as just another group.
                Same 3-up small-label idiom BudgetRow's own `sm:hidden` block
                uses for a category row's own figures. */}
            <div className="sm:hidden border-b border-line pb-1.5 mb-1">
              <h3 className="eyebrow">{section.name}</h3>
              <div className="grid grid-cols-3 gap-2 mt-1">
                <div>
                  <p className="text-xs text-muted">Assigned</p>
                  <p className="tabular text-xs">{formatUSD(sums.assigned)}</p>
                </div>
                <div>
                  <p className="text-xs text-muted">Activity</p>
                  <p className="tabular text-xs">{formatUSD(sums.activity)}</p>
                </div>
                <div>
                  <p className="text-xs text-muted">Available</p>
                  <p className="tabular text-xs">{formatUSD(sums.available)}</p>
                </div>
              </div>
            </div>
            <div className={`${GRID} border-b border-line pb-1.5 mb-1`}>
              <h3 className="eyebrow">{section.name}</h3>
              <span className="tabular text-right text-xs text-muted">{formatUSD(sums.assigned)}</span>
              <span className="tabular text-right text-xs text-muted">{formatUSD(sums.activity)}</span>
              <span className="tabular text-right text-xs text-muted">{formatUSD(sums.available)}</span>
            </div>
            <div className="divide-y divide-line">
              {visible.map((e) => (
                <BudgetRow key={e.row.categoryId} row={e.row} name={e.name} target={e.target} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}
