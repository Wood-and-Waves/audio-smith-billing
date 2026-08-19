// Payee memory: the one YNAB convenience that turns categorizing a monthly
// import from 28 chores into 5. When a payee has been categorized before,
// the newest categorized row teaches the category, and imports of that payee
// arrive pre-categorized. A convenience, never an authority: it only fills
// category on NEW rows, never overwrites, never touches kind, and never
// learns from owner-pay/transfer rows (those carry no category by design)
// or from uncategorized rows (nothing to teach).
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
 * normalized payee -> category_id, taught by the NEWEST categorized
 * income/expense row for that payee (ties broken by array order: later
 * wins, so callers should pass rows oldest-first or any stable order —
 * the date comparison does the real work).
 */
export function rememberedCategories(rows: PayeeMemoryRow[]): Map<string, string> {
  const best = new Map<string, { date: string; category: string }>()
  for (const r of rows) {
    if (r.category_id === null) continue
    if (r.kind !== 'income' && r.kind !== 'expense') continue
    const key = normalizePayee(r.payee)
    if (key === '') continue
    const prev = best.get(key)
    if (!prev || r.date >= prev.date) best.set(key, { date: r.date, category: r.category_id })
  }
  const out = new Map<string, string>()
  for (const [k, v] of best) out.set(k, v.category)
  return out
}
