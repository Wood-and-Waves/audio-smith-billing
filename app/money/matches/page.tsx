import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { proposeMatches, type BankRow, type CandidateInvoice, type CandidateExpense, type Dismissal } from '@/lib/ledgerMatch'
import { formatUSD } from '@/lib/money'
import AppShell from '@/components/AppShell'
import MatchQueue, { type IncomeCard, type ExpenseCard, type DismissedCard } from '@/components/MatchQueue'

export const dynamic = 'force-dynamic'

// Supabase selects silently cap at 1000 rows (PostgREST's max_rows) — a plain
// unranged .select() would truncate any of the six sets below with no error,
// which would make proposeMatches guess from a partial picture (a "linked"
// invoice that's actually on page 2 would look unlinked, and reappear as a
// bogus proposal). Same paged, (created_at, id)-ordered shape as every other
// copy of this loop in app/money/*.tsx, duplicated rather than imported for
// the same reason those are: a 'use server' file may only export actions.
const PAGE_SIZE = 1000

type RawLedgerTxnRow = {
  id: string
  date: string
  amount_cents: number
  kind: 'income' | 'expense' | 'owner_pay' | 'transfer'
  payee: string
}

/** Every ledger_transactions row for THIS account — the matcher's own BankRow
 *  candidates (income/expense kind, `linked` computed below) are drawn from
 *  this set, so it has to be complete or a real deposit/charge could be
 *  missing from the queue entirely. */
async function fetchAllLedgerTxns(
  supabase: Awaited<ReturnType<typeof createClient>>,
  accountId: string,
): Promise<{ rows: RawLedgerTxnRow[]; error: string | null }> {
  const rows: RawLedgerTxnRow[] = []
  let from = 0
  for (;;) {
    const { data, error } = await supabase
      .from('ledger_transactions')
      .select('id, date, amount_cents, kind, payee')
      .eq('account_id', accountId)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1)
    if (error) return { rows: [], error: error.message }
    rows.push(...((data ?? []) as RawLedgerTxnRow[]))
    if (!data || data.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }
  return { rows, error: null }
}

type RawInvoiceLinkRow = { transaction_id: string; invoice_id: string }

/** Every ledger_transaction_invoices row, owner-wide (not account-scoped —
 *  the link table has no account_id of its own). Grows unbounded as invoices
 *  get matched over the years, so this pages the same as everything else
 *  here rather than trusting a single unranged select to stay under 1000. */
async function fetchAllInvoiceLinks(
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<{ rows: RawInvoiceLinkRow[]; error: string | null }> {
  const rows: RawInvoiceLinkRow[] = []
  let from = 0
  for (;;) {
    const { data, error } = await supabase
      .from('ledger_transaction_invoices')
      .select('transaction_id, invoice_id')
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1)
    if (error) return { rows: [], error: error.message }
    rows.push(...((data ?? []) as RawInvoiceLinkRow[]))
    if (!data || data.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }
  return { rows, error: null }
}

type RawExpenseLinkRow = { transaction_id: string; expense_id: string }

/** Every ledger_transaction_expenses row, owner-wide — mirrors
 *  fetchAllInvoiceLinks above, the expense-side twin of the same link. */
async function fetchAllExpenseLinks(
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<{ rows: RawExpenseLinkRow[]; error: string | null }> {
  const rows: RawExpenseLinkRow[] = []
  let from = 0
  for (;;) {
    const { data, error } = await supabase
      .from('ledger_transaction_expenses')
      .select('transaction_id, expense_id')
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1)
    if (error) return { rows: [], error: error.message }
    rows.push(...((data ?? []) as RawExpenseLinkRow[]))
    if (!data || data.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }
  return { rows, error: null }
}

type RawDismissalRow = { id: string; transaction_id: string; invoice_id: string | null; expense_id: string | null }

/** Every ledger_match_dismissals row, owner-wide — proposeMatches is pure and
 *  stateless (see lib/ledgerMatch.ts's own doc comment), so a truncated read
 *  here would let a rejected guess Dan already dismissed reappear once the
 *  dismissal list grew past 1000 rows. `id` rides along (not just the
 *  transaction_id/invoice_id/expense_id proposeMatches itself needs) because
 *  the Dismissed section below and restoreDismissal both key off the
 *  dismissal row's own id, not the pair it names. */
async function fetchAllDismissals(
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<{ rows: RawDismissalRow[]; error: string | null }> {
  const rows: RawDismissalRow[] = []
  let from = 0
  for (;;) {
    const { data, error } = await supabase
      .from('ledger_match_dismissals')
      .select('id, transaction_id, invoice_id, expense_id')
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1)
    if (error) return { rows: [], error: error.message }
    rows.push(...((data ?? []) as RawDismissalRow[]))
    if (!data || data.length < PAGE_SIZE) break
    from += PAGE_SIZE
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
  // object at runtime, same cast app/money/actions.ts's BridgeInvoiceRow uses
  // for the identical embed — never an array, whatever the generated types
  // might otherwise claim.
  clients: { name: string } | null
}

/** Every sent-or-paid invoice, owner-wide — a paid-but-unlinked invoice stays
 *  a candidate on purpose (a deposit matched by hand should still get its own
 *  bank row linked up), so the filter here stays broad:
 *  `.in('status', ['sent','paid'])`, not just 'sent'. The recency narrowing
 *  — a paid invoice only counts within PAID_RECENCY_DAYS of paid_at — is NOT
 *  this query's job; it's applied per row by lib/ledgerMatch.ts's
 *  eligibleForRow, which is exactly where a pre-0032 invoice (paid_at NULL)
 *  drops out. */
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
      .range(from, from + PAGE_SIZE - 1)
    if (error) return { rows: [], error: error.message }
    rows.push(...((data ?? []) as unknown as RawCandidateInvoiceRow[]))
    if (!data || data.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }
  return { rows, error: null }
}

type RawCandidateExpenseRow = {
  id: string
  show_id: string
  amount_cents: number
  spent_on: string
  where_spent: string
  shows: { name: string } | null
}

/** Every expense, owner-wide — unfiltered on whether it's already billed;
 *  `linked` (computed from fetchAllExpenseLinks' set) is what
 *  proposeMatches actually uses to exclude one that's already matched. */
async function fetchAllCandidateExpenses(
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<{ rows: RawCandidateExpenseRow[]; error: string | null }> {
  const rows: RawCandidateExpenseRow[] = []
  let from = 0
  for (;;) {
    const { data, error } = await supabase
      .from('expenses')
      .select('id, show_id, amount_cents, spent_on, where_spent, shows(name)')
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1)
    if (error) return { rows: [], error: error.message }
    rows.push(...((data ?? []) as unknown as RawCandidateExpenseRow[]))
    if (!data || data.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }
  return { rows, error: null }
}

type DismissedTxnLite = { id: string; date: string; amount_cents: number; payee: string }

/**
 * Bank rows the Dismissed section needs but fetchAllLedgerTxns above didn't
 * return — that fetch is scoped to THIS account (`.eq('account_id', ...)`),
 * so a dismissal naming a transaction on some other/since-closed account
 * would otherwise have no display row at all. Not paged like the candidate
 * fetches above: bounded by how many dismissals point somewhere the main
 * fetch missed, never by total transaction count, so a single `.in()` is the
 * "direct .in on collected ids is fine" case, not the "truncates past 1000"
 * one those fetches guard against.
 */
async function fetchMissingTxns(
  supabase: Awaited<ReturnType<typeof createClient>>,
  ids: string[],
): Promise<{ rows: DismissedTxnLite[]; error: string | null }> {
  if (ids.length === 0) return { rows: [], error: null }
  const { data, error } = await supabase
    .from('ledger_transactions')
    .select('id, date, amount_cents, payee')
    .in('id', ids)
  if (error) return { rows: [], error: error.message }
  return { rows: (data ?? []) as DismissedTxnLite[], error: null }
}

type DismissedInvoiceLite = { id: string; number: number; total_cents: number; clients: { name: string } | null }

/**
 * Invoices the Dismissed section needs but fetchAllCandidateInvoices above
 * didn't return — that fetch filters to status in ('sent','paid'), so a
 * dismissal against an invoice that's since gone back to 'draft' or been
 * voided would otherwise have no display row. Same "direct .in, not paged"
 * reasoning as fetchMissingTxns above.
 */
async function fetchMissingInvoices(
  supabase: Awaited<ReturnType<typeof createClient>>,
  ids: string[],
): Promise<{ rows: DismissedInvoiceLite[]; error: string | null }> {
  if (ids.length === 0) return { rows: [], error: null }
  const { data, error } = await supabase
    .from('invoices')
    .select('id, number, total_cents, clients(name)')
    .in('id', ids)
  if (error) return { rows: [], error: error.message }
  return { rows: (data ?? []) as unknown as DismissedInvoiceLite[], error: null }
}

type DismissedExpenseLite = {
  id: string; amount_cents: number; spent_on: string; where_spent: string; shows: { name: string } | null
}

/**
 * Expenses the Dismissed section needs but fetchAllCandidateExpenses above
 * didn't return — that fetch is unfiltered on status, but a dismissed
 * expense can still have been deleted outright since. Same "direct .in, not
 * paged" reasoning as fetchMissingTxns above.
 */
async function fetchMissingExpenses(
  supabase: Awaited<ReturnType<typeof createClient>>,
  ids: string[],
): Promise<{ rows: DismissedExpenseLite[]; error: string | null }> {
  if (ids.length === 0) return { rows: [], error: null }
  const { data, error } = await supabase
    .from('expenses')
    .select('id, amount_cents, spent_on, where_spent, shows(name)')
    .in('id', ids)
  if (error) return { rows: [], error: error.message }
  return { rows: (data ?? []) as unknown as DismissedExpenseLite[], error: null }
}

function LoadError({ message }: { message: string }) {
  return (
    <AppShell current="money">
      <p role="alert" className="text-danger border-l-2 border-danger pl-4 py-2">
        Couldn&rsquo;t load the match queue: {message}
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

export default async function MoneyMatchesPage() {
  const supabase = await createClient()

  // Same single-account model as /money/budget: the one open checking
  // account this ledger runs from. Matches are drawn from THIS account's own
  // bank rows against every invoice/expense the owner has, so with no
  // account there is nothing to propose.
  const { data: accountRow, error: accountError } = await supabase
    .from('ledger_accounts')
    .select('id')
    .eq('closed', false)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (accountError) return <LoadError message={accountError.message} />

  if (!accountRow) {
    return (
      <AppShell current="money">
        <BackLink />
        <h1 className="display text-3xl font-bold mb-4">Matches</h1>
        <p className="text-muted border-l-2 border-line pl-4 py-2">
          There&rsquo;s no checking account yet.{' '}
          <Link href="/money" className="font-semibold text-accent hover:opacity-80">
            Set one up on the ledger
          </Link>{' '}
          first, then come back to review matches.
        </p>
      </AppShell>
    )
  }

  const { rows: txnRows, error: txnError } = await fetchAllLedgerTxns(supabase, accountRow.id)
  if (txnError) return <LoadError message={txnError} />

  const { rows: invoiceLinkRows, error: invoiceLinkError } = await fetchAllInvoiceLinks(supabase)
  if (invoiceLinkError) return <LoadError message={invoiceLinkError} />

  const { rows: expenseLinkRows, error: expenseLinkError } = await fetchAllExpenseLinks(supabase)
  if (expenseLinkError) return <LoadError message={expenseLinkError} />

  const { rows: dismissalRows, error: dismissalError } = await fetchAllDismissals(supabase)
  if (dismissalError) return <LoadError message={dismissalError} />

  const { rows: invoiceRows, error: invoicesError } = await fetchAllCandidateInvoices(supabase)
  if (invoicesError) return <LoadError message={invoicesError} />

  const { rows: expenseRows, error: expensesError } = await fetchAllCandidateExpenses(supabase)
  if (expensesError) return <LoadError message={expensesError} />

  // "linked" = named by ANY row in either link table — a bank row can only
  // ever be an income link, an expense link, or unlinked (acceptIncomeMatch/
  // acceptExpenseMatch both refuse a second link), so one combined set is
  // enough for BankRow.linked.
  const linkedTxnIds = new Set<string>()
  for (const l of invoiceLinkRows) linkedTxnIds.add(l.transaction_id)
  for (const l of expenseLinkRows) linkedTxnIds.add(l.transaction_id)
  const linkedInvoiceIds = new Set(invoiceLinkRows.map((l) => l.invoice_id))
  const linkedExpenseIds = new Set(expenseLinkRows.map((l) => l.expense_id))

  const rows: BankRow[] = txnRows.map((t) => ({
    id: t.id,
    date: t.date,
    amount_cents: t.amount_cents,
    payee: t.payee,
    kind: t.kind,
    linked: linkedTxnIds.has(t.id),
  }))

  const invoices: CandidateInvoice[] = invoiceRows.map((i) => ({
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

  const expenses: CandidateExpense[] = expenseRows.map((e) => ({
    id: e.id,
    show_id: e.show_id,
    amount_cents: e.amount_cents,
    spent_on: e.spent_on,
    where_spent: e.where_spent,
    linked: linkedExpenseIds.has(e.id),
  }))

  const dismissed: Dismissal[] = dismissalRows.map((d) => ({
    transaction_id: d.transaction_id,
    invoice_id: d.invoice_id,
    expense_id: d.expense_id,
  }))

  const proposals = proposeMatches({ rows, invoices, expenses, dismissed })

  // Lookup maps: proposeMatches hands back ids, not the rows themselves (it
  // never sees anything but plain matcher inputs), so this page — the only
  // place that also knows client/show display names — re-attaches them for
  // MatchQueue.
  const rowById = new Map(rows.map((r) => [r.id, r]))
  const invoiceById = new Map(invoices.map((i) => [i.id, i]))
  const expenseById = new Map(expenses.map((e) => [e.id, e]))
  const showNameByExpenseId = new Map(expenseRows.map((e) => [e.id, e.shows?.name ?? '']))

  const income: IncomeCard[] = proposals.income.map((p) => {
    // Non-null: every id proposeMatches returns came from `rows`/`invoices`
    // above, the exact arrays these maps are built from.
    const txn = rowById.get(p.transactionId)!
    const invs = p.invoiceIds.map((id) => invoiceById.get(id)!)
    return {
      txn: { id: txn.id, date: txn.date, amountCents: txn.amount_cents, payee: txn.payee },
      invoices: invs.map((i) => ({
        id: i.id, number: i.number, clientName: i.client_name, totalCents: i.total_cents,
        status: i.status,
        // Non-null: proposeMatches's own eligibleInvoices filter already
        // requires sent_at !== null before an invoice can appear in any
        // proposal — same cast lib/ledgerMatch.ts's own sentDate uses.
        sent: (i.sent_at as string).slice(0, 10),
      })),
      confidence: p.confidence,
      payeeAgrees: p.payeeAgrees,
    }
  })

  const expense: ExpenseCard[] = proposals.expense.map((p) => {
    const exp = expenseById.get(p.expenseId)!
    const txns = p.transactionIds.map((id) => rowById.get(id)!)
    return {
      txns: txns.map((t) => ({ id: t.id, date: t.date, amountCents: t.amount_cents, payee: t.payee })),
      expense: {
        id: exp.id, amountCents: exp.amount_cents, spentOn: exp.spent_on, whereSpent: exp.where_spent,
        showName: showNameByExpenseId.get(exp.id) ?? '',
      },
      confidence: p.confidence,
      payeeAgrees: p.payeeAgrees,
    }
  })

  // Display maps for the Dismissed section — seeded from the candidate sets
  // already fetched above (the common case: nothing else has happened to the
  // dismissed pair since), then patched with whatever those fetches missed.
  const txnDisplayById = new Map(
    rows.map((r) => [r.id, { date: r.date, payee: r.payee, amountCents: r.amount_cents }]),
  )
  const invoiceDisplayById = new Map(
    invoices.map((i) => [i.id, { number: i.number, clientName: i.client_name, totalCents: i.total_cents }]),
  )
  const expenseDisplayById = new Map(
    expenses.map((e) => [e.id, {
      whereSpent: e.where_spent, showName: showNameByExpenseId.get(e.id) ?? '',
      amountCents: e.amount_cents, spentOn: e.spent_on,
    }]),
  )

  const missingTxnIds = [...new Set(
    dismissalRows.map((d) => d.transaction_id).filter((id) => !txnDisplayById.has(id)),
  )]
  const missingInvoiceIds = [...new Set(
    dismissalRows.map((d) => d.invoice_id).filter((id): id is string => id !== null && !invoiceDisplayById.has(id)),
  )]
  const missingExpenseIds = [...new Set(
    dismissalRows.map((d) => d.expense_id).filter((id): id is string => id !== null && !expenseDisplayById.has(id)),
  )]

  const { rows: missingTxns, error: missingTxnsError } = await fetchMissingTxns(supabase, missingTxnIds)
  if (missingTxnsError) return <LoadError message={missingTxnsError} />
  const { rows: missingInvoices, error: missingInvoicesError } = await fetchMissingInvoices(supabase, missingInvoiceIds)
  if (missingInvoicesError) return <LoadError message={missingInvoicesError} />
  const { rows: missingExpenses, error: missingExpensesError } = await fetchMissingExpenses(supabase, missingExpenseIds)
  if (missingExpensesError) return <LoadError message={missingExpensesError} />

  for (const t of missingTxns) txnDisplayById.set(t.id, { date: t.date, payee: t.payee, amountCents: t.amount_cents })
  for (const i of missingInvoices) {
    invoiceDisplayById.set(i.id, { number: i.number, clientName: i.clients?.name ?? '', totalCents: i.total_cents })
  }
  for (const e of missingExpenses) {
    expenseDisplayById.set(e.id, {
      whereSpent: e.where_spent, showName: e.shows?.name ?? '', amountCents: e.amount_cents, spentOn: e.spent_on,
    })
  }

  // One dismissal can, in principle, name a transaction/invoice/expense this
  // owner no longer has any record of at all (not just aged out of a
  // candidate fetch, but genuinely gone — a hard-deleted expense, say).
  // Skipped rather than crashed on: a stale dismissal with nothing left to
  // show is not worth blocking the whole page over, and restoreDismissal
  // still works from the raw id even for one that got filtered out here.
  //
  // Reversed here, and only here: fetchAllDismissals pages oldest-first (the
  // (created_at, id) order every paged fetch on this page shares), which is
  // what keeps its own range() calls stable — but the Dismissed section
  // should read newest-first, so the display list is reversed after paging,
  // not the fetch itself.
  const dismissedCards: DismissedCard[] = [...dismissalRows].reverse().flatMap((d) => {
    const txn = txnDisplayById.get(d.transaction_id)
    if (!txn) return []
    let target: string
    if (d.invoice_id !== null) {
      const inv = invoiceDisplayById.get(d.invoice_id)
      if (!inv) return []
      target = `#${inv.number} · ${inv.clientName} · ${formatUSD(inv.totalCents)}`
    } else if (d.expense_id !== null) {
      const exp = expenseDisplayById.get(d.expense_id)
      if (!exp) return []
      target = `${exp.whereSpent} · ${exp.showName} · ${formatUSD(exp.amountCents)}`
    } else {
      // Migration 0032's own check (num_nonnulls(invoice_id, expense_id) = 1)
      // makes this unreachable — belt-and-suspenders, not a real case.
      return []
    }
    return [{ id: d.id, txn: { date: txn.date, payee: txn.payee, amountCents: txn.amountCents }, target }]
  })

  return (
    <AppShell current="money">
      <BackLink />
      <h1 className="display text-3xl font-bold mb-8">Matches</h1>
      <MatchQueue income={income} expense={expense} dismissed={dismissedCards} />
    </AppShell>
  )
}
