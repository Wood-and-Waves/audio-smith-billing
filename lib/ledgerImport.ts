// The dedupe/match brain for a bank-statement import. This is YNAB's rule,
// proven for a decade: an imported row either already exists (its import id
// is one the register has seen), or it adopts a manual row someone typed in
// before the statement arrived (same amount, close date), or it's genuinely
// new. Getting this wrong means either a client dinner appears twice or a
// hand-entered expense gets orphaned next to its own bank line.
//
// Pure: no database, no clock beyond the plain dates it's handed. That's
// what lets every branch be pinned by a test instead of a live import.

import type { ParsedOfxTxn } from './ofx.ts'

export type ExistingTxn = {
  id: string
  date: string
  amount_cents: number
  import_id: string | null
  source: 'manual' | 'import'
}

export type ImportPlan = {
  duplicates: ParsedOfxTxn[]
  matches: { row: ParsedOfxTxn; importId: string; existingId: string }[]
  inserts: { row: ParsedOfxTxn; importId: string; kind: 'income' | 'expense' }[]
}

const MS_PER_DAY = 24 * 60 * 60 * 1000

/** Whole-day distance between two YYYY-MM-DD strings, via Date.UTC so no local timezone leaks in. */
function daysApart(a: string, b: string): number {
  const utc = (d: string) => {
    const [y, m, day] = d.split('-').map(Number)
    return Date.UTC(y, m - 1, day)
  }
  return Math.abs(utc(a) - utc(b)) / MS_PER_DAY
}

/**
 * Seed the GEN occurrence counter from existing import ids, so a second
 * import of a statement that overlaps the first one continues numbering
 * instead of colliding with GEN ids the first import already claimed.
 */
function seedGenCounters(existing: ExistingTxn[]): Map<string, number> {
  const counters = new Map<string, number>()
  for (const e of existing) {
    if (!e.import_id || !e.import_id.startsWith('GEN:')) continue
    const rest = e.import_id.slice('GEN:'.length) // "<amountCents>:<date>:<n>"
    const key = rest.slice(0, rest.lastIndexOf(':'))
    counters.set(key, (counters.get(key) ?? 0) + 1)
  }
  return counters
}

/**
 * A bank FITID is the real identity when the bank sends one. When it doesn't
 * (some banks omit it on older exports), fall back to a synthetic id built
 * from amount + date + an occurrence count, so two identical transactions on
 * the same day still get distinct, stable ids across re-imports.
 */
function importIdFor(row: ParsedOfxTxn, genCounters: Map<string, number>): string {
  if (row.fitid !== null && row.fitid.trim() !== '') return `OFX:${row.fitid}`
  const key = `${row.amountCents}:${row.date}`
  const n = (genCounters.get(key) ?? 0) + 1
  genCounters.set(key, n)
  return `GEN:${key}:${n}`
}

/**
 * The closest not-yet-claimed manual row within 10 days at the same amount,
 * or null. "Manual, unlinked" is the only kind of row eligible to adopt an
 * import id — an already-imported or already-matched row must never be
 * claimed a second time.
 */
function findMatch(
  row: ParsedOfxTxn,
  existing: ExistingTxn[],
  claimed: Set<string>,
): ExistingTxn | null {
  let best: ExistingTxn | null = null
  let bestDistance = Infinity
  for (const candidate of existing) {
    if (candidate.source !== 'manual' || candidate.import_id !== null) continue
    if (candidate.amount_cents !== row.amountCents) continue
    if (claimed.has(candidate.id)) continue
    const distance = daysApart(candidate.date, row.date)
    if (distance > 10) continue
    const closer = distance < bestDistance
    const tiedButEarlier = distance === bestDistance && best !== null && candidate.date < best.date
    if (closer || tiedButEarlier) {
      best = candidate
      bestDistance = distance
    }
  }
  return best
}

export function planImport(rows: ParsedOfxTxn[], existing: ExistingTxn[]): ImportPlan {
  const existingImportIds = new Set(
    existing.map((e) => e.import_id).filter((id): id is string => id !== null),
  )
  const genCounters = seedGenCounters(existing)
  const claimed = new Set<string>()

  const duplicates: ParsedOfxTxn[] = []
  const matches: ImportPlan['matches'] = []
  const inserts: ImportPlan['inserts'] = []

  for (const row of rows) {
    const importId = importIdFor(row, genCounters)

    if (existingImportIds.has(importId)) {
      duplicates.push(row)
      continue
    }

    const match = findMatch(row, existing, claimed)
    if (match) {
      claimed.add(match.id)
      matches.push({ row, importId, existingId: match.id })
      continue
    }

    inserts.push({ row, importId, kind: row.amountCents > 0 ? 'income' : 'expense' })
  }

  return { duplicates, matches, inserts }
}
