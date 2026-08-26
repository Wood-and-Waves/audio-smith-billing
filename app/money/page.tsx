import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { formatDateShort, todayInChicago } from '@/lib/dates'
import {
  workingBalance, clearedBalance, compareLedgerOrder, runningBalances, type BalanceLike,
} from '@/lib/ledgerBalance'
import {
  proposeMatches, type BankRow, type CandidateInvoice, type CandidateExpense, type Dismissal,
} from '@/lib/ledgerMatch'
import {
  buildBudget, OPENING_MONTH, FIRST_BUDGET_MONTH, type BudgetCategory, type BudgetMove, type BudgetTxn,
} from '@/lib/budget'
import { explodeForCategories, type TxnForExplode } from '@/lib/ledgerSplits'
import AppShell from '@/components/AppShell'
import MoneyRegister, {
  type CategoryOption, type LedgerAccountSummary, type LedgerTxnRow, type ShowOption, type SplitLegRow,
} from '@/components/MoneyRegister'
import LedgerImportReconcile from '@/components/LedgerImportReconcile'
import { ensureDefaultCategories } from '@/app/money/actions'

export const dynamic = 'force-dynamic'

// Supabase selects silently cap at 1000 rows (PostgREST's max_rows) — a plain
// unranged .select() would truncate an account past 1000 transactions with no
// error, which would understate the working/cleared balance and quietly drop
// rows from the register. This mirrors fetchAllLedgerTransactions inside
// app/money/actions.ts exactly (stable order, page-until-short), duplicated
// rather than imported because a 'use server' file may only export actions.
const LEDGER_TXN_PAGE_SIZE = 1000

type RawTxnRow = {
  id: string
  date: string
  amount_cents: number
  kind: 'income' | 'expense' | 'owner_pay' | 'transfer'
  category_id: string | null
  show_id: string | null
  payee: string
  memo: string | null
  cleared: 'uncleared' | 'cleared' | 'reconciled'
  created_at: string
  // null = UNREVIEWED (migration 0042) — a review marker, "I have looked at
  // this", never an accounting gate. The register renders it directly
  // (LedgerTxnRow.entered_at, unchanged here) to mark the row for review, and
  // toReviewIds below counts it, but nothing else on this page keys off it:
  // the Matches badge, the budget and the CategoryPicker-balance assembly all
  // count every row the moment it lands, reviewed or not (Dan's 2026-08-25
  // decision).
  entered_at: string | null
  // Where the row came from (migration 0027): 'manual' for anything he typed
  // into the register, 'import' for a row the bank file created. import_id is
  // the bank's own per-row key, non-null only on an imported row (0027's
  // partial unique index is what makes a re-import a no-op). Both are read
  // here for exactly one thing — LedgerTxnRow.isImported below, the gate on
  // the payee-rename offer.
  source: 'manual' | 'import'
  import_id: string | null
  receipt_path: string | null
  receipt_original: string | null
  // Denormalized here (rather than cross-referenced client-side against the
  // "not hidden" categories list or the "most recent 25" shows list) so a
  // transaction tagged to an old show or a since-hidden category still shows
  // its real name in the register — those two lists only exist to populate
  // the Select pickers, and neither is guaranteed to still contain a name
  // some past transaction points at. budget_role rides along for the same
  // reason as name (Wave B Task 5, name-keyed since H1): MoneyRegister's
  // deriveKind needs a category's own name and budget role to re-derive kind
  // on save, and a since-hidden category (categories can be hidden, never
  // hard-deleted — see /money/categories) is exactly the case where that
  // lookup can't go through the not-hidden `categories` list below either.
  // No `grp` here (H1 dropped it — deriveKind keys owner_pay on name, not
  // group; `categories` below still selects its own grp, for the picker's
  // "Group: Name" display, an unrelated need).
  category: { name: string; budget_role: string } | null
  show: { name: string } | null
}

async function fetchAllTransactions(
  supabase: Awaited<ReturnType<typeof createClient>>,
  accountId: string,
): Promise<{ rows: RawTxnRow[]; error: string | null }> {
  const rows: RawTxnRow[] = []
  let from = 0
  for (;;) {
    const { data, error } = await supabase
      .from('ledger_transactions')
      .select(`id, date, amount_cents, kind, category_id, show_id, payee, memo, cleared, created_at,
                entered_at, source, import_id, receipt_path, receipt_original,
                category:ledger_categories(name, budget_role), show:shows(name)`)
      .eq('account_id', accountId)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + LEDGER_TXN_PAGE_SIZE - 1)
    if (error) return { rows: [], error: error.message }
    rows.push(...((data ?? []) as unknown as RawTxnRow[]))
    if (!data || data.length < LEDGER_TXN_PAGE_SIZE) break
    from += LEDGER_TXN_PAGE_SIZE
  }
  return { rows, error: null }
}

type RawSplitLegRow = {
  transaction_id: string
  category_id: string | null
  amount_cents: number
  note: string | null
  // Same since-hidden-category fallback reason as RawTxnRow's own
  // category/categoryName pair above — a leg can point at a category
  // that's since been hidden, and the not-hidden `categories` list
  // (categoryPickerOptions' own source) has nothing to seed that leg's
  // picker with otherwise.
  category: { name: string; budget_role: string } | null
}

/** Every split leg, owner-wide (Wave C Task 4) — joined client-side onto
 *  its parent transaction below, same "one paged fetch, bucket by foreign
 *  key" shape as fetchAllInvoiceLinks/fetchAllExpenseLinks further down
 *  this file. Ordered by (created_at, id), but that does NOT reproduce the
 *  order Dan built a split in (M1, Wave C final review): every leg from one
 *  replace_transaction_splits call comes from a SINGLE insert...select
 *  statement (migration 0042), so they all share one `created_at` — the
 *  tiebreak actually deciding render order is `id`, a random uuid
 *  (gen_random_uuid()) with no relation to leg order at all. The order legs
 *  render in is arbitrary within one save, not the app lying about it; a
 *  real ordinal column on ledger_transaction_splits is the future fix, not
 *  something this ORDER BY can paper over today. */
async function fetchAllSplitLegs(
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<{ rows: RawSplitLegRow[]; error: string | null }> {
  const rows: RawSplitLegRow[] = []
  let from = 0
  for (;;) {
    const { data, error } = await supabase
      .from('ledger_transaction_splits')
      .select('transaction_id, category_id, amount_cents, note, category:ledger_categories(name, budget_role)')
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + LEDGER_TXN_PAGE_SIZE - 1)
    if (error) return { rows: [], error: error.message }
    rows.push(...((data ?? []) as unknown as RawSplitLegRow[]))
    if (!data || data.length < LEDGER_TXN_PAGE_SIZE) break
    from += LEDGER_TXN_PAGE_SIZE
  }
  return { rows, error: null }
}

type RawBudgetCategoryRow = {
  id: string; name: string; grp: string; sort: number; hidden: boolean; budget_role: string
}

/**
 * Every category, hidden or not — CategoryPicker's own balance map (Wave B
 * Task 3, categoryBalanceCents below) is built by running buildBudget, and
 * that function's own comment (lib/budget.ts) is explicit that a hidden
 * category's assigned/activity must still be counted, since hiding is a
 * presentation concern, never an accounting one. `categories` above (the
 * `.eq('hidden', false)` query CategoryPicker's own option LIST is built
 * from) can't double as buildBudget's input for exactly that reason — it
 * would silently undercount every hidden category's carry-in from month to
 * month. Paged for the same PostgREST 1000-row-cap reason every other
 * fetcher on this page is (see LEDGER_TXN_PAGE_SIZE's own comment); mirrors
 * app/money/budget/page.tsx's own fetchAllCategories exactly (same columns,
 * same order) since that page's own budget is the ground truth this map has
 * to agree with.
 */
async function fetchAllCategoriesForBudget(
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<{ rows: RawBudgetCategoryRow[]; error: string | null }> {
  const rows: RawBudgetCategoryRow[] = []
  let from = 0
  for (;;) {
    const { data, error } = await supabase
      .from('ledger_categories')
      .select('id, name, grp, sort, hidden, budget_role')
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + LEDGER_TXN_PAGE_SIZE - 1)
    if (error) return { rows: [], error: error.message }
    rows.push(...((data ?? []) as RawBudgetCategoryRow[]))
    if (!data || data.length < LEDGER_TXN_PAGE_SIZE) break
    from += LEDGER_TXN_PAGE_SIZE
  }
  return { rows, error: null }
}

type RawBudgetMoveRow = {
  month: string; from_category_id: string | null; to_category_id: string | null
  amount_cents: number; undone_at: string | null
}

/**
 * Every budget move, owner-wide — the other half of CategoryPicker's balance
 * map, paged the same way app/money/budget/page.tsx's own fetchAllBudgetMoves
 * is (see that file's own comment for the PostgREST cap reasoning this
 * mirrors). Trimmed to the four columns buildBudget's own BudgetMove type
 * actually reads: this page never needs a move's id/created_at the way
 * BudgetHistory's Undo/Redo does on the budget page itself — it only sums
 * moves into a balance map, it never orders or replays them.
 */
async function fetchAllBudgetMoves(
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<{ rows: RawBudgetMoveRow[]; error: string | null }> {
  const rows: RawBudgetMoveRow[] = []
  let from = 0
  for (;;) {
    const { data, error } = await supabase
      .from('ledger_budget_moves')
      .select('month, from_category_id, to_category_id, amount_cents, undone_at')
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + LEDGER_TXN_PAGE_SIZE - 1)
    if (error) return { rows: [], error: error.message }
    rows.push(...((data ?? []) as RawBudgetMoveRow[]))
    if (!data || data.length < LEDGER_TXN_PAGE_SIZE) break
    from += LEDGER_TXN_PAGE_SIZE
  }
  return { rows, error: null }
}

type RawInvoiceLinkRow = { transaction_id: string; invoice_id: string; invoices: { number: number } | null }

/** Every ledger_transaction_invoices row, owner-wide (mirrors
 *  app/money/matches/page.tsx's own fetchAllInvoiceLinks) — the
 *  `invoices(number)` embed is this page's own addition, so the register can
 *  show "#123" on a linked row without a second round trip. Same many-to-one
 *  embed-as-single-object caveat as that page's `clients` join. */
async function fetchAllInvoiceLinks(
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<{ rows: RawInvoiceLinkRow[]; error: string | null }> {
  const rows: RawInvoiceLinkRow[] = []
  let from = 0
  for (;;) {
    const { data, error } = await supabase
      .from('ledger_transaction_invoices')
      .select('transaction_id, invoice_id, invoices(number)')
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + LEDGER_TXN_PAGE_SIZE - 1)
    if (error) return { rows: [], error: error.message }
    rows.push(...((data ?? []) as unknown as RawInvoiceLinkRow[]))
    if (!data || data.length < LEDGER_TXN_PAGE_SIZE) break
    from += LEDGER_TXN_PAGE_SIZE
  }
  return { rows, error: null }
}

type RawExpenseLinkRow = {
  transaction_id: string
  expense_id: string
  expenses: { receipt_path: string | null } | null
}

/** Every ledger_transaction_expenses row, owner-wide (mirrors
 *  app/money/matches/page.tsx's own fetchAllExpenseLinks) — the
 *  `expenses(receipt_path)` embed lets the register fall back to a linked
 *  expense's receipt when the bank row has none of its own
 *  (LedgerTxnRow.linkedReceiptPath, ReceiptControl's view branch). */
async function fetchAllExpenseLinks(
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<{ rows: RawExpenseLinkRow[]; error: string | null }> {
  const rows: RawExpenseLinkRow[] = []
  let from = 0
  for (;;) {
    const { data, error } = await supabase
      .from('ledger_transaction_expenses')
      .select('transaction_id, expense_id, expenses(receipt_path)')
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + LEDGER_TXN_PAGE_SIZE - 1)
    if (error) return { rows: [], error: error.message }
    rows.push(...((data ?? []) as unknown as RawExpenseLinkRow[]))
    if (!data || data.length < LEDGER_TXN_PAGE_SIZE) break
    from += LEDGER_TXN_PAGE_SIZE
  }
  return { rows, error: null }
}

type RawDismissalRow = { transaction_id: string; invoice_id: string | null; expense_id: string | null }

/** Every ledger_match_dismissals row, owner-wide — mirrors
 *  app/money/matches/page.tsx's own fetchAllDismissals exactly. proposeMatches
 *  is pure and stateless, so a truncated read here would let a guess Dan
 *  already dismissed reappear in the Matches badge count once the dismissal
 *  list grew past 1000 rows. */
async function fetchAllDismissals(
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<{ rows: RawDismissalRow[]; error: string | null }> {
  const rows: RawDismissalRow[] = []
  let from = 0
  for (;;) {
    const { data, error } = await supabase
      .from('ledger_match_dismissals')
      .select('transaction_id, invoice_id, expense_id')
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + LEDGER_TXN_PAGE_SIZE - 1)
    if (error) return { rows: [], error: error.message }
    rows.push(...((data ?? []) as RawDismissalRow[]))
    if (!data || data.length < LEDGER_TXN_PAGE_SIZE) break
    from += LEDGER_TXN_PAGE_SIZE
  }
  return { rows, error: null }
}

type RawCandidateInvoiceRow = {
  id: string
  number: number
  client_id: string
  total_cents: number
  sent_at: string | null
  paid_at: string | null
  status: string
  // Many-to-one FK (invoices.client_id -> clients.id) embeds as a single
  // object at runtime — same cast app/money/matches/page.tsx's identical
  // fetcher uses for the same embed.
  clients: { name: string } | null
}

/** Every sent-or-paid invoice, owner-wide — mirrors
 *  app/money/matches/page.tsx's own fetchAllCandidateInvoices exactly (same
 *  `.in('status', ['sent','paid'])` filter: a paid-but-unlinked invoice still
 *  counts toward the badge, same broad-query-narrow-per-row split that page's
 *  own comment explains). */
async function fetchAllCandidateInvoices(
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<{ rows: RawCandidateInvoiceRow[]; error: string | null }> {
  const rows: RawCandidateInvoiceRow[] = []
  let from = 0
  for (;;) {
    const { data, error } = await supabase
      .from('invoices')
      .select('id, number, client_id, total_cents, sent_at, paid_at, status, clients(name)')
      .in('status', ['sent', 'paid'])
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + LEDGER_TXN_PAGE_SIZE - 1)
    if (error) return { rows: [], error: error.message }
    rows.push(...((data ?? []) as unknown as RawCandidateInvoiceRow[]))
    if (!data || data.length < LEDGER_TXN_PAGE_SIZE) break
    from += LEDGER_TXN_PAGE_SIZE
  }
  return { rows, error: null }
}

type RawCandidateExpenseRow = {
  id: string
  show_id: string
  amount_cents: number
  spent_on: string
  where_spent: string
}

/** Every expense, owner-wide — mirrors app/money/matches/page.tsx's own
 *  fetchAllCandidateExpenses, minus the `shows(name)` embed that page needs
 *  for MatchQueue's display and this one doesn't (the badge only counts
 *  proposals, it never renders one). Unfiltered on whether it's already
 *  billed, same as that page: `linked` (from fetchAllExpenseLinks' set) is
 *  what proposeMatches actually uses to exclude an already-matched one. */
async function fetchAllCandidateExpenses(
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<{ rows: RawCandidateExpenseRow[]; error: string | null }> {
  const rows: RawCandidateExpenseRow[] = []
  let from = 0
  for (;;) {
    const { data, error } = await supabase
      .from('expenses')
      .select('id, show_id, amount_cents, spent_on, where_spent')
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + LEDGER_TXN_PAGE_SIZE - 1)
    if (error) return { rows: [], error: error.message }
    rows.push(...((data ?? []) as RawCandidateExpenseRow[]))
    if (!data || data.length < LEDGER_TXN_PAGE_SIZE) break
    from += LEDGER_TXN_PAGE_SIZE
  }
  return { rows, error: null }
}

function LoadError({ message }: { message: string }) {
  return (
    <AppShell current="money" wide>
      <p role="alert" className="text-danger border-l-2 border-danger pl-4 py-2">
        Couldn&rsquo;t load the ledger: {message}
      </p>
    </AppShell>
  )
}

export default async function MoneyPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>
}) {
  const params = await searchParams
  // The RENDERED list is filtered to uncategorized income/expense rows when
  // this is set — see the `filtered` slice below. Balances (working/cleared,
  // computed from allTxns) never see this flag: they must stay right whether
  // or not the register is currently narrowed to the review queue.
  const uncategorizedOnly = params.filter === 'uncategorized'

  const supabase = await createClient()

  // The one open checking account this ledger runs from — "first" by when it
  // was created, same tie-break the rest of the app uses when a query could
  // in principle return more than one row.
  const { data: accountRow, error: accountError } = await supabase
    .from('ledger_accounts')
    // opening_date rides along for the budget seed's own clamp below
    // (mirroring app/money/budget/page.tsx's own openingMonth/seedMonth
    // logic) — nothing else on this page needed it before now.
    .select('id, name, opening_balance_cents, opening_date, last_reconciled_at')
    .eq('closed', false)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (accountError) return <LoadError message={accountError.message} />

  // Seeds the S-Corp starter chart the first time this owner ever opens the
  // ledger — a no-op every load after that (see the doc comment on the
  // action itself). Runs whether or not an account exists yet, so the
  // categories are already there the moment the first-run card creates one.
  const seedResult = await ensureDefaultCategories()
  if ('error' in seedResult) return <LoadError message={seedResult.error} />

  const { data: categoryRows, error: categoryError } = await supabase
    .from('ledger_categories')
    .select('id, name, grp, sort, budget_role')
    .eq('hidden', false)
    .order('grp', { ascending: true })
    .order('sort', { ascending: true })
  if (categoryError) return <LoadError message={categoryError.message} />

  // grp rides along for MoneyRegister's "Group: Name" category cell; both it
  // and budget_role also feed MoneyRegister's deriveKind (Wave B Task 5) —
  // this query already selected grp (below) for no reason beyond ordering
  // until now, and now selects budget_role for the same reason.
  const categories: CategoryOption[] = (categoryRows ?? []).map((c) => ({
    id: c.id, name: c.name, grp: c.grp, budgetRole: c.budget_role as 'spending' | 'income',
  }))

  // For the Add row's show tag picker only — capped, and ordered by however
  // recently the show was created, not by its own dates. A transaction tagged
  // to a show outside this list still displays correctly (see RawTxnRow's
  // `show` join above); this list only has to be good enough to tag NEW ones.
  const { data: showRows, error: showError } = await supabase
    .from('shows')
    .select('id, name, show_days(date)')
    .order('created_at', { ascending: false })
    .limit(25)
  if (showError) return <LoadError message={showError.message} />

  const shows: ShowOption[] = ((showRows ?? []) as unknown as
    { id: string; name: string; show_days: { date: string }[] }[]
  ).map((s) => {
    const dates = s.show_days.map((d) => d.date).sort()
    const label = dates.length > 0 ? `${s.name} · ${formatDateShort(dates[0])}` : s.name
    return { id: s.id, label }
  })

  if (!accountRow) {
    return (
      <AppShell current="money" wide>
        <MoneyRegister
          account={null}
          categories={categories}
          categoryBalanceCents={{}}
          shows={shows}
          transactions={[]}
          toReviewIds={[]}
          workingBalanceCents={0}
          clearedBalanceCents={0}
          uncategorizedCount={0}
          totalCount={0}
          knownPayees={[]}
          aliasedRawPayees={[]}
        />
      </AppShell>
    )
  }

  const { rows: allTxns, error: txnError } = await fetchAllTransactions(supabase, accountRow.id)
  if (txnError) return <LoadError message={txnError} />

  // Split legs (Wave C Task 4) — owner-wide, bucketed by transaction_id
  // below; a transaction absent from this map is simply unsplit (the
  // ordinary case), never an error. Fetched here rather than per-account
  // scoped since fetchAllSplitLegs mirrors every other owner-wide fetch on
  // this page (fetchAllInvoiceLinks, fetchAllExpenseLinks, ...) — RLS
  // already scopes it to the caller's own rows, and only THIS account's
  // transactions ever look themselves up in it below.
  const { rows: splitLegRows, error: splitLegError } = await fetchAllSplitLegs(supabase)
  if (splitLegError) return <LoadError message={splitLegError} />
  const legsByTxnId = new Map<string, SplitLegRow[]>()
  for (const l of splitLegRows) {
    const list = legsByTxnId.get(l.transaction_id) ?? []
    list.push({
      categoryId: l.category_id,
      categoryName: l.category?.name ?? null,
      categoryBudgetRole: l.category ? (l.category.budget_role === 'income' ? 'income' : 'spending') : null,
      amountCents: l.amount_cents,
      note: l.note,
    })
    legsByTxnId.set(l.transaction_id, list)
  }

  // CategoryPicker's own balance map (Wave B Task 3) — the SAME validated
  // arithmetic app/money/budget/page.tsx runs (lib/budget.ts's buildBudget),
  // zero new math here. `budgetCategoryRows` and `moveRows` are the two
  // fetches that page has and this one didn't; `allTxns` above already IS
  // this page's own paged read of ledger_transactions, so building
  // buildBudget's own BudgetTxn list from it (below) needs no second paged
  // query — only the same `.gte(FIRST_BUDGET_MONTH)` filter and the same
  // opening-balance seed row that page's own txns assembly injects.
  //
  // M1 (Wave B final review): either fetch failing used to LoadError the
  // WHOLE register — but this map only feeds CategoryPicker's balance
  // FIGURES, a decoration on top of the register, not a guard. (Every
  // ownership/money read elsewhere on this page still fails closed with
  // LoadError, unchanged — this is the one map that's display-only.) A
  // transient error here now degrades to an empty map instead: no balance
  // figures show in the picker, but Dan can still see and edit every
  // transaction. Nothing sensitive is logged — the error text itself is
  // simply dropped, the same as it would have been inside LoadError's own
  // rendered message.
  const { rows: budgetCategoryRows, error: budgetCategoryError } = await fetchAllCategoriesForBudget(supabase)
  const { rows: moveRows, error: moveError } = await fetchAllBudgetMoves(supabase)

  const categoryBalanceCents: Record<string, number> = {}
  if (!budgetCategoryError && !moveError) {
    const budgetCategories: BudgetCategory[] = budgetCategoryRows.map((c) => ({
      id: c.id, name: c.name, grp: c.grp, sort: c.sort, hidden: c.hidden,
      budgetRole: c.budget_role as 'spending' | 'income',
    }))
    const budgetMoves: BudgetMove[] = moveRows.map((m) => ({
      month: m.month.slice(0, 7),
      fromCategoryId: m.from_category_id,
      toCategoryId: m.to_category_id,
      amountCents: m.amount_cents,
      undoneAt: m.undone_at,
    }))

    const currentMonth = todayInChicago().slice(0, 7)
    // The account's opening balance is not a transaction, but it is money
    // that needs a job just like app/money/budget/page.tsx's own RTA seed —
    // clamped the exact same way that file's own seedMonth is (see its own
    // comment for why both ends need the clamp), just against
    // `currentMonth` in place of that page's navigable `last` (this page
    // never looks past today).
    const openingMonth = accountRow.opening_date.slice(0, 7)
    const budgetSeedMonth =
      openingMonth < OPENING_MONTH ? OPENING_MONTH :
      openingMonth > currentMonth ? currentMonth :
      openingMonth
    // explodeForCategories (lib/ledgerSplits.ts) — the SAME single helper
    // app/money/budget/page.tsx's own txn assembly calls — runs over this
    // SAME paged `allTxns` before it feeds buildBudget, so a split parent's
    // line is suppressed in favor of its legs. Every row counts, reviewed
    // or not (2026-08-25): entered_at is not read here at all any more.
    // `legsByTxnId` is already built above (for the register's own Split (N)
    // display) and is reused here rather than double-fetched.
    const explodableTxns: TxnForExplode[] = allTxns
      .filter((t) => t.date >= `${FIRST_BUDGET_MONTH}-01`)
      .map((t) => ({
        month: t.date.slice(0, 7),
        categoryId: t.category_id,
        amountCents: t.amount_cents,
        legs: legsByTxnId.get(t.id),
      }))
    const budgetTxns: BudgetTxn[] = [
      { month: budgetSeedMonth, categoryId: null, amountCents: accountRow.opening_balance_cents },
      ...explodeForCategories(explodableTxns),
    ]

    const budget = buildBudget({
      categories: budgetCategories, moves: budgetMoves, txns: budgetTxns, targets: [],
      fromMonth: OPENING_MONTH, toMonth: currentMonth,
    })
    for (const row of budget.get(currentMonth)?.rows ?? []) categoryBalanceCents[row.categoryId] = row.availableCents
  }

  // Link tables + everything the Matches badge needs — both pages that touch
  // these (this one and app/money/matches/page.tsx) page past 1000 rows for
  // the same reason fetchAllTransactions above does: a plain unranged select
  // would silently drop a link or a dismissal past PostgREST's cap.
  const { rows: invoiceLinkRows, error: invoiceLinkError } = await fetchAllInvoiceLinks(supabase)
  if (invoiceLinkError) return <LoadError message={invoiceLinkError} />

  const { rows: expenseLinkRows, error: expenseLinkError } = await fetchAllExpenseLinks(supabase)
  if (expenseLinkError) return <LoadError message={expenseLinkError} />

  const { rows: dismissalRows, error: dismissalError } = await fetchAllDismissals(supabase)
  if (dismissalError) return <LoadError message={dismissalError} />

  const { rows: candidateInvoiceRows, error: candidateInvoicesError } = await fetchAllCandidateInvoices(supabase)
  if (candidateInvoicesError) return <LoadError message={candidateInvoicesError} />

  const { rows: candidateExpenseRows, error: candidateExpensesError } = await fetchAllCandidateExpenses(supabase)
  if (candidateExpensesError) return <LoadError message={candidateExpensesError} />

  // The three fields LedgerTxnRow adds for the register (components/
  // MoneyRegister.tsx) — a txn can carry more than one invoice link (a
  // deposit covering two invoices), hence an array; "first linked expense
  // with a receipt_path wins" for linkedReceiptPath works because
  // fetchAllExpenseLinks pages in (created_at, id) order, so the first
  // qualifying row seen here really is the earliest-linked one.
  const invoiceNumbersByTxnId = new Map<string, number[]>()
  for (const l of invoiceLinkRows) {
    if (l.invoices === null) continue
    const list = invoiceNumbersByTxnId.get(l.transaction_id) ?? []
    list.push(l.invoices.number)
    invoiceNumbersByTxnId.set(l.transaction_id, list)
  }
  const expenseLinkedTxnIds = new Set(expenseLinkRows.map((l) => l.transaction_id))
  const linkedReceiptPathByTxnId = new Map<string, string>()
  for (const l of expenseLinkRows) {
    const path = l.expenses?.receipt_path
    if (path && !linkedReceiptPathByTxnId.has(l.transaction_id)) {
      linkedReceiptPathByTxnId.set(l.transaction_id, path)
    }
  }

  // Matches badge: "linked" = named by ANY row in either link table, same
  // derivation app/money/matches/page.tsx uses for BankRow/CandidateInvoice/
  // CandidateExpense.linked. proposeMatches runs over allTxns (already
  // loaded above, already the complete unpaged set for this account) rather
  // than a second ledger_transactions fetch.
  const linkedTxnIds = new Set<string>()
  for (const l of invoiceLinkRows) linkedTxnIds.add(l.transaction_id)
  for (const l of expenseLinkRows) linkedTxnIds.add(l.transaction_id)
  const linkedInvoiceIds = new Set(invoiceLinkRows.map((l) => l.invoice_id))
  const linkedExpenseIds = new Set(expenseLinkRows.map((l) => l.expense_id))

  // No pending filter (2026-08-25): an unreviewed deposit is ordinary money
  // now and can legitimately be the one that paid an invoice. /money/matches
  // drops the same filter at its own fetch, so this badge still agrees with
  // the page it links to (the register's own badge/list rule).
  const matchRows: BankRow[] = allTxns.map((t) => ({
    id: t.id, date: t.date, amount_cents: t.amount_cents, payee: t.payee, kind: t.kind,
    linked: linkedTxnIds.has(t.id),
  }))
  const candidateInvoices: CandidateInvoice[] = candidateInvoiceRows.map((i) => ({
    id: i.id,
    number: i.number,
    client_id: i.client_id,
    client_name: i.clients?.name ?? '',
    total_cents: i.total_cents,
    sent_at: i.sent_at,
    paid_at: i.paid_at,
    status: i.status as 'sent' | 'paid',
    linked: linkedInvoiceIds.has(i.id),
  }))
  const candidateExpenses: CandidateExpense[] = candidateExpenseRows.map((e) => ({
    id: e.id,
    show_id: e.show_id,
    amount_cents: e.amount_cents,
    spent_on: e.spent_on,
    where_spent: e.where_spent,
    linked: linkedExpenseIds.has(e.id),
  }))
  const dismissed: Dismissal[] = dismissalRows.map((d) => ({
    transaction_id: d.transaction_id, invoice_id: d.invoice_id, expense_id: d.expense_id,
  }))
  const proposals = proposeMatches({
    rows: matchRows, invoices: candidateInvoices, expenses: candidateExpenses, dismissed,
  })
  const matchCount = proposals.income.length + proposals.expense.length

  const balanceInputs: BalanceLike[] = allTxns.map((t) => ({ amount_cents: t.amount_cents, cleared: t.cleared }))
  const workingBalanceCents = workingBalance(accountRow.opening_balance_cents, balanceInputs)
  const clearedBalanceCents = clearedBalance(accountRow.opening_balance_cents, balanceInputs)
  // This is the "uncategorized queue" count, which the inline picker and its
  // apply-to-same-payee sweep both scope to income/expense (see
  // setTransactionCategory's own doc comment in app/money/actions.ts) —
  // transfer never carries a category (lt_nocat_for_transfer, migration
  // 0038) and owner_pay, though it can carry one since that same migration,
  // is categorized through the edit form rather than this queue. Counting
  // either kind here would inflate the queue with rows this workflow was
  // never meant to surface. `!legsByTxnId.has(t.id)` excludes a split
  // parent (Wave C Task 4) — its own category_id is null too (replace_
  // transaction_splits forces it the instant legs exist), but it is
  // categorized through its legs, not this queue; without this it would
  // inflate the badge with rows MoneyRegister's inline quick-pick doesn't
  // even offer a picker for anymore (see LedgerTxnRow's own `legs` comment).
  const uncategorizedCount = allTxns.filter(
    (t) => t.category_id === null && !legsByTxnId.has(t.id) && (t.kind === 'income' || t.kind === 'expense'),
  ).length

  // Canonical (oldest-first) ledger order — date asc, created_at asc, id asc,
  // see compareLedgerOrder's doc comment — over the FULL set, so runningBalances
  // can prefix-sum from the account's true opening balance. balanceById then lets
  // the render step below look up "the balance after this txn" by id regardless
  // of what order or subset it's about to display.
  const ledgerOrdered = [...allTxns].sort(compareLedgerOrder)
  const balances = runningBalances(accountRow.opening_balance_cents, ledgerOrdered)
  const balanceById = new Map(ledgerOrdered.map((t, i) => [t.id, balances[i]]))

  // Display order is the EXACT reverse of ledger order (compareLedgerOrder
  // called with its arguments swapped), rather than a hand-rolled
  // newest-first sort — that used to skip the id tiebreak, which
  // compareLedgerOrder has. Because it's the true reverse, the top rendered
  // row is always the most-recent txn in ledger order, so its balanceCents
  // equals workingBalanceCents exactly (see runningBalances' invariant,
  // proven by the "invariant — last balance equals workingBalance" test in
  // scripts/test/ledgerBalance.test.ts).
  const sorted = [...allTxns].sort((a, b) => compareLedgerOrder(b, a))
  // The RENDERED list — filtered to match the uncategorized queue when
  // ?filter=uncategorized is set, otherwise the full transaction set. Same kind
  // filter as uncategorizedCount above, so when filtered, this list's length
  // always agrees with that badge.
  //
  // Balances (balanceById, built above) are computed over the FULL,
  // unfiltered set — DELIBERATELY unaffected by this filter. A row's balance
  // is what the account held after that transaction actually posted; that
  // fact doesn't change because the review queue is currently narrowed to
  // uncategorized rows only, so filtering here must never recompute or
  // re-derive it.
  const filtered = uncategorizedOnly
    ? sorted.filter((t) => t.category_id === null && !legsByTxnId.has(t.id) && (t.kind === 'income' || t.kind === 'expense'))
    : sorted
  const totalCount = filtered.length
  // The one row mapper for the DISPLAY list, which obeys the page filter.
  const toRow = (t: (typeof sorted)[number]): LedgerTxnRow => ({
    id: t.id,
    date: t.date,
    amount_cents: t.amount_cents,
    kind: t.kind,
    category_id: t.category_id,
    // deriveKind's own fallback for a since-hidden category (see RawTxnRow's
    // own comment above) — undefined-vs-null doesn't matter here since
    // t.category is either the whole join or null, never partial.
    categoryName: t.category?.name ?? null,
    categoryBudgetRole: t.category ? (t.category.budget_role === 'income' ? 'income' : 'spending') : null,
    show_id: t.show_id,
    showName: t.show?.name ?? null,
    payee: t.payee,
    memo: t.memo,
    cleared: t.cleared,
    entered_at: t.entered_at,
    // BOTH markers, deliberately (see LedgerTxnRow.isImported): a row is only
    // treated as the bank's if it says 'import' AND carries the bank's own
    // per-row key, so a hand-entered row that somehow ended up with one of
    // the two can't be mistaken for a bank descriptor and offered a rename.
    isImported: t.source === 'import' && t.import_id !== null,
    legs: legsByTxnId.get(t.id) ?? [],
    // Non-null assertion is safe: t comes from allTxns (via sorted/filtered),
    // and balanceById was built from ledgerOrdered — the exact same array,
    // just sorted differently — so every id here is guaranteed a key there.
    balanceCents: balanceById.get(t.id)!,
    receipt_path: t.receipt_path,
    receipt_original: t.receipt_original,
    invoiceNumbers: invoiceNumbersByTxnId.get(t.id) ?? [],
    expenseLinked: expenseLinkedTxnIds.has(t.id),
    linkedReceiptPath: linkedReceiptPathByTxnId.get(t.id) ?? null,
  })
  const transactions: LedgerTxnRow[] = filtered.map(toRow)
  // Unreviewed ids from the UNFILTERED set: the review count and Enter All
  // must never shrink because a display filter is on.
  const toReviewIds: string[] = sorted.filter((t) => t.entered_at === null).map((t) => t.id)

  const account: LedgerAccountSummary = {
    id: accountRow.id,
    name: accountRow.name,
    lastReconciledAt: accountRow.last_reconciled_at,
  }

  // The suggestion's raw material: payees he already uses, and the aliases he
  // has already confirmed. Both are small — a few hundred rows at most — and
  // the register needs them to decide whether to offer a rename at all.
  //
  // Owner-scoped explicitly, not left to RLS alone, the same doctrine
  // setPayeeAlias states for its own reads and writes. And the error is kept,
  // not swallowed: `?? []` on a FAILED read would say "he has aliased nothing
  // yet" — which is not an absence of aliases, it is an absence of knowledge —
  // and the register would sprout a rename chip on every payee he already
  // named. `null` carries that unknown through to the register, which offers
  // no chip at all while it holds. The page still renders: a chip he cannot
  // see is a smaller loss than the whole ledger going behind an error screen.
  const { data: { user: aliasUser } } = await supabase.auth.getUser()
  let aliasedRaw: string[] | null = null
  if (aliasUser) {
    const { data: aliasRows, error: aliasError } = await supabase
      .from('ledger_payee_aliases').select('raw_payee').eq('owner_id', aliasUser.id)
    if (!aliasError) {
      aliasedRaw = ((aliasRows ?? []) as { raw_payee: string }[]).map((a) => a.raw_payee)
    }
  }
  const knownPayees: string[] = [...new Set(
    allTxns.filter((t) => t.category_id !== null && t.payee.trim() !== '').map((t) => t.payee),
  )]

  return (
    <AppShell current="money" wide>
      <MoneyRegister
        account={account}
        categories={categories}
        categoryBalanceCents={categoryBalanceCents}
        shows={shows}
        transactions={transactions}
        toReviewIds={toReviewIds}
        workingBalanceCents={workingBalanceCents}
        clearedBalanceCents={clearedBalanceCents}
        uncategorizedCount={uncategorizedCount}
        totalCount={totalCount}
        knownPayees={knownPayees}
        aliasedRawPayees={aliasedRaw}
        uncategorizedOnly={uncategorizedOnly}
        headerActions={
          <>
            <LedgerImportReconcile accountId={account.id} />
            <Link
              href="/money/matches"
              className="text-xs text-muted hover:text-ink transition-colors"
            >
              Matches{matchCount > 0 && <span className="ml-1 font-semibold text-accent">{matchCount}</span>}
            </Link>
            <Link
              href="/money/budget"
              className="text-xs text-muted hover:text-ink transition-colors"
            >
              Budget
            </Link>
            <Link
              href="/money/forecast"
              className="text-xs text-muted hover:text-ink transition-colors"
            >
              Forecast
            </Link>
            <Link
              href="/money/reports"
              className="text-xs text-muted hover:text-ink transition-colors"
            >
              Reports
            </Link>
            <Link
              href="/money/categories"
              className="text-xs text-muted hover:text-ink transition-colors"
            >
              Edit categories
            </Link>
          </>
        }
      />
    </AppShell>
  )
}
