import { formatUSD } from '@/lib/money'
import BudgetRow from '@/components/BudgetRow'
import type { MonthBudget, BudgetCategory, CategoryMonth } from '@/lib/budget'

type Entry = { row: CategoryMonth; name: string; sort: number }
type Section = { name: string; sort: number; entries: Entry[] }

// Same grid every row in this table uses (BudgetRow's own template, repeated
// here rather than imported so a group header's four cells line up under a
// category row's four cells without either file reaching into the other).
const GRID = 'grid grid-cols-[1fr_7rem_7rem_8rem] gap-x-4 items-center'

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
 *     activity, nothing available) is simply dropped. This is the normal
 *     case — Bank Fees, Lodging and Subscriptions are all retired with
 *     nothing left in them.
 *   - a hidden row that still holds money or saw activity is kept, folded
 *     into a synthetic "Hidden" section at the bottom, so the rendered rows
 *     still sum to the month's own totals instead of a reader checking the
 *     arithmetic by hand finding money that appears from nowhere.
 */
export default function BudgetTable({
  month, categories,
}: {
  month: MonthBudget
  categories: BudgetCategory[]
}) {
  const catById = new Map(categories.map((c) => [c.id, c]))

  const sectionsByGroup = new Map<string, Section>()
  const hiddenEntries: Entry[] = []

  for (const row of month.rows) {
    const category = catById.get(row.categoryId)
    if (!category) continue // every row's id comes from `categories` itself

    const isEmpty = row.assignedCents === 0 && row.activityCents === 0 && row.availableCents === 0
    if (row.hidden && isEmpty) continue

    const entry: Entry = { row, name: category.name, sort: category.sort }

    if (row.hidden) {
      hiddenEntries.push(entry)
      continue
    }

    const existing = sectionsByGroup.get(category.grp)
    if (existing) {
      existing.entries.push(entry)
      existing.sort = Math.min(existing.sort, category.sort)
    } else {
      sectionsByGroup.set(category.grp, { name: category.grp, sort: category.sort, entries: [entry] })
    }
  }

  const sections = [...sectionsByGroup.values()].sort((a, b) => a.sort - b.sort)
  for (const section of sections) section.entries.sort((a, b) => a.sort - b.sort)

  // Always last, regardless of what sort value its members carry — it isn't
  // a real category group, it's a catch-all for whatever hidden rows still
  // have money in them this month.
  if (hiddenEntries.length > 0) {
    sections.push({
      name: 'Hidden',
      sort: Infinity,
      entries: hiddenEntries.sort((a, b) => a.sort - b.sort),
    })
  }

  return (
    <div className="overflow-x-auto">
      <div className="min-w-[34rem]">
        {sections.map((section) => {
          const sums = section.entries.reduce(
            (acc, e) => ({
              assigned: acc.assigned + e.row.assignedCents,
              activity: acc.activity + e.row.activityCents,
              available: acc.available + e.row.availableCents,
            }),
            { assigned: 0, activity: 0, available: 0 },
          )
          return (
            <section key={section.name} className="mb-6 last:mb-0">
              <div className={`${GRID} border-b border-line pb-1.5 mb-1`}>
                <h3 className="eyebrow">{section.name}</h3>
                <span className="tabular text-right text-xs text-muted">{formatUSD(sums.assigned)}</span>
                <span className="tabular text-right text-xs text-muted">{formatUSD(sums.activity)}</span>
                <span className="tabular text-right text-xs text-muted">{formatUSD(sums.available)}</span>
              </div>
              <div className="divide-y divide-line">
                {section.entries.map((e) => (
                  <BudgetRow key={e.row.categoryId} row={e.row} name={e.name} />
                ))}
              </div>
            </section>
          )
        })}
      </div>
    </div>
  )
}
