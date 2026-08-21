import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { proposeMatches, type BankRow, type CandidateInvoice, type CandidateExpense, type Dismissal } from '@/lib/ledgerMatch'
import AppShell from '@/components/AppShell'
import MatchQueue, { type IncomeCard, type ExpenseCard } from '@/components/MatchQueue'

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

type RawDismissalRow = { transaction_id: string; invoice_id: string | null; expense_id: string | null }

/** Every ledger_match_dismissals row, owner-wide — proposeMatches is pure and
 *  stateless (see lib/ledgerMatch.ts's own doc comment), so a truncated read
 *  here would let a rejected guess Dan already dismissed reappear once the
 *  dismissal list grew past 1000 rows. */
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
 *  a candidate on purpose (a deposit matched by hand, or an invoice marked
 *  paid before this bridge existed, should still get its own bank row linked
 *  up), so the filter is `.in('status', ['sent','paid'])`, not just 'sent'. */
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
      })),
      confidence: p.confidence,
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
    }
  })

  return (
    <AppShell current="money">
      <BackLink />
      <h1 className="display text-3xl font-bold mb-8">Matches</h1>
      <MatchQueue income={income} expense={expense} />
    </AppShell>
  )
}
