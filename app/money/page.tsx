import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { formatDateShort } from '@/lib/dates'
import { workingBalance, clearedBalance, type BalanceLike } from '@/lib/ledgerBalance'
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

function LoadError({ message }: { message: string }) {
  return (
    <AppShell current="money">
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

  const categories: CategoryOption[] = (categoryRows ?? []).map((c) => ({ id: c.id, name: c.name }))

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
      <AppShell current="money">
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

  const balanceInputs: BalanceLike[] = allTxns.map((t) => ({ amount_cents: t.amount_cents, cleared: t.cleared }))
  const workingBalanceCents = workingBalance(accountRow.opening_balance_cents, balanceInputs)
  const clearedBalanceCents = clearedBalance(accountRow.opening_balance_cents, balanceInputs)
  // Owner pay and transfers never carry a category (lt_nocat_for_owner_or_transfer,
  // migration 0027) — counting them here would inflate the queue with rows
  // that can never be categorized in the first place.
  const uncategorizedCount = allTxns.filter(
    (t) => t.category_id === null && (t.kind === 'income' || t.kind === 'expense'),
  ).length

  // Newest first for the register, same as every other list in this app
  // (ExpenseLog, ShowsPage). created_at is the tiebreak for two rows entered
  // on the same date, matching the pagination order above.
  const sorted = [...allTxns].sort((a, b) => (
    a.date === b.date ? b.created_at.localeCompare(a.created_at) : b.date.localeCompare(a.date)
  ))
  // The RENDERED list only — filtered before the 200-cap below (not after),
  // so ?filter=uncategorized shows the actual next 200 uncategorized rows
  // rather than whatever uncategorized rows happened to survive an unrelated
  // most-recent-200 cut. Same kind filter as uncategorizedCount above, so
  // this list's length always agrees with that badge.
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
  }))

  const account: LedgerAccountSummary = {
    id: accountRow.id,
    name: accountRow.name,
    lastReconciledAt: accountRow.last_reconciled_at,
  }

  return (
    <AppShell current="money">
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
