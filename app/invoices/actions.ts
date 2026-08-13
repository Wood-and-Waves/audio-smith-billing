'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { computeTotals } from '@/lib/money'
import { addDays } from '@/lib/dates'

export type LineInput = {
  description: string
  qty_hundredths: number
  unit_price_cents: number
}

export type InvoiceInput = {
  id?: string
  client_id: string
  issue_date: string
  terms_days: number
  deposit_cents: number
  notes: string
  lines: LineInput[]
}

export type SaveResult = { error: string } | { ok: true; id: string }

/**
 * The one place an invoice is written. Totals are recomputed here from the
 * line items rather than trusted from the browser — a total that disagrees
 * with its own lines is the worst bug this app could ship.
 */
export async function saveInvoice(input: InvoiceInput): Promise<SaveResult> {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  if (!input.client_id) return { error: 'Choose a client before saving.' }
  const lines = input.lines.filter((l) => l.description.trim() || l.unit_price_cents !== 0)
  if (lines.length === 0) return { error: 'Add at least one line item.' }

  // Tax is hardcoded to zero, not read from the caller: neither renderer
  // (InvoiceDocument.tsx nor invoicePdf.ts) draws a tax row, so any non-zero
  // value here would produce a document whose printed total does not add up
  // to what the client is being asked to pay. See InvoiceInput above — it
  // has no tax_bp field, so no caller can even attempt to pass one.
  const totals = computeTotals(
    lines.map((l) => ({ qtyHundredths: l.qty_hundredths, unitPriceCents: l.unit_price_cents })),
    { taxBasisPoints: 0, depositCents: input.deposit_cents },
  )

  const { data: client } = await supabase
    .from('clients')
    .select('name, address_line1, address_line2')
    .eq('id', input.client_id)
    .maybeSingle()

  // Frozen at save time, so editing a client later can't rewrite an invoice
  // that has already gone out.
  const billTo = [client?.name, client?.address_line1, client?.address_line2]
    .filter(Boolean)
    .join('\n')

  const row = {
    owner_id: user.id,
    client_id: input.client_id,
    issue_date: input.issue_date,
    due_date: addDays(input.issue_date, input.terms_days),
    terms_days: input.terms_days,
    bill_to_snapshot: billTo,
    subtotal_cents: totals.subtotalCents,
    tax_bp: 0,
    tax_cents: totals.taxCents,
    deposit_cents: totals.depositCents,
    total_cents: totals.totalCents,
    notes: input.notes.trim() || null,
  }

  let invoiceId = input.id

  if (invoiceId) {
    const { error } = await supabase.from('invoices').update(row).eq('id', invoiceId)
    if (error) return { error: error.message }
    const { error: delError } = await supabase
      .from('invoice_lines')
      .delete()
      .eq('invoice_id', invoiceId)
    if (delError) return { error: delError.message }
  } else {
    const { data: number, error: numError } = await supabase.rpc('allocate_invoice_number')
    if (numError) return { error: `Couldn't allocate an invoice number: ${numError.message}` }

    const { data: created, error } = await supabase
      .from('invoices')
      .insert({ ...row, number, status: 'draft' })
      .select('id')
      .single()
    if (error) return { error: error.message }
    invoiceId = created.id
  }

  const { error: lineError } = await supabase.from('invoice_lines').insert(
    lines.map((l, position) => ({
      owner_id: user.id,
      invoice_id: invoiceId,
      position,
      description: l.description.trim(),
      qty_hundredths: l.qty_hundredths,
      unit_price_cents: l.unit_price_cents,
      line_total_cents: Math.round((l.qty_hundredths * l.unit_price_cents) / 100),
    })),
  )
  if (lineError) return { error: lineError.message }

  revalidatePath('/invoices')
  revalidatePath(`/invoices/${invoiceId}`)
  return { ok: true, id: invoiceId! }
}

/** draft -> sent, or sent -> paid. Kept separate from editing on purpose. */
export async function setInvoiceStatus(
  id: string,
  status: 'draft' | 'sent' | 'paid' | 'void',
): Promise<{ error: string } | { ok: true }> {
  const supabase = await createClient()
  const patch: Record<string, unknown> = { status }
  if (status === 'sent') patch.sent_at = new Date().toISOString()

  const { error } = await supabase.from('invoices').update(patch).eq('id', id)
  if (error) return { error: error.message }

  revalidatePath('/invoices')
  revalidatePath(`/invoices/${id}`)
  return { ok: true }
}
