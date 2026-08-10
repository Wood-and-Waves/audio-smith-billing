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

/** Add whole days to a plain date, staying in plain-date space. */
export function addDays(iso: string, days: number): string {
  const d = asUTC(iso)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}
