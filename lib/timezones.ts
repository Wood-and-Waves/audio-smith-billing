// The timezones a show can be worked in.
//
// This exists because punch times are stored as instants and rendered in the
// SHOW's zone. Get the zone wrong and the hours are still right — a duration
// cannot be changed by a timezone — but every time you read back is shifted,
// which is worst exactly when you are checking whether you punched in.
//
// One list, used by both the picker and the server-side validator, so a zone
// that can be chosen is always a zone that will be accepted.
//
// Deliberately a short US list rather than every IANA zone: a searchable list
// of 400 is worse than a list of seven when six of them are wrong for you.
// Add a row when a job needs one.
//
// No JSX, no '@/' imports — usable from a server action and a client component.

export type TimezoneOption = { value: string; label: string }

export const TIMEZONES: TimezoneOption[] = [
  { value: 'America/New_York', label: 'Eastern — New York, Orlando, Atlanta' },
  { value: 'America/Chicago', label: 'Central — Chicago, Dallas, Nashville' },
  { value: 'America/Denver', label: 'Mountain — Denver, Salt Lake City' },
  { value: 'America/Phoenix', label: 'Arizona — Phoenix (no daylight saving)' },
  { value: 'America/Los_Angeles', label: 'Pacific — Los Angeles, Las Vegas, Seattle' },
  { value: 'America/Anchorage', label: 'Alaska — Anchorage' },
  { value: 'Pacific/Honolulu', label: 'Hawaii — Honolulu' },
]

/** Where Dan is based. The column default, and what a new show gets. */
export const DEFAULT_TIMEZONE = 'America/Chicago'

/**
 * Is this one of the offered zones?
 *
 * Checked on the server as well as constrained by the picker: a bad value here
 * does not throw, it silently renders every punch time in the wrong hour, and
 * that is the kind of wrong you only notice weeks later on an invoice.
 */
export function isKnownTimezone(tz: string): boolean {
  return TIMEZONES.some((t) => t.value === tz)
}

/** "Eastern", "Central" — the short form, for showing next to a time. */
export function timezoneShortLabel(tz: string): string {
  const found = TIMEZONES.find((t) => t.value === tz)
  return found ? found.label.split(' — ')[0] : tz
}
