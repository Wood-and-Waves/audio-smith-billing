import { createClient } from '@/lib/supabase/server'
import { formatUSD } from '@/lib/money'
import { displayStatus, todayInChicago } from '@/lib/status'
import AppShell from '@/components/AppShell'
import InvoiceRow, { type InvoiceRowData } from '@/components/InvoiceRow'

export const dynamic = 'force-dynamic'

export default async function InvoicesPage() {
  const supabase = await createClient()
  const today = todayInChicago()

  const { data, error } = await supabase
    .from('invoices')
    .select('id, number, issue_date, due_date, status, total_cents, clients(name)')
    .order('number', { ascending: false })

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
              <InvoiceRow key={r.id} invoice={r} today={today} emphasis />
            ))}
          </ul>
        )}
      </section>

      <section>
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 mb-4">
          <h2 className="eyebrow">All invoices</h2>
          <p className="tabular text-sm text-muted">
            {rows.length} total ·{' '}
            <span className="text-ink">
              {formatUSD(rows.reduce((t, r) => t + r.total_cents, 0))}
            </span>
          </p>
        </div>

        <ul className="border-t border-line">
          {rows.map((r) => (
            <InvoiceRow key={r.id} invoice={r} today={today} />
          ))}
        </ul>
      </section>
    </AppShell>
  )
}
