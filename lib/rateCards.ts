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
 * The travel and PM rates a card's own rules imply for a given day rate.
 *
 * This is the ONE place that math happens, used both when `createShow`
 * freezes a card onto a new show and when `NewShowForm` re-derives travel/PM
 * as the day rate is typed — so the two can never drift into disagreement.
 * It exists because `updateShow` deliberately does NOT do this (day, travel
 * and PM are independent columns once a show exists — see its comment in
 * app/shows/actions.ts): a show edited from $780 to $900 kept a $390 travel
 * rate and a $78 PM rate, silently, which is the whole reason rate cards and
 * this function exist.
 *
 * Travel bills per LEG (migration 0013): a full-day-travel card bills one
 * whole day rate per leg, everything else bills travelRateFrom (half).
 */
export function deriveFromDayRate(
  dayRateCents: number, otAfterHours: number, travelFullDay: boolean,
): { travel_rate_cents: number; pm_rate_cents: number } {
  return {
    travel_rate_cents: travelFullDay ? dayRateCents : travelRateFrom(dayRateCents),
    pm_rate_cents: otAfterHours > 0 ? Math.round(dayRateCents / otAfterHours) : 0,
  }
}
