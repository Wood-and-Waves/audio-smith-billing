import { createClient } from '@/lib/supabase/server'
import { todayInChicago } from '@/lib/dates'
import {
  buildBudget, FIRST_BUDGET_MONTH, OPENING_MONTH,
  type BudgetCategory, type BudgetMove, type BudgetTxn, type CategoryTarget, type MonthBudget,
} from '@/lib/budget'
import { explodeForCategories, type TxnForExplode } from '@/lib/ledgerSplits'

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

export type RawMoveRow = {
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
  batch_id: string | null
}

async function fetchAllBudgetMoves(
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<{ rows: RawMoveRow[]; error: string | null }> {
  const rows: RawMoveRow[] = []
  let from = 0
  for (;;) {
    const { data, error } = await supabase
      .from('ledger_budget_moves')
      .select('id, created_at, month, from_category_id, to_category_id, amount_cents, undone_at, batch_id')
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

// `id` and `entered_at` are Task 5's own addition (Wave C): `id` is what
// the split-legs map below is keyed by, and `entered_at` is what
// explodeForCategories reads to drop a pending row from activity entirely
// (migration 0042 — null means pending). Neither existed on this page's
// txn assembly before this wave; buildBudget's own arithmetic (lib/budget.ts)
// is untouched, only what feeds it changes.
type RawTxnRow = {
  id: string
  date: string
  category_id: string | null
  amount_cents: number
  entered_at: string | null
}

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
      .select('id, date, category_id, amount_cents, entered_at')
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

type RawSplitLegRow = { transaction_id: string; category_id: string | null; amount_cents: number }

/** Every split leg, owner-wide (Wave C Task 5) — the budget's own txn
 *  assembly needs only category_id/amount_cents per leg (buildBudget's
 *  activity(c,m) is kind-blind, see lib/budget.ts's own doc comment), so
 *  this fetches a narrower column set than app/money/page.tsx's own
 *  fetchAllSplitLegs (which also needs a leg's category name for display).
 *  Bucketed by transaction_id below, same "one paged fetch, group by
 *  foreign key" shape as fetchAllBudgetMoves. */
async function fetchAllBudgetSplitLegs(
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<{ rows: RawSplitLegRow[]; error: string | null }> {
  const rows: RawSplitLegRow[] = []
  let from = 0
  for (;;) {
    const { data, error } = await supabase
      .from('ledger_transaction_splits')
      .select('transaction_id, category_id, amount_cents')
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1)
    if (error) return { rows: [], error: error.message }
    rows.push(...((data ?? []) as RawSplitLegRow[]))
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

export type BudgetAssembly = {
  accountRow: { id: string; opening_balance_cents: number; opening_date: string }
  categories: BudgetCategory[]
  moveRows: RawMoveRow[]
  months: Map<string, MonthBudget>
  // Not in the brief's own BudgetAssembly sketch, added here because the
  // page's rendering needs it and CategoryMonth (months' own rows) doesn't
  // carry kind/dueDate: BudgetTable passes this straight through to
  // TargetEditor for editing, same as the page did with its own `targets`
  // before this extraction. Byte-identical rendering wins over the sketch.
  targets: CategoryTarget[]
}

/** The ONE budget assembly (page + auto-assign action): null accountRow is
 *  the page's own "no account yet" case, surfaced as ok with months empty. */
export async function assembleBudget(
  supabase: Awaited<ReturnType<typeof createClient>>,
  viewMonth: string,
): Promise<{ ok: true; assembly: BudgetAssembly | null } | { ok: false; error: string }> {
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
  if (accountError) return { ok: false, error: accountError.message }

  if (!accountRow) return { ok: true, assembly: null }

  const { rows: categoryRows, error: categoryError } = await fetchAllCategories(supabase)
  if (categoryError) return { ok: false, error: categoryError }

  const { rows: moveRows, error: moveError } = await fetchAllBudgetMoves(supabase)
  if (moveError) return { ok: false, error: moveError }

  const { rows: rawTxns, error: txnError } = await fetchAllBudgetTxns(supabase, accountRow.id)
  if (txnError) return { ok: false, error: txnError }

  // Split legs (Wave C Task 5) — owner-wide, bucketed by transaction_id, fed
  // into explodeForCategories below alongside entered_at so a split parent's
  // legs (not its own suppressed line) and no pending row ever reach
  // buildBudget. A transaction absent from this map is simply unsplit.
  const { rows: splitLegRows, error: splitLegError } = await fetchAllBudgetSplitLegs(supabase)
  if (splitLegError) return { ok: false, error: splitLegError }
  const legsByTxnId = new Map<string, { categoryId: string | null; amountCents: number }[]>()
  for (const l of splitLegRows) {
    const list = legsByTxnId.get(l.transaction_id) ?? []
    list.push({ categoryId: l.category_id, amountCents: l.amount_cents })
    legsByTxnId.set(l.transaction_id, list)
  }

  const { rows: targetRows, error: targetError } = await fetchAllCategoryTargets(supabase)
  if (targetError) return { ok: false, error: targetError }

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

  // Every month from the opening seed forward to whichever is later, today
  // or the month being viewed — navigating ahead of the calendar still needs
  // a real MonthBudget in the map, and the arithmetic already handles
  // assigning into a future month. Computed here (rather than beside
  // `budget` below, its only other use) because the opening-balance seed
  // just below needs it too.
  const today = todayInChicago()
  const last = viewMonth > today.slice(0, 7) ? viewMonth : today.slice(0, 7)

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
  // Wave C Task 5: rawTxns goes through explodeForCategories (lib/
  // ledgerSplits.ts) — the ONE helper every category-reading consumer
  // calls — before buildBudget ever sees it. A split parent's own line is
  // suppressed in favor of its legs (the $400 case: an owner_pay leg plus a
  // Temporary Transfer expense leg, each landing in its own category's
  // activity); a pending row (entered_at null, migration 0042's OFX import
  // axis) yields nothing at all, matching Dan's own semantics — pending
  // counts in the register's balances but nothing category-shaped until
  // entered. The opening-balance line is NOT a transaction (see its own
  // comment above) and is injected after explosion, unchanged.
  const explodableTxns: TxnForExplode[] = rawTxns.map((t) => ({
    month: t.date.slice(0, 7),
    categoryId: t.category_id,
    amountCents: t.amount_cents,
    enteredAt: t.entered_at,
    legs: legsByTxnId.get(t.id),
  }))
  const txns: BudgetTxn[] = [
    {
      month: seedMonth,
      categoryId: null,
      amountCents: accountRow.opening_balance_cents,
    },
    ...explodeForCategories(explodableTxns),
  ]

  const targets: CategoryTarget[] = targetRows.map((t) => ({
    categoryId: t.category_id,
    kind: t.kind as 'monthly' | 'by_date',
    amountCents: t.amount_cents,
    dueDate: t.due_date,
  }))

  const months = buildBudget({ categories, moves, txns, targets, fromMonth: OPENING_MONTH, toMonth: last })

  return { ok: true, assembly: { accountRow, categories, moveRows, months, targets } }
}
