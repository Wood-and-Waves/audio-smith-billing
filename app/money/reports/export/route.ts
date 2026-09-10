import { createClient } from '@/lib/supabase/server'
import { todayInChicago } from '@/lib/dates'
import { resolveRange } from '@/lib/reportRange'
import { filterRange } from '@/lib/ledgerReports'
import { explodeForReports } from '@/lib/ledgerSplits'
import { transactionsCsv, csvFilename } from '@/lib/reportCsv'

// The transaction export. Same range contract as the Reports page it is
// launched from: from/to in the query string, resolved through resolveRange so
// a malformed URL yields the current year rather than an error.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return new Response('Not signed in.', { status: 401 })

  const params = new URL(request.url).searchParams
  const { from, to } = resolveRange(
    params.get('from') ?? undefined, params.get('to') ?? undefined, todayInChicago(),
  )

  const { data: txnRows, error: txnError } = await supabase
    .from('ledger_transactions')
    .select('id, date, amount_cents, kind, category_id, payee')
    .gte('date', from).lte('date', to)
    .order('date', { ascending: true })
    .order('id', { ascending: true })
  if (txnError) return new Response(txnError.message, { status: 500 })

  const { data: legRows, error: legError } = await supabase
    .from('ledger_transaction_splits')
    .select('transaction_id, category_id, amount_cents, kind')
  if (legError) return new Response(legError.message, { status: 500 })

  const { data: categoryRows, error: categoryError } = await supabase
    .from('ledger_categories')
    .select('id, name, grp, sort, deductible')
  if (categoryError) return new Response(categoryError.message, { status: 500 })

  const legsByTxnId = new Map<string, { categoryId: string | null; amountCents: number; kind: string }[]>()
  for (const l of legRows ?? []) {
    const list = legsByTxnId.get(l.transaction_id) ?? []
    list.push({ categoryId: l.category_id, amountCents: l.amount_cents, kind: l.kind })
    legsByTxnId.set(l.transaction_id, list)
  }

  const lines = explodeForReports((txnRows ?? []).map((t) => ({
    date: t.date, amountCents: t.amount_cents, kind: t.kind,
    categoryId: t.category_id, payee: t.payee ?? '', legs: legsByTxnId.get(t.id),
  })))

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
