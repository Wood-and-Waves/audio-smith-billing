'use client'

import { useMemo, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  computeTotals, formatUSD, formatAmount, formatQty,
  parseUSD, parseQty, travelRateFrom, overtimeRateFrom, doubleTimeRateFrom,
} from '@/lib/money'
import { todayInChicago, addDays } from '@/lib/dates'
import { saveInvoice, type InvoiceInput } from '@/app/invoices/actions'

export type EditorClient = {
  id: string
  name: string
  terms_days: number
  day_rate_cents: number | null
  ot_after_hours: number
}

export type EditorItem = {
  id: string
  name: string
  unit_label: string
  default_price_cents: number
  kind: 'flat' | 'derived'
  derive_rule: string | null
}

type Line = { key: string; description: string; qty: string; price: string }

const newLine = (over: Partial<Line> = {}): Line => ({
  key: Math.random().toString(36).slice(2),
  description: '', qty: '1', price: '', ...over,
})

const field =
  'w-full px-3 py-2 bg-surface border border-line rounded-field text-ink text-sm ' +
  'focus:border-accent focus:outline-none'

export default function InvoiceEditor({
  clients, items, initial, invoiceId, invoiceNumber,
}: {
  clients: EditorClient[]
  items: EditorItem[]
  initial?: Partial<InvoiceInput>
  invoiceId?: string
  invoiceNumber?: number
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  // Set only when saveInvoice reports it switched off a billed invoice's
  // hours page because the edited hours no longer match it — see the
  // reconciliation guard in app/invoices/actions.ts. Shown instead of an
  // immediate redirect so it is not navigated past before Dan can read it.
  const [warning, setWarning] = useState<{ id: string; message: string } | null>(null)

  const [clientId, setClientId] = useState(initial?.client_id ?? '')
  const [issueDate, setIssueDate] = useState(
    initial?.issue_date ?? todayInChicago(),
  )
  const [termsDays, setTermsDays] = useState(String(initial?.terms_days ?? 30))
  const [deposit, setDeposit] = useState(
    initial?.deposit_cents ? formatAmount(initial.deposit_cents) : '',
  )
  const [notes, setNotes] = useState(initial?.notes ?? '')
  const [lines, setLines] = useState<Line[]>(
    initial?.lines?.length
      ? initial.lines.map((l) =>
          newLine({
            description: l.description,
            qty: formatQty(l.qty_hundredths),
            price: formatAmount(l.unit_price_cents),
          }),
        )
      : [newLine()],
  )

  const client = clients.find((c) => c.id === clientId)

  /**
   * Travel and overtime are SUGGESTED from the client's day rate, then stored
   * as whatever number ends up on the line. Dan's history contains both
   * $106.36 and $106.37 for the same computed rate, so recomputing on read
   * would quietly rewrite invoices he has already sent.
   */
  function priceFor(item: EditorItem): number {
    const day = client?.day_rate_cents ?? 0
    const hours = client?.ot_after_hours ?? 10
    if (item.kind === 'derived' && day) {
      if (item.derive_rule === 'travel_half') return travelRateFrom(day)
      if (item.derive_rule === 'overtime_1_5x') return overtimeRateFrom(day, hours)
      if (item.derive_rule === 'double_time_2x') return doubleTimeRateFrom(day, hours)
    }
    if (item.name === 'Day Rate' && day) return day
    return item.default_price_cents
  }

  const parsed = useMemo(
    () =>
      lines.map((l) => ({
        description: l.description,
        qty_hundredths: parseQty(l.qty) ?? 0,
        unit_price_cents: parseUSD(l.price) ?? 0,
      })),
    [lines],
  )

  const totals = useMemo(
    () =>
      computeTotals(
        parsed.map((l) => ({
          qtyHundredths: l.qty_hundredths,
          unitPriceCents: l.unit_price_cents,
        })),
        { taxBasisPoints: 0, depositCents: parseUSD(deposit) ?? 0 },
      ),
    [parsed, deposit],
  )

  const dueDate = useMemo(
    () => addDays(issueDate, Number(termsDays) || 0),
    [issueDate, termsDays],
  )

  const setLine = (key: string, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)))

  function addItem(item: EditorItem) {
    setLines((ls) => [
      ...ls.filter((l) => l.description.trim() || l.price.trim()),
      newLine({ description: item.name, price: formatAmount(priceFor(item)) }),
    ])
  }

  function submit() {
    setError(null)
    setWarning(null)
    startTransition(async () => {
      const result = await saveInvoice({
        id: invoiceId,
        client_id: clientId,
        issue_date: issueDate,
        terms_days: Number(termsDays) || 30,
        deposit_cents: parseUSD(deposit) ?? 0,
        notes,
        lines: parsed,
      })
      if ('error' in result) { setError(result.error); return }
      if (result.warning) {
        // Stay put and surface it, rather than navigating straight past it —
        // the invoice is saved either way, so the link below is how Dan gets
        // there once he has seen why the hours page went dark.
        setWarning({ id: result.id, message: result.warning })
        router.refresh()
        return
      }
      router.push(`/invoices/${result.id}`)
      router.refresh()
    })
  }

  return (
    <div className="max-w-3xl">
      <h1 className="display text-3xl font-bold mb-8">
        {invoiceNumber ? <>Edit <span className="text-muted">#</span>{invoiceNumber}</> : 'New invoice'}
      </h1>

      <div className="grid gap-4 sm:grid-cols-2 mb-8">
        <div className="sm:col-span-2">
          <label className="eyebrow block mb-2" htmlFor="client">Client</label>
          <select id="client" className={field} value={clientId}
                  onChange={(e) => {
                    setClientId(e.target.value)
                    const c = clients.find((x) => x.id === e.target.value)
                    if (c) setTermsDays(String(c.terms_days))
                  }}>
            <option value="">Choose a client…</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          {client?.day_rate_cents ? (
            <p className="text-xs text-muted mt-1.5 tabular">
              Day {formatUSD(client.day_rate_cents)} · Travel{' '}
              {formatUSD(travelRateFrom(client.day_rate_cents))} · OT{' '}
              {formatUSD(overtimeRateFrom(client.day_rate_cents, client.ot_after_hours))} after{' '}
              {client.ot_after_hours}h
            </p>
          ) : client ? (
            <p className="text-xs text-accent mt-1.5">
              No rate card for {client.name} — prices start blank.
            </p>
          ) : null}
        </div>

        <div>
          <label className="eyebrow block mb-2" htmlFor="issue">Date</label>
          <input id="issue" type="date" className={field} value={issueDate}
                 onChange={(e) => setIssueDate(e.target.value)} />
        </div>

        <div>
          <label className="eyebrow block mb-2" htmlFor="terms">Terms (days)</label>
          <input id="terms" type="number" min={0} className={field} value={termsDays}
                 onChange={(e) => setTermsDays(e.target.value)} />
          <p className="text-xs text-muted mt-1.5">Due {dueDate}</p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <span className="eyebrow">Add</span>
        {items.map((item) => (
          <button key={item.id} type="button" onClick={() => addItem(item)}
                  className="px-2.5 py-1 text-xs font-semibold rounded-field border border-line
                             text-muted hover:text-ink hover:border-accent transition-colors">
            {item.name}
          </button>
        ))}
      </div>

      <div className="border-t border-line mb-2">
        {lines.map((l) => {
          const total = Math.round(((parseQty(l.qty) ?? 0) * (parseUSD(l.price) ?? 0)) / 100)
          return (
            <div key={l.key}
                 className="grid grid-cols-[1fr_auto] sm:grid-cols-[1fr_4.5rem_7rem_6.5rem_2rem]
                            gap-2 items-center py-2 border-b border-line">
              <input aria-label="Description" placeholder="Description" className={`${field} col-span-2 sm:col-span-1`}
                     value={l.description} onChange={(e) => setLine(l.key, { description: e.target.value })} />
              <input aria-label="Quantity" inputMode="decimal" className={`${field} tabular text-right`}
                     value={l.qty} onChange={(e) => setLine(l.key, { qty: e.target.value })} />
              <input aria-label="Unit price" inputMode="decimal" placeholder="0.00"
                     className={`${field} tabular text-right`}
                     value={l.price} onChange={(e) => setLine(l.key, { price: e.target.value })} />
              <span className="tabular text-sm text-right pr-1">{formatUSD(total)}</span>
              <button type="button" aria-label={`Remove ${l.description || 'line'}`}
                      onClick={() => setLines((ls) => (ls.length === 1 ? [newLine()] : ls.filter((x) => x.key !== l.key)))}
                      className="text-muted hover:text-danger transition-colors text-lg leading-none">
                ×
              </button>
            </div>
          )
        })}
      </div>

      <button type="button" onClick={() => setLines((ls) => [...ls, newLine()])}
              className="text-xs font-semibold uppercase tracking-wider text-muted hover:text-accent
                         transition-colors mb-8">
        + Add line
      </button>

      <div className="flex justify-end mb-8">
        <dl className="w-full sm:w-80">
          <div className="flex justify-between items-baseline py-1 text-sm">
            <dt className="text-muted">Subtotal</dt>
            <dd className="tabular">{formatUSD(totals.subtotalCents)}</dd>
          </div>
          <div className="flex justify-between items-center py-1 text-sm gap-4">
            <dt className="text-muted shrink-0">Deposit received</dt>
            <dd className="w-32">
              <input aria-label="Deposit received" inputMode="decimal" placeholder="0.00"
                     className={`${field} tabular text-right`}
                     value={deposit} onChange={(e) => setDeposit(e.target.value)} />
            </dd>
          </div>
          <div className="flex justify-between items-baseline pt-3 mt-2 border-t-2 border-line">
            <dt className="display font-bold">Total due</dt>
            <dd className="tabular text-2xl font-bold">{formatUSD(totals.totalCents)}</dd>
          </div>
        </dl>
      </div>

      <div className="mb-8">
        <label className="eyebrow block mb-2" htmlFor="notes">Notes on this invoice</label>
        <textarea id="notes" rows={3} className={field} value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Anything this client needs to see. Your remit-to details print automatically." />
      </div>

      {error && (
        <p role="alert" className="mb-5 text-sm text-danger border-l-2 border-danger pl-3 py-1">
          {error}
        </p>
      )}

      {warning && (
        <p role="status" className="mb-5 text-sm text-accent border-l-2 border-accent pl-3 py-1">
          {warning.message}{' '}
          <Link href={`/invoices/${warning.id}`} className="underline font-semibold">
            View invoice
          </Link>
        </p>
      )}

      <div className="flex items-center gap-3">
        <button type="button" onClick={submit} disabled={pending}
                className="px-5 py-2.5 bg-accent-surface text-accent-ink font-bold uppercase tracking-wider
                           text-sm rounded-field cursor-pointer hover:opacity-90 transition-opacity
                           disabled:opacity-50 disabled:cursor-not-allowed">
          {pending ? 'Saving…' : invoiceId ? 'Save changes' : 'Create invoice'}
        </button>
        <button type="button" onClick={() => router.back()} disabled={pending}
                className="px-5 py-2.5 border border-line text-muted font-bold uppercase tracking-wider
                           text-sm rounded-field cursor-pointer hover:text-ink transition-colors">
          Cancel
        </button>
      </div>
    </div>
  )
}
