import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { todayInChicago, monthLabel, addMonths } from '@/lib/dates'
import { formatUSD } from '@/lib/money'
import {
  buildBudget, FIRST_BUDGET_MONTH, OPENING_MONTH, MAX_MONTHS_AHEAD,
  type BudgetCategory, type BudgetMove, type BudgetTxn, type CategoryTarget,
} from '@/lib/budget'
import AppShell from '@/components/AppShell'
import BudgetTable from '@/components/BudgetTable'

export const dynamic = 'force-dynamic'

// The reports/calendar idiom (app/calendar/page.tsx): a bad or absent `m`
// falls back to the current month rather than 404ing or crashing a date
// helper on garbage input. `f` isn't read yet — Task 8's filter chips land
// on this same query param, and the type is shaped for that now so this
// page's signature doesn't change again when they do.
// The month component is constrained to 01-12 (not just \d{2}) so a value
// like "2026-13" reads as malformed rather than as a real month greater
// than every legitimate one — that used to slip past the FIRST_BUDGET_MONTH
// clamp below and fall straight into buildBudget as toMonth.
const MONTH_KEY = /^\d{4}-(0[1-9]|1[0-2])$/

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
      .select('month, from_category_id, to_category_id, amount_cents, undone_at')
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

// Empty today — 0038 shipped the table, but nothing writes to it until
// Task 7's editor. Fetched (and paged) anyway rather than stubbed: every row
// buildBudget hands back simply carries `status: { kind: 'none' }` until
// then, which is the honest result of "no targets exist yet," not a
// shortcut this page is taking.
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

  // The account's opening balance is not a transaction, but it is money that
  // arrived and needs a job — so Ready to Assign has to see it. Injected in
  // the month the account opened. This is precisely why January shows $1.01
  // to assign: the opening balance is $585.75 and YNAB's carry-in is
  // $584.74, the difference being a penny stranded in a Novo account this
  // app does not carry.
  //
  // Clamped to the later of OPENING_MONTH and the account's own opening
  // month: buildBudget only ever consults income for months inside
  // [fromMonth, toMonth], which below is always [OPENING_MONTH, last]. If
  // opening_date's month ever fell before OPENING_MONTH — a data-entry
  // mistake, a replaced account, a future migration — the seed would land
  // outside the built range and the opening balance would vanish from Ready
  // to Assign in every month, with nothing on screen to say so.
  const openingMonth = accountRow.opening_date.slice(0, 7)
  const seedMonth = openingMonth > OPENING_MONTH ? openingMonth : OPENING_MONTH
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

  // Every month from the opening seed forward to whichever is later, today
  // or the month being viewed — navigating ahead of the calendar still needs
  // a real MonthBudget in the map, and the arithmetic already handles
  // assigning into a future month.
  const last = month > today.slice(0, 7) ? month : today.slice(0, 7)
  const budget = buildBudget({ categories, moves, txns, targets, fromMonth: OPENING_MONTH, toMonth: last })
  const current = budget.get(month)!

  const rta = current.readyToAssignCents

  return (
    <AppShell current="money">
      <BackLink />
      <h1 className="display text-3xl font-bold mb-8">Budget</h1>

      <header className="flex flex-col items-center gap-5 mb-10">
        <div className="flex items-center gap-3">
          {month !== FIRST_BUDGET_MONTH && (
            <Link
              href={`/money/budget?m=${addMonths(month, -1)}`}
              aria-label="Previous month"
              className="text-muted hover:text-ink transition-colors text-lg leading-none"
            >
              ‹
            </Link>
          )}
          <h2 className="eyebrow text-ink">{monthLabel(month)}</h2>
          <Link
            href={`/money/budget?m=${addMonths(month, 1)}`}
            aria-label="Next month"
            className="text-muted hover:text-ink transition-colors text-lg leading-none"
          >
            ›
          </Link>
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

      <BudgetTable month={current} categories={categories} targets={targets} />
    </AppShell>
  )
}
