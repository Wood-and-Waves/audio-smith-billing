import Link from 'next/link'
import { formatUSD } from '@/lib/money'
import { displayStatus, daysUntilDue, STATUS_META, type InvoiceLike } from '@/lib/status'
import { formatDateShort } from '@/lib/dates'

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
  // Null on most invoices imported before this existed, and on any hand-
  // written one nobody has labelled yet — see app/invoices/actions.ts on how
  // it's set and edited. Absence here is normal, not an error state.
  work_for: string | null
  clients: { name: string } | null
}

export default function InvoiceRow({
  invoice,
  today,
  emphasis = false,
  unverified = false,
}: {
  invoice: InvoiceRowData
  today: string
  emphasis?: boolean
  /**
   * Paid, but no bank deposit is linked to it — so the app is taking Dan's
   * word for it rather than showing him money that arrived. Dan, 2026-09-07:
   * "How do I know which invoices are settled?" He could not; a hand-marked
   * invoice and one settled by a real deposit both just read "paid".
   *
   * NOT an error state, which is why it is --info blue rather than danger
   * red: amber asks for attention, red is late, green is done, and this is
   * none of those. It is a statement of fact about what the app can prove.
   *
   * Set for EVERY unlinked paid invoice, pre-ledger ones included (Dan's
   * call, 2026-09-07). Roughly 89 of his 107 paid invoices carry it, so it
   * reads as "these are on your word" rather than "these need fixing".
   */
  unverified?: boolean
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
        className="relative block border-b border-line py-3 pl-4 pr-3 hover:bg-surface transition-colors"
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

          {/* The show title matters as much as the client (Dan). On a phone
              the two share one truncating line only when both are short —
              a long client name would swallow the title entirely — so the
              title takes its own line there. Desktop has the width for the
              inline " · " form. */}
          <span className={`min-w-0 sm:flex-1 ${emphasis ? 'font-semibold' : ''}`}>
            <span className="block truncate">
              {unverified && (
                <span
                  title="Paid, but no deposit linked"
                  aria-label="Paid, but no deposit linked"
                  className="inline-block align-middle mr-1.5 h-1.5 w-1.5 rounded-full bg-info"
                />
              )}
              {name}
              {invoice.work_for
                ? <span className="hidden sm:inline text-muted font-normal"> · {invoice.work_for}</span>
                : null}
            </span>
            {invoice.work_for && (
              <span className="block truncate text-muted font-normal sm:hidden">
                {invoice.work_for}
              </span>
            )}
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
            {formatDateShort(invoice.issue_date)}
          </span>
        </div>
      </Link>
    </li>
  )
}
