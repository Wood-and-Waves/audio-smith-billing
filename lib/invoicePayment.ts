// How much of an invoice was actually paid, and by how much the payment
// missed (design: docs/superpowers/specs/
// 2026-08-25-short-paid-settlement-design.md).
//
// Dan, 2026-08-25: a client keyed the wrong amount and the check arrived $10
// short on invoice #385. He is not chasing the $10. On CASH BASIS — his own
// confirmation — that $10 was never income, so nothing in the books needs
// correcting and nothing here may reach a report or a total. What was
// missing was a way to say "settled" when the deposit does not match to the
// penny, and a durable note of WHY it does not.
//
// Nothing here is stored. The figure is derived from the deposit actually
// linked to the invoice (ledger_transaction_invoices), so the link stays the
// single source of truth and no second copy can drift away from it.

/** One invoice's link, as little of it as the arithmetic needs. */
export type SettlementLink = {
  /** The linked deposit's own amount, positive cents. */
  amountCents: number
  /** How many invoices that one deposit covers (1..3). */
  invoiceCount: number
}

export type Settlement = {
  paidCents: number
  /** paid − total. Negative = short, positive = over, 0 = exact. */
  deltaCents: number
  state: 'unpaid' | 'exact' | 'short' | 'over'
}

export function settlementFor(
  totalCents: number,
  link: SettlementLink | null,
): Settlement {
  if (link === null) {
    // `totalCents === 0 ? 0 : …` rather than `-totalCents || 0`: unary
    // negation of 0 yields -0, which node:assert/strict distinguishes from
    // 0 (Object.is semantics), so the zero-total case needs SOME guard. The
    // `|| 0` form would also swallow a NaN into a plausible-looking 0 and
    // hide a corrupt total; this one fixes only the -0 it means to fix and
    // lets anything genuinely broken stay visibly broken. The link path
    // below needs no such guard — `paidCents - totalCents` yields +0 for
    // equal operands and can only produce -0 from an already-poisoned one.
    return { paidCents: 0, deltaCents: totalCents === 0 ? 0 : -totalCents, state: 'unpaid' }
  }

  // A COMBO — one deposit covering several invoices — is only ever created
  // by the matcher, and it proposes one solely when the invoice totals sum
  // to the deposit EXACTLY. So this invoice's share is precisely its own
  // total. Reading the whole deposit here would report a huge phantom
  // overpayment on an invoice that was in fact paid to the penny.
  const paidCents = link.invoiceCount > 1 ? totalCents : link.amountCents
  const deltaCents = paidCents - totalCents

  return {
    paidCents,
    deltaCents,
    state: deltaCents === 0 ? 'exact' : deltaCents < 0 ? 'short' : 'over',
  }
}

/**
 * May a deposit be linked to these invoices, given the amounts?
 *
 * Returns null to allow, or the refusal message. Extracted from
 * acceptIncomeMatch so the one rule that decides whether money may be
 * linked across a mismatch is testable, which a server action is not.
 *
 * A COMBO — one deposit covering 2 or 3 invoices — must ALWAYS add up
 * exactly. There is no honest way to attribute a mismatch across several
 * invoices, so no flag relaxes that; the matcher only ever proposes a
 * combo whose totals sum to the deposit anyway.
 *
 * A SINGLE invoice is different: a client can key the wrong amount, and
 * Dan may decide to treat the invoice as settled regardless (his #385 came
 * in $10 short and he is not chasing it). That is a deliberate act, so it
 * requires the caller to say so explicitly via `settleMismatch` — the
 * Matches queue never passes it and keeps its strict behaviour unchanged.
 */
export function amountLinkRefusal(input: {
  sumCents: number
  txnAmountCents: number
  invoiceCount: number
  settleMismatch: boolean
}): string | null {
  if (input.sumCents === input.txnAmountCents) return null
  if (input.settleMismatch && input.invoiceCount === 1) return null
  return 'Those amounts do not add up.'
}
