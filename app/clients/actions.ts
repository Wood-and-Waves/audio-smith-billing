'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { parseUSD } from '@/lib/money'

export type ClientInput = {
  id?: string
  name: string
  billing_email: string
  contact_name: string
  phone: string
  address_line1: string
  address_line2: string
  terms_days: number
  day_rate: string        // raw user input, e.g. "780" or "$780.00"
  ot_after_hours: number
  notes: string
  archived: boolean
  show_hours_on_invoice: boolean
}

type Fail = { error: string }

export async function saveClient(input: ClientInput): Promise<Fail | { ok: true; id: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  if (!input.name.trim()) return { error: 'A client needs a name.' }

  // parseUSD returns null on junk and 0 on an empty string. A blank day rate is
  // legitimate — it means "no rate card" — but "banana" is not.
  const raw = input.day_rate.trim()
  const dayRate = raw === '' ? null : parseUSD(raw)
  if (raw !== '' && dayRate === null) {
    return { error: `Couldn't read "${input.day_rate}" as a day rate. Try something like 780.` }
  }
  if (dayRate !== null && dayRate < 0) return { error: 'A day rate cannot be negative.' }

  if (!Number.isFinite(input.ot_after_hours) || input.ot_after_hours <= 0) {
    return { error: 'Overtime threshold must be more than zero hours.' }
  }
  if (!Number.isFinite(input.terms_days) || input.terms_days < 0) {
    return { error: 'Payment terms must be zero days or more.' }
  }

  const row = {
    owner_id: user.id,
    name: input.name.trim(),
    billing_email: input.billing_email.trim() || null,
    contact_name: input.contact_name.trim() || null,
    phone: input.phone.trim() || null,
    address_line1: input.address_line1.trim() || null,
    address_line2: input.address_line2.trim() || null,
    terms_days: input.terms_days,
    day_rate_cents: dayRate,
    ot_after_hours: input.ot_after_hours,
    notes: input.notes.trim() || null,
    archived: input.archived,
    show_hours_on_invoice: input.show_hours_on_invoice,
  }

  let id = input.id
  if (id) {
    const { error } = await supabase.from('clients').update(row).eq('id', id)
    if (error) return { error: error.message }
  } else {
    const { data, error } = await supabase.from('clients').insert(row).select('id').single()
    if (error) return { error: error.message }
    id = data.id
  }

  revalidatePath('/clients')
  revalidatePath(`/clients/${id}`)
  return { ok: true, id: id! }
}
