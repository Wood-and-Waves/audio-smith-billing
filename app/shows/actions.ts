'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { chronologyError } from '@/lib/chronology'
import { travelRateFrom, overtimeRateFrom, doubleTimeRateFrom } from '@/lib/money'
import { todayInChicago } from '@/lib/dates'
import { computeShowLines, mergeLines, type ShowRates, type BucketLine } from '@/lib/showBuckets'
import type { ShowDayLike, ShowRuleset } from '@/lib/payroll'
import type { PunchType, DayType } from '@/lib/punchTypes'

type Fail = { error: string }

/**
 * Copies the client's rate card onto the show. See migration 0003.
 *
 * Several real clients (Journey Church, Harvest Bible Chapel, Crescent Event
 * Productions, The Orchard Church) are billed ad hoc and have no day rate on
 * file — `day_rate_cents` is NULL. Freezing 0 onto the show in that case
 * would let Task 5 generate an invoice line reading "Day Rate x1 @ $0.00",
 * so we refuse instead of silently substituting a default.
 */
export async function createShow(input: {
  client_id: string; name: string; venue?: string
}): Promise<Fail | { ok: true; id: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }
  if (!input.client_id) return { error: 'Choose a client.' }
  if (!input.name.trim()) return { error: 'Give the show a name.' }

  const { data: client } = await supabase
    .from('clients').select('name, day_rate_cents, ot_after_hours')
    .eq('id', input.client_id).maybeSingle()

  if (client?.day_rate_cents == null) {
    return {
      error: `${client?.name ?? 'This client'} has no day rate on file, so there is no rate ` +
        'card to freeze onto this show.',
    }
  }

  const day = client.day_rate_cents
  const hours = Number(client.ot_after_hours ?? 10)

  const { data, error } = await supabase.from('shows').insert({
    owner_id: user.id,
    client_id: input.client_id,
    name: input.name.trim(),
    venue: input.venue?.trim() || null,
    day_rate_cents: day,
    travel_rate_cents: travelRateFrom(day),
    pm_rate_cents: hours > 0 ? Math.round(day / hours) : 0,
    ot_after_hours: hours,
  }).select('id').single()

  if (error) return { error: error.message }
  revalidatePath('/shows')
  return { ok: true, id: data.id }
}

export async function addShowDay(
  showId: string, date: string, dayType: DayType,
): Promise<Fail | { ok: true; id: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  const { data: show } = await supabase.from('shows').select('status').eq('id', showId).maybeSingle()
  if (show?.status === 'billed') return { error: 'This show is billed. Unlink it before editing.' }

  const { data, error } = await supabase.from('show_days')
    .insert({ owner_id: user.id, show_id: showId, date, day_type: dayType })
    .select('id').single()
  if (error) return { error: error.message }
  revalidatePath(`/shows/${showId}`)
  return { ok: true, id: data.id }
}

export async function recordPunch(
  showDayId: string, type: PunchType, at: string,
): Promise<Fail | { ok: true }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  const { data: day } = await supabase.from('show_days')
    .select('show_id, shows(status), punches(punch_type, punched_at)')
    .eq('id', showDayId).maybeSingle()
  if (!day) return { error: 'That day no longer exists.' }

  const status = (day as unknown as { shows: { status: string } }).shows?.status
  if (status === 'billed') return { error: 'This show is billed. Unlink it before editing.' }

  const existing = (day as unknown as { punches: { punch_type: string; punched_at: string }[] }).punches ?? []
  const problem = chronologyError(type, at, existing)
  if (problem) return { error: problem }

  const { error } = await supabase.from('punches')
    .insert({ owner_id: user.id, show_day_id: showDayId, punch_type: type, punched_at: at })
  if (error) return { error: error.message }

  revalidatePath(`/shows/${(day as unknown as { show_id: string }).show_id}`)
  return { ok: true }
}

export async function deletePunch(punchId: string, showId: string): Promise<Fail | { ok: true }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  // Do NOT trust the caller-supplied `showId` for the lock decision: a
  // punch belongs to whichever show its own show_day points at, which may
  // not be the show the caller named. Deriving status from an unrelated
  // (open) show would let a billed show's punches be deleted anyway. Walk
  // the punch's own foreign keys instead: punches.show_day_id -> show_days,
  // show_days.show_id -> shows.
  const { data: punch } = await supabase
    .from('punches')
    .select('show_day_id, show_days(show_id, shows(status))')
    .eq('id', punchId).maybeSingle()
  if (!punch) return { error: 'That punch no longer exists.' }

  const showDay = (punch as unknown as { show_days: { show_id: string; shows: { status: string } } }).show_days
  if (showDay?.shows?.status === 'billed') {
    return { error: 'This show is billed. Unlink it before editing.' }
  }

  const derivedShowId = showDay?.show_id ?? showId
  const { error } = await supabase.from('punches').delete().eq('id', punchId)
  if (error) return { error: error.message }
  revalidatePath(`/shows/${derivedShowId}`)
  return { ok: true }
}

/**
 * Generates a DRAFT invoice from one or more unbilled shows for the same
 * client, then locks those shows. The lines are a snapshot: editing punches
 * afterwards cannot change an invoice a client already holds.
 */
export async function billShows(showIds: string[]): Promise<Fail | { ok: true; invoiceId: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }
  if (showIds.length === 0) return { error: 'Select at least one show.' }

  const { data: shows, error } = await supabase
    .from('shows')
    .select(`id, name, client_id, status,
             day_rate_cents, travel_rate_cents, pm_rate_cents, ot_after_hours,
             dt_after_hours, minimum_meal_break_minutes, meal_break_deduction_cap,
             meal_penalty_grace_hours, meal_penalty_cents, short_turn_rest_hours,
             continuous_time_enabled,
             show_days(id, date, day_type, pay_as_half_day, punches(punch_type, punched_at))`)
    .in('id', showIds)
  if (error) return { error: error.message }
  if (!shows?.length) return { error: 'Those shows no longer exist.' }

  if (shows.some((s) => s.status === 'billed')) return { error: 'One of those shows is already billed.' }
  const clientId = shows[0].client_id
  if (shows.some((s) => s.client_id !== clientId)) {
    return { error: 'All shows on one invoice must be for the same client.' }
  }

  // An incomplete day would silently bill zero hours, so refuse instead.
  for (const s of shows) {
    for (const d of (s.show_days ?? []) as { date: string; day_type: string; punches: { punch_type: string }[] }[]) {
      if (d.day_type === 'travel') continue
      const types = new Set(d.punches.map((p) => p.punch_type))
      if (types.has('start') !== types.has('end')) {
        return { error: `${s.name}: ${d.date} has an unfinished punch. Complete or remove it first.` }
      }
    }
  }

  const perShow: BucketLine[][] = []
  for (const s of shows) {
    const hours = Number(s.ot_after_hours)
    const rules: ShowRuleset = {
      overtime_after_hours: hours,
      double_time_enabled: s.dt_after_hours != null,
      double_time_after_hours: Number(s.dt_after_hours ?? 12),
      meal_penalty_enabled: s.meal_penalty_cents > 0,
      meal_penalty_grace_hours: Number(s.meal_penalty_grace_hours),
      minimum_meal_break_enabled: s.minimum_meal_break_minutes > 0,
      minimum_meal_break_minutes: s.minimum_meal_break_minutes,
      meal_break_deduction_cap: s.meal_break_deduction_cap,
      short_turn_penalty_enabled: true,
      short_turn_rest_hours: Number(s.short_turn_rest_hours),
      continuous_time_enabled: s.continuous_time_enabled,
    }
    const rates: ShowRates = {
      day_rate_cents: s.day_rate_cents,
      travel_rate_cents: s.travel_rate_cents,
      pm_rate_cents: s.pm_rate_cents,
      ot_rate_cents: overtimeRateFrom(s.day_rate_cents, hours),
      dt_rate_cents: doubleTimeRateFrom(s.day_rate_cents, hours),
      meal_penalty_cents: s.meal_penalty_cents,
    }
    const days = ((s.show_days ?? []) as unknown as ShowDayLike[])
    perShow.push(computeShowLines(days, rates, rules))
  }
  const merged = mergeLines(perShow)

  if (merged.length === 0) return { error: 'Nothing to bill — those shows have no completed days.' }

  const { saveInvoice } = await import('@/app/invoices/actions')
  const issue = todayInChicago()
  const result = await saveInvoice({
    client_id: clientId,
    issue_date: issue,
    terms_days: 30,
    deposit_cents: 0,
    tax_bp: 0,
    notes: shows.map((s) => s.name).join(', '),
    lines: merged,
  })
  if ('error' in result) return result

  const { error: linkError } = await supabase
    .from('shows')
    .update({ status: 'billed', invoice_id: result.id })
    .in('id', showIds)
  if (linkError) return { error: linkError.message }

  revalidatePath('/shows')
  revalidatePath('/invoices')
  return { ok: true, invoiceId: result.id }
}

/** Returns a show to unbilled so its punches can be edited again. */
export async function unlinkShow(showId: string): Promise<Fail | { ok: true }> {
  const supabase = await createClient()
  const { error } = await supabase
    .from('shows').update({ status: 'open', invoice_id: null }).eq('id', showId)
  if (error) return { error: error.message }
  revalidatePath('/shows')
  revalidatePath(`/shows/${showId}`)
  return { ok: true }
}
