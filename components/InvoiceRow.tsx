import Link from 'next/link'
import { formatUSD } from '@/lib/money'
import { displayStatus, daysUntilDue, STATUS_META, type InvoiceLike } from '@/lib/status'

// A row restructures on a phone rather than shrinking: the client name is the
// thing you scan for, so it keeps a full line of its own and never truncates
// to "Str…". Desktop puts everything on one line.
//
// The 3px bar on the left edge is the invoice's signal state — amber for live,
// red for clipping, dim for muted, nothing once it's printed and paid.

export type InvoiceRowData = InvoiceLike & {
  id: string
  number: number
  issue_date: string
  clients: { name: string } | null
}

const shortDate = (iso: string) =>
  new Intl.DateTimeFormat('en-US', { month: 'numeric', day: 'numeric', year: '2-digit' })
    .format(new Date(iso + 'T00:00:00Z'))

export default function InvoiceRow({
  invoice,
  today,
  emphasis = false,
}: {
  invoice: InvoiceRowData
  today: string
  emphasis?: boolean
}) {
  const s = displayStatus(invoice, today)
  const days = daysUntilDue(invoice.due_date, today)
  const name = invoice.clients?.name ?? 'Unknown client'

  const timing =
    s === 'overdue'
      ? `${Math.abs(days)} ${Math.abs(days) === 1 ? 'day' : 'days'} late`
      : s === 'sent'
        ? `due in ${days} ${days === 1 ? 'day' : 'days'}`
        : STATUS_META[s].label

  return (
    <li>
      <Link
        href={`/invoices/${invoice.id}`}
        className="relative block border-b border-line py-3 pl-4 pr-1 hover:bg-surface transition-colors"
      >
        <span
          aria-hidden
          className={`absolute left-0 top-0 bottom-0 w-[3px] ${STATUS_META[s].bar}`}
        />

        <div className="grid grid-cols-[2.75rem_1fr_auto] items-center gap-x-3 gap-y-0.5
                        sm:flex sm:gap-4">
          <span className="tabular text-sm text-muted row-span-2 self-center sm:row-auto sm:w-12 sm:shrink-0">
            {invoice.number}
          </span>

          <span className={`min-w-0 truncate sm:flex-1 ${emphasis ? 'font-semibold' : ''}`}>
            {name}
          </span>

          <span className="tabular font-semibold row-span-2 self-center text-right
                           sm:row-auto sm:order-last sm:w-28 sm:shrink-0">
            {formatUSD(invoice.total_cents)}
          </span>

          {/* Second line on a phone; inline columns from sm up. */}
          <span className={`text-xs ${STATUS_META[s].text} sm:w-28 sm:text-right sm:shrink-0`}>
            {timing}
          </span>

          <span className="hidden sm:block tabular text-sm text-muted w-20 text-right shrink-0 sm:order-2">
            {shortDate(invoice.issue_date)}
          </span>
        </div>
      </Link>
    </li>
  )
}
