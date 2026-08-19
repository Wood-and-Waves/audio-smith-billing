import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { workingBalance, type BalanceLike } from '@/lib/ledgerBalance'
import { envelopeBalances, availableToAllocate, type EnvelopeMoveLike } from '@/lib/envelopes'
import AppShell from '@/components/AppShell'
import BudgetPanel, { type EnvelopeRow, type EnvelopeMoveRow } from '@/components/BudgetPanel'
import { ensureDefaultEnvelopes } from '@/app/money/actions'

export const dynamic = 'force-dynamic'

// Mirrors app/money/page.tsx's own fetchAllTransactions / fetchAllLedgerTransactions
// (app/money/actions.ts) exactly — Supabase selects silently cap at 1000 rows
// (PostgREST's max_rows), so a plain unranged .select() would truncate an
// account past 1000 transactions with no error, understating the working
// balance this page's "Available to allocate" is built on. Duplicated rather
// than imported for the same reason those two copies are: a 'use server' file
// may only export actions, and this page needs neither's exact column set.
const PAGE_SIZE = 1000

// The latest N moves shown under "Recent moves" — every move is still read to
// compute balances (see fetchAllEnvelopeMoves below); this only caps the
// audit-trail list actually rendered.
const RECENT_MOVES_CAP = 20

async function fetchAllTransactionsForBalance(
  supabase: Awaited<ReturnType<typeof createClient>>,
  accountId: string,
): Promise<{ rows: BalanceLike[]; error: string | null }> {
  const rows: BalanceLike[] = []
  let from = 0
  for (;;) {
    const { data, error } = await supabase
      .from('ledger_transactions')
      .select('amount_cents, cleared')
      .eq('account_id', accountId)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1)
    if (error) return { rows: [], error: error.message }
    rows.push(...((data ?? []) as BalanceLike[]))
    if (!data || data.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }
  return { rows, error: null }
}

type RawMoveRow = {
  id: string
  from_envelope_id: string | null
  to_envelope_id: string | null
  amount_cents: number
  moved_on: string
  note: string | null
}

// Every move this owner has ever made, not account-scoped (ledger_envelope_moves
// carries owner_id, not account_id — RLS alone is the filter here). Paged for
// the same reason fetchAllTransactionsForBalance above is: Available to
// allocate and every envelope balance are sums over ALL of history, and a
// truncated page would understate both silently. Ordered (created_at, id)
// ascending — a stable tiebreak so a page boundary can't skip or duplicate a
// row — the newest-first order the "Recent moves" list wants is applied by
// the caller, once the full set is in hand.
async function fetchAllEnvelopeMoves(
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<{ rows: RawMoveRow[]; error: string | null }> {
  const rows: RawMoveRow[] = []
  let from = 0
  for (;;) {
    const { data, error } = await supabase
      .from('ledger_envelope_moves')
      .select('id, from_envelope_id, to_envelope_id, amount_cents, moved_on, note')
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

export default async function MoneyBudgetPage() {
  const supabase = await createClient()

  // Same single-account model as the register: the one open checking account
  // this ledger runs from, "first" by creation, same tie-break the rest of
  // the app uses. Envelopes divide THIS account's working balance, so with no
  // account there is nothing to divide — sent to /money to create one instead
  // of standing up an empty envelope screen.
  const { data: accountRow, error: accountError } = await supabase
    .from('ledger_accounts')
    .select('id, opening_balance_cents')
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
          first, then come back to divide it into envelopes.
        </p>
      </AppShell>
    )
  }

  const { rows: balanceRows, error: txnError } = await fetchAllTransactionsForBalance(supabase, accountRow.id)
  if (txnError) return <LoadError message={txnError} />
  const workingBalanceCents = workingBalance(accountRow.opening_balance_cents, balanceRows)

  // Seeds Dan's three YNAB Savings funds the first time this owner opens the
  // budget — a no-op every load after that (see the action's own doc
  // comment). No revalidatePath in that action: this runs during THIS page's
  // own render, and the envelope query right below already reads whatever it
  // just seeded fresh, so there is nothing stale to fix.
  const seedResult = await ensureDefaultEnvelopes()
  if ('error' in seedResult) return <LoadError message={seedResult.error} />

  // Every envelope, hidden ones included — unlike the register's own category
  // query (app/money/page.tsx, `.eq('hidden', false)`), this can't filter at
  // the database level: whether a hidden envelope still belongs on screen
  // depends on its BALANCE, which isn't known until the moves below are read.
  // Also doubles as the name lookup for "Recent moves" (a move can reference
  // an envelope that's since been hidden), which is why nothing here is
  // dropped before that map is built.
  const { data: envelopeRows, error: envelopeError } = await supabase
    .from('ledger_envelopes')
    .select('id, name, sort, hidden')
    .order('sort', { ascending: true })
  if (envelopeError) return <LoadError message={envelopeError.message} />

  const { rows: moveRows, error: moveError } = await fetchAllEnvelopeMoves(supabase)
  if (moveError) return <LoadError message={moveError} />

  const balances = envelopeBalances(moveRows as EnvelopeMoveLike[])
  const availableCents = availableToAllocate(workingBalanceCents, moveRows as EnvelopeMoveLike[])

  // Unhidden envelopes in their own sort order, PLUS hidden ones that still
  // carry a nonzero balance — an emptied hidden envelope drops off the list
  // entirely (nothing left to track), but a funded one has to stay visible or
  // its balance would be stranded with no row anywhere to move it back out
  // from. Computed AFTER balances, never before, for exactly that reason.
  const envelopes: EnvelopeRow[] = (envelopeRows ?? [])
    .filter((e) => !e.hidden || (balances.get(e.id) ?? 0) !== 0)
    .map((e) => ({ id: e.id, name: e.name, hidden: e.hidden, balanceCents: balances.get(e.id) ?? 0 }))

  // Every envelope name, not just the visible list above — a move made years
  // ago can point at an envelope that's since been hidden AND drained to
  // zero (so it no longer appears in `envelopes`), but the move itself is
  // still real history and still needs a real name to show, not "Unknown".
  // Envelopes can never be deleted (FK restrict on ledger_envelope_moves —
  // migration 0030), so every id a move carries is guaranteed to resolve here.
  const nameById = new Map((envelopeRows ?? []).map((e) => [e.id, e.name]))

  // Newest first, capped to the latest N (RECENT_MOVES_CAP) — the fetch above
  // is ascending for safe paging, so this is a plain reverse rather than a
  // second sort. `balances`/`availableCents` above were already computed from
  // the FULL, uncapped `moveRows`, so capping here only affects what's shown,
  // never what's added up.
  const moves: EnvelopeMoveRow[] = [...moveRows]
    .reverse()
    .slice(0, RECENT_MOVES_CAP)
    .map((m) => ({
      id: m.id,
      amountCents: m.amount_cents,
      fromName: m.from_envelope_id === null ? 'Available' : (nameById.get(m.from_envelope_id) ?? 'Unknown'),
      toName: m.to_envelope_id === null ? 'Available' : (nameById.get(m.to_envelope_id) ?? 'Unknown'),
      movedOn: m.moved_on,
      note: m.note,
    }))

  return (
    <AppShell current="money">
      <BackLink />
      <h1 className="display text-3xl font-bold mb-8">Budget</h1>
      <BudgetPanel
        availableCents={availableCents}
        envelopes={envelopes}
        moves={moves}
      />
    </AppShell>
  )
}
