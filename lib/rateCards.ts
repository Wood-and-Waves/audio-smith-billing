// Picking the one card that matters when nothing more specific was chosen.
//
// A card's `name` is null exactly when it is the client's default (unnamed)
// rate — see migration 0013 and saveClient's one-default-per-client
// invariant (app/clients/actions.ts). No 'use client', no imports: plain
// data in, plain data out.

export type RateCardLike = { name: string | null }

/** The client's one unnamed default card, or null if it has none. */
export function defaultCardOf<T extends RateCardLike>(cards: T[]): T | null {
  return cards.find((c) => c.name === null) ?? null
}
