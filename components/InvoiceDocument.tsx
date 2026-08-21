import Image from 'next/image'
import { formatUSD, formatQty } from '@/lib/money'
import { formatDateLong } from '@/lib/dates'
import { billToText } from '@/lib/clientAddress'

// The invoice itself, on paper.
//
// The app is charcoal because that's the brand; this is white because it is a
// document someone prints, forwards and pays against. The same component is
// the on-screen preview and the reference for the PDF, so what Dan approves
// here is what a client receives.
//
// Three deliberate departures from the old spreadsheet template:
//   1. No reserved empty rows. A one-line invoice is a short invoice; the
//      totals sit under the line they total.
//   2. There is no tax row at all. Tax is 0% on all 105 invoices ever issued,
//      so the row was noise; the deposit row survives because 16 invoices
//      really carry one. A zero deposit is omitted, a real one is printed.
//   3. Remit-to always prints. ACH details never do — clients ask for those,
//      and bank numbers on a forwarded PDF are an unnecessary exposure.

export type DocumentData = {
  number: number
  /**
   * Optional, and only ever changes the total's LABEL. A paid invoice that
   * still says "Total due" reads as a demand for money already received —
   * which is exactly what the emailed copy used to do.
   */
  status?: 'draft' | 'sent' | 'paid' | 'void'
  issue_date: string
  due_date: string
  terms_days: number
  bill_to_snapshot: string | null
  subtotal_cents: number
  tax_bp: number
  tax_cents: number
  deposit_cents: number
  total_cents: number
  notes: string | null
  /**
   * What the invoice is for — show names, frozen in at bill time. Separate
   * from `notes` on purpose: `notes` is InvoiceEditor's textarea and a
   * hand-edit overwrites it, but `work_for` must survive that edit. Null on
   * every hand-written invoice and all 105 historical ones, which render
   * nothing here — unchanged.
   */
  work_for?: string | null
  client: {
    name: string
    address_line1: string | null
    address_line2: string | null
    city: string | null
    state: string | null
    postal_code: string | null
  } | null
  lines: {
    id: string
    description: string
    qty_hundredths: number
    unit_price_cents: number
    line_total_cents: number
  }[]
  settings: {
    business_name: string
    legal_name: string
    address_line1: string | null
    address_line2: string | null
    phone: string | null
    email: string | null
    remit_to: string | null
  } | null
  /**
   * The frozen backup, present only on invoices billed from shows after
   * migration 0012. Receipt images arrive already fetched as data URIs — the
   * PDF renderer must not pull remote URLs itself.
   */
  backup?: {
    show_hours: boolean
    shows: { name: string; zone_label: string; bill_hourly: boolean; days: {
      day: string; in: string | null; out: string | null; meal_minutes: number
      net_hours: number; st_hours: number; ot_hours: number; dt_hours: number
      travel_in: boolean; travel_out: boolean; half_day: boolean; meal_penalties: number
    }[] }[]
    total_net: number; total_st: number; total_ot: number; total_dt: number
    expenses: {
      category: 'meals' | 'rides' | 'baggage' | 'other'
      where_spent: string; amount_cents: number; spent_on: string
      receiptDataUri: string | null
      /**
       * A signed URL to the untouched PDF original, set only when the
       * receipt IS a PDF. Populated only by app/invoices/[id]/page.tsx — the
       * one DocumentData assembly point that hands data to a client
       * component (components/DownloadInvoiceButton.tsx) that fetches and
       * appends it in the browser. sendInvoice's own server-side assembly
       * (app/invoices/actions.ts) omits it: the emailed PDF's appendix is
       * built server-side from its own fetch, never from this field.
       */
      receiptOriginalPdfUrl?: string | null
    }[]
  }
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-6 py-1">
      <dt className="text-[11px] font-semibold uppercase tracking-[0.12em] text-neutral-500">
        {label}
      </dt>
      <dd className="tabular text-sm font-semibold text-paper-ink">{value}</dd>
    </div>
  )
}

// The sheet's border uses --paper-line, not --line: the paper's own edge
// belongs to the paper and must not flip with the theme. On charcoal the
// shadow alone defines the sheet; on a light ground it needs the hairline.
export default function InvoiceDocument({ data }: { data: DocumentData }) {
  const s = data.settings
  const billTo = data.bill_to_snapshot ?? (data.client ? billToText(data.client) : '')

  return (
    <article className="bg-paper text-paper-ink rounded-card overflow-hidden shadow-lg border border-paper-line">
      {/* Amber rule, the way the site closes its header. */}
      <div className="h-1.5 bg-accent-surface" />

      <div className="p-8 sm:p-12">
        <header className="flex flex-wrap items-start justify-between gap-6 pb-8 border-b-2 border-paper-ink">
          <div className="flex items-center gap-3">
            <Image src="/logo.png" alt="" width={44} height={44} />
            <div>
              <p className="display text-xl font-bold leading-none">
                The Audio <span className="text-paper-accent">Smith</span>
              </p>
              <p className="text-[11px] uppercase tracking-[0.12em] text-neutral-500 mt-1">
                {s?.legal_name ?? 'Smith Audio, LLC'}
              </p>
            </div>
          </div>

          <div className="text-right text-xs leading-relaxed text-neutral-600">
            {s?.address_line1 && <p>{s.address_line1}</p>}
            {s?.address_line2 && <p>{s.address_line2}</p>}
            {s?.phone && <p>{s.phone}</p>}
            {s?.email && <p>{s.email}</p>}
          </div>
        </header>

        <div className="grid gap-8 sm:grid-cols-[1fr_auto] py-8">
          <div>
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-neutral-500 mb-2">
              Bill to
            </h2>
            <p className="font-semibold whitespace-pre-line leading-relaxed">
              {billTo || '—'}
            </p>
            {data.work_for && (
              <>
                <h2 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-neutral-500 mb-2 mt-4">
                  For
                </h2>
                <p className="text-sm leading-relaxed">{data.work_for}</p>
              </>
            )}
          </div>

          <dl className="sm:min-w-[15rem] sm:border-l sm:border-paper-line sm:pl-8">
            <Meta label="Invoice" value={`#${data.number}`} />
            <Meta label="Date" value={formatDateLong(data.issue_date)} />
            <Meta label="Terms" value={`Net ${data.terms_days}`} />
            <Meta label="Due" value={formatDateLong(data.due_date)} />
          </dl>
        </div>

        <table className="w-full text-sm">
          <thead>
            <tr className="border-b-2 border-paper-ink">
              <th className="text-left pb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-neutral-500">
                Description
              </th>
              <th className="text-right pb-2 w-16 text-[11px] font-semibold uppercase tracking-[0.12em] text-neutral-500">
                Qty
              </th>
              <th className="text-right pb-2 w-24 text-[11px] font-semibold uppercase tracking-[0.12em] text-neutral-500">
                Price
              </th>
              <th className="text-right pb-2 w-28 text-[11px] font-semibold uppercase tracking-[0.12em] text-neutral-500">
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {data.lines.map((l) => (
              <tr key={l.id} className="border-b border-paper-line">
                <td className="py-2.5 pr-4">{l.description}</td>
                <td className="py-2.5 text-right tabular">{formatQty(l.qty_hundredths)}</td>
                <td className="py-2.5 text-right tabular">{formatUSD(l.unit_price_cents)}</td>
                <td className="py-2.5 text-right tabular">{formatUSD(l.line_total_cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Totals sit directly under the lines they total — the old template
            floated them six inches down a page of reserved blank rows. */}
        <div className="flex justify-end pt-4">
          <dl className="w-full sm:w-72">
            <div className="flex justify-between py-1 text-sm">
              <dt className="text-neutral-600">Subtotal</dt>
              <dd className="tabular">{formatUSD(data.subtotal_cents)}</dd>
            </div>

            {data.deposit_cents !== 0 && (
              <div className="flex justify-between py-1 text-sm">
                <dt className="text-neutral-600">Deposit received</dt>
                <dd className="tabular">−{formatUSD(data.deposit_cents)}</dd>
              </div>
            )}

            <div className="flex justify-between items-baseline pt-3 mt-2 border-t-2 border-paper-ink">
              <dt className="display text-sm font-bold">
                {data.status === 'paid' ? 'Paid in full' : 'Total due'}
              </dt>
              <dd className="tabular text-2xl font-bold">{formatUSD(data.total_cents)}</dd>
            </div>
          </dl>
        </div>

        {(s?.remit_to || data.notes) && (
          // grid-flow-col + auto-cols-fr, NOT grid-cols-2: the columns are as
          // many as there are, each an equal share of the width. That is what
          // invoicePdf.ts's footerCol does (flexGrow 1, flexBasis 0), and
          // grid-cols-2 did not — an invoice with no notes kept the payment
          // block in the left half on screen while the PDF ran it full width,
          // so a long remit-to line wrapped in the preview and did not on the
          // file the client receives. The preview has to be the file.
          <footer className="mt-10 pt-6 border-t border-paper-line grid gap-6 sm:grid-flow-col sm:auto-cols-fr">
            {s?.remit_to && (
              <div>
                <h2 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-neutral-500 mb-2">
                  Payment
                </h2>
                <p className="text-xs leading-relaxed text-neutral-600 whitespace-pre-line">
                  {s.remit_to}
                </p>
                <p className="text-xs text-neutral-500 mt-2">
                  Paying by ACH? Ask and I&rsquo;ll send the transfer details.
                </p>
              </div>
            )}
            {data.notes && (
              <div>
                <h2 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-neutral-500 mb-2">
                  Notes
                </h2>
                <p className="text-xs leading-relaxed text-neutral-600 whitespace-pre-line">
                  {data.notes}
                </p>
              </div>
            )}
          </footer>
        )}

        {/* The old spreadsheet template signed off every one of 105 invoices
            with "THANK YOU FOR YOUR BUSINESS!". It was the only wording the
            data-only rebuild dropped, restored here in the document's own
            voice rather than the template's capitals. */}
        <p className="mt-10 text-center text-[11px] text-neutral-500">
          Thank you for your business!
        </p>
      </div>
    </article>
  )
}
