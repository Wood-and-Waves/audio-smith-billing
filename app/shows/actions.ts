'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { chronologyError, isIncompleteDay } from '@/lib/chronology'
import { parseUSD } from '@/lib/money'
import { todayInChicago, addDays, isPlainDate } from '@/lib/dates'
import {
  computeShowLines, mergeLines, rulesetAndRatesFor, type BucketLine, type PmEntryLike,
} from '@/lib/showBuckets'
import type { ShowDayLike } from '@/lib/payroll'
import type { PunchType } from '@/lib/punchTypes'
import { isKnownTimezone } from '@/lib/timezones'
import { expenseLines, expensesMissingReceipts, type ExpenseLike } from '@/lib/expenses'
import { buildBackupSnapshot, type SnapshotInput } from '@/lib/backupSnapshot'

type Fail = { error: string }

/**
 * Copies one of the client's rate cards onto the show — the whole rate
 * agreement, straight across, with no math at creation time. See migrations
 * 0013 and 0015.
 *
 * A card, not `clients.day_rate_cents` (superseded — nothing reads it any
 * more): Streamline Pictures pays $900 for PwC PM work and $780 for
 * everything else, and every rate and rule the card carries — day, travel
 * and PM rates, the OT/DT thresholds, meal-break and meal-penalty rules,
 * short-turn rest, continuous time — must all come from the SAME card. Dan
 * could already make a $900 show by editing the day rate afterwards, but
 * `updateShow` takes every one of these as an independent raw input and
 * re-derives nothing — so that show silently kept a $780-derived travel rate
 * and PM rate under a $900 day rate. Choosing the right card here, and
 * copying it wholesale, is what fixes that.
 *
 * The rules themselves (OT/DT thresholds, meal rules, short-turn rest,
 * continuous time) are NOT overridable at creation — only day/travel/PM rate
 * and the OT threshold have boxes on New Show, applied on top of the copied
 * values below. Everything else is edited afterwards in "Rates and rules"
 * (updateShow), which is unchanged.
 *
 * Several real clients (Journey Church, Harvest Bible Chapel, Crescent Event
 * Productions, The Orchard Church) are billed ad hoc and have no card at
 * all. Freezing a $0 rate onto the show in that case would let Task 5
 * generate an invoice line reading "Day Rate x1 @ $0.00", so we refuse
 * instead of silently substituting a default.
 */
export async function createShow(input: {
  client_id: string
  name: string
  venue?: string
  /** Free text, "San Diego, CA" — where the show is, for scanning a list.
   *  Separate from venue (the building). Nothing computes on it; see
   *  migration 0017. */
  location?: string
  rate_card_id?: string
  /** IANA zone the show is worked in, e.g. "America/Los_Angeles". Required —
   *  see lib/timezones.ts. A San Diego show silently left on the
   *  DEFAULT_TIMEZONE fallback (America/Chicago) is what this field exists
   *  to stop: the hours would still be right, but every punch read back two
   *  hours off. */
  timezone: string
  /** Optional trip dates. Both or neither — creates the days via
   *  addShowDays below, never a second insert path. */
  start_date?: string
  end_date?: string
  /** Marks the first/last created day as a travel leg (setTravelLeg). Off
   *  unless ticked — travel is a deliberate choice, never automatic, and
   *  either flag is a no-op with no dates to apply it to. */
  travel_in?: boolean
  travel_out?: boolean
  // Raw USD/number input, same shape as UpdateShowInput below. Each is an
  // OVERRIDE of the chosen rate card's own number: undefined or blank means
  // "use the card", not zero — parseUSD("") is 0, and treating a blank box
  // as a deliberate $0 would rebuild the exact bug rate cards exist to
  // prevent (see deriveFromDayRate in lib/rateCards.ts).
  day_rate?: string
  travel_rate?: string
  pm_rate?: string
  ot_after_hours?: string
}): Promise<Fail | { ok: true; id: string; warning?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }
  if (!input.client_id) return { error: 'Choose a client.' }
  if (!input.name.trim()) return { error: 'Give the show a name.' }

  // No default here (contrast updateShow, which trusts an already-validated
  // value on an existing show): a bad or missing zone does not throw, it
  // silently renders every punch in the wrong hour, and that is only
  // noticed later, on an invoice.
  if (!input.timezone) return { error: 'Choose a timezone.' }
  if (!isKnownTimezone(input.timezone)) {
    return { error: `"${input.timezone}" is not a timezone this app offers.` }
  }

  const { data: client } = await supabase
    .from('clients').select('name')
    .eq('id', input.client_id).maybeSingle()

  // Scoped to this client_id, never a bare lookup by id — a caller-supplied
  // rate_card_id is only trusted once it turns up in THIS client's own
  // cards, the same way deleteExpense/deletePunch derive authorisation from
  // a record's own foreign keys rather than trusting a caller-supplied pair.
  const { data: cards } = await supabase
    .from('client_rate_cards')
    .select(`id, name, day_rate_cents, travel_rate_cents, pm_rate_cents, ot_after_hours,
             dt_after_hours, minimum_meal_break_minutes, meal_break_deduction_cap,
             meal_penalty_grace_hours, meal_penalty_cents, short_turn_rest_hours,
             continuous_time_enabled`)
    .eq('client_id', input.client_id)

  if (!cards || cards.length === 0) {
    return {
      error: `${client?.name ?? 'This client'} has no billable day rate on file, so there is no ` +
        'rate card to freeze onto this show.',
    }
  }

  let card: (typeof cards)[number] | undefined
  if (input.rate_card_id) {
    card = cards.find((c) => c.id === input.rate_card_id)
    if (!card) return { error: 'That rate card does not belong to this client.' }
  } else if (cards.length === 1) {
    card = cards[0]
  } else {
    // More than one card and none named: NewShowForm always sends
    // rate_card_id once a client has more than one card, so this only
    // fires if that contract is bypassed — refuse rather than guess.
    card = cards.find((c) => c.name === null)
    if (!card) return { error: 'Choose a rate card for this client.' }
  }

  // An override box that is undefined or blank means "use the card", not
  // zero — parseUSD("") is 0, and a cleared box must not silently freeze a
  // $0.00 rate. Only a box that actually has text in it gets parsed, and
  // only parseUSD's real null (junk, not blank) is refused.
  function overrideCents(raw: string | undefined): number | null | undefined {
    if (raw === undefined || raw.trim() === '') return undefined
    return parseUSD(raw)
  }

  const dayOverride = overrideCents(input.day_rate)
  if (dayOverride === null) return { error: `Couldn't read "${input.day_rate}" as a day rate.` }
  if (dayOverride !== undefined && dayOverride <= 0) {
    return { error: 'Day rate must be more than $0.00 — a show needs a usable rate card.' }
  }
  const day = dayOverride ?? card.day_rate_cents

  const hoursRaw = input.ot_after_hours?.trim()
  let hours: number
  if (hoursRaw) {
    const parsed = Number(hoursRaw)
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return { error: 'Overtime threshold must be more than zero hours.' }
    }
    hours = parsed
  } else {
    hours = Number(card.ot_after_hours ?? 10)
  }

  // Straight copies of the card's OWN stored rates — no re-derivation from
  // the (possibly overridden) day rate above. Task 1 gave the card its own
  // explicit travel_rate_cents/pm_rate_cents (migration 0015), precisely so
  // this no longer has to guess; a card billing a flat $200/leg, or a full
  // day rate for travel, is expressed directly on the card now, not through
  // a switch this function would have to reinterpret.
  //
  // Reject a zero override the same way a zero day rate already is, not
  // just a negative one: overrideCents only returns 0 here if the box
  // genuinely contains "0" (a blank box is `undefined`, filtered out above)
  // — but a $0.00 travel or PM rate is never something Dan means to enter,
  // and lib/showBuckets.ts prints any line with unit_price_cents >= 0
  // straight onto an invoice. This is also the backstop for
  // NewShowForm's onDayRateChange guard: if that client-side check is ever
  // bypassed, a $0 override still can't reach the shows table.
  const travelOverride = overrideCents(input.travel_rate)
  if (travelOverride === null) return { error: `Couldn't read "${input.travel_rate}" as a travel rate.` }
  if (travelOverride !== undefined && travelOverride <= 0) {
    return { error: 'Travel rate must be more than $0.00 — leave it blank to use the rate card.' }
  }
  const travel = travelOverride ?? card.travel_rate_cents

  const pmOverride = overrideCents(input.pm_rate)
  if (pmOverride === null) return { error: `Couldn't read "${input.pm_rate}" as a PM rate.` }
  if (pmOverride !== undefined && pmOverride <= 0) {
    return { error: 'PM rate must be more than $0.00 — leave it blank to use the rate card.' }
  }
  const pm = pmOverride ?? card.pm_rate_cents

  // Validated BEFORE the insert below, even though addShowDays repeats the
  // same checks: its three checks (isPlainDate, ordering, MAX_RANGE_DAYS)
  // need no database and no show id, so there is no reason a bad range
  // ("From 2026-03-10, To 2026-03-01", or a mistyped year like 2062) should
  // ever be allowed to commit a day-less show first and complain after. A
  // genuine error here means nothing has been created yet — refuse
  // outright rather than warn.
  const startDate = input.start_date?.trim()
  const endDate = input.end_date?.trim()
  if (startDate && endDate) {
    const rangeCheck = walkDateRange(startDate, endDate)
    if ('error' in rangeCheck) return rangeCheck
  }

  const { data, error } = await supabase.from('shows').insert({
    owner_id: user.id,
    client_id: input.client_id,
    name: input.name.trim(),
    venue: input.venue?.trim() || null,
    location: input.location?.trim() || null,
    timezone: input.timezone,
    day_rate_cents: day,
    travel_rate_cents: travel,
    pm_rate_cents: pm,
    ot_after_hours: hours,
    // The rules below are copied straight off the card, with no override box
    // on New Show for any of them — they're edited afterwards in "Rates and
    // rules" (updateShow), same as before this change.
    dt_after_hours: card.dt_after_hours,
    minimum_meal_break_minutes: card.minimum_meal_break_minutes,
    meal_break_deduction_cap: card.meal_break_deduction_cap,
    meal_penalty_grace_hours: card.meal_penalty_grace_hours,
    meal_penalty_cents: card.meal_penalty_cents,
    short_turn_rest_hours: card.short_turn_rest_hours,
    continuous_time_enabled: card.continuous_time_enabled,
    // Frozen to the CARD's name regardless of any override above — the card
    // names the arrangement, not the number (see ShowSettings, which prints
    // it as "Frozen from the ... rate card" even once the rates beneath it
    // have been hand-edited).
    rate_card_name: card.name,
  }).select('id').single()

  if (error) return { error: error.message }
  revalidatePath('/shows')

  // Everything below is best-effort on a show that already exists: a
  // failure here is reported as a warning, never as though createShow
  // itself failed — the row is committed and Dan would otherwise be told
  // "it didn't work" about a show he can already see in the list. The date
  // range itself was already validated above, before the insert, so the
  // only way addShowDays fails here is something that genuinely needs the
  // database (e.g. the write itself).
  const warnings: string[] = []
  let daysCreated = false

  if (startDate && endDate) {
    const daysResult = await addShowDays(data.id, startDate, endDate)
    if ('error' in daysResult) {
      warnings.push(`The show was created, but the days could not be added: ${daysResult.error}`)
    } else {
      daysCreated = true
    }
  }

  if (input.travel_in || input.travel_out) {
    if (!daysCreated) {
      warnings.push('Travel legs were not set — no days were added to apply them to.')
    } else {
      const { data: days, error: daysReadError } = await supabase
        .from('show_days').select('id, date').eq('show_id', data.id).order('date')
      // daysCreated is true here, so this readback failing or coming back
      // empty is itself a problem worth a warning — every other failure in
      // this block warns, and silently dropping the leg (first/last both
      // undefined, both `if` branches below just falling through) was the
      // one exception.
      if (!days || days.length === 0) {
        warnings.push(daysReadError
          ? `Travel legs were not set — the show's days could not be read back: ${daysReadError.message}`
          : 'Travel legs were not set — the days that were just created could not be found.')
      } else {
        const first = days[0]
        const last = days[days.length - 1]
        if (input.travel_in) {
          const legResult = await setTravelLeg(first.id, 'in', true)
          if ('error' in legResult) warnings.push(`Travel-in was not set: ${legResult.error}`)
        }
        if (input.travel_out) {
          const legResult = await setTravelLeg(last.id, 'out', true)
          if ('error' in legResult) warnings.push(`Travel-out was not set: ${legResult.error}`)
        }
      }
    }
  }

  return { ok: true, id: data.id, ...(warnings.length ? { warning: warnings.join(' ') } : {}) }
}

const MAX_RANGE_DAYS = 60

/**
 * Walks [startDate, endDate] into a list of plain dates, inclusive, or
 * refuses before returning anything. Pure — no database, no show id — so
 * createShow can run it as a pre-flight before the `shows` insert (see
 * above) and addShowDays (which actually creates the day rows) can run the
 * exact same check, rather than this being a second implementation that
 * could drift out of sync with the first.
 */
function walkDateRange(startDate: string, endDate: string): Fail | { ok: true; dates: string[] } {
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
  return { ok: true, dates }
}

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

  const range = walkDateRange(startDate, endDate)
  if ('error' in range) return range
  const { dates } = range

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
 * Deletes a show and, by cascade, its days, punches, PM log and expenses.
 * This destroys recorded work, so it is refused while the show is billed —
 * unlinking it first (see unlinkShow) is a deliberate second step, not a
 * confirmation dialog.
 *
 * The cascade is real, not assumed: migration 0003 declares
 * show_days.show_id and punches.show_day_id `on delete cascade`, migration
 * 0005 declares pm_entries.show_id `on delete cascade`, and migration 0010
 * declares expenses.show_id `on delete cascade` too — so deleting the
 * `shows` row alone removes all four without an explicit multi-table
 * transaction here.
 *
 * The cascade does NOT reach Storage — a deleted expense row leaves its
 * receipt JPEGs behind in the private bucket with nothing referencing them,
 * silently, forever. So the expenses' receipt paths are read BEFORE the
 * delete (there is nothing left to read them from after), and the files are
 * removed AFTER the row delete, matching the order deleteExpense already
 * uses (app/expenses/actions.ts): row first, then files, so a storage
 * failure orphans a file rather than leaving a row pointing at a deleted one.
 *
 * Both storage-adjacent calls are checked, not swallowed: the show row is
 * genuinely gone either way by the time either could fail, so neither is a
 * reason to report the delete itself as failed — but leaving Dan with no
 * signal at all is exactly the silent orphaning this code exists to prevent.
 * A pre-read failure is the worse case (paths ends up empty and every
 * receipt orphans with zero indication), so it gets the same warning
 * treatment as a failed remove().
 */
export async function deleteShow(showId: string): Promise<Fail | { ok: true; warning?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  // Derive the lock from the row being deleted, not a caller-supplied flag.
  const { data: show } = await supabase.from('shows').select('status').eq('id', showId).maybeSingle()
  if (!show) return { error: 'That show no longer exists.' }
  if (show.status === 'billed') return { error: 'This show is billed. Unlink it before editing.' }

  const { data: expenseRows, error: readError } = await supabase
    .from('expenses').select('receipt_path, receipt_original').eq('show_id', showId)

  const { error } = await supabase.from('shows').delete().eq('id', showId)
  if (error) return { error: error.message }

  revalidatePath('/shows')

  if (readError) {
    return {
      ok: true,
      warning: 'The show was deleted, but its receipt files could not be looked up, so they ' +
        `may be left behind in storage: ${readError.message}`,
    }
  }

  const paths = (expenseRows ?? [])
    .flatMap((e) => [e.receipt_path, e.receipt_original])
    .filter((p): p is string => Boolean(p))
  if (paths.length) {
    const { error: storageError } = await supabase.storage.from('receipts').remove(paths)
    if (storageError) {
      return {
        ok: true,
        warning: 'The show was deleted, but its receipt file' +
          `${paths.length === 1 ? '' : 's'} could not be removed from storage: ${storageError.message}`,
      }
    }
  }

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
    .select(`id, name, client_id, status, timezone,
             day_rate_cents, travel_rate_cents, pm_rate_cents, ot_after_hours,
             dt_after_hours, minimum_meal_break_minutes, meal_break_deduction_cap,
             meal_penalty_grace_hours, meal_penalty_cents, short_turn_rest_hours,
             continuous_time_enabled, rate_card_name,
             show_days(id, date, travel_in, travel_out, pay_as_half_day,
                       punches(punch_type, punched_at)),
             pm_entries(minutes),
             expenses(id, category, where_spent, amount_cents, spent_on, receipt_path)`)
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

  // Every expense has to have a receipt to bill. An expense may be LOGGED
  // without one, because the amount is usually noted before the photograph,
  // but a client must never receive an expense with nothing behind it.
  const receiptless = shows.flatMap((s) => {
    const rows = (s as unknown as { expenses?: ExpenseLike[] }).expenses ?? []
    return expensesMissingReceipts(rows).map((e) => `${e.where_spent} (#${s.name})`)
  })
  if (receiptless.length) {
    return {
      error: `${receiptless.length} ${receiptless.length === 1 ? 'expense needs' : 'expenses need'} ` +
        `a receipt before billing: ${receiptless.join(', ')}.`,
    }
  }

  const perShow: BucketLine[][] = []
  for (const s of shows) {
    const { rules, rates } = rulesetAndRatesFor(s)
    const days = ((s.show_days ?? []) as unknown as ShowDayLike[])
    const pmEntries = ((s.pm_entries ?? []) as unknown as PmEntryLike[])
    perShow.push(computeShowLines(days, pmEntries, rates, rules))
    const expenses = (s as unknown as { expenses?: ExpenseLike[] }).expenses ?? []
    perShow.push(expenseLines(expenses))
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
    .from('clients').select('terms_days, show_hours_on_invoice').eq('id', clientId).maybeSingle()
  const termsDays = clientRow?.terms_days ?? 30

  // Frozen here, from the SAME days and rules that produced the lines above.
  // Deriving it later from the shows would reintroduce exactly the drift this
  // replaces: unlink one show of two and the backup stops matching the charge.
  const backupSnapshot = buildBackupSnapshot({
    showHours: clientRow?.show_hours_on_invoice ?? false,
    shows: shows.map((s) => {
      const { rules } = rulesetAndRatesFor(s)
      return {
        name: s.name,
        timezone: s.timezone,
        days: ((s.show_days ?? []) as unknown as ShowDayLike[]),
        rules,
        expenses: ((s as unknown as { expenses?: ExpenseLike[] }).expenses ?? []),
      } satisfies SnapshotInput
    }),
  })

  const { saveInvoice } = await import('@/app/invoices/actions')
  const issue = todayInChicago()
  // The same string that fills `notes` today, but ALSO frozen onto its own
  // column — work_for — so it survives independently of `notes`. Dan can
  // relabel it afterwards through InvoiceEditor's "For" field (saveInvoice
  // only updates work_for when that field actually sends a value), but this
  // is still the accurate answer for a show-derived invoice on day one,
  // set the moment it's created rather than left for him to fill in by hand.
  const workFor = shows.map((s) => s.name).join(', ')
  const result = await saveInvoice({
    client_id: clientId,
    issue_date: issue,
    terms_days: termsDays,
    deposit_cents: 0,
    notes: workFor,
    work_for: workFor,
    lines: merged,
    backupSnapshot,
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
/**
 * Returns a show to unbilled so its punches can be edited again.
 *
 * Warns first when the invoice has already gone out. Unlinking is how a
 * mistake gets fixed, so it stays allowed — but unlink-then-rebill charges
 * that show's labour AND its expenses a second time, on a second invoice, and
 * both invoices are internally consistent so nothing looks wrong.
 *
 * That used to be self-announcing: before the backup was frozen, the old
 * invoice's expense itemisation re-derived live and visibly stopped matching
 * its own page 1. Freezing the snapshot removed that symptom without removing
 * the problem, so the warning has to be deliberate now.
 */
export async function unlinkShow(
  showId: string, confirmed = false,
): Promise<Fail | { ok: true } | { needsConfirm: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  if (!confirmed) {
    // Read through the show's OWN foreign key rather than trusting a caller to
    // say which invoice this is — the same rule deletePunch and deleteExpense
    // already follow.
    const { data: show } = await supabase
      .from('shows').select('name, invoices(number, status)').eq('id', showId).maybeSingle()
    const invoice = (show as unknown as {
      invoices: { number: number; status: string } | null
    } | null)?.invoices

    if (invoice && (invoice.status === 'sent' || invoice.status === 'paid')) {
      const state = invoice.status === 'paid' ? 'already been paid' : 'already been sent'
      return {
        needsConfirm:
          `Invoice #${invoice.number} has ${state}. Unlinking this show does not change that ` +
          `invoice — it stays as it went out. But billing the show again will charge its days ` +
          `and expenses a second time, on a second invoice. Unlink anyway?`,
      }
    }
  }

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
  /** Free text, "San Diego, CA" — where the show is, for scanning a list.
   *  Separate from venue (the building). Nothing computes on it; see
   *  migration 0017. */
  location: string
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
    location: input.location.trim() || null,
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
