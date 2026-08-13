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
