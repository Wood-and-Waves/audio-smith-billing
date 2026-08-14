'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { chronologyError, isIncompleteDay } from '@/lib/chronology'
import { travelRateFrom, parseUSD } from '@/lib/money'
import { todayInChicago, addDays, isPlainDate } from '@/lib/dates'
import {
  computeShowLines, mergeLines, rulesetAndRatesFor, type BucketLine, type PmEntryLike,
} from '@/lib/showBuckets'
import type { ShowDayLike } from '@/lib/payroll'
import type { PunchType } from '@/lib/punchTypes'
import { isKnownTimezone } from '@/lib/timezones'

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

  if (client?.day_rate_cents == null || client.day_rate_cents <= 0) {
    return {
      error: `${client?.name ?? 'This client'} has no billable day rate on file, so there is no ` +
        'rate card to freeze onto this show.',
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

const MAX_RANGE_DAYS = 60

/**
 * Creates a day per date across [startDate, endDate], inclusive. Dates that
 * already exist for this show are SKIPPED, not errors: re-running an
 * overlapping range (e.g. adding a trip that already had its first two days
 * entered) must not fail halfway through and leave a partial trip behind.
 */
export async function addShowDays(
  showId: string, startDate: string, endDate: string,
): Promise<Fail | { ok: true; created: number; skipped: number }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  const { data: show } = await supabase.from('shows').select('status').eq('id', showId).maybeSingle()
  if (!show) return { error: 'That show no longer exists.' }
  if (show.status === 'billed') return { error: 'This show is billed. Unlink it before editing.' }

  // Before any date arithmetic: a cleared date input submits "", and addDays("")
  // throws rather than returning, which would surface as a crash instead of this
  // message.
  if (!isPlainDate(startDate) || !isPlainDate(endDate)) {
    return { error: 'Enter both a start and an end date.' }
  }

  if (endDate < startDate) return { error: 'End date must be on or after the start date.' }

  // Walk the range with addDays, never new Date() arithmetic (see
  // lib/dates.ts) — a plain date pushed through local time shifts a day
  // west of UTC. Bail as soon as the count crosses the cap rather than
  // building the full list first: a mistyped year (2026 -> 2062) would
  // otherwise walk tens of thousands of dates before we ever check.
  const dates: string[] = []
  let cursor = startDate
  while (cursor <= endDate) {
    dates.push(cursor)
    if (dates.length > MAX_RANGE_DAYS) {
      return { error: `That range is more than ${MAX_RANGE_DAYS} days — check the dates.` }
    }
    cursor = addDays(cursor, 1)
  }

  const { data: existingRows, error: existingError } = await supabase
    .from('show_days').select('date').eq('show_id', showId).in('date', dates)
  if (existingError) return { error: existingError.message }
  const existing = new Set((existingRows ?? []).map((r) => r.date as string))

  const toInsert = dates.filter((d) => !existing.has(d))
  const skipped = dates.length - toInsert.length
  if (toInsert.length === 0) return { ok: true, created: 0, skipped }

  const { error } = await supabase.from('show_days')
    .insert(toInsert.map((date) => ({ owner_id: user.id, show_id: showId, date })))
  if (error) return { error: error.message }

  revalidatePath(`/shows/${showId}`)
  return { ok: true, created: toInsert.length, skipped }
}

/**
 * Sets or clears one travel leg on a day. Travel is a flag on a day, not a
 * day type (migration 0005) — a day can be flown-in AND worked the same day.
 */
export async function setTravelLeg(
  showDayId: string, leg: 'in' | 'out', value: boolean,
): Promise<Fail | { ok: true }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  // Walk the day's own foreign keys for the lock, the same way
  // setDayHalfDay/deletePunch do: show_days.show_id -> shows.status. Never
  // trust a caller-supplied id for the lock decision.
  const { data: day } = await supabase
    .from('show_days').select('show_id, shows(status)').eq('id', showDayId).maybeSingle()
  if (!day) return { error: 'That day no longer exists.' }

  const status = (day as unknown as { shows: { status: string } }).shows?.status
  if (status === 'billed') return { error: 'This show is billed. Unlink it before editing.' }

  const column = leg === 'in' ? 'travel_in' : 'travel_out'
  const { error } = await supabase.from('show_days')
    .update({ [column]: value }).eq('id', showDayId)
  if (error) return { error: error.message }

  revalidatePath(`/shows/${(day as unknown as { show_id: string }).show_id}`)
  return { ok: true }
}

const PM_MAX_MINUTES = 1440 // 24h fat-finger guard

/** Logs a piece of prep work. See migration 0005: PM is a duration log, not a punched day. */
export async function addPmEntry(
  showId: string, workedOn: string, minutes: number, note: string,
): Promise<Fail | { ok: true; id: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  const { data: show } = await supabase.from('shows').select('status').eq('id', showId).maybeSingle()
  if (!show) return { error: 'That show no longer exists.' }
  if (show.status === 'billed') return { error: 'This show is billed. Unlink it before editing.' }

  if (!isPlainDate(workedOn)) return { error: 'Pick the date you did the work.' }

  // The UI offers 15-minute presets, but the action is the boundary that
  // actually has to hold — a value typed straight into a request cannot
  // slip through.
  if (!Number.isInteger(minutes) || minutes <= 0 || minutes % 15 !== 0) {
    return { error: 'PM time must be a positive multiple of 15 minutes.' }
  }
  if (minutes > PM_MAX_MINUTES) {
    return { error: 'A single PM entry cannot exceed 24 hours (1440 minutes) — check for a typo.' }
  }

  const { data, error } = await supabase.from('pm_entries')
    .insert({ owner_id: user.id, show_id: showId, worked_on: workedOn, minutes, note: note.trim() || null })
    .select('id').single()
  if (error) return { error: error.message }

  revalidatePath(`/shows/${showId}`)
  return { ok: true, id: data.id }
}

export async function deletePmEntry(pmEntryId: string): Promise<Fail | { ok: true }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  // Derive the lock from the entry's own show_id, never a caller-supplied one.
  const { data: entry } = await supabase
    .from('pm_entries').select('show_id, shows(status)').eq('id', pmEntryId).maybeSingle()
  if (!entry) return { error: 'That entry no longer exists.' }

  const status = (entry as unknown as { shows: { status: string } }).shows?.status
  if (status === 'billed') return { error: 'This show is billed. Unlink it before editing.' }

  const showId = (entry as unknown as { show_id: string }).show_id
  const { error } = await supabase.from('pm_entries').delete().eq('id', pmEntryId)
  if (error) return { error: error.message }

  revalidatePath(`/shows/${showId}`)
  return { ok: true }
}

/**
 * Deletes a show and, by cascade, its days, punches and PM log. This
 * destroys recorded work, so it is refused while the show is billed —
 * unlinking it first (see unlinkShow) is a deliberate second step, not a
 * confirmation dialog.
 *
 * The cascade is real, not assumed: migration 0003 declares
 * show_days.show_id and punches.show_day_id `on delete cascade`, and
 * migration 0005 declares pm_entries.show_id `on delete cascade` too — so
 * deleting the `shows` row alone removes all three without an explicit
 * multi-table transaction here.
 */
export async function deleteShow(showId: string): Promise<Fail | { ok: true }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  // Derive the lock from the row being deleted, not a caller-supplied flag.
  const { data: show } = await supabase.from('shows').select('status').eq('id', showId).maybeSingle()
  if (!show) return { error: 'That show no longer exists.' }
  if (show.status === 'billed') return { error: 'This show is billed. Unlink it before editing.' }

  const { error } = await supabase.from('shows').delete().eq('id', showId)
  if (error) return { error: error.message }

  revalidatePath('/shows')
  return { ok: true }
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
             show_days(id, date, travel_in, travel_out, pay_as_half_day,
                       punches(punch_type, punched_at)),
             pm_entries(minutes)`)
    .in('id', showIds)
  if (error) return { error: error.message }
  if (!shows?.length) return { error: 'Those shows no longer exist.' }

  if (shows.some((s) => s.status === 'billed')) return { error: 'One of those shows is already billed.' }
  const clientId = shows[0].client_id
  if (shows.some((s) => s.client_id !== clientId)) {
    return { error: 'All shows on one invoice must be for the same client.' }
  }

  // An incomplete day would silently bill zero hours — or, for an unpaired
  // meal punch, silently bill the break as worked time — so refuse instead.
  // Every show_days row is a work day now (migration 0005 dropped
  // day_type); a day with no punches at all is simply not incomplete
  // (isIncompleteDay only flags an unpaired start/end or meal), so there is
  // no "skip travel days" case to carve out any more.
  for (const s of shows) {
    for (const d of (s.show_days ?? []) as { date: string; punches: { punch_type: string }[] }[]) {
      if (isIncompleteDay(d.punches)) {
        return { error: `${s.name}: ${d.date} has an unfinished punch. Complete or remove it first.` }
      }
    }
  }

  const perShow: BucketLine[][] = []
  for (const s of shows) {
    const { rules, rates } = rulesetAndRatesFor(s)
    const days = ((s.show_days ?? []) as unknown as ShowDayLike[])
    const pmEntries = ((s.pm_entries ?? []) as unknown as PmEntryLike[])
    perShow.push(computeShowLines(days, pmEntries, rates, rules))
  }
  // Merge same-description/same-price lines across shows BEFORE rounding
  // each to cents (mergeLines, then lineTotal inside saveInvoice) — never
  // sum each show's already-rounded total. round(a) + round(b) is not
  // always round(a + b), and the multi-show preview in UnbilledShows.tsx
  // calls this same mergeLines-before-rounding order so it can never
  // disagree with the invoice created here.
  const merged = mergeLines(perShow)

  if (merged.length === 0) return { error: 'Nothing to bill — those shows have no completed days.' }

  // Terms must match what a client invoiced through InvoiceEditor would get:
  // InvoiceEditor always overwrites its terms field with the chosen client's
  // own terms_days (see the client <select> onChange there), so
  // client.terms_days takes precedence here too. There is no tax to look up
  // any more — saveInvoice hardcodes tax to zero for every invoice.
  const { data: clientRow } = await supabase
    .from('clients').select('terms_days').eq('id', clientId).maybeSingle()
  const termsDays = clientRow?.terms_days ?? 30

  const { saveInvoice } = await import('@/app/invoices/actions')
  const issue = todayInChicago()
  const result = await saveInvoice({
    client_id: clientId,
    issue_date: issue,
    terms_days: termsDays,
    deposit_cents: 0,
    notes: shows.map((s) => s.name).join(', '),
    lines: merged,
  })
  if ('error' in result) return result

  // saveInvoice only hands back the id, but the error messages below need
  // to point the user at the invoice by the number they'll actually see.
  const { data: invoiceRow } = await supabase
    .from('invoices').select('number').eq('id', result.id).maybeSingle()
  const invoiceNumber = invoiceRow?.number ?? result.id

  // The `.eq('status', 'open')` below — not the `shows.some(status ===
  // 'billed')` check earlier — is what actually prevents a double-click (or
  // any two overlapping calls) from billing the same shows twice. Both
  // calls can pass that earlier read-time check before either has written
  // anything; only one update can flip a given row from 'open' to 'billed'.
  // Whichever call's update touches fewer rows than it asked for lost the
  // race and must say so instead of reporting success.
  const { data: linked, error: linkError } = await supabase
    .from('shows')
    .update({ status: 'billed', invoice_id: result.id })
    .in('id', showIds)
    .eq('status', 'open')
    .select('id')

  if (linkError) {
    // The invoice already consumed a number; don't try to auto-delete a
    // financial record. Tell the user exactly what happened instead.
    return {
      error: `Draft invoice #${invoiceNumber} was created but could not be linked to these ` +
        `shows (${linkError.message}). Review or delete that draft invoice manually.`,
    }
  }

  if (!linked || linked.length < showIds.length) {
    return {
      error: `These shows were already billed by another action. Draft invoice #${invoiceNumber} ` +
        'was created but is not linked to any shows — find and delete it manually.',
    }
  }

  revalidatePath('/shows')
  revalidatePath('/invoices')
  return { ok: true, invoiceId: result.id }
}

/** Returns a show to unbilled so its punches can be edited again. */
export async function unlinkShow(showId: string): Promise<Fail | { ok: true }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  const { data, error } = await supabase
    .from('shows').update({ status: 'open', invoice_id: null }).eq('id', showId)
    .select('id')
  if (error) return { error: error.message }
  if (!data || data.length === 0) return { error: 'That show could not be unlinked.' }

  revalidatePath('/shows')
  revalidatePath(`/shows/${showId}`)
  return { ok: true }
}

export type UpdateShowInput = {
  id: string
  name: string
  venue: string
  notes: string
  day_rate: string             // raw USD input, e.g. "780" or "$780.00"
  travel_rate: string          // raw USD input
  pm_rate: string               // raw USD input
  ot_after_hours: number
  // Raw string, not a number: an empty box must become NULL ("no double
  // time"), and Number('') is 0 — which would mean "every hour is double
  // time" instead. Keep this a string all the way to the parse below so
  // "nothing entered" and "entered zero" stay distinguishable.
  dt_after_hours: string
  minimum_meal_break_minutes: number
  meal_break_deduction_cap: number
  meal_penalty_grace_hours: number
  meal_penalty: string          // raw USD input; 0/"" -> meal penalties disabled (see billShows)
  short_turn_rest_hours: number
  /** IANA zone the show is worked in. Punch times are rendered in it. */
  timezone: string
  continuous_time_enabled: boolean
}

/**
 * Edits the rate card and rules a show already froze onto itself at
 * `createShow` time (migration 0003). This is the only path that can ever
 * turn on double time, meal penalties, or half-days for a show after the
 * fact, so every check here is load-bearing — get one wrong and an invoice
 * is wrong.
 */
export async function updateShow(input: UpdateShowInput): Promise<Fail | { ok: true }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  // Derive the lock from the row being touched, never trust a caller flag.
  const { data: show } = await supabase.from('shows').select('status').eq('id', input.id).maybeSingle()
  if (!show) return { error: 'That show no longer exists.' }
  if (show.status === 'billed') return { error: 'This show is billed. Unlink it before editing.' }

  if (!input.name.trim()) return { error: 'Give the show a name.' }

  // Money fields: parseUSD returns null on junk and 0 on empty input. These
  // columns are NOT NULL (default 0) on `shows`, so an empty box is a
  // legitimate zero, not "leave unset" — only reject text that doesn't parse.
  const dayRate = parseUSD(input.day_rate)
  if (dayRate === null) return { error: `Couldn't read "${input.day_rate}" as a day rate.` }
  // A show must always carry a usable rate card — that is the point of
  // freezing one at creation (see createShow above). A day rate of $0.00
  // would let computeShowLines emit a real "Day Rate x1 @ $0.00" line (and
  // zero the derived OT/DT rates), billing nothing for a day that was worked.
  if (dayRate <= 0) return { error: 'Day rate must be more than $0.00 — a show needs a usable rate card.' }

  const travelRate = parseUSD(input.travel_rate)
  if (travelRate === null) return { error: `Couldn't read "${input.travel_rate}" as a travel rate.` }
  if (travelRate < 0) return { error: 'Travel rate cannot be negative.' }

  const pmRate = parseUSD(input.pm_rate)
  if (pmRate === null) return { error: `Couldn't read "${input.pm_rate}" as a PM rate.` }
  if (pmRate < 0) return { error: 'PM rate cannot be negative.' }

  // meal_penalty_cents at 0 is how billShows derives meal_penalty_enabled:
  // false. That's intended and correct — 0 disables the rule, it does not
  // mean "unset". Do not special-case it into null.
  const mealPenaltyCents = parseUSD(input.meal_penalty)
  if (mealPenaltyCents === null) return { error: `Couldn't read "${input.meal_penalty}" as a meal penalty.` }
  if (mealPenaltyCents < 0) return { error: 'Meal penalty cannot be negative.' }

  // ot_after_hours is the divisor for both the PM and overtime rates
  // (lib/money.ts overtimeRateFrom/doubleTimeRateFrom); zero yields Infinity.
  if (!Number.isFinite(input.ot_after_hours) || input.ot_after_hours <= 0) {
    return { error: 'Overtime threshold must be more than zero hours.' }
  }

  // dt_after_hours: empty means "no double time" and must store NULL, never
  // 0 — 0 would mean every hour past clock-in is double time.
  const dtRaw = input.dt_after_hours.trim()
  let dtAfterHours: number | null = null
  if (dtRaw !== '') {
    const parsed = Number(dtRaw)
    if (!Number.isFinite(parsed)) {
      return { error: `Couldn't read "${input.dt_after_hours}" as a double-time threshold.` }
    }
    dtAfterHours = parsed
  }
  // Double time starting at or before overtime is incoherent.
  if (dtAfterHours !== null && dtAfterHours <= input.ot_after_hours) {
    return { error: 'Double time must start after the overtime threshold.' }
  }

  if (!Number.isInteger(input.minimum_meal_break_minutes) || input.minimum_meal_break_minutes < 0) {
    return { error: 'Minimum meal break must be zero minutes or more.' }
  }
  if (!Number.isInteger(input.meal_break_deduction_cap) || input.meal_break_deduction_cap < 0) {
    return { error: 'Meal break deduction cap must be zero minutes or more.' }
  }
  if (!Number.isFinite(input.meal_penalty_grace_hours) || input.meal_penalty_grace_hours < 0) {
    return { error: 'Meal penalty grace period must be zero hours or more.' }
  }
  if (!Number.isFinite(input.short_turn_rest_hours) || input.short_turn_rest_hours < 0) {
    return { error: 'Short-turn rest hours must be zero or more.' }
  }

  // A bad zone does not throw — it silently renders every punch an hour or
  // three out, which is only noticed later, on an invoice.
  if (!isKnownTimezone(input.timezone)) {
    return { error: `"${input.timezone}" is not a timezone this app offers.` }
  }

  const { error } = await supabase.from('shows').update({
    name: input.name.trim(),
    venue: input.venue.trim() || null,
    notes: input.notes.trim() || null,
    day_rate_cents: dayRate,
    travel_rate_cents: travelRate,
    pm_rate_cents: pmRate,
    ot_after_hours: input.ot_after_hours,
    dt_after_hours: dtAfterHours,
    minimum_meal_break_minutes: input.minimum_meal_break_minutes,
    meal_break_deduction_cap: input.meal_break_deduction_cap,
    meal_penalty_grace_hours: input.meal_penalty_grace_hours,
    meal_penalty_cents: mealPenaltyCents,
    short_turn_rest_hours: input.short_turn_rest_hours,
    continuous_time_enabled: input.continuous_time_enabled,
    timezone: input.timezone,
  }).eq('id', input.id)
  if (error) return { error: error.message }

  revalidatePath(`/shows/${input.id}`)
  revalidatePath('/shows')
  return { ok: true }
}

/**
 * Half-day is a negotiated call, not a computed one — see the UI in
 * app/shows/[id]/page.tsx, which only offers the toggle under 5 net hours
 * but always honours a stored value regardless of hours.
 */
export async function setDayHalfDay(showDayId: string, value: boolean): Promise<Fail | { ok: true }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  // Walk the day's own foreign keys for the lock, the same way deletePunch
  // does for a punch: show_days.show_id -> shows.status. Never trust a
  // caller-supplied id for the lock decision.
  const { data: day } = await supabase
    .from('show_days').select('show_id, shows(status)').eq('id', showDayId).maybeSingle()
  if (!day) return { error: 'That day no longer exists.' }

  const status = (day as unknown as { shows: { status: string } }).shows?.status
  if (status === 'billed') return { error: 'This show is billed. Unlink it before editing.' }

  const { error } = await supabase.from('show_days')
    .update({ pay_as_half_day: value }).eq('id', showDayId)
  if (error) return { error: error.message }

  revalidatePath(`/shows/${(day as unknown as { show_id: string }).show_id}`)
  return { ok: true }
}

export async function deleteShowDay(showDayId: string): Promise<Fail | { ok: true }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  // Same pattern as setDayHalfDay/deletePunch: derive the lock from the row
  // being deleted, not from a caller-supplied id.
  const { data: day } = await supabase
    .from('show_days').select('show_id, shows(status)').eq('id', showDayId).maybeSingle()
  if (!day) return { error: 'That day no longer exists.' }

  const status = (day as unknown as { shows: { status: string } }).shows?.status
  if (status === 'billed') return { error: 'This show is billed. Unlink it before editing.' }

  const showId = (day as unknown as { show_id: string }).show_id
  const { error } = await supabase.from('show_days').delete().eq('id', showDayId)
  if (error) return { error: error.message }

  revalidatePath(`/shows/${showId}`)
  return { ok: true }
}
