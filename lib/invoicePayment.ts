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
    return { paidCents: 0, deltaCents: -totalCents || 0, state: 'unpaid' }
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
