// Wall-clock time in a named zone, to and from an instant.
//
// A punch is stored as an instant (`punched_at timestamptz`) and displayed in
// the show's own zone. So when a show in Orlando is billed from Chicago and Dan
// types 9:00 AM, that has to mean 9:00 AM EASTERN — the time he actually walked
// in — not 9:00 AM Central turned into 10:00 Eastern on the way back out.
//
// Getting this wrong does not change the hours billed, because a duration is a
// duration. It changes every time he reads back, which is what he checks
// against his own notes.
//
// No Date.now() and no `new Date()` without an argument: every function here
// takes its clock from the caller so the tests can pin it.

/**
 * How far ahead of UTC the zone was at that instant, in milliseconds.
 *
 * Derived by formatting the instant in the zone and reading the wall time back,
 * because there is no API that simply hands you an offset for an IANA name.
 */
function offsetMsAt(ts: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ts))

  const v = (type: string) => Number(parts.find((p) => p.type === type)!.value)
  const asIfUTC = Date.UTC(v('year'), v('month') - 1, v('day'), v('hour'), v('minute'), v('second'))
  return asIfUTC - ts
}

/**
 * `2026-08-29` + `09:00` in `America/New_York` -> the ISO instant.
 *
 * Two candidates, deliberately. The first offset has to be looked up at the
 * wrong moment — we only have a wall time, so the lookup treats it as though it
 * were already UTC — and near a DST boundary that guess is an hour out. Reading
 * the offset again at the corrected instant gives a second candidate.
 *
 * On an ordinary day both candidates are the same instant. On the two days a
 * year they differ, the rule is the one every date library settles on:
 *
 *  - **Ambiguous** (the autumn hour that happens twice): take the earlier — the
 *    first time the clock read 1:30.
 *  - **Nonexistent** (the spring hour that is skipped): shift FORWARD. Typing
 *    2:30 on a day with no 2:30 should land on 3:30, not quietly on 1:30 —
 *    reading back an hour earlier than you typed looks like a bug, because it
 *    is indistinguishable from one.
 */
export function wallToInstant(date: string, time: string, tz: string): string {
  const [y, m, d] = date.split('-').map(Number)
  const [hh, mm] = time.split(':').map(Number)
  const naive = Date.UTC(y, m - 1, d, hh, mm)

  const first = naive - offsetMsAt(naive, tz)
  const second = naive - offsetMsAt(first, tz)

  const readsBack = (ts: number) => {
    const w = instantToWall(new Date(ts).toISOString(), tz)
    return w.date === date && w.time === time
  }

  const valid = [first, second].filter(readsBack)
  // Valid candidates: earliest, so an ambiguous hour resolves to its first
  // occurrence. None valid: the wall time does not exist, so take the later
  // instant, which lands just past the gap.
  const ts = valid.length > 0 ? Math.min(...valid) : Math.max(first, second)
  return new Date(ts).toISOString()
}

/** The instant, read as a wall clock in the zone. The inverse of the above. */
export function instantToWall(iso: string, tz: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(iso))

  const v = (type: string) => parts.find((p) => p.type === type)!.value
  return { date: `${v('year')}-${v('month')}-${v('day')}`, time: `${v('hour')}:${v('minute')}` }
}

/**
 * The nearest quarter hour, for prefilling the picker.
 *
 * Nobody punches in at 9:07. Rounding to :00/:15/:30/:45 means the common case
 * is one tap, and 23:53 wraps to 00:00 rather than producing a 24th hour.
 */
export function nearest15(time: string): string {
  const [hh, mm] = time.split(':').map(Number)
  const rounded = Math.round((hh * 60 + mm) / 15) * 15
  const wrapped = ((rounded % 1440) + 1440) % 1440
  return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`
}

/** `13:45` -> `1:45 PM`, for reading back what is about to be saved. */
export function friendlyTime(time: string): string {
  const [hh, mm] = time.split(':').map(Number)
  const suffix = hh < 12 ? 'AM' : 'PM'
  const h12 = hh % 12 === 0 ? 12 : hh % 12
  return `${h12}:${String(mm).padStart(2, '0')} ${suffix}`
}

/**
 * `2h 40m` between two instants — the number that makes a flight across
 * timezones readable.
 *
 * A Chicago→Orlando flight leaves at 8:30 AM Central and lands at 12:10 PM
 * Eastern. Read as clock times that looks like 3h40m; it is 2h40m. Neither
 * end is wrong and neither should be converted — a traveller needs each
 * airport's own local time — so the elapsed figure is what reconciles them.
 *
 * Null when either instant is unparseable or the arrival precedes the
 * departure: a wrong duration is worse than none, and the caller renders
 * nothing rather than a negative.
 */
export function elapsedLabel(fromIso: string, toIso: string): string | null {
  const from = Date.parse(fromIso)
  const to = Date.parse(toIso)
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) return null
  const minutes = Math.round((to - from) / 60000)
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h === 0) return `${m}m`
  if (m === 0) return `${h}h`
  return `${h}h ${m}m`
}
