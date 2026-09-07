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

  // Two reads together: the invoices, and which of them have a bank deposit
  // linked.
  const [{ data, error }, linkRes] = await Promise.all([
    supabase
      .from('invoices')
      .select('id, number, issue_date, due_date, status, total_cents, work_for, clients(name)')
      .order('number', { ascending: false }),
    supabase.from('ledger_transaction_invoices').select('invoice_id'),
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
   * EVERY paid invoice with no link is marked, pre-ledger ones included —
   * Dan's explicit call on 2026-09-07: "I would like the blue dots next to
   * all that are not linked. Even the ones from before 2026."
   *
   * This was first built with a cutoff at the ledger account's opening date,
   * on the reasoning that 85 of his paid invoices predate any bank rows, so
   * marking them says nothing and a dot on four rows in five teaches him to
   * ignore it. He overruled that, and it is his ledger: the dot now means
   * exactly "no deposit is linked", with no judgement about whether one
   * could have been. The account read is kept — the retention/import work
   * may want it — but no longer gates the mark.
   *
   * Fails toward SILENCE: if the link read errors, `unverified` stays empty.
   * A false mark sends him hunting for a payment that is already recorded,
   * which is worse than the absence of a hint he never had.
   */
  const linked = linkRes.error
    ? null
    : new Set(((linkRes.data ?? []) as { invoice_id: string }[]).map((l) => l.invoice_id))
  const unverified = new Set<string>(
    linked
      ? rows.filter((r) => r.status === 'paid' && !linked.has(r.id)).map((r) => r.id)
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
