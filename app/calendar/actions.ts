'use server'

// This file is the only place `aerodatabox.p.rapidapi.com` gets called. The
// client never talks to the provider directly, and FLIGHT_API_KEY never
// leaves the server — it is read once, here, from process.env. Response
// parsing itself lives in lib/flightLookup.ts (Task 3) so a future provider
// swap touches one pure file; this file's job is narrower: validate the two
// inputs BEFORE either reaches a URL, make the one HTTP call inside a bounded
// timeout, and translate whatever comes back — a timeout, a network failure,
// a 404, any other non-OK status, or a malformed body — into one of two
// friendly messages. The provider's own response text is never read into an
// error returned to the client: an outage notice, a rate-limit message, an
// HTML error page, none of it crosses this boundary.

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { isPlainDate } from '@/lib/dates'
import { normalizeFlightNo, parseAeroDataBox, type CandidateLeg } from '@/lib/flightLookup'

type Fail = { error: string }

const PROVIDER_HOST = 'aerodatabox.p.rapidapi.com'
const LOOKUP_TIMEOUT_MS = 10_000

// Mirrors lib/flightLookup.ts's own NOT_FOUND text (not exported — a
// deliberately tiny, private constant there) so a provider 404 and a
// provider 200-with-empty-array read as the identical message to Dan;
// they are the same fact told two different ways by the API.
const NO_FLIGHT: Fail = { error: 'No flight found for that number and date.' }
const UNAVAILABLE: Fail = { error: 'Flight lookup is unavailable right now — enter the times by hand.' }

/**
 * Looks up one flight's schedule from AeroDataBox — the only network call
 * this app makes to a third party at request time, and the only action in
 * this file that never writes. Dan types a flight number and date; on
 * success the UI fills an editable form from the first candidate leg; on
 * ANY failure — bad input, no key configured yet, the provider down or
 * slow, no such flight — the same form stays open for hand entry. That is
 * why every failure path here reads "enter the times by hand": a lookup
 * miss degrades the feature, it never blocks saving a flight.
 *
 * `no` and `date` are validated to the exact shapes `normalizeFlightNo`
 * and `isPlainDate` enforce BEFORE either value is spliced into the
 * request URL. `no` is guaranteed `[A-Z0-9]{2,8}` and `date` has already
 * round-tripped through `isPlainDate`, so building the URL by
 * interpolation below is safe — nothing untrusted reaches it.
 */
export async function lookupFlight(
  input: { flightNo: string; date: string },
): Promise<Fail | { ok: true; candidates: CandidateLeg[] }> {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError) return { error: authError.message }
  if (!user) return { error: 'Not signed in.' }

  const no = normalizeFlightNo(input.flightNo)
  if (!no) return { error: 'Enter a valid flight number, like AA1234.' }
  if (!isPlainDate(input.date)) return { error: 'Enter a valid flight date.' }

  const key = process.env.FLIGHT_API_KEY
  if (!key) return { error: 'Flight lookup is not set up yet — enter the times by hand.' }

  const url = `https://${PROVIDER_HOST}/flights/number/${no}/${input.date}`

  let json: unknown
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS)
    let response: Response
    try {
      response = await fetch(url, {
        headers: { 'X-RapidAPI-Key': key, 'X-RapidAPI-Host': PROVIDER_HOST },
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }

    if (!response.ok) {
      // The response body is never read here on a non-OK status — quota
      // text, an HTML error page, a RapidAPI outage notice, whatever it
      // is, it stays on the server. A 404 means no such flight for that
      // number and date; anything else (401 bad key, 429 rate limit, a
      // 5xx) is indistinguishable from "unavailable" to Dan, who cannot
      // act on the difference either way.
      return response.status === 404 ? NO_FLIGHT : UNAVAILABLE
    }
    json = await response.json()
  } catch {
    // One catch for three distinct failures — a genuine network throw
    // (DNS, connection refused), the AbortController firing at the 10s
    // timeout, and a malformed (non-JSON) OK body from response.json().
    // All three land Dan in the same place: the provider didn't give us
    // anything usable, so fall back to hand entry.
    return UNAVAILABLE
  }

  const parsed = parseAeroDataBox(json)
  return 'error' in parsed ? parsed : { ok: true, candidates: parsed.candidates }
}

type FlightInput = {
  flightNo: string
  flightDate: string
  depAirport: string | null
  arrAirport: string | null
  depAt: string | null
  arrAt: string | null
  depTz: string | null
  arrTz: string | null
  note: string
}

type FlightRow = {
  flight_no: string
  flight_date: string
  dep_airport: string | null
  arr_airport: string | null
  dep_at: string | null
  arr_at: string | null
  dep_tz: string | null
  arr_tz: string | null
  note: string | null
}

/**
 * "AA1234", "aa 1234", "dl45" all become one canonical uppercase, no-space
 * form via `normalizeFlightNo`; junk (no number, punctuation) fails the
 * save. Airports get the opposite treatment: `/^[A-Z]{3}$/` after
 * trim/upper, and anything that doesn't match — empty, a typo, a full
 * city name — becomes null rather than an error. A mistyped airport code
 * is not worth blocking a save over; the calendar still shows "AA1234 on
 * 9/12" with the airports blank, exactly like a lookup miss would.
 */
function normalizeAirport(raw: string | null): string | null {
  if (!raw) return null
  const cleaned = raw.trim().toUpperCase()
  return /^[A-Z]{3}$/.test(cleaned) ? cleaned : null
}

/**
 * Shared validation for saveFlight/updateFlight — the same row shape,
 * checked the same way, whether this is a brand-new flight or an edit.
 * `depAt`/`arrAt` arrive as ISO strings or null from the UI; each is
 * checked independently with `Number.isNaN(Date.parse(x))` before the
 * ordered check runs, so a single malformed timestamp reads as "that time
 * isn't valid" rather than a confusing ordering complaint. The ordered
 * check itself only runs when BOTH times are present — a flight with just
 * a departure time is legal, mirroring `flights_arrival_after_departure`
 * (migration 0033: `dep_at is null or arr_at is null or arr_at >= dep_at`)
 * — so a bad pair fails here with a message Dan can read, instead of
 * surfacing as a raw Postgres constraint-violation string. `depTz`/`arrTz`
 * are passed through as given: the provider or Dan's own picker is the
 * source of truth for zone names here, not a strict IANA check.
 */
function validateFlightInput(input: FlightInput): Fail | { ok: true; row: FlightRow } {
  const flightNo = normalizeFlightNo(input.flightNo)
  if (!flightNo) return { error: 'Enter a valid flight number, like AA1234.' }
  if (!isPlainDate(input.flightDate)) return { error: 'Enter a valid flight date.' }

  if (input.depAt !== null && Number.isNaN(Date.parse(input.depAt))) {
    return { error: 'That departure time is not valid.' }
  }
  if (input.arrAt !== null && Number.isNaN(Date.parse(input.arrAt))) {
    return { error: 'That arrival time is not valid.' }
  }
  if (
    input.depAt !== null && input.arrAt !== null &&
    Date.parse(input.arrAt) < Date.parse(input.depAt)
  ) {
    return { error: 'Arrival must be on or after departure.' }
  }

  return {
    ok: true,
    row: {
      flight_no: flightNo,
      flight_date: input.flightDate,
      dep_airport: normalizeAirport(input.depAirport),
      arr_airport: normalizeAirport(input.arrAirport),
      dep_at: input.depAt,
      arr_at: input.arrAt,
      dep_tz: input.depTz,
      arr_tz: input.arrTz,
      note: input.note.trim() || null,
    },
  }
}

/**
 * Creates one flight. `owner_id: user.id` is set here, not trusted from
 * the caller — the same rule every other insert in this codebase follows.
 */
export async function saveFlight(input: FlightInput): Promise<Fail | { ok: true; id: string }> {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError) return { error: authError.message }
  if (!user) return { error: 'Not signed in.' }

  const validated = validateFlightInput(input)
  if ('error' in validated) return validated

  const { data, error } = await supabase
    .from('flights')
    .insert({ owner_id: user.id, ...validated.row })
    .select('id')
    .single()
  if (error) return { error: error.message }

  revalidatePath('/calendar')
  return { ok: true, id: data.id }
}

/**
 * Edits one flight. The row is fetched first, RLS-scoped to this owner,
 * so a stale id (someone else's flight, or one already deleted in another
 * tab) fails closed with a readable message instead of a silent no-op
 * update. Fail-direction rule (see unlinkTransaction's comment in
 * app/money/actions.ts): a READ ERROR on that fetch must not read the same
 * as "no such row" — that would mask an actual database problem behind
 * the ordinary "That flight no longer exists" message a genuinely-deleted
 * flight gets, so the error case returns first and separately.
 */
export async function updateFlight(
  input: { id: string } & FlightInput,
): Promise<Fail | { ok: true }> {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError) return { error: authError.message }
  if (!user) return { error: 'Not signed in.' }

  const { data: existing, error: existingError } = await supabase
    .from('flights').select('id').eq('id', input.id).maybeSingle()
  if (existingError) return { error: existingError.message }
  if (!existing) return { error: 'That flight no longer exists.' }

  const validated = validateFlightInput(input)
  if ('error' in validated) return validated

  const { error } = await supabase.from('flights').update(validated.row).eq('id', input.id)
  if (error) return { error: error.message }

  revalidatePath('/calendar')
  return { ok: true }
}

/**
 * Deletes one flight. Fetch-first for the same reason updateFlight does:
 * RLS scopes the read to this owner, and a read error is returned before
 * the presence test rather than folded into "already gone" (fail-direction
 * rule, as above). Flights carry no downstream links (no show_id, no
 * money column — see migration 0033's header) so there is nothing else to
 * cascade or restore; the delete itself is unconditional once the row is
 * confirmed to exist.
 */
export async function deleteFlight(id: string): Promise<Fail | { ok: true }> {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError) return { error: authError.message }
  if (!user) return { error: 'Not signed in.' }

  const { data: existing, error: existingError } = await supabase
    .from('flights').select('id').eq('id', id).maybeSingle()
  if (existingError) return { error: existingError.message }
  if (!existing) return { error: 'That flight no longer exists.' }

  const { error } = await supabase.from('flights').delete().eq('id', id)
  if (error) return { error: error.message }

  revalidatePath('/calendar')
  return { ok: true }
}

/**
 * Mints (or replaces) the calendar feed token — the saveSettings idiom
 * (app/settings/actions.ts:79-88) applied to a single column instead of
 * the whole settings row. One function covers both first-generate (column
 * currently null) and regenerate (column already set): `crypto.randomUUID()`
 * followed by an unconditional update is correct either way, and
 * regenerating is the entire revocation story for the old URL — the same
 * design invoices' public_token already uses. owner_id scopes the update
 * the same reason every settings write does: unscoped, a second owner's
 * update would overwrite Dan's own token.
 */
export async function generateCalendarToken(): Promise<Fail | { ok: true }> {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError) return { error: authError.message }
  if (!user) return { error: 'Not signed in.' }

  const token = crypto.randomUUID()
  const { error } = await supabase.from('settings').update({ calendar_token: token }).eq('owner_id', user.id)
  if (error) return { error: error.message }

  revalidatePath('/calendar')
  return { ok: true }
}
