import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { todayInChicago, monthLabel, formatDateShort } from '@/lib/dates'
import { formatUSD } from '@/lib/money'
import { workingBalance } from '@/lib/ledgerBalance'
import { availableToAllocate, type EnvelopeMoveLike } from '@/lib/envelopes'
import {
  buildForecast, computeOverheadCents,
  type ForecastShow, type ForecastInvoice, type ForecastClient, type ShowProjection,
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
  pm_rate_cents: number
  pm_role: boolean
  location: string | null
  invoice_id: string | null
  show_days: {
    date: string; travel_in: boolean; travel_out: boolean
    pay_as_half_day: boolean; travel_works: boolean
  }[]
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
      .select(`id, name, client_id, status, day_rate_cents, travel_rate_cents,
                pm_rate_cents, pm_role, location, invoice_id,
                show_days(date, travel_in, travel_out, pay_as_half_day, travel_works)`)
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
}

async function fetchAllForecastInvoices(
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<{ rows: RawInvoiceRow[]; error: string | null }> {
  const rows: RawInvoiceRow[] = []
  let from = 0
  for (;;) {
    // draft/sent only — a 'paid' or 'void' invoice contributes no future
    // cash. Payment timing is each client's terms_days now, always (see
    // lib/forecast.ts's header), so there is no learner left that needs a
    // wider read to find settled, deposit-linked history.
    const { data, error } = await supabase
      .from('invoices')
      .select('id, number, client_id, status, total_cents, sent_at')
      .in('status', ['draft', 'sent'])
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
 *  every figure here (take-home, overhead override, tax rate, billing lag,
 *  home state) actually lives and is edited. Payment terms passes its own
 *  `href` instead: `terms_days` lives on each CLIENT record, not Settings, so
 *  linking that row to Settings would send Dan somewhere he can't change the
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

/** One row in the "Booked shows" list — the per-show breakdown backing each
 *  show's contribution to `inflows`. The muted line under the name states
 *  the non-zero COUNTS (`dayCount`/`travelDays`/`pmHours`), not dollars — the
 *  row's own total (`totalCents`) already carries the money, so a second
 *  dollar figure per component just repeated it in smaller type. `dayCount`
 *  (work days) and `travelDays` no longer strictly partition the scheduled
 *  block: a flagged travel day with `travel_works` set counts in BOTH, so
 *  "3 days · 2 travel" on a 5-day show can mean a worked travel day is
 *  counted twice, not that the block is exactly 5. The counts come straight
 *  off `ShowProjection`, sourced from
 *  the same computation as `dayCents`/`travelCents`/`pmCents` (see its doc
 *  comment in lib/forecast.ts) — but a count can be positive while its own
 *  dollars are exactly zero (a $0 travel or PM rate), so each part below is
 *  gated on BOTH its count and its cents, not the count alone, or a $0-rate
 *  show would claim "2 travel · 4h PM" beside a total that pays for neither.
 *  `travelAssumed` gets its own quiet marker (matching the "Short" / "Booked
 *  work ends" tag idiom in ForecastTable) rather than folding into the
 *  travel figure itself, so an assumed travel day reads distinctly from one
 *  Dan actually flagged; a show whose `landsMonth` falls past the last month
 *  the table below actually renders gets the same quiet-marker treatment
 *  ("beyond the table") — the bigger, more optimistic booked-work total has
 *  no row behind it there. */
function BookedShowRow({ sp, lastRenderedMonth }: { sp: ShowProjection; lastRenderedMonth: string | null }) {
  const dateSpan = sp.firstDay === sp.lastDay
    ? formatDateShort(sp.firstDay)
    : `${formatDateShort(sp.firstDay)}–${formatDateShort(sp.lastDay)}`

  const parts: { key: string; node: React.ReactNode }[] = []
  if (sp.dayCount > 0 && sp.dayCents > 0) {
    parts.push({ key: 'days', node: `${sp.dayCount} day${sp.dayCount === 1 ? '' : 's'}` })
  }
  if (sp.travelDays > 0 && sp.travelCents > 0) {
    parts.push({
      key: 'travel',
      node: (
        <>
          {sp.travelDays} travel
          {sp.travelAssumed && (
            <span className="ml-1 text-[10px] font-semibold uppercase tracking-wider text-muted">assumed</span>
          )}
        </>
      ),
    })
  }
  if (sp.pmHours > 0 && sp.pmCents > 0) parts.push({ key: 'pm', node: `${sp.pmHours}h PM` })

  const beyondTable = lastRenderedMonth !== null && sp.landsMonth > lastRenderedMonth

  return (
    <li>
      <Link
        href={`/shows/${sp.showId}`}
        className="block border-b border-line py-4 pl-3 -ml-3 pr-3 hover:bg-surface transition-colors"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <span className="font-semibold">{sp.name}</span>
          <span className="tabular font-semibold text-right">{formatUSD(sp.totalCents)}</span>
        </div>
        <p className="text-xs text-muted mt-1">
          {dateSpan} · lands {monthLabel(sp.landsMonth)}
          {beyondTable && (
            <span className="ml-1 text-[10px] font-semibold uppercase tracking-wider text-muted">
              beyond the table
            </span>
          )}
          {parts.length > 0 && ' · '}
          {parts.map((p, i) => (
            <span key={p.key}>
              {i > 0 && ' · '}
              {p.node}
            </span>
          ))}
        </p>
      </Link>
    </li>
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
    .select('monthly_take_home_cents, monthly_overhead_cents, billing_lag_days, tax_setaside_bp, home_state')
    .eq('owner_id', user.id)
    .maybeSingle()
  if (settingsError) return <LoadError message={settingsError.message} />

  const today = todayInChicago()

  const workingBalanceCents = workingBalance(accountRow.opening_balance_cents, txnRows)
  // I4 (comment fix, behavior deliberately unchanged): this used to say
  // /money/budget computes the same figure via its own call to this helper.
  // It no longer does — /money/budget doesn't import lib/envelopes at all.
  // `moveRows` comes from ledger_envelope_moves, which the 0030 envelope
  // feature shipped empty and which NOTHING CAN WRITE TO ANY MORE: the last
  // writer, moveEnvelopeMoney, was deleted with the rest of that feature's
  // dead write path, so the table is empty by construction rather than by
  // accident. netAllocated(moveRows) is therefore permanently 0 and this
  // always equals workingBalanceCents exactly. In particular it
  // does NOT subtract money the real budget (lib/budget.ts) has already
  // assigned to a category this month — so this figure can present money
  // Dan already gave a job as still free to spend. That's a real gap, not
  // this page's math being wrong for what it's actually computing; closing
  // it (making the forecast budget-aware) is deliberately deferred, not
  // fixed here.
  const availableCents = availableToAllocate(workingBalanceCents, moveRows as EnvelopeMoveLike[])

  const clients: ForecastClient[] = (clientRows ?? []).map((c) => ({
    id: c.id, name: c.name, terms_days: c.terms_days,
  }))

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
      pm_rate_cents: s.pm_rate_cents,
      pm_role: s.pm_role,
      location: s.location,
      days: (s.show_days ?? []).map((d) => ({
        date: d.date, travel_in: d.travel_in, travel_out: d.travel_out,
        pay_as_half_day: d.pay_as_half_day, travel_works: d.travel_works,
      })),
    }
  })

  const invoices: ForecastInvoice[] = (invoiceRows ?? []).map((i) => ({
    id: i.id,
    number: i.number,
    client_id: i.client_id,
    status: i.status as 'draft' | 'sent',
    total_cents: i.total_cents,
    sent_at: i.sent_at,
  }))

  const hasOpenShows = shows.some((s) => s.status === 'open')
  // Only draft/sent invoices are fetched (see fetchAllForecastInvoices
  // above), so "has any unpaid invoice" is just "fetched any invoice at all".
  const hasUnpaidInvoices = invoices.length > 0

  const takeHomeCents = settingsRow?.monthly_take_home_cents ?? 0
  const overheadOverrideCents = settingsRow?.monthly_overhead_cents ?? null
  const computedOverheadCents = computeOverheadCents(txnRows, today)
  const overheadCents = overheadOverrideCents ?? computedOverheadCents
  const taxRateBp = settingsRow?.tax_setaside_bp ?? 0
  const billingLagDays = settingsRow?.billing_lag_days ?? 7
  // Same default as migration 0035's column default — a settings row that
  // predates the column, or hasn't loaded, still needs a state to compare
  // show locations against rather than passing an empty string through to
  // stateOf's comparison in lib/forecast.ts.
  const homeState = settingsRow?.home_state ?? 'IL'

  const forecast = hasOpenShows || hasUnpaidInvoices
    ? buildForecast({
        today,
        startingBalanceCents: availableCents,
        homeState,
        shows,
        invoices,
        clients,
        assumptions: { takeHomeCents, overheadCents, taxRateBp, billingLagDays },
      })
    : null

  const overdueInflows = forecast?.inflows.filter((f) => f.overdue) ?? []
  const bookedShowsTotalCents = forecast?.showProjections.reduce((sum, sp) => sum + sp.totalCents, 0) ?? 0
  // ForecastTable stops rendering at the first uncovered month (or the
  // horizon), but bookedShowsTotalCents above sums EVERY showProjection
  // regardless of whether the table below has a row for the month it lands
  // in — so this can be the last month actually on the page, not the last
  // month with booked work. Used to flag individual Booked-shows rows whose
  // cash lands past it (see BookedShowRow's "beyond the table" marker);
  // does not change any arithmetic.
  const lastRenderedMonth = forecast && forecast.months.length > 0
    ? forecast.months[forecast.months.length - 1].month
    : null

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

          {forecast.showProjections.length > 0 && (
            <section className="mb-10">
              <h2 className="eyebrow mb-4">Booked shows</h2>
              <ul className="border-t border-line">
                {forecast.showProjections.map((sp) => (
                  <BookedShowRow key={sp.showId} sp={sp} lastRenderedMonth={lastRenderedMonth} />
                ))}
              </ul>
              <div className="flex items-center justify-between gap-3 pt-3 text-sm font-semibold">
                <span>Total booked work</span>
                <span className="tabular">{formatUSD(bookedShowsTotalCents)}</span>
              </div>
            </section>
          )}

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
              {/* Every client's own terms_days, not a learned figure — see
                  lib/forecast.ts's header on why per-client learning was
                  dropped. Links to the client list since terms_days lives on
                  each client record, not Settings. */}
              <AssumptionRow label="Payment terms" value="Net 30 — each client's terms" href="/clients" />
              {/* Mirrors the out-of-state travel-day rule in
                  computeShowBreakdown (lib/forecast.ts): only fires past one
                  scheduled day, and only when flagged days didn't already
                  answer the question. */}
              <AssumptionRow
                label="Travel"
                value={`Two days assumed on multi-day shows outside ${homeState}`}
                href="/settings"
              />
            </div>
          </section>
        </>
      )}
    </AppShell>
  )
}
