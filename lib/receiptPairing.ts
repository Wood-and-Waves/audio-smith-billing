// Pairing identical receipts to identical charges.
//
// lib/receiptAutoFile.ts decides ONE receipt at a time, and it is right to
// refuse a tie: shown a single $24.38 receipt and two $24.38 charges, nothing
// in that receipt says which. But looked at as a SET the tie often dissolves.
// Praxis has two Meritage Resort charges at $24.38 and two receipts for them;
// IllumiNations has two United bag fees at $60.00 and two receipts. Every
// receipt has a charge and every charge has a receipt, so the only open
// question is which goes with which — and for the same vendor, same amount and
// the same show, the worst outcome of guessing is a receipt dated a day off the
// charge it documents.
//
// Dan's call, 2026-09-10, told that cost. It roughly doubles what files
// without him.
//
// The refusal that stays: counts must match EXACTLY. Two receipts against three
// charges pairs nothing, because then one charge genuinely has no receipt and
// picking two of three would be a guess with a wrong answer available. Same for
// three receipts against two charges.
//
// Pure: no database, no clock.

export type PairableItem = { amountCents: number }

export type PairableCharge = {
  id: string
  /** YYYY-MM-DD. Only used to make the pairing order deterministic. */
  date: string
  amountCents: number
  /** A charge already carrying a receipt is not free, so it is not in the set. */
  hasReceipt: boolean
}

/**
 * Item index -> charge id, for every amount where the number of receipts equals
 * the number of free charges. Amounts that do not balance appear nowhere in the
 * result and fall through to the one-at-a-time rule.
 */
export function pairExactSets(
  items: readonly PairableItem[],
  charges: readonly PairableCharge[],
): Map<number, string> {
  const itemsByAmount = new Map<number, number[]>()
  items.forEach((item, index) => {
    const at = itemsByAmount.get(item.amountCents)
    if (at === undefined) itemsByAmount.set(item.amountCents, [index])
    else at.push(index)
  })

  const chargesByAmount = new Map<number, PairableCharge[]>()
  for (const charge of charges) {
    if (charge.hasReceipt) continue
    const at = chargesByAmount.get(charge.amountCents)
    if (at === undefined) chargesByAmount.set(charge.amountCents, [charge])
    else at.push(charge)
  }

  const paired = new Map<number, string>()
  for (const [amountCents, indexes] of itemsByAmount) {
    const free = chargesByAmount.get(amountCents) ?? []
    if (free.length === 0 || free.length !== indexes.length) continue
    // Oldest charge to the earliest receipt, so a re-run pairs the same way.
    const ordered = [...free].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1))
    indexes.forEach((index, i) => paired.set(index, ordered[i].id))
  }
  return paired
}
