import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { todayInChicago } from '@/lib/dates'
import { formatUSD } from '@/lib/money'
import {
  filterYear, plSummary, spendByCategory, monthlyTotals,
  type ReportTxn, type ReportCategory, type CategorySpend,
} from '@/lib/ledgerReports'
import AppShell from '@/components/AppShell'

export const dynamic = 'force-dynamic'

// Mirrors app/money/page.tsx's own fetchAllTransactions: Supabase selects
// silently cap at 1000 rows (PostgREST's max_rows), so a plain unranged
// .select() would truncate an account past 1000 transactions with no error —
// quietly understating a year's income/expenses instead of failing loudly.
// Duplicated (not imported) for the same reason app/money/page.tsx's own copy
// is duplicated rather than pulled from app/money/actions.ts: a 'use server'
// file may only export actions, and this page needs different columns than
// either existing copy (no category/show names — reports never renders one).
const LEDGER_TXN_PAGE_SIZE = 1000

async function fetchAllReportTxns(
  supabase: Awaited<ReturnType<typeof createClient>>,
  accountId: string,
): Promise<{ rows: ReportTxn[]; error: string | null }> {
  const rows: ReportTxn[] = []
  let from = 0
  for (;;) {
    const { data, error } = await supabase
      .from('ledger_transactions')
      .select('date, amount_cents, kind, category_id')
      .eq('account_id', accountId)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + LEDGER_TXN_PAGE_SIZE - 1)
    if (error) return { rows: [], error: error.message }
    rows.push(...((data ?? []) as ReportTxn[]))
    if (!data || data.length < LEDGER_TXN_PAGE_SIZE) break
    from += LEDGER_TXN_PAGE_SIZE
  }
  return { rows, error: null }
}

function LoadError({ message }: { message: string }) {
  return (
    <AppShell current="money">
      <p role="alert" className="text-danger border-l-2 border-danger pl-4 py-2">
        Couldn&rsquo;t load the reports: {message}
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

const MONTH_LABELS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]

/** A row of consecutive spendByCategory results sharing one `grp` — the rows
 *  arrive already sorted by (grp, sort), so grouping is just a linear walk
 *  rather than a second sort or a Map keyed on group name. */
type CategoryGroup = { grp: string; rows: CategorySpend[] }

function groupByGrp(rows: CategorySpend[]): CategoryGroup[] {
  const groups: CategoryGroup[] = []
  for (const row of rows) {
    const last = groups[groups.length - 1]
    if (last && last.grp === row.category.grp) last.rows.push(row)
    else groups.push({ grp: row.category.grp, rows: [row] })
  }
  return groups
}

/** Plain proportional bar — a colored div inside a track div, both width via
 *  inline style since the percentage is data, not a Tailwind class Tailwind
 *  could ever see ahead of time. No chart library, per the brief. */
function Bar({ pct, className }: { pct: number; className: string }) {
  return (
    <div className="h-2 rounded-pill bg-accent-wash overflow-hidden">
      <div
        className={`h-full rounded-pill ${className}`}
        style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
      />
    </div>
  )
}

export default async function MoneyReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ year?: string }>
}) {
  const params = await searchParams
  const currentYear = Number(todayInChicago().slice(0, 4))
  const parsedYear = Number(params.year)
  const year = Number.isInteger(parsedYear) && params.year ? parsedYear : currentYear

  const supabase = await createClient()

  // Same single-account model as the register: the one open checking account
  // this ledger runs from, "first" by creation, same tie-break the rest of
  // the app uses.
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
        <h1 className="display text-3xl font-bold mb-4">Reports</h1>
        <p className="text-muted border-l-2 border-line pl-4 py-2 max-w-md">
          There&rsquo;s no ledger account yet, so there&rsquo;s nothing to report on. Set one up
          from{' '}
          <Link href="/money" className="text-accent font-semibold hover:opacity-80">
            the ledger
          </Link>{' '}
          first.
        </p>
      </AppShell>
    )
  }

  // Every category, including hidden ones — a hidden category's history
  // still counts toward this year's (or any year's) spend, unlike the
  // register's own category query, which only needs live options to offer
  // in a picker.
  const { data: categoryRows, error: categoryError } = await supabase
    .from('ledger_categories')
    .select('id, name, grp, sort, deductible')
    .order('grp', { ascending: true })
    .order('sort', { ascending: true })
  if (categoryError) return <LoadError message={categoryError.message} />
  const categories: ReportCategory[] = categoryRows ?? []

  const { rows: allTxns, error: txnError } = await fetchAllReportTxns(supabase, accountRow.id)
  if (txnError) return <LoadError message={txnError} />

  // Account-wide, not year-scoped — matches app/money/page.tsx's own
  // uncategorizedCount exactly (same kind filter), so this banner's number
  // and the register's badge never disagree. Owner pay and transfers never
  // carry a category (lt_nocat_for_owner_or_transfer, migration 0027) and are
  // excluded here for the same reason the register excludes them.
  const uncategorizedCount = allTxns.filter(
    (t) => t.category_id === null && (t.kind === 'income' || t.kind === 'expense'),
  ).length

  const yearTxns = filterYear(allTxns, year)
  const pl = plSummary(yearTxns, categories)
  const spend = spendByCategory(yearTxns, categories)
  const months = monthlyTotals(allTxns, year)

  const groups = groupByGrp(spend.rows)
  const maxSpend = Math.max(1, ...spend.rows.map((r) => r.spentCents), spend.uncategorizedCents)
  const maxMonth = Math.max(1, ...months.flatMap((m) => [m.incomeCents, m.expenseCents]))

  return (
    <AppShell current="money">
      <BackLink />

      <header className="flex flex-wrap items-baseline justify-between gap-4 mb-10">
        <h1 className="display text-3xl font-bold">Reports</h1>
        <div className="flex items-center gap-4">
          <Link
            href={`/money/reports?year=${year - 1}`}
            aria-label="Previous year"
            className="text-muted hover:text-ink transition-colors text-lg leading-none"
          >
            ‹
          </Link>
          <span className="tabular text-xl font-bold">{year}</span>
          <Link
            href={`/money/reports?year=${year + 1}`}
            aria-label="Next year"
            className="text-muted hover:text-ink transition-colors text-lg leading-none"
          >
            ›
          </Link>
        </div>
      </header>

      {uncategorizedCount > 0 && (
        <Link
          href="/money?filter=uncategorized"
          className="block mb-10 rounded-field border border-accent bg-accent-wash px-4 py-3
                     text-sm font-semibold text-accent hover:opacity-80 transition-opacity"
        >
          {uncategorizedCount} transaction{uncategorizedCount === 1 ? '' : 's'} need a category
          before these numbers are trustworthy.
        </Link>
      )}

      <section className="mb-10">
        {/* Honest label: paging back to 2025 must not read "This year". */}
        <h2 className="eyebrow mb-4">{year === currentYear ? 'This year' : `${year} totals`}</h2>
        <div className="border-t border-line">
          <div className="flex items-center justify-between py-3 border-b border-line">
            <span className="text-muted">Income</span>
            <span className="tabular font-semibold">{formatUSD(pl.incomeCents)}</span>
          </div>
          <div className="flex items-center justify-between py-3 border-b border-line">
            <span className="text-muted">Expenses</span>
            <span className="tabular font-semibold">{formatUSD(pl.expenseCents)}</span>
          </div>
          <div className="flex items-center justify-between py-3 border-b border-line">
            <span className="font-semibold">Net</span>
            <span className={`tabular font-semibold ${pl.netCents >= 0 ? 'text-good' : 'text-danger'}`}>
              {formatUSD(pl.netCents)}
            </span>
          </div>
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 py-3 border-b border-line text-muted">
            <span className="text-sm">Owner pay <span className="text-xs">(excluded from expenses)</span></span>
            <span className="tabular text-sm">{formatUSD(pl.ownerPayCents)}</span>
          </div>
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 py-3 text-muted">
            <span className="text-sm">
              Deductible expenses <span className="text-xs">(so far — categories drive this)</span>
            </span>
            <span className="tabular text-sm">{formatUSD(pl.deductibleCents)}</span>
          </div>
        </div>
      </section>

      <section className="mb-10">
        <h2 className="eyebrow mb-4">Spend by category</h2>
        {groups.length === 0 && spend.uncategorizedCents === 0 ? (
          <p className="text-muted border-l-2 border-line pl-4 py-1">No categorized spend in {year}.</p>
        ) : (
          <div className="space-y-6">
            {groups.map((group) => (
              <div key={group.grp}>
                <p className="eyebrow mb-3">{group.grp}</p>
                <div className="space-y-3">
                  {group.rows.map((row) => (
                    <div key={row.category.id}>
                      <div className="flex items-baseline justify-between gap-3 mb-1">
                        <span className="text-sm truncate">{row.category.name}</span>
                        <span className="tabular text-sm font-semibold shrink-0">
                          {formatUSD(row.spentCents)}
                        </span>
                      </div>
                      <Bar pct={(row.spentCents / maxSpend) * 100} className="bg-accent" />
                    </div>
                  ))}
                </div>
              </div>
            ))}

            {spend.uncategorizedCents > 0 && (
              <div>
                <p className="eyebrow mb-3 text-danger">Uncategorized</p>
                <div>
                  <div className="flex items-baseline justify-between gap-3 mb-1">
                    <span className="text-sm text-danger truncate">Uncategorized</span>
                    <span className="tabular text-sm font-semibold text-danger shrink-0">
                      {formatUSD(spend.uncategorizedCents)}
                    </span>
                  </div>
                  <Bar pct={(spend.uncategorizedCents / maxSpend) * 100} className="bg-danger" />
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      <section>
        <h2 className="eyebrow mb-4">By month</h2>
        <div className="border-t border-line">
          {months.map((m, idx) => {
            const empty = m.incomeCents === 0 && m.expenseCents === 0
            return (
              <div
                key={m.month}
                className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2.5 border-b border-line"
              >
                <span className="w-9 text-xs text-muted shrink-0">{MONTH_LABELS[idx]}</span>
                {empty ? (
                  <span className="flex-1 min-w-[6rem] text-xs text-muted">—</span>
                ) : (
                  <div className="flex-1 min-w-[6rem] space-y-1">
                    <Bar pct={(m.incomeCents / maxMonth) * 100} className="bg-good" />
                    <Bar pct={(m.expenseCents / maxMonth) * 100} className="bg-accent" />
                  </div>
                )}
                <div className="text-right tabular text-xs shrink-0 ml-auto">
                  <p className={empty ? 'text-muted' : ''}>{empty ? '—' : formatUSD(m.incomeCents)}</p>
                  <p className="text-muted">{empty ? '—' : formatUSD(m.expenseCents)}</p>
                </div>
              </div>
            )
          })}
        </div>
      </section>
    </AppShell>
  )
}
