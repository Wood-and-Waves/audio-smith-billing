// Envelope arithmetic — YNAB's Rule 1 applied to the business checking
// account. An envelope's balance is nothing but the sum of the immutable
// moves that touched it; Available to allocate is whatever the account's
// working balance hasn't been given a job. A move between two envelopes
// changes neither Available nor the total — money just changes jobs.
//
// No '@/' imports and no JSX — exercised by node --test.

export type EnvelopeMoveLike = {
  /** null = the Available pool. */
  from_envelope_id: string | null
  /** null = the Available pool. */
  to_envelope_id: string | null
  /** Always positive; direction lives in from/to. */
  amount_cents: number
}

export function envelopeBalances(moves: EnvelopeMoveLike[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const m of moves) {
    if (m.to_envelope_id !== null) {
      out.set(m.to_envelope_id, (out.get(m.to_envelope_id) ?? 0) + m.amount_cents)
    }
    if (m.from_envelope_id !== null) {
      out.set(m.from_envelope_id, (out.get(m.from_envelope_id) ?? 0) - m.amount_cents)
    }
  }
  return out
}

/** Net cents moved OUT of Available into envelopes, over all time. */
export function netAllocated(moves: EnvelopeMoveLike[]): number {
  let net = 0
  for (const m of moves) {
    if (m.to_envelope_id !== null && m.from_envelope_id === null) net += m.amount_cents
    if (m.from_envelope_id !== null && m.to_envelope_id === null) net -= m.amount_cents
  }
  return net
}

export function availableToAllocate(
  workingBalanceCents: number, moves: EnvelopeMoveLike[],
): number {
  return workingBalanceCents - netAllocated(moves)
}
