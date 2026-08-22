'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'

export type SettingsInput = {
  business_name: string
  legal_name: string
  address_line1: string
  address_line2: string
  phone: string
  email: string
  remit_to: string
  // Bank transfer details. Deliberately never rendered on an invoice —
  // components/InvoiceDocument.tsx prints only remit_to. A client who wants
  // to pay by ACH asks, and these get sent to them separately. Do not wire
  // this into the invoice document; that's the whole point of keeping it
  // off the PDF.
  ach_details: string
  default_terms_days: number
  next_invoice_number: number
  // Basis points, 3000 = 30%. Estimate-only — the rate is Dan's/his CPA's
  // number, never computed by this app.
  tax_setaside_bp: number
  // The three assumptions the cash-flow forecast reads from Settings.
  // Integer cents, like every other money field in this app.
  monthly_take_home_cents: number
  // null = use the trailing 3-month average computed by the forecast;
  // a number here overrides it. Meaningfully different from 0.
  monthly_overhead_cents: number | null
  billing_lag_days: number
}

type Fail = { error: string }

export async function saveSettings(input: SettingsInput): Promise<Fail | { ok: true }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  if (!input.business_name.trim()) return { error: 'A trading name is required.' }
  if (!input.legal_name.trim()) return { error: 'A legal name is required — it prints in the remit-to block.' }

  if (!Number.isFinite(input.default_terms_days) || input.default_terms_days < 0) {
    return { error: 'Default terms must be zero days or more.' }
  }

  if (!Number.isFinite(input.next_invoice_number) || !Number.isInteger(input.next_invoice_number)) {
    return { error: 'Next invoice number must be a whole number.' }
  }

  if (
    !Number.isInteger(input.tax_setaside_bp) ||
    input.tax_setaside_bp < 0 || input.tax_setaside_bp > 10000
  ) {
    return { error: 'Tax set-aside must be between 0% and 100%.' }
  }

  if (!Number.isInteger(input.monthly_take_home_cents) || input.monthly_take_home_cents < 0) {
    return { error: 'Monthly take-home must be zero or more.' }
  }

  if (
    input.monthly_overhead_cents !== null &&
    (!Number.isInteger(input.monthly_overhead_cents) || input.monthly_overhead_cents < 0)
  ) {
    return { error: 'Monthly overhead must be zero or more, or left blank to use the average.' }
  }

  if (
    !Number.isInteger(input.billing_lag_days) ||
    input.billing_lag_days < 0 || input.billing_lag_days > 120
  ) {
    return { error: 'Billing lag must be between 0 and 120 days.' }
  }

  // Lowering this would hand out an invoice number that already exists, and
  // the unique index on (owner_id, number) would reject the next invoice
  // with a database error the user cannot interpret. Refuse it here, clearly.
  // Owner-scoped for the same reason the update below is: unscoped, a second
  // owner's invoice numbers would set the floor for Dan's counter.
  const { data: maxRow } = await supabase
    .from('invoices').select('number').eq('owner_id', user.id)
    .order('number', { ascending: false }).limit(1).maybeSingle()
  const highest = maxRow?.number ?? 0
  if (input.next_invoice_number <= highest) {
    return { error: `Next invoice number must be above ${highest}, the highest already used.` }
  }

  const row = {
    business_name: input.business_name.trim(),
    legal_name: input.legal_name.trim(),
    address_line1: input.address_line1.trim() || null,
    address_line2: input.address_line2.trim() || null,
    phone: input.phone.trim() || null,
    email: input.email.trim() || null,
    remit_to: input.remit_to.trim() || null,
    ach_details: input.ach_details.trim() || null,
    default_terms_days: input.default_terms_days,
    next_invoice_number: input.next_invoice_number,
    tax_setaside_bp: input.tax_setaside_bp,
    monthly_take_home_cents: input.monthly_take_home_cents,
    monthly_overhead_cents: input.monthly_overhead_cents,
    billing_lag_days: input.billing_lag_days,
  }

  // owner_id, not `id = 1`. This is a WRITE: keyed on the singleton row it
  // would overwrite whoever's business details happen to live there, and those
  // details print on every invoice that entity sends. RLS refuses it today,
  // but the filter belongs in the query rather than being borrowed from a
  // policy — one owner today, but nothing stops a second.
  const { error } = await supabase.from('settings').update(row).eq('owner_id', user.id)
  if (error) return { error: error.message }

  revalidatePath('/settings')
  return { ok: true }
}
