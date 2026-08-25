import { createClient } from '@/lib/supabase/server'
import { buildCalendarFeed, type FeedDay, type FeedFlight } from '@/lib/ics'

// The public ICS feed. Same capability model as /i/[token]: gated only by the
// unguessable calendar_token (0033), no session, no service role, no storage
// access. It reads through public_calendar_feed() — a security-definer
// function that returns one owner's schedule facts (days, flights) and
// nothing else — and folds them into an RFC 5545 VCALENDAR via lib/ics.
// force-dynamic: a calendar client's next poll must see the current
// schedule, not a build-time snapshot.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// A malformed uuid is a driver error, not a null row; guard the shape so a bad
// token is a 404, never a 500 that would confirm the parameter is a uuid.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type FeedRow = {
  days: {
    id: string
    /** Optional on purpose: a deploy that lands before migration 0047 gets
     *  rows without it, and the mapping below falls back rather than
     *  collapsing every show into one run. */
    show_id?: string
    date: string
    show_name: string
    venue: string | null
    location: string | null
    client: string
  }[]
  flights: {
    id: string
    flight_no: string
    flight_date: string
    dep_airport: string | null
    arr_airport: string | null
    dep_at: string | null
    arr_at: string | null
  }[]
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token: rawToken } = await params
  // Both /cal/{uuid} and /cal/{uuid}.ics (or .ICS, .Ics — calendar clients
  // and OSes vary in case) work: strip at most one trailing .ics,
  // case-insensitively, before the shape check reaches the token itself.
  const token = rawToken.replace(/\.ics$/i, '')
  if (!UUID.test(token)) return new Response('Not found', { status: 404 })

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('public_calendar_feed', { p_token: token })

  // A DB error and a token that matches nothing are different answers: 500 for
  // a real failure (generic body — never error.message, which can carry
  // schema detail), 404 for a miss (so a stranger cannot tell a real token
  // from a fake one).
  if (error) {
    console.error('[public-calendar-feed] rpc failed', { code: error.code })
    return new Response('Feed unavailable', { status: 500 })
  }
  if (!data) return new Response('Not found', { status: 404 })

  const row = data as FeedRow
  const days: FeedDay[] = row.days.map((d) => ({
    id: d.id,
    // Pre-0047 the RPC returns no show_id. Falling back to the day's own id
    // degrades to one event per day — exactly what this feed published
    // yesterday — instead of collapsing every show into one merged event
    // and silently dropping the rest. Costs nothing once 0047 is applied.
    showId: d.show_id ?? d.id,
    date: d.date,
    showName: d.show_name,
    venue: d.venue,
    location: d.location,
    client: d.client,
  }))
  const flights: FeedFlight[] = row.flights.map((f) => ({
    id: f.id,
    flightNo: f.flight_no,
    flightDate: f.flight_date,
    depAirport: f.dep_airport,
    arrAirport: f.arr_airport,
    depAt: f.dep_at,
    arrAt: f.arr_at,
  }))

  const ics = buildCalendarFeed({ days, flights, nowIso: new Date().toISOString() })

  return new Response(ics, {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  })
}
