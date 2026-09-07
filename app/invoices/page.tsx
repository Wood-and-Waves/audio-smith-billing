import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { formatUSD } from '@/lib/money'
import { displayStatus, todayInChicago } from '@/lib/status'
import AppShell from '@/components/AppShell'
import InvoiceRow, { type InvoiceRowData } from '@/components/InvoiceRow'

export const dynamic = 'force-dynamic'

export default async function InvoicesPage() {
  const supabase = await createClient()
  const today = todayInChicago()

  // Three reads together: the invoices, which of them have a bank deposit
  // linked, and when the ledger account opened — the cutoff that decides
  // whether an unlinked invoice is worth marking at all.
  const [{ data, error }, linkRes, accountRes] = await Promise.all([
    supabase
      .from('invoices')
      .select('id, number, issue_date, due_date, status, total_cents, work_for, clients(name)')
      .order('number', { ascending: false }),
    supabase.from('ledger_transaction_invoices').select('invoice_id'),
    supabase
      .from('ledger_accounts')
      .select('opening_date')
      .eq('closed', false)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle(),
  ])

  if (error) {
    return (
      <AppShell current="invoices">
        <p role="alert" className="text-danger border-l-2 border-danger pl-4 py-2">
          Couldn&rsquo;t load invoices: {error.message}
        </p>
      </AppShell>
    )
  }

  const rows = (data ?? []) as unknown as InvoiceRowData[]

  /**
   * Paid invoices with no bank deposit behind them.
   *
   * Dan, 2026-09-07: "How do I know which invoices are settled?" He could
   * not — this page read `status` alone, so an invoice he hand-marked paid
   * and one settled by a real deposit both said "paid".
   *
   * Marked only when the invoice was issued AFTER the ledger account opened.
   *
   * The cutoff went in, came out, and went back in — the history is the
   * argument. It was built with the cutoff, on the reasoning that invoices
   * predating the account could never have had a deposit linked, so marking
   * them says nothing. Dan asked for every unlinked invoice to be marked
   * (2026-09-07) and that shipped. Then he reconciled the whole ledger era:
   * 21 of 21 paid invoices since the account opened now carry a real
   * deposit, and every remaining unlinked invoice — 86 of them — is
   * pre-ledger. Signal and noise separated exactly along this line, so he
   * restored the cutoff the same day.
   *
   * The effect is that a dot now means something has gone UNRECONCILED, not
   * merely unproven: with the era clean, the next dot to appear is a new
   * invoice he marked paid without a deposit behind it.
   *
   * Fails toward SILENCE: if either read errors, `unverified` stays empty. A
   * false mark sends him hunting for a payment that is already recorded,
   * which is worse than the absence of a hint he never had.
   */
  const openingDate = (accountRes.data?.opening_date as string | undefined) ?? null
  const linked = linkRes.error
    ? null
    : new Set(((linkRes.data ?? []) as { invoice_id: string }[]).map((l) => l.invoice_id))
  const unverified = new Set<string>(
    linked && openingDate
      ? rows
          .filter((r) => r.status === 'paid' && !linked.has(r.id) && r.issue_date >= openingDate)
          .map((r) => r.id)
      : [],
  )

  const open = rows.filter((r) => r.status === 'sent')
  const openTotal = open.reduce((t, r) => t + r.total_cents, 0)
  const overdue = open.filter((r) => displayStatus(r, today) === 'overdue')

  return (
    <AppShell current="invoices">
      {/* What is owed. Four rows out of 105, so it leads. */}
      <section className="mb-14">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 mb-4">
          <h2 className="eyebrow">Open</h2>
          <p className="tabular text-sm text-muted">
            {open.length} open ·{' '}
            <span className="text-ink font-semibold">{formatUSD(openTotal)}</span>
            {overdue.length > 0 && (
              <>
                {' · '}
                <span className="text-danger font-semibold">{overdue.length} overdue</span>
              </>
            )}
          </p>
        </div>

        {open.length === 0 ? (
          <p className="text-muted py-6 border-t border-line">
            Nothing outstanding. Every invoice you&rsquo;ve sent has been paid.
          </p>
        ) : (
          <ul className="border-t border-line">
            {open.map((r) => (
              <InvoiceRow key={r.id} invoice={r} today={today} emphasis
                          unverified={unverified.has(r.id)} />
            ))}
          </ul>
        )}
      </section>

      <section>
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 mb-4">
          <div className="flex items-baseline gap-4">
            <h2 className="eyebrow">All invoices</h2>
            <Link
              href="/invoices/new"
              className="text-xs font-semibold uppercase tracking-wider text-accent hover:opacity-80"
            >
              + New invoice
            </Link>
          </div>
          <p className="tabular text-sm text-muted">
            {rows.length} total ·{' '}
            <span className="text-ink">
              {formatUSD(rows.reduce((t, r) => t + r.total_cents, 0))}
            </span>
          </p>
        </div>

        <ul className="border-t border-line">
          {rows.map((r) => (
            <InvoiceRow key={r.id} invoice={r} today={today}
                        unverified={unverified.has(r.id)} />
          ))}
        </ul>
      </section>
    </AppShell>
  )
}
