// Picking the one card that matters when nothing more specific was chosen.
//
// A card's `name` is null exactly when it is the client's default (unnamed)
// rate — see migration 0013 and saveClient's one-default-per-client
// invariant (app/clients/actions.ts). No 'use client', no hooks: plain data
// in, plain data out, so this renders in server and client trees alike, and
// in a plain `node` test (same rule lib/money.ts follows).

import { travelRateFrom } from './money.ts'

export type RateCardLike = { name: string | null }

/** The client's one unnamed default card, or null if it has none. */
export function defaultCardOf<T extends RateCardLike>(cards: T[]): T | null {
  return cards.find((c) => c.name === null) ?? null
}

/**
 * The travel and PM rates a plain day rate/OT pair would imply — a PRE-FILL,
 * not show-creation logic. `client_rate_cards` now holds its own explicit
 * `travel_rate_cents`/`pm_rate_cents` (migration 0015), and `createShow`
 * copies those straight off the chosen card rather than deriving anything
 * (see app/shows/actions.ts). What's left for this function: when Dan types
 * a NEW day rate into a form — editing a card, or overriding the day rate on
 * New Show — travel and PM should follow along unless he's typed into those
 * boxes himself. Travel always pre-fills at half the day rate; a flat or
 * full-day arrangement is something he then types over by hand, the same as
 * any other override (the boolean full/half-day switch this replaced could
 * not express a flat $200/leg arrangement — see migration 0015).
 */
export function deriveFromDayRate(
  dayRateCents: number, otAfterHours: number,
): { travel_rate_cents: number; pm_rate_cents: number } {
  return {
    travel_rate_cents: travelRateFrom(dayRateCents),
    pm_rate_cents: otAfterHours > 0 ? Math.round(dayRateCents / otAfterHours) : 0,
  }
}

/**
 * True when a parsed day rate is a usable basis for `deriveFromDayRate`.
 *
 * `parseUSD` returns `null` for junk and `0` for an emptied box — neither
 * means "derive from zero". NewShowForm's day-rate/OT handlers must check
 * this instead of `=== null`, or a cleared day-rate box re-derives travel
 * and PM from $0.00 and silently overwrites both boxes with "0.00" (see
 * app/shows/actions.ts overrideCents for the matching server-side guard).
 */
export function isDerivableDayRate(parsedDayRate: number | null): parsedDayRate is number {
  return parsedDayRate !== null && parsedDayRate > 0
}
