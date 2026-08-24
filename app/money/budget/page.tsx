import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { todayInChicago, addMonths, monthLabel } from '@/lib/dates'
import { formatUSD } from '@/lib/money'
import { redoTarget } from '@/lib/budgetMoves'
import {
  buildBudget, FIRST_BUDGET_MONTH, OPENING_MONTH, MAX_MONTHS_AHEAD,
  type BudgetCategory, type BudgetMove, type BudgetTxn, type CategoryTarget,
} from '@/lib/budget'
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
 * MoveMoneyDialog's own From/To option list (budget-phase-two Task 3). This
 * page is where the type is defined because this page is where the list is
 * built (see `assignableCategories` below): `lib/budget.ts` stays untouched,
 * so this is presentation-path plumbing, the same status TargetEditor's own
 * `target?: CategoryTarget | null` prop carries.
 */
export type AssignableCategory = { id: string; name: string; availableCents: number }

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

// Supabase selects silently cap at 1000 rows (PostgREST's max_rows) with no
// error. ledger_transactions is already past 300 rows and grows every month,
// and every table read below is summed into Ready to Assign or a category's
// Available — so a truncated page here isn't a missing row on screen, it's a
// silently wrong budget. Mirrors this file's own pre-rewrite
// fetchAllTransactionsForBalance (see git history) and the same pattern in
// app/money/page.tsx, app/money/reports/page.tsx and app/money/forecast/page.tsx.
// Duplicated per fetch rather than shared: each needs its own column set and
// its own row type, same reasoning those files already give for not sharing.
const PAGE_SIZE = 1000

type RawCategoryRow = {
  id: string
  name: string
  grp: string
  sort: number
  hidden: boolean
  budget_role: string
}

async function fetchAllCategories(
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<{ rows: RawCategoryRow[]; error: string | null }> {
  const rows: RawCategoryRow[] = []
  let from = 0
  for (;;) {
    const { data, error } = await supabase
      .from('ledger_categories')
      .select('id, name, grp, sort, hidden, budget_role')
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1)
    if (error) return { rows: [], error: error.message }
    rows.push(...((data ?? []) as RawCategoryRow[]))
    if (!data || data.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }
  return { rows, error: null }
}

type RawMoveRow = {
  // `id`/`created_at` earn their place here on top of buildBudget's own four
  // fields (which never needed them — a sum doesn't care what order its
  // addends arrive in) because BudgetHistory's own Undo/Redo state and
  // Recent Moves list (budget-phase-two Task 4) both need the register's
  // real tie-break order (`created_at desc, id desc` — `lbm_owner_created_idx`,
  // migration 0038, the same order app/money/budget/actions.ts's own
  // newestActiveMove/newestUndoneMove read by) to know which move is
  // "newest." Reusing this one paged fetch for that — rather than adding a
  // second one — is exactly the plan's own instruction: the page already
  // fetches every move; Task 4 must not add a new fetch on top of it.
  id: string
  created_at: string
  month: string
  from_category_id: string | null
  to_category_id: string | null
  amount_cents: number
  undone_at: string | null
}

async function fetchAllBudgetMoves(
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<{ rows: RawMoveRow[]; error: string | null }> {
  const rows: RawMoveRow[] = []
  let from = 0
  for (;;) {
    const { data, error } = await supabase
      .from('ledger_budget_moves')
      .select('id, created_at, month, from_category_id, to_category_id, amount_cents, undone_at')
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1)
    if (error) return { rows: [], error: error.message }
    rows.push(...((data ?? []) as RawMoveRow[]))
    if (!data || data.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }
  return { rows, error: null }
}

type RawTxnRow = { date: string; category_id: string | null; amount_cents: number }

// Same single-account model as the register (see accountRow's own query
// below): scoped to THIS account, same as fetchAllTransactionsForBalance
// (this file's pre-rewrite copy) and app/money/forecast/page.tsx's
// fetchAllForecastTxns. Filtered to FIRST_BUDGET_MONTH forward — anything
// earlier is already folded into the account's opening_balance_cents (see
// the opening-seed comment below), and reading it again here would
// double-count it into Ready to Assign. The single-account `.eq` is also a
// silent trade, not just a precedent: the moment a second open account
// exists, its transactions are simply never read here, and the budget
// understates itself with nothing on screen to say so.
async function fetchAllBudgetTxns(
  supabase: Awaited<ReturnType<typeof createClient>>,
  accountId: string,
): Promise<{ rows: RawTxnRow[]; error: string | null }> {
  const rows: RawTxnRow[] = []
  let from = 0
  for (;;) {
    const { data, error } = await supabase
      .from('ledger_transactions')
      .select('date, category_id, amount_cents')
      .eq('account_id', accountId)
      .gte('date', `${FIRST_BUDGET_MONTH}-01`)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1)
    if (error) return { rows: [], error: error.message }
    rows.push(...((data ?? []) as RawTxnRow[]))
    if (!data || data.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }
  return { rows, error: null }
}

type RawTargetRow = {
  category_id: string
  kind: string
  amount_cents: number
  due_date: string | null
}

// 0038 shipped the table; components/TargetEditor.tsx (via
// app/money/budget/actions.ts's setCategoryTarget/clearCategoryTarget) is
// the editor that writes to it now, so this can be genuinely empty for an
// owner who hasn't set any targets yet, or full for one who has. Fetched
// (and paged) either way rather than stubbed: a category with no target
// simply carries `status: { kind: 'none' }` out of buildBudget, which is the
// honest result of "no target exists," not a shortcut this page is taking.
async function fetchAllCategoryTargets(
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<{ rows: RawTargetRow[]; error: string | null }> {
  const rows: RawTargetRow[] = []
  let from = 0
  for (;;) {
    const { data, error } = await supabase
      .from('ledger_category_targets')
      .select('category_id, kind, amount_cents, due_date')
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1)
    if (error) return { rows: [], error: error.message }
    rows.push(...((data ?? []) as RawTargetRow[]))
    if (!data || data.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }
  return { rows, error: null }
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

  // Same single-account model as the register: the one open checking
  // account this ledger runs from, "first" by creation, same tie-break the
  // rest of the app uses. The budget divides THIS account's money, so with
  // no account there is nothing to divide.
  const { data: accountRow, error: accountError } = await supabase
    .from('ledger_accounts')
    .select('id, opening_balance_cents, opening_date')
    .eq('closed', false)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (accountError) return <LoadError message={accountError.message} />

  if (!accountRow) {
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

  const { rows: categoryRows, error: categoryError } = await fetchAllCategories(supabase)
  if (categoryError) return <LoadError message={categoryError} />

  const { rows: moveRows, error: moveError } = await fetchAllBudgetMoves(supabase)
  if (moveError) return <LoadError message={moveError} />

  const { rows: rawTxns, error: txnError } = await fetchAllBudgetTxns(supabase, accountRow.id)
  if (txnError) return <LoadError message={txnError} />

  const { rows: targetRows, error: targetError } = await fetchAllCategoryTargets(supabase)
  if (targetError) return <LoadError message={targetError} />

  const categories: BudgetCategory[] = categoryRows.map((c) => ({
    id: c.id,
    name: c.name,
    grp: c.grp,
    sort: c.sort,
    hidden: c.hidden,
    budgetRole: c.budget_role as 'spending' | 'income',
  }))

  const moves: BudgetMove[] = moveRows.map((m) => ({
    month: m.month.slice(0, 7),
    fromCategoryId: m.from_category_id,
    toCategoryId: m.to_category_id,
    amountCents: m.amount_cents,
    undoneAt: m.undone_at,
  }))

  // BudgetHistory's own Undo/Redo button states and Recent Moves list
  // (budget-phase-two Task 4) — derived here, from moveRows this page
  // already fetched paged above, never a new query. `moveRows` itself stays
  // in fetchAllBudgetMoves' own ascending order (buildBudget only sums it,
  // so order there is irrelevant); this is a separate newest-first copy for
  // display and for the undo/redo decision, ordered by the register's own
  // tie-break (`created_at desc, id desc` — `lbm_owner_created_idx`,
  // migration 0038), the same order app/money/budget/actions.ts's own
  // newestActiveMove/newestUndoneMove read by. String comparison on both
  // fields, same as lib/budgetMoves.ts's own `isNewer` — see that file's
  // comment for why that matches a Postgres ORDER BY on the same columns.
  const movesByRecency = [...moveRows].sort((a, b) =>
    a.created_at !== b.created_at
      ? (a.created_at > b.created_at ? -1 : 1)
      : (a.id > b.id ? -1 : 1),
  )
  const newestActiveMoveRow = movesByRecency.find((m) => m.undone_at === null) ?? null
  const newestUndoneMoveRow = movesByRecency.find((m) => m.undone_at !== null) ?? null
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

  // Every month from the opening seed forward to whichever is later, today
  // or the month being viewed — navigating ahead of the calendar still needs
  // a real MonthBudget in the map, and the arithmetic already handles
  // assigning into a future month. Computed here (rather than beside
  // `budget` below, its only other use) because the opening-balance seed
  // just below needs it too.
  const last = month > today.slice(0, 7) ? month : today.slice(0, 7)

  // The account's opening balance is not a transaction, but it is money that
  // arrived and needs a job — so Ready to Assign has to see it. Injected in
  // the month the account opened. This is precisely why January shows $1.01
  // to assign: the opening balance is $585.75 and YNAB's carry-in is
  // $584.74, the difference being a penny stranded in a Novo account this
  // app does not carry.
  //
  // Clamped on BOTH ends to the range buildBudget is actually about to walk,
  // [OPENING_MONTH, last]: it only ever consults income for months inside
  // whatever range it's given, so a seed month outside that range means the
  // opening balance vanishes from Ready to Assign in every visible month,
  // with nothing on screen to say so — the very failure this comment used to
  // describe for the lower bound alone. The upper bound needs the same
  // guard for the same reason, not a hypothetical one: `last` is only ever
  // `month` or `today`, and `month` is a value Dan reaches by clicking
  // "Next month" through MAX_MONTHS_AHEAD's own ceiling — nowhere near
  // `opening_date`, but a future account replacement or a fat-fingered
  // opening_date could still push `openingMonth` past whatever `last`
  // happens to be, and this clamp is what keeps that honest instead of
  // silent.
  const openingMonth = accountRow.opening_date.slice(0, 7)
  const seedMonth =
    openingMonth < OPENING_MONTH ? OPENING_MONTH :
    openingMonth > last ? last :
    openingMonth
  const txns: BudgetTxn[] = [
    {
      month: seedMonth,
      categoryId: null,
      amountCents: accountRow.opening_balance_cents,
    },
    ...rawTxns.map((t) => ({
      month: t.date.slice(0, 7),
      categoryId: t.category_id,
      amountCents: t.amount_cents,
    })),
  ]

  const targets: CategoryTarget[] = targetRows.map((t) => ({
    categoryId: t.category_id,
    kind: t.kind as 'monthly' | 'by_date',
    amountCents: t.amount_cents,
    dueDate: t.due_date,
  }))

  const budget = buildBudget({ categories, moves, txns, targets, fromMonth: OPENING_MONTH, toMonth: last })
  const current = budget.get(month)!

  const rta = current.readyToAssignCents
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
  // what MoveMoneyDialog's From/To selects list (budget-phase-two Task 3:
  // clicking a category's Available pill opens a move-money dialog). Built
  // once here from data this page already fetched (categories, current.rows)
  // so MoveMoneyDialog — a client component — never refetches it, and
  // threaded down through BudgetTable/BudgetRow as an explicit prop rather
  // than re-derived lower in the tree, the same "the page already holds
  // every row's figures — pass them down" rule the plan states for this
  // list. Hidden categories are excluded: moveBetweenCategories's own
  // ownership walk (`requireAssignable`) refuses a hidden category as either
  // side of a move, so one has no honest reason to appear as a source or
  // target option.
  const rowByCategoryId = new Map(current.rows.map((r) => [r.categoryId, r]))
  const assignableCategories: AssignableCategory[] = categories
    .filter((c) => c.budgetRole === 'spending' && !c.hidden)
    .sort((a, b) => a.sort - b.sort)
    .map((c) => ({ id: c.id, name: c.name, availableCents: rowByCategoryId.get(c.id)?.availableCents ?? 0 }))

  return (
    <AppShell current="money">
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
        {rta === 0 && (
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

      {/* Right column at `lg` and up (design doc: "Right panel"); above the
          table below `lg`, where it reads as a strip (design doc: "The
          summary becomes a strip at the top"). Plain DOM order puts
          BudgetSummary first so mobile — no `order` in play there — stacks
          it on top by default; `lg:order-*` below reassigns which grid
          track each side lands in once there are two, without moving
          either block's markup or duplicating either component. */}
      <div className="grid lg:grid-cols-[1fr_20rem] gap-8">
        <div className="lg:order-2">
          <BudgetSummary month={current} />
        </div>

        <div className="lg:order-1 min-w-0">
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

            <BudgetHistory undoEnabled={undoEnabled} redoEnabled={redoEnabled} moves={recentMoves} />
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
