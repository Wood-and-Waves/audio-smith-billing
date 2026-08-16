'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { parseUSD } from '@/lib/money'
import { deriveFromDayRate } from '@/lib/rateCards'

export type CardInput = {
  id?: string
  // NULL is the default (unnamed) card. There can be only one — see the
  // validation below, backed by a partial unique index in the database.
  name: string | null
  day_rate: string        // raw user input, e.g. "780" or "$780.00"
  ot_after_hours: number
  // Raw user input, same override convention as createShow's day/travel/pm
  // boxes: undefined or blank means "use the default the day rate and OT
  // threshold imply" (see deriveFromDayRate), not zero — a blank box must
  // never freeze a $0.00 rate onto the card. Explicit, because migration
  // 0015 gave the card its own travel_rate_cents/pm_rate_cents precisely so
  // an arrangement that isn't half-day-travel-or-full (a flat $200/leg, say)
  // can be typed in directly instead of picked from a switch.
  travel_rate?: string
  pm_rate?: string
  // Raw string, not a number: an empty box must become NULL ("no double
  // time"), and Number('') is 0 — which would mean "every hour is double
  // time" instead. Same convention as ShowSettings/updateShow.
  dt_after_hours: string
  minimum_meal_break_minutes: number
  meal_break_deduction_cap: number
  meal_penalty_grace_hours: number
  // Raw USD input; 0/"" -> meal penalties disabled for shows created from
  // this card (see billShows and ShowSettings — unlike travel/PM above,
  // blank here is a real, legitimate zero, not "use a default").
  meal_penalty: string
  short_turn_rest_hours: number
  continuous_time_enabled: boolean
  // ClientEditor now always sends this — its card checkbox is wired and threads
  // the card's real stored value through, so an unrelated client edit resaves
  // the true flag rather than a stale default. Kept optional for safety: a
  // future caller that omits it is defaulted by parseCards via `?? false`.
  bill_hourly?: boolean
}

export type ClientInput = {
  id?: string
  name: string
  billing_email: string
  contact_name: string
  phone: string
  address_line1: string
  address_line2: string
  city: string
  state: string
  postal_code: string
  terms_days: number
  notes: string
  archived: boolean
  show_hours_on_invoice: boolean
  cards: CardInput[]
}

type Fail = { error: string }

// Parsed card, ready to write. `id` present means update an existing row;
// absent means insert.
type CardRow = {
  id?: string
  name: string | null
  day_rate_cents: number
  ot_after_hours: number
  travel_rate_cents: number
  pm_rate_cents: number
  dt_after_hours: number | null
  minimum_meal_break_minutes: number
  meal_break_deduction_cap: number
  meal_penalty_grace_hours: number
  meal_penalty_cents: number
  short_turn_rest_hours: number
  continuous_time_enabled: boolean
  bill_hourly: boolean
}

// Same override convention as createShow's overrideCents: undefined or blank
// means "use the default", not zero — parseUSD('') is 0, and a cleared box
// must not silently freeze a $0.00 rate onto the card.
function overrideCents(raw: string | undefined): number | null | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  return parseUSD(raw)
}

/**
 * Validate the card rows from the form. Returns the rows to write, with
 * empty/untouched rows dropped — clearing a card's day rate is how the form
 * deletes it. A second unnamed card is refused here, not just by the
 * database's partial unique index, so the message is readable rather than a
 * raw Postgres unique-violation.
 */
function parseCards(cards: CardInput[]): CardRow[] | Fail {
  const rows: CardRow[] = []
  const seenNames = new Set<string>()

  for (const card of cards) {
    const isDefault = card.name === null
    const trimmedName = card.name?.trim() ?? ''
    const rawRate = card.day_rate.trim()

    if (isDefault) {
      if (rawRate === '') continue // no default card
    } else {
      if (trimmedName === '' && rawRate === '') continue // untouched blank row
      if (trimmedName === '') return { error: 'A named rate card needs a name.' }
      if (rawRate === '') return { error: `"${trimmedName}" needs a day rate.` }
    }

    const label = isDefault ? 'the default rate' : `"${trimmedName}"`
    const cents = parseUSD(rawRate)
    if (cents === null) {
      return { error: `Couldn't read "${card.day_rate}" as a day rate for ${label}. Try something like 780.` }
    }
    if (cents <= 0) return { error: `The day rate for ${label} must be more than zero.` }
    if (!Number.isFinite(card.ot_after_hours) || card.ot_after_hours <= 0) {
      return { error: `Overtime threshold for ${label} must be more than zero hours.` }
    }

    if (!isDefault) {
      const key = trimmedName.toLowerCase()
      if (seenNames.has(key)) return { error: `Two rate cards can't share the name "${trimmedName}".` }
      seenNames.add(key)
    }

    const derived = deriveFromDayRate(cents, card.ot_after_hours)

    const travelOverride = overrideCents(card.travel_rate)
    if (travelOverride === null) {
      return { error: `Couldn't read "${card.travel_rate}" as a travel rate for ${label}.` }
    }
    if (travelOverride !== undefined && travelOverride <= 0) {
      return { error: `The travel rate for ${label} must be more than $0.00 — leave it blank to use half the day rate.` }
    }

    const pmOverride = overrideCents(card.pm_rate)
    if (pmOverride === null) {
      return { error: `Couldn't read "${card.pm_rate}" as a PM rate for ${label}.` }
    }
    if (pmOverride !== undefined && pmOverride <= 0) {
      return { error: `The PM rate for ${label} must be more than $0.00 — leave it blank to use the day rate ÷ OT hours.` }
    }

    // dt_after_hours: empty means "no double time" and must store NULL,
    // never 0 — 0 would mean every hour past clock-in is double time. Same
    // rule as updateShow (app/shows/actions.ts), which this card feeds.
    const dtRaw = card.dt_after_hours.trim()
    let dtAfterHours: number | null = null
    if (dtRaw !== '') {
      const parsed = Number(dtRaw)
      if (!Number.isFinite(parsed)) {
        return { error: `Couldn't read "${card.dt_after_hours}" as a double-time threshold for ${label}.` }
      }
      dtAfterHours = parsed
    }
    if (dtAfterHours !== null && dtAfterHours <= card.ot_after_hours) {
      return { error: `Double time for ${label} must start after the overtime threshold.` }
    }

    if (!Number.isInteger(card.minimum_meal_break_minutes) || card.minimum_meal_break_minutes < 0) {
      return { error: `Minimum meal break for ${label} must be zero minutes or more.` }
    }
    if (!Number.isInteger(card.meal_break_deduction_cap) || card.meal_break_deduction_cap < 0) {
      return { error: `Meal break deduction cap for ${label} must be zero minutes or more.` }
    }
    if (!Number.isFinite(card.meal_penalty_grace_hours) || card.meal_penalty_grace_hours < 0) {
      return { error: `Meal penalty grace for ${label} must be zero hours or more.` }
    }
    if (!Number.isFinite(card.short_turn_rest_hours) || card.short_turn_rest_hours < 0) {
      return { error: `Short-turn rest for ${label} must be zero hours or more.` }
    }

    // meal_penalty_cents at 0 is how billShows derives meal_penalty_enabled:
    // false for a show frozen off this card — that's intended and correct, 0
    // disables the rule rather than meaning "unset". A blank box parses to 0
    // (parseUSD(''): see lib/money.ts), which is exactly that legitimate
    // zero, not the "cleared box" case travel/PM guard against above.
    const mealPenaltyCents = parseUSD(card.meal_penalty)
    if (mealPenaltyCents === null) {
      return { error: `Couldn't read "${card.meal_penalty}" as a meal penalty for ${label}.` }
    }
    if (mealPenaltyCents < 0) return { error: `The meal penalty for ${label} cannot be negative.` }

    rows.push({
      id: card.id,
      name: isDefault ? null : trimmedName,
      day_rate_cents: cents,
      ot_after_hours: card.ot_after_hours,
      travel_rate_cents: travelOverride ?? derived.travel_rate_cents,
      pm_rate_cents: pmOverride ?? derived.pm_rate_cents,
      dt_after_hours: dtAfterHours,
      minimum_meal_break_minutes: card.minimum_meal_break_minutes,
      meal_break_deduction_cap: card.meal_break_deduction_cap,
      meal_penalty_grace_hours: card.meal_penalty_grace_hours,
      meal_penalty_cents: mealPenaltyCents,
      short_turn_rest_hours: card.short_turn_rest_hours,
      continuous_time_enabled: card.continuous_time_enabled,
      // No form field sends this yet — undefined (not sent) becomes the
      // migration's own off-by-default, same as every other rule field's
      // ultimate fallback when a card is created fresh.
      bill_hourly: card.bill_hourly ?? false,
    })
  }

  const defaultCount = rows.filter((r) => r.name === null).length
  if (defaultCount > 1) {
    return { error: 'A client can have only one default (unnamed) rate card.' }
  }
  // A named-only client is exactly the bug this invariant exists to kill:
  // with no default, a single named card looks the same as no card at all to
  // NewShowForm's "more than one card" check, so createShow silently takes
  // that lone named card and its name decorates every line on every invoice
  // — "Day Rate — PM" — even when there was never a choice to make. Refusing
  // here, once, is cheaper than patching every screen that assumes a default
  // exists whenever any card does.
  if (defaultCount === 0 && rows.length > 0) {
    return {
      error: 'A client with any named rate cards also needs a default (unnamed) one — ' +
        'otherwise every invoice line for them would carry a card name like "— PM".',
    }
  }
  return rows
}

export async function saveClient(input: ClientInput): Promise<Fail | { ok: true; id: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  if (!input.name.trim()) return { error: 'A client needs a name.' }

  const cardRows = parseCards(input.cards)
  if ('error' in cardRows) return cardRows

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
    city: input.city.trim() || null,
    state: input.state.trim() || null,
    postal_code: input.postal_code.trim() || null,
    terms_days: input.terms_days,
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

  // Cards are inserted, updated and deleted to match the form: any existing
  // card whose id isn't among the rows we're about to write is gone.
  const { data: existingCards, error: existingError } = await supabase
    .from('client_rate_cards')
    .select('id')
    .eq('client_id', id)
  if (existingError) return { error: existingError.message }

  const keepIds = new Set(cardRows.filter((c) => c.id).map((c) => c.id!))
  const toDelete = (existingCards ?? []).map((c) => c.id).filter((cid) => !keepIds.has(cid))
  if (toDelete.length > 0) {
    const { error: delError } = await supabase.from('client_rate_cards').delete().in('id', toDelete)
    if (delError) return { error: delError.message }
  }

  for (const card of cardRows) {
    const cardValues = {
      name: card.name,
      day_rate_cents: card.day_rate_cents,
      ot_after_hours: card.ot_after_hours,
      travel_rate_cents: card.travel_rate_cents,
      pm_rate_cents: card.pm_rate_cents,
      dt_after_hours: card.dt_after_hours,
      minimum_meal_break_minutes: card.minimum_meal_break_minutes,
      meal_break_deduction_cap: card.meal_break_deduction_cap,
      meal_penalty_grace_hours: card.meal_penalty_grace_hours,
      meal_penalty_cents: card.meal_penalty_cents,
      short_turn_rest_hours: card.short_turn_rest_hours,
      continuous_time_enabled: card.continuous_time_enabled,
      bill_hourly: card.bill_hourly,
    }
    if (card.id) {
      // Scoped to THIS client's id too, not a bare lookup by card id — a
      // caller-supplied card id is only trusted once it's confirmed to
      // belong to the client being saved, the same way createShow and
      // deletePunch derive authorisation from a record's own foreign keys
      // rather than trusting a caller-supplied pair.
      const { error: updError } = await supabase
        .from('client_rate_cards').update(cardValues).eq('id', card.id).eq('client_id', id)
      if (updError) return { error: updError.message }
    } else {
      const { error: insError } = await supabase
        .from('client_rate_cards').insert({ ...cardValues, owner_id: user.id, client_id: id })
      if (insError) return { error: insError.message }
    }
  }

  revalidatePath('/clients')
  revalidatePath(`/clients/${id}`)
  return { ok: true, id: id! }
}
