// AeroDataBox is one flight-lookup provider among several that could serve
// crew flight info — parsing lives here, isolated, so a future provider
// swap touches this file alone and never the calendar UI. Dan has no
// AeroDataBox key yet, so this parser is pinned against canned JSON
// fixtures (scripts/test/flightLookup.test.ts) instead of a live call; the
// real response shape gets verified by doing, the same rule CLAUDE.md
// already applies to Vercel's encrypted env vars, once the key exists.
//
// This function receives arbitrary JSON from an external service and must
// NEVER throw. Nothing about the input is assumed — every field, at every
// nesting level, is read with typeof/Array.isArray guards rather than
// trusted to exist or to be the right type. A missing or malformed field
// becomes null; an unrecognizable top-level shape becomes an error result.
// No try/catch: the guards make one unnecessary.

/** One flight leg. Every field is independently optional on the wire. */
export type CandidateLeg = {
  depAirport: string | null
  arrAirport: string | null
  depAt: string | null // ISO instant (UTC)
  arrAt: string | null // ISO instant (UTC)
  depTz: string | null // IANA zone name, when the provider supplies one
  arrTz: string | null
}

const NOT_FOUND = { error: 'No flight found for that number and date.' } as const

/** A plain JSON object — not an array, not null. */
function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function stringOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

/**
 * AeroDataBox's own timestamps read "YYYY-MM-DD HH:MMZ" — a space where ISO
 * wants 'T', and no seconds. Anything that doesn't match that exact shape
 * comes back null rather than a guessed or partial conversion.
 */
const PROVIDER_INSTANT = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})Z$/

function toIsoInstant(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const m = PROVIDER_INSTANT.exec(v)
  return m ? `${m[1]}T${m[2]}:00Z` : null
}

/**
 * One side of a leg (departure or arrival), read field by field so a
 * missing `airport`, `scheduledTime`, or any field within them degrades to
 * null instead of throwing on `undefined.something`.
 */
function sideOf(leg: Record<string, unknown>, key: 'departure' | 'arrival') {
  const side = asRecord(leg[key])
  const airport = side ? asRecord(side.airport) : null
  const scheduledTime = side ? asRecord(side.scheduledTime) : null
  return {
    iata: airport ? stringOrNull(airport.iata) : null,
    timeZone: airport ? stringOrNull(airport.timeZone) : null,
    at: scheduledTime ? toIsoInstant(scheduledTime.utc) : null,
  }
}

function parseLeg(leg: Record<string, unknown>): CandidateLeg {
  const dep = sideOf(leg, 'departure')
  const arr = sideOf(leg, 'arrival')
  return {
    depAirport: dep.iata,
    arrAirport: arr.iata,
    depAt: dep.at,
    arrAt: arr.at,
    depTz: dep.timeZone,
    arrTz: arr.timeZone,
  }
}

/**
 * The provider returns a JSON array of legs for a flight-number-and-date
 * lookup. Anything that isn't a non-empty array — a bare object, a string,
 * a number, null — is "unrecognizable shape" and comes back as the same
 * no-flight error an empty array would, rather than as a type worth
 * distinguishing to the caller. A non-object entry inside the array (e.g. a
 * stray string mixed into legs) is skipped rather than crashing the parse;
 * if every entry turns out to be unusable, the result is that same error
 * rather than an empty `candidates` array — callers only ever see a
 * genuine, non-empty result or a reason there isn't one.
 */
export function parseAeroDataBox(json: unknown): { candidates: CandidateLeg[] } | { error: string } {
  if (!Array.isArray(json) || json.length === 0) return NOT_FOUND

  const candidates: CandidateLeg[] = []
  for (const entry of json) {
    const leg = asRecord(entry)
    if (leg) candidates.push(parseLeg(leg))
  }

  return candidates.length === 0 ? NOT_FOUND : { candidates }
}

/**
 * Flight numbers as Dan types them ("aa 1234", "dl45") vs. as the provider
 * expects them ("AA1234"). Uppercases and strips whitespace, then accepts
 * only the shape a real flight number can take: 2 to 8 alphanumerics, no
 * punctuation. Anything else — including slash/path-shaped input like
 * "AA/12" — comes back null rather than being passed through to a URL or
 * query string un-validated.
 */
export function normalizeFlightNo(raw: string): string | null {
  if (typeof raw !== 'string') return null
  const cleaned = raw.toUpperCase().replace(/\s+/g, '')
  return /^[A-Z0-9]{2,8}$/.test(cleaned) ? cleaned : null
}
