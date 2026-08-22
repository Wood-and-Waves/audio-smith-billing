// Dates on an invoice are PLAIN dates — "2026-08-10" is the tenth of August,
// not an instant. Formatting one through the viewer's local timezone shifts it
// backwards west of UTC: `new Date('2026-08-10T00:00:00Z')` rendered in Chicago
// is the evening of the 9th, so an invoice dated the 10th prints as 8/9/2026.
//
// Every formatter here pins timeZone: 'UTC' so a stored date renders as the
// date it is. This class of bug bit CrewTracker twice; it does not get a third.
//
// No 'use client', no hooks: renders in server and client trees alike.

const SHORT = new Intl.DateTimeFormat('en-US', {
  month: 'numeric', day: 'numeric', year: '2-digit', timeZone: 'UTC',
})

const LONG = new Intl.DateTimeFormat('en-US', {
  month: 'numeric', day: 'numeric', year: 'numeric', timeZone: 'UTC',
})

const asUTC = (iso: string) => new Date(iso + 'T00:00:00Z')

/** "8/10/26" */
export const formatDateShort = (iso: string) => SHORT.format(asUTC(iso))

/** "8/10/2026" */
export const formatDateLong = (iso: string) => LONG.format(asUTC(iso))

/**
 * Today where Dan bills from. `new Date().toISOString()` is UTC, which rolls
 * over to tomorrow at 7pm Chicago — so a new invoice created on a weekday
 * evening would be dated tomorrow.
 */
export function todayInChicago(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
}

/**
 * Is this a real YYYY-MM-DD date?
 *
 * A cleared `<input type="date">` submits an empty string, and every date
 * helper here builds `new Date(iso + 'T00:00:00Z')` — which for "" is an
 * Invalid Date whose `toISOString()` THROWS. A server action that walks a
 * range would crash with a RangeError instead of returning a message, so
 * actions taking a date from a request check it here first.
 *
 * The shape test alone would accept 2026-02-31, so the parsed date is
 * round-tripped back to a string and compared.
 */
export function isPlainDate(iso: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false
  const d = asUTC(iso)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso
}

/** Add whole days to a plain date, staying in plain-date space. */
export function addDays(iso: string, days: number): string {
  const d = asUTC(iso)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

// ---------------------------------------------------------------------------
// Month-grid helpers for the calendar view. Same doctrine as above, extended
// to month keys ("YYYY-MM") and weekday math: every date this file builds is
// `Date.UTC(y, m-1, d)`, every read is `getUTC*`. A month grid built off
// machine-local time would shift its Sunday column on any viewer not on UTC
// — the exact bug this file's header already promises never to reintroduce.

const MONTH_LABEL = new Intl.DateTimeFormat('en-US', {
  month: 'long', year: 'numeric', timeZone: 'UTC',
})

/** Sunday-first weekday abbreviations, index-aligned with weekdayIndex/getUTCDay. */
export const WEEKDAYS: readonly string[] = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const ymParts = (ym: string): [number, number] => {
  const [y, m] = ym.split('-').map(Number)
  return [y, m]
}

const isoParts = (iso: string): [number, number, number] => {
  const [y, m, d] = iso.split('-').map(Number)
  return [y, m, d]
}

/** 0=Sun..6=Sat, from the UTC calendar date — never the machine's local day. */
export function weekdayIndex(iso: string): number {
  const [y, m, d] = isoParts(iso)
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}

/** '2026-08' -> 'August 2026' */
export function monthLabel(ym: string): string {
  const [y, m] = ymParts(ym)
  return MONTH_LABEL.format(new Date(Date.UTC(y, m - 1, 1)))
}

/** '2026-08', -1 -> '2026-07'; wraps the year in either direction. */
export function addMonths(ym: string, n: number): string {
  const [y, m] = ymParts(ym)
  const d = new Date(Date.UTC(y, m - 1 + n, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

/**
 * Sunday-first weeks of plain YYYY-MM-DD dates covering the month, padded
 * with leading/trailing adjacent-month dates to full 7-day rows. Always
 * 4-6 rows: exactly as many as it takes for the padded range to reach the
 * month's last day.
 */
export function monthGrid(ym: string): string[][] {
  const [y, m] = ymParts(ym)
  const first = new Date(Date.UTC(y, m - 1, 1))
  const lastOfMonth = new Date(Date.UTC(y, m, 0)) // day 0 of next month = last day of this one

  const cursor = new Date(Date.UTC(y, m - 1, 1 - first.getUTCDay()))
  const rows: string[][] = []
  do {
    const row: string[] = []
    for (let i = 0; i < 7; i++) {
      row.push(cursor.toISOString().slice(0, 10))
      cursor.setUTCDate(cursor.getUTCDate() + 1)
    }
    rows.push(row)
    // cursor now sits one day past the row just built; keep going while the
    // month's last day is still ahead of it.
  } while (cursor.getTime() <= lastOfMonth.getTime())

  return rows
}
