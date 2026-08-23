// Payee memory: the one YNAB convenience that turns categorizing a monthly
// import from 28 chores into 5. When a payee has been categorized before,
// the newest categorized row teaches the category, and imports of that payee
// arrive pre-categorized. A convenience, never an authority: it only fills
// category on NEW rows, never overwrites, never touches kind, and never
// learns from owner-pay/transfer rows (transfer rows carry no category by
// design; owner-pay rows do carry one since migration 0038, but the OFX
// importer this map exists for never produces an owner-pay row, so a memory
// key can never need one) or from uncategorized rows (nothing to teach).
//
// No '@/' imports and no JSX — exercised by node --test.

export type PayeeMemoryRow = {
  payee: string
  category_id: string | null
  kind: string
  date: string
}

/** Case-insensitive, whitespace-collapsed — "Travel  Diner " teaches "TRAVEL DINER". */
export function normalizePayee(payee: string): string {
  return payee.trim().replace(/\s+/g, ' ').toLowerCase()
}

/**
 * The memory map's actual key: kind AND payee, not payee alone. A payee can
 * legitimately appear on both sides of the ledger with different meanings —
 * "SQUARE INC" as an expense is a processing fee, as income it's a client's
 * payout — so teaching one must never pre-fill the other. Both the lib and
 * every caller that looks the map up (importOfx, the same-payee sweep) go
 * through this one function so the two sides can never drift apart.
 */
export function memoryKey(kind: string, payee: string): string {
  return `${kind}:${normalizePayee(payee)}`
}

/**
 * memoryKey(kind, payee) -> category_id, taught by the NEWEST categorized
 * row for that exact (kind, payee) pair — income and expense rows of the
 * same payee are remembered independently (ties broken by array order:
 * later wins, so callers should pass rows oldest-first or any stable order —
 * the date comparison does the real work).
 */
export function rememberedCategories(rows: PayeeMemoryRow[]): Map<string, string> {
  const best = new Map<string, { date: string; category: string }>()
  for (const r of rows) {
    if (r.category_id === null) continue
    if (r.kind !== 'income' && r.kind !== 'expense') continue
    if (normalizePayee(r.payee) === '') continue
    const key = memoryKey(r.kind, r.payee)
    const prev = best.get(key)
    if (!prev || r.date >= prev.date) best.set(key, { date: r.date, category: r.category_id })
  }
  const out = new Map<string, string>()
  for (const [k, v] of best) out.set(k, v.category)
  return out
}
