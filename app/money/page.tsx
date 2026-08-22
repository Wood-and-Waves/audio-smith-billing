import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { formatDateShort } from '@/lib/dates'
import {
  workingBalance, clearedBalance, compareLedgerOrder, runningBalances, type BalanceLike,
} from '@/lib/ledgerBalance'
import {
  proposeMatches, type BankRow, type CandidateInvoice, type CandidateExpense, type Dismissal,
} from '@/lib/ledgerMatch'
import AppShell from '@/components/AppShell'
import MoneyRegister, {
  type CategoryOption, type LedgerAccountSummary, type LedgerTxnRow, type ShowOption,
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

// The RENDERED list is capped (see below) to keep the DOM sane on an account
// with years of history, but the balances above it are computed from every
// row that exists — the whole reason this file pages past 1000 in the first
// place.
const RENDER_CAP = 200

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
  receipt_path: string | null
  receipt_original: string | null
  // Denormalized here (rather than cross-referenced client-side against the
  // "not hidden" categories list or the "most recent 25" shows list) so a
  // transaction tagged to an old show or a since-hidden category still shows
  // its real name in the register — those two lists only exist to populate
  // the Select pickers, and neither is guaranteed to still contain a name
  // some past transaction points at.
  category: { name: string } | null
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
                receipt_path, receipt_original,
                category:ledger_categories(name), show:shows(name)`)
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
    .select('id, name, opening_balance_cents, last_reconciled_at')
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
    .select('id, name, grp, sort')
    .eq('hidden', false)
    .order('grp', { ascending: true })
    .order('sort', { ascending: true })
  if (categoryError) return <LoadError message={categoryError.message} />

  // grp rides along for MoneyRegister's "Group: Name" category cell — this
  // query already selected it (below) for no reason beyond ordering until
  // now.
  const categories: CategoryOption[] = (categoryRows ?? []).map((c) => ({ id: c.id, name: c.name, grp: c.grp }))

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
          shows={shows}
          transactions={[]}
          workingBalanceCents={0}
          clearedBalanceCents={0}
          uncategorizedCount={0}
          totalCount={0}
        />
      </AppShell>
    )
  }

  const { rows: allTxns, error: txnError } = await fetchAllTransactions(supabase, accountRow.id)
  if (txnError) return <LoadError message={txnError} />

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
  // Owner pay and transfers never carry a category (lt_nocat_for_owner_or_transfer,
  // migration 0027) — counting them here would inflate the queue with rows
  // that can never be categorized in the first place.
  const uncategorizedCount = allTxns.filter(
    (t) => t.category_id === null && (t.kind === 'income' || t.kind === 'expense'),
  ).length

  // Canonical (oldest-first) ledger order — date asc, created_at asc, id asc,
  // see compareLedgerOrder's doc comment — over the FULL set (never the
  // 200-slice), so runningBalances can prefix-sum from the account's true
  // opening balance. balanceById then lets the render step below look up
  // "the balance after this txn" by id regardless of what order or subset
  // it's about to display.
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
  // The RENDERED list only — filtered before the 200-cap below (not after),
  // so ?filter=uncategorized shows the actual next 200 uncategorized rows
  // rather than whatever uncategorized rows happened to survive an unrelated
  // most-recent-200 cut. Same kind filter as uncategorizedCount above, so
  // this list's length always agrees with that badge.
  //
  // Balances (balanceById, built above) are computed over the FULL,
  // unfiltered set — DELIBERATELY unaffected by this filter. A row's balance
  // is what the account held after that transaction actually posted; that
  // fact doesn't change because the review queue is currently narrowed to
  // uncategorized rows only, so filtering here must never recompute or
  // re-derive it.
  const filtered = uncategorizedOnly
    ? sorted.filter((t) => t.category_id === null && (t.kind === 'income' || t.kind === 'expense'))
    : sorted
  const totalCount = filtered.length
  const transactions: LedgerTxnRow[] = filtered.slice(0, RENDER_CAP).map((t) => ({
    id: t.id,
    date: t.date,
    amount_cents: t.amount_cents,
    kind: t.kind,
    category_id: t.category_id,
    categoryName: t.category?.name ?? null,
    show_id: t.show_id,
    showName: t.show?.name ?? null,
    payee: t.payee,
    memo: t.memo,
    cleared: t.cleared,
    // Non-null assertion is safe: t comes from allTxns (via sorted/filtered),
    // and balanceById was built from ledgerOrdered — the exact same array,
    // just sorted differently — so every id here is guaranteed a key there.
    balanceCents: balanceById.get(t.id)!,
    receipt_path: t.receipt_path,
    receipt_original: t.receipt_original,
    invoiceNumbers: invoiceNumbersByTxnId.get(t.id) ?? [],
    expenseLinked: expenseLinkedTxnIds.has(t.id),
    linkedReceiptPath: linkedReceiptPathByTxnId.get(t.id) ?? null,
  }))

  const account: LedgerAccountSummary = {
    id: accountRow.id,
    name: accountRow.name,
    lastReconciledAt: accountRow.last_reconciled_at,
  }

  return (
    <AppShell current="money" wide>
      <MoneyRegister
        account={account}
        categories={categories}
        shows={shows}
        transactions={transactions}
        workingBalanceCents={workingBalanceCents}
        clearedBalanceCents={clearedBalanceCents}
        uncategorizedCount={uncategorizedCount}
        totalCount={totalCount}
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
