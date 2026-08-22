import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { todayInChicago, monthLabel } from '@/lib/dates'
import { formatUSD } from '@/lib/money'
import { workingBalance } from '@/lib/ledgerBalance'
import { availableToAllocate, type EnvelopeMoveLike } from '@/lib/envelopes'
import {
  buildForecast, computeOverheadCents,
  type ForecastShow, type ForecastInvoice, type ForecastClient,
} from '@/lib/forecast'
import AppShell from '@/components/AppShell'
import ForecastTable from '@/components/ForecastTable'

export const dynamic = 'force-dynamic'

// Same reasoning as every other paged fetch under app/money/ (see
// app/money/page.tsx, app/money/budget/page.tsx, app/money/reports/page.tsx):
// Supabase selects silently cap at 1000 rows (PostgREST's max_rows), and a
// forecast built on a truncated read would understate the working balance,
// the overhead average, or the booked-work total with no error to show for
// it. Duplicated per page rather than shared for the same reason those three
// already are: each page needs its own column set, and a 'use server' file
// (app/money/actions.ts) may only export actions.
const PAGE_SIZE = 1000

type RawTxnRow = { id: string; date: string; amount_cents: number; kind: string }

async function fetchAllForecastTxns(
  supabase: Awaited<ReturnType<typeof createClient>>,
  accountId: string,
): Promise<{ rows: RawTxnRow[]; error: string | null }> {
  const rows: RawTxnRow[] = []
  let from = 0
  for (;;) {
    const { data, error } = await supabase
      .from('ledger_transactions')
      .select('id, date, amount_cents, kind')
      .eq('account_id', accountId)
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

type RawMoveRow = { from_envelope_id: string | null; to_envelope_id: string | null; amount_cents: number }

// Every move this owner has ever made, not account-scoped (ledger_envelope_moves
// carries owner_id, not account_id — RLS alone is the filter here). Same
// paging rationale as app/money/budget/page.tsx's own copy: starting balance
// below is a sum over ALL of history, so a truncated page would understate it.
async function fetchAllForecastMoves(
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<{ rows: RawMoveRow[]; error: string | null }> {
  const rows: RawMoveRow[] = []
  let from = 0
  for (;;) {
    const { data, error } = await supabase
      .from('ledger_envelope_moves')
      .select('from_envelope_id, to_envelope_id, amount_cents')
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

type RawShowRow = {
  id: string
  name: string
  client_id: string
  status: string
  day_rate_cents: number
  travel_rate_cents: number
  invoice_id: string | null
  show_days: { date: string; travel_in: boolean; travel_out: boolean; pay_as_half_day: boolean }[]
}

// Both 'open' and 'billed' shows, unfiltered — a billed show still needs to
// be read here so the void defense below (voidInvoiceIds) can inspect its
// invoice_id. Filtering to status='open' at the query would silently hide
// exactly the rows that defense exists to catch.
async function fetchAllForecastShows(
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<{ rows: RawShowRow[]; error: string | null }> {
  const rows: RawShowRow[] = []
  let from = 0
  for (;;) {
    const { data, error } = await supabase
      .from('shows')
      .select(`id, name, client_id, status, day_rate_cents, travel_rate_cents, invoice_id,
                show_days(date, travel_in, travel_out, pay_as_half_day)`)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1)
    if (error) return { rows: [], error: error.message }
    rows.push(...((data ?? []) as unknown as RawShowRow[]))
    if (!data || data.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }
  return { rows, error: null }
}

type RawInvoiceRow = {
  id: string
  number: number
  client_id: string
  status: string
  total_cents: number
  sent_at: string | null
  paid_at: string | null
  ledger_transaction_invoices: { transaction_id: string }[]
}

async function fetchAllForecastInvoices(
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<{ rows: RawInvoiceRow[]; error: string | null }> {
  const rows: RawInvoiceRow[] = []
  let from = 0
  for (;;) {
    // Includes 'paid' alongside 'draft'/'sent' — NOT just the unpaid ones.
    // payLagFor (lib/forecast.ts) can only learn a client's pay lag from a
    // linked invoice that has both sent_at AND paid_at, and paid_at is only
    // ever written alongside status='paid' (markInvoicePaid). Fetching only
    // draft/sent, as this used to, meant no invoice this page supplied could
    // ever have a paid_at — every client silently fell back to terms_days,
    // and "learned" pay lags were unreachable. buildForecast still excludes
    // 'paid' invoices from inflows (see its own status check), so this adds
    // nothing to projected income — it only makes the learning data reachable.
    const { data, error } = await supabase
      .from('invoices')
      .select(`id, number, client_id, status, total_cents, sent_at, paid_at,
                ledger_transaction_invoices(transaction_id)`)
      .in('status', ['draft', 'sent', 'paid'])
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1)
    if (error) return { rows: [], error: error.message }
    rows.push(...((data ?? []) as unknown as RawInvoiceRow[]))
    if (!data || data.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }
  return { rows, error: null }
}

// The void defense: upstream (app/shows/actions.ts, billShows) billing a
// show flips it to status 'billed' and stores the invoice's id. If that
// invoice is later voided, nothing walks back and reopens the show — only
// the manual unlinkShow action does (app/shows/actions.ts) — so a show can
// sit at 'billed' forever pointing at an invoice that no longer represents
// money owed. buildForecast (lib/forecast.ts) correctly skips both 'billed'
// shows (their revenue is normally counted through the invoice instead) and
// 'void' invoices (no money is coming), so without this set, such a show's
// money would silently vanish from the forecast rather than reappearing as
// booked-but-unbilled work. Just the ids — see the shows mapping below for
// where this actually reopens one.
async function fetchAllVoidInvoiceIds(
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<{ ids: Set<string>; error: string | null }> {
  const ids = new Set<string>()
  let from = 0
  for (;;) {
    const { data, error } = await supabase
      .from('invoices')
      .select('id')
      .eq('status', 'void')
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1)
    if (error) return { ids: new Set(), error: error.message }
    for (const row of (data ?? []) as { id: string }[]) ids.add(row.id)
    if (!data || data.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }
  return { ids, error: null }
}

type RawClientRow = { id: string; name: string; terms_days: number }

async function fetchAllForecastClients(
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<{ rows: RawClientRow[]; error: string | null }> {
  const rows: RawClientRow[] = []
  let from = 0
  for (;;) {
    const { data, error } = await supabase
      .from('clients')
      .select('id, name, terms_days')
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1)
    if (error) return { rows: [], error: error.message }
    rows.push(...((data ?? []) as RawClientRow[]))
    if (!data || data.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }
  return { rows, error: null }
}

function LoadError({ message }: { message: string }) {
  return (
    <AppShell current="money">
      <p role="alert" className="text-danger border-l-2 border-danger pl-4 py-2">
        Couldn&rsquo;t load the forecast: {message}
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

/** One assumptions row — by default the whole row links to Settings, where
 *  every figure here (take-home, overhead override, tax rate, billing lag)
 *  actually lives and is edited. Per-client pay-lag rows pass their own
 *  `href` instead: `terms_days` lives on the CLIENT record, not Settings, so
 *  linking those to Settings would send Dan somewhere he can't change the
 *  number that's actually driving the row. */
function AssumptionRow({
  label, value, href = '/settings',
}: { label: string; value: React.ReactNode; href?: string }) {
  return (
    <Link
      href={href}
      className="flex items-center justify-between gap-3 py-2.5 border-b border-line text-sm
                 text-ink hover:text-accent transition-colors"
    >
      <span className="text-muted">{label}</span>
      <span className="text-right">{value}</span>
    </Link>
  )
}

export default async function MoneyForecastPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  // proxy.ts redirects an unauthenticated request before it reaches here —
  // belt and braces, same guard app/settings/page.tsx uses before its own
  // owner_id-filtered read.
  if (!user) {
    return (
      <AppShell current="money">
        <p role="alert" className="text-danger border-l-2 border-danger pl-4 py-2">
          You&rsquo;re not signed in.
        </p>
      </AppShell>
    )
  }

  // Same single-account model as the rest of /money: the one open checking
  // account this ledger runs from, "first" by creation.
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
        <h1 className="display text-3xl font-bold mb-4">Forecast</h1>
        <p className="text-muted border-l-2 border-line pl-4 py-2">
          There&rsquo;s no checking account yet.{' '}
          <Link href="/money" className="font-semibold text-accent hover:opacity-80">
            Set one up on the ledger
          </Link>{' '}
          first — the forecast starts from its working balance.
        </p>
      </AppShell>
    )
  }

  const { rows: txnRows, error: txnError } = await fetchAllForecastTxns(supabase, accountRow.id)
  if (txnError) return <LoadError message={txnError} />

  const { rows: moveRows, error: moveError } = await fetchAllForecastMoves(supabase)
  if (moveError) return <LoadError message={moveError} />

  const { rows: showRows, error: showError } = await fetchAllForecastShows(supabase)
  if (showError) return <LoadError message={showError} />

  const { rows: invoiceRows, error: invoiceError } = await fetchAllForecastInvoices(supabase)
  if (invoiceError) return <LoadError message={invoiceError} />

  const { ids: voidInvoiceIds, error: voidError } = await fetchAllVoidInvoiceIds(supabase)
  if (voidError) return <LoadError message={voidError} />

  const { rows: clientRows, error: clientError } = await fetchAllForecastClients(supabase)
  if (clientError) return <LoadError message={clientError} />

  const { data: settingsRow, error: settingsError } = await supabase
    .from('settings')
    // Explicit columns, never '*' — this screen has no business reading
    // remit_to/ach_details/etc, and a widened select would hand more of the
    // settings row to this page than the forecast has any use for.
    .select('monthly_take_home_cents, monthly_overhead_cents, billing_lag_days, tax_setaside_bp')
    .eq('owner_id', user.id)
    .maybeSingle()
  if (settingsError) return <LoadError message={settingsError.message} />

  const today = todayInChicago()

  const workingBalanceCents = workingBalance(accountRow.opening_balance_cents, txnRows)
  // Same "available to allocate" figure /money/budget computes — see that
  // page's own call to this helper. Sharing it (rather than reimplementing
  // workingBalance - netAllocated inline, as this page used to) is what
  // keeps the two screens' starting-balance math structurally identical
  // instead of coincidentally identical.
  const availableCents = availableToAllocate(workingBalanceCents, moveRows as EnvelopeMoveLike[])

  const clients: ForecastClient[] = (clientRows ?? []).map((c) => ({
    id: c.id, name: c.name, terms_days: c.terms_days,
  }))
  const clientNames = new Map(clients.map((c) => [c.id, c.name]))

  const shows: ForecastShow[] = (showRows ?? []).map((s) => {
    // The void defense (see fetchAllVoidInvoiceIds above): a 'billed' show
    // whose invoice was voided is treated as still 'open' for this
    // forecast only — nothing is written back to the shows row.
    const status: 'open' | 'billed' =
      s.status === 'billed' && s.invoice_id !== null && voidInvoiceIds.has(s.invoice_id)
        ? 'open'
        : (s.status as 'open' | 'billed')
    return {
      id: s.id,
      name: s.name,
      client_id: s.client_id,
      status,
      day_rate_cents: s.day_rate_cents,
      travel_rate_cents: s.travel_rate_cents,
      days: (s.show_days ?? []).map((d) => ({
        date: d.date, travel_in: d.travel_in, travel_out: d.travel_out, pay_as_half_day: d.pay_as_half_day,
      })),
    }
  })

  const invoices: ForecastInvoice[] = (invoiceRows ?? []).map((i) => ({
    id: i.id,
    number: i.number,
    client_id: i.client_id,
    status: i.status as 'draft' | 'sent' | 'paid',
    total_cents: i.total_cents,
    sent_at: i.sent_at,
    paid_at: i.paid_at,
    linked: (i.ledger_transaction_invoices ?? []).length > 0,
  }))

  const hasOpenShows = shows.some((s) => s.status === 'open')
  // 'paid' rows are fetched too now (so payLagFor can learn from them — see
  // fetchAllForecastInvoices above), so this can no longer just be
  // invoices.length > 0 — that would count a client with only settled
  // history as having current booked work.
  const hasUnpaidInvoices = invoices.some((i) => i.status !== 'paid')

  const takeHomeCents = settingsRow?.monthly_take_home_cents ?? 0
  const overheadOverrideCents = settingsRow?.monthly_overhead_cents ?? null
  const computedOverheadCents = computeOverheadCents(txnRows, today)
  const overheadCents = overheadOverrideCents ?? computedOverheadCents
  const taxRateBp = settingsRow?.tax_setaside_bp ?? 0
  const billingLagDays = settingsRow?.billing_lag_days ?? 7

  const forecast = hasOpenShows || hasUnpaidInvoices
    ? buildForecast({
        today,
        startingBalanceCents: availableCents,
        shows,
        invoices,
        clients,
        assumptions: { takeHomeCents, overheadCents, taxRateBp, billingLagDays },
      })
    : null

  const overdueInflows = forecast?.inflows.filter((f) => f.overdue) ?? []

  // With no take-home set, the walk still runs (draw = $0), so
  // coveredThrough/beyondHorizon would name a runway Dan hasn't actually
  // earned — the month table below still reflects the true, honest $0-draw
  // arithmetic, but the headline itself should prompt him to set the number
  // rather than assert a month it can't back up.
  const headline = forecast === null || takeHomeCents === 0
    ? null
    : forecast.beyondHorizon
      ? 'Covered beyond the next two years'
      : forecast.coveredThrough === null
        ? 'This month is short'
        : `Covered through ${monthLabel(forecast.coveredThrough)}`

  return (
    <AppShell current="money">
      <BackLink />
      <h1 className="display text-3xl font-bold mb-8">Forecast</h1>

      {forecast === null ? (
        <p className="text-muted border-l-2 border-line pl-4 py-2 max-w-md">
          The forecast needs booked work to project from — an open show or a draft/sent invoice.
          Add one and this page fills in.
        </p>
      ) : (
        <>
          <section className="mb-8">
            {takeHomeCents === 0 ? (
              <Link
                href="/settings"
                className="display text-2xl sm:text-3xl font-bold text-accent hover:opacity-80
                           transition-opacity"
              >
                Set your monthly take-home to see your runway →
              </Link>
            ) : (
              <p className="display text-2xl sm:text-3xl font-bold">{headline}</p>
            )}
            <p className="text-xs text-muted mt-2">
              Estimates from booked work only — not a promise.
            </p>
            {forecast.bookedThrough !== null && (
              <p className="text-muted mt-1">
                Booked work runs out after {monthLabel(forecast.bookedThrough)}.
              </p>
            )}
          </section>

          {forecast.notProjected.length > 0 && (
            <section className="mb-6">
              <p className="text-xs text-muted">
                Not projected —{' '}
                {forecast.notProjected.map((s, idx) => (
                  <span key={s.showId}>
                    {idx > 0 && ', '}
                    {s.name} ({s.reason === 'no days' ? 'no scheduled days' : 'no rate set'})
                  </span>
                ))}
              </p>
            </section>
          )}

          {overdueInflows.length > 0 && (
            <section className="mb-8">
              <h2 className="eyebrow mb-3">Expected now</h2>
              <ul className="space-y-1">
                {overdueInflows.map((f, idx) => (
                  <li key={`${f.label}-${idx}`} className="text-sm">
                    {f.label} · <span className="tabular">{formatUSD(f.amountCents)}</span>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-muted mt-2">
                Past their expected date and not yet received — counted in this month either way.
              </p>
            </section>
          )}

          <section className="mb-10">
            <ForecastTable months={forecast.months} bookedThrough={forecast.bookedThrough} />
          </section>

          <section>
            <h2 className="eyebrow mb-4">Assumptions</h2>
            <div className="border-t border-line">
              <AssumptionRow label="Monthly take-home" value={formatUSD(takeHomeCents)} />
              <AssumptionRow
                label="Monthly overhead"
                value={
                  overheadOverrideCents !== null
                    ? `override ${formatUSD(overheadOverrideCents)} · computed ${formatUSD(computedOverheadCents)}`
                    : formatUSD(computedOverheadCents)
                }
              />
              {/* Estimate, not advice — this is your own configured set-aside
                  rate (settings.tax_setaside_bp), read-only here by design;
                  it's edited in Settings, never on this page. */}
              <AssumptionRow
                label="Tax set-aside — your configured rate, an estimate"
                value={`${(taxRateBp / 100).toFixed(2)}%`}
              />
              <AssumptionRow label="Billing lag" value={`${billingLagDays} day${billingLagDays === 1 ? '' : 's'}`} />
            </div>

            {forecast.payLags.length > 0 && (
              <div className="mt-6">
                <h3 className="eyebrow mb-3">Pay lag by client</h3>
                <div className="border-t border-line">
                  {forecast.payLags.map((lag) => {
                    const name = clientNames.get(lag.clientId) ?? lag.clientId
                    const detail = lag.source === 'learned'
                      ? `learned from ${lag.sampleSize}`
                      : `Net ${lag.days} terms`
                    return (
                      <AssumptionRow
                        key={lag.clientId}
                        label={name}
                        value={`${lag.days} day${lag.days === 1 ? '' : 's'} · ${detail}`}
                        href={`/clients/${lag.clientId}`}
                      />
                    )
                  })}
                </div>
              </div>
            )}
          </section>
        </>
      )}
    </AppShell>
  )
}
