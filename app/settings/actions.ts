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
  default_tax_pct: string // raw user input, e.g. "8.25" -> stored as basis points
  next_invoice_number: number
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

  // Tax is entered as a percentage and stored as basis points.
  const pctRaw = input.default_tax_pct.trim()
  const pct = pctRaw === '' ? 0 : Number(pctRaw)
  if (!Number.isFinite(pct)) {
    return { error: `Couldn't read "${input.default_tax_pct}" as a tax rate. Try something like 8.25.` }
  }
  const taxBp = Math.round(pct * 100)
  if (taxBp < 0) return { error: 'Default tax cannot be negative.' }
  if (taxBp > 10000) return { error: 'Default tax cannot be over 100%.' }

  if (!Number.isFinite(input.next_invoice_number) || !Number.isInteger(input.next_invoice_number)) {
    return { error: 'Next invoice number must be a whole number.' }
  }

  // Lowering this would hand out an invoice number that already exists, and
  // the unique index on (owner_id, number) would reject the next invoice
  // with a database error the user cannot interpret. Refuse it here, clearly.
  const { data: maxRow } = await supabase
    .from('invoices').select('number').order('number', { ascending: false }).limit(1).maybeSingle()
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
    default_tax_bp: taxBp,
    next_invoice_number: input.next_invoice_number,
  }

  const { error } = await supabase.from('settings').update(row).eq('id', 1)
  if (error) return { error: error.message }

  revalidatePath('/settings')
  return { ok: true }
}
