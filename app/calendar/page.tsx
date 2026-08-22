import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { todayInChicago, monthGrid, monthLabel, addMonths } from '@/lib/dates'
import AppShell from '@/components/AppShell'
import CalendarMonth, { type DayEntry, type FlightEntry } from '@/components/CalendarMonth'
import AddFlightDialog from '@/components/AddFlightDialog'

export const dynamic = 'force-dynamic'

// The reports-page idiom (app/money/reports/page.tsx): a bad or absent `m`
// falls back to the current month rather than 404ing or crashing a date
// helper on garbage input.
const MONTH_KEY = /^(19|20)\d{2}-(0[1-9]|1[0-2])$/

type ShowDayRow = {
  id: string
  date: string
  travel_in: boolean
  travel_out: boolean
  pay_as_half_day: boolean
  show_id: string
  shows: {
    name: string
    venue: string | null
    location: string | null
    timezone: string
    clients: { name: string } | null
  } | null
}

type FlightRow = {
  id: string
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

function LoadError({ message }: { message: string }) {
  return (
    <AppShell current="calendar">
      <p role="alert" className="text-danger border-l-2 border-danger pl-4 py-2">
        Couldn&rsquo;t load the calendar: {message}
      </p>
    </AppShell>
  )
}

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ m?: string }>
}) {
  const params = await searchParams
  const month = params.m && MONTH_KEY.test(params.m) ? params.m : todayInChicago().slice(0, 7)

  // Grid-bounded, not month-bounded: leading/trailing cells from the
  // adjacent months show their own entries too, so the query has to cover
  // the padded range monthGrid actually renders.
  const grid = monthGrid(month)
  const first = grid[0][0]
  const last = grid[grid.length - 1][6]

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  // proxy.ts redirects an unauthenticated request to /login before it
  // reaches here (the Settings-page idiom) — this is belt and braces, and
  // the token query below needs a real id rather than silently passing
  // `undefined` to .eq().
  if (!user) {
    return (
      <AppShell current="calendar">
        <p role="alert" className="text-danger border-l-2 border-danger pl-4 py-2">
          You&rsquo;re not signed in.
        </p>
      </AppShell>
    )
  }

  const [
    { data: dayRows, error: dayError },
    { data: flightRows, error: flightError },
  ] = await Promise.all([
    supabase
      .from('show_days')
      .select(
        'id, date, travel_in, travel_out, pay_as_half_day, show_id, ' +
          'shows(name, venue, location, timezone, clients(name))',
      )
      .gte('date', first)
      .lte('date', last)
      .order('date'),
    supabase
      .from('flights')
      .select('id, flight_no, flight_date, dep_airport, arr_airport, dep_at, arr_at, dep_tz, arr_tz, note')
      .gte('flight_date', first)
      .lte('flight_date', last)
      .order('flight_date'),
  ])

  if (dayError) return <LoadError message={dayError.message} />
  if (flightError) return <LoadError message={flightError.message} />

  const dayRowsTyped = (dayRows ?? []) as unknown as ShowDayRow[]
  const flightRowsTyped = (flightRows ?? []) as unknown as FlightRow[]

  // Grouped here, server-side, into plain objects keyed by date — a Map
  // can't cross the RSC boundary into CalendarMonth's client props, and an
  // object literal is exactly as cheap to build.
  const showsByDate: Record<string, DayEntry[]> = {}
  for (const d of dayRowsTyped) {
    if (!d.shows) continue
    const entry: DayEntry = {
      id: d.id,
      showId: d.show_id,
      showName: d.shows.name,
      venue: d.shows.venue,
      location: d.shows.location,
      clientName: d.shows.clients?.name ?? null,
      travelIn: d.travel_in,
      travelOut: d.travel_out,
      payAsHalfDay: d.pay_as_half_day,
    }
    ;(showsByDate[d.date] ??= []).push(entry)
  }

  const flightsByDate: Record<string, FlightEntry[]> = {}
  for (const f of flightRowsTyped) {
    const entry: FlightEntry = {
      id: f.id,
      flightNo: f.flight_no,
      flightDate: f.flight_date,
      depAirport: f.dep_airport,
      arrAirport: f.arr_airport,
      depAt: f.dep_at,
      arrAt: f.arr_at,
      depTz: f.dep_tz,
      arrTz: f.arr_tz,
      note: f.note,
    }
    ;(flightsByDate[f.flight_date] ??= []).push(entry)
  }

  const today = todayInChicago()

  return (
    <AppShell current="calendar">
      <header className="flex flex-wrap items-center justify-between gap-4 mb-8">
        <div className="flex items-center gap-3">
          <Link
            href={`/calendar?m=${addMonths(month, -1)}`}
            aria-label="Previous month"
            className="text-muted hover:text-ink transition-colors text-lg leading-none"
          >
            ‹
          </Link>
          <h1 className="eyebrow text-ink">{monthLabel(month)}</h1>
          <Link
            href={`/calendar?m=${addMonths(month, 1)}`}
            aria-label="Next month"
            className="text-muted hover:text-ink transition-colors text-lg leading-none"
          >
            ›
          </Link>
        </div>
        {/* The feed link and its Regenerate live in Settings, not here.
            Regenerating IS revocation and has no undo — and once the link has
            been shared (Dan sent his to his wife), an accidental click breaks
            her calendar too. A button like that does not belong on a page
            opened every day; one-time setup belongs with setup. */}
        <AddFlightDialog mode="create" defaultDate={today} />
      </header>

      <CalendarMonth
        grid={grid}
        month={month}
        today={today}
        showsByDate={showsByDate}
        flightsByDate={flightsByDate}
      />
    </AppShell>
  )
}
