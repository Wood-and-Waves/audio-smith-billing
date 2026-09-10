import { createClient } from '@/lib/supabase/server'
import { todayInChicago } from '@/lib/dates'
import { resolveRange } from '@/lib/reportRange'
import { filterRange } from '@/lib/ledgerReports'
import { explodeForReports, type ReportTxnForExplode } from '@/lib/ledgerSplits'
import { transactionsCsv, csvFilename } from '@/lib/reportCsv'

// The transaction export. Same range contract as the Reports page it is
// launched from: from/to in the query string, resolved through resolveRange so
// a malformed URL yields the current year rather than an error.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Mirrors app/money/reports/page.tsx's own LEDGER_TXN_PAGE_SIZE and paged
// helpers, for the same reason spelled out in that file's header comment: a
// plain unranged .select() on ledger_transactions or ledger_transaction_splits
// silently caps at 1000 rows (PostgREST's max_rows) with no error — quietly
// truncating a document handed to a third party instead of failing loudly.
// Duplicated rather than imported: a page file may only export the default
// component (plus other page-lifecycle exports), not arbitrary helpers a
// route module could pull in the usual way.
const LEDGER_TXN_PAGE_SIZE = 1000

type RawReportTxnRow = {
  id: string
  date: string
  amount_cents: number
  kind: string
  category_id: string | null
  payee: string | null
}

async function fetchAllReportTxns(
  supabase: Awaited<ReturnType<typeof createClient>>,
  accountId: string,
  from: string,
  to: string,
): Promise<{ rows: RawReportTxnRow[]; error: string | null }> {
  const rows: RawReportTxnRow[] = []
  let start = 0
  for (;;) {
    const { data, error } = await supabase
      .from('ledger_transactions')
      .select('id, date, amount_cents, kind, category_id, payee')
      .eq('account_id', accountId)
      .gte('date', from).lte('date', to)
      .order('date', { ascending: true })
      .order('id', { ascending: true })
      .range(start, start + LEDGER_TXN_PAGE_SIZE - 1)
    if (error) return { rows: [], error: error.message }
    rows.push(...((data ?? []) as RawReportTxnRow[]))
    if (!data || data.length < LEDGER_TXN_PAGE_SIZE) break
    start += LEDGER_TXN_PAGE_SIZE
  }
  return { rows, error: null }
}

type RawReportSplitLegRow = { transaction_id: string; category_id: string | null; amount_cents: number; kind: string }

async function fetchAllReportSplitLegs(
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<{ rows: RawReportSplitLegRow[]; error: string | null }> {
  const rows: RawReportSplitLegRow[] = []
  let start = 0
  for (;;) {
    const { data, error } = await supabase
      .from('ledger_transaction_splits')
      .select('transaction_id, category_id, amount_cents, kind')
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(start, start + LEDGER_TXN_PAGE_SIZE - 1)
    if (error) return { rows: [], error: error.message }
    rows.push(...((data ?? []) as RawReportSplitLegRow[]))
    if (!data || data.length < LEDGER_TXN_PAGE_SIZE) break
    start += LEDGER_TXN_PAGE_SIZE
  }
  return { rows, error: null }
}

export async function GET(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return new Response('Not signed in.', { status: 401 })

  const params = new URL(request.url).searchParams
  const { from, to } = resolveRange(
    params.get('from') ?? undefined, params.get('to') ?? undefined, todayInChicago(),
  )

  // One wave, not three trips in a line — same fix and reason as
  // app/money/reports/page.tsx. Guards keep their original order below.
  const [accountRes, categoriesRes, splitLegsRes] = await Promise.all([
    // Same single-account model as the Reports page this export is launched
    // from: the one open checking account this ledger runs from, "first" by
    // creation, same tie-break the rest of the app uses. An export scoped
    // differently from the screen it's launched from would be the same class
    // of silent error as a truncated one.
    supabase.from('ledger_accounts')
      .select('id')
      .eq('closed', false)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle(),
    supabase.from('ledger_categories')
      .select('id, name, grp, sort, deductible'),
    fetchAllReportSplitLegs(supabase),
  ])
  const { data: accountRow, error: accountError } = accountRes
  if (accountError) return new Response(accountError.message, { status: 500 })

  const { data: categoryRows, error: categoryError } = categoriesRes
  if (categoryError) return new Response(categoryError.message, { status: 500 })

  // No account yet: the Reports page has its own "no ledger account yet"
  // state, and a download shouldn't be the thing that explains that — hand
  // back an empty file (header row only) rather than erroring.
  if (!accountRow) {
    return new Response(transactionsCsv([], categoryRows ?? []), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${csvFilename(from, to)}"`,
      },
    })
  }

  const { rows: legRows, error: legError } = splitLegsRes
  if (legError) return new Response(legError, { status: 500 })

  const { rows: txnRows, error: txnError } = await fetchAllReportTxns(supabase, accountRow.id, from, to)
  if (txnError) return new Response(txnError, { status: 500 })

  const legsByTxnId = new Map<string, { categoryId: string | null; amountCents: number; kind: string }[]>()
  for (const l of legRows) {
    const list = legsByTxnId.get(l.transaction_id) ?? []
    list.push({ categoryId: l.category_id, amountCents: l.amount_cents, kind: l.kind })
    legsByTxnId.set(l.transaction_id, list)
  }

  const explodableTxns: ReportTxnForExplode[] = txnRows.map((t) => ({
    date: t.date, amountCents: t.amount_cents, kind: t.kind,
    categoryId: t.category_id, payee: t.payee ?? '', legs: legsByTxnId.get(t.id),
  }))
  const lines = explodeForReports(explodableTxns)

  // filterRange is belt-and-braces over the query's own date bounds: the
  // explosion above cannot move a line's date, but the range contract lives in
  // one place and this keeps the file honest if the query ever changes.
  const csv = transactionsCsv(filterRange(lines, from, to), categoryRows ?? [])

  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${csvFilename(from, to)}"`,
    },
  })
}
