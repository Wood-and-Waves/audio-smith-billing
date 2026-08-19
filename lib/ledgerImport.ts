// The dedupe/match brain for a bank-statement import. This is YNAB's rule,
// proven for a decade: an imported row either already exists (its import id
// is one the register has seen), or it adopts a manual row someone typed in
// before the statement arrived (same amount, close date), or it's genuinely
// new. Getting this wrong means either a client dinner appears twice or a
// hand-entered expense gets orphaned next to its own bank line. A fourth,
// narrower outcome: a $0.00 line has no sign to classify by and no money to
// book, so it's skipped rather than forced into income or expense.
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
  // Carried through so importOfx's match-application can decide whether
  // adopting this row is allowed to write 'cleared' (its normal outcome) or
  // must preserve 'reconciled' instead — this planner itself makes no
  // decision based on it: matching a reconciled manual row is still correct
  // (see the "still matchable" test), it's the WRITE after the match that
  // must not downgrade an already-locked row.
  cleared: 'uncleared' | 'cleared' | 'reconciled'
}

export type ImportPlan = {
  duplicates: ParsedOfxTxn[]
  matches: { row: ParsedOfxTxn; importId: string; existingId: string }[]
  inserts: { row: ParsedOfxTxn; importId: string; kind: 'income' | 'expense' }[]
  // A $0.00 bank line (an auth-hold reversal, typically) carries no money to
  // book. It can't be classified income or expense — the DB check
  // expense ⇒ amount < 0 would reject a zero-amount expense row and abort
  // the whole batch — so it's set aside here instead. The UI reports a count.
  skipped: ParsedOfxTxn[]
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
 * Seeds two per-key facts from existing GEN import ids: `count` (how many
 * rows of that key already exist) and `maxN` (the highest suffix ever
 * issued for it). planImport compares each batch row's OCCURRENCE POSITION
 * within the key against `count` to decide duplicate vs. new — see the doc
 * comment there — and anchors a genuinely-new occurrence's id at `maxN`, so
 * it can never collide with a surviving higher suffix even after some id in
 * between was deleted (":1" and ":3" survive, ":2" is gone: `count` is 2,
 * `maxN` is 3, so the next new occurrence is ":4", not the ":3" a
 * count-only scheme would propose and collide with the survivor).
 */
function seedGenCounters(existing: ExistingTxn[]): { count: Map<string, number>; maxN: Map<string, number> } {
  const count = new Map<string, number>()
  const maxN = new Map<string, number>()
  for (const e of existing) {
    if (!e.import_id || !e.import_id.startsWith('GEN:')) continue
    const rest = e.import_id.slice('GEN:'.length) // "<amountCents>:<date>:<n>"
    const sep = rest.lastIndexOf(':')
    const key = rest.slice(0, sep)
    const n = Number(rest.slice(sep + 1))
    if (!Number.isFinite(n)) continue
    count.set(key, (count.get(key) ?? 0) + 1)
    maxN.set(key, Math.max(maxN.get(key) ?? 0, n))
  }
  return { count, maxN }
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
  const { count: existingGenCount, maxN: genMaxN } = seedGenCounters(existing)
  // Position within the current batch, per (amountCents,date) key — counts
  // only GEN-eligible (fitid-less) rows of that key, in the order they're
  // walked below.
  const genBatchPosition = new Map<string, number>()
  // OFX ids this batch has already handed out (to a match or an insert), so
  // a second row in the SAME FILE proposing the same FITID reads as a
  // duplicate instead of double-claiming a manual row or racing itself on
  // insert (I3) — existingImportIds alone only catches ids from PAST
  // imports, not siblings within this one.
  const issuedThisBatch = new Set<string>()
  const claimed = new Set<string>()

  const duplicates: ParsedOfxTxn[] = []
  const matches: ImportPlan['matches'] = []
  const inserts: ImportPlan['inserts'] = []
  const skipped: ParsedOfxTxn[] = []

  for (const row of rows) {
    // A $0.00 line (e.g. an auth-hold reversal) is neither income nor
    // expense — there's no sign to classify it by, and the DB's
    // expense ⇒ amount < 0 check would reject it outright. Set it aside
    // before it ever claims an id or gets matched against a manual row.
    if (row.amountCents === 0) {
      skipped.push(row)
      continue
    }

    let importId: string

    if (row.fitid !== null && row.fitid.trim() !== '') {
      importId = `OFX:${row.fitid}`
      if (existingImportIds.has(importId) || issuedThisBatch.has(importId)) {
        duplicates.push(row)
        continue
      }
    } else {
      // GEN (fitid-less bank export): bank statements overlap on
      // re-download — the file Dan re-imports typically repeats rows the
      // ledger already has, in the same order, before it gets to anything
      // new. So rather than trust a max-based id to always be unseen (which
      // is exactly what let a re-import duplicate EVERY row: a fresh
      // maxN+1, maxN+2, … never collides with what's already there),
      // classify by OCCURRENCE POSITION: the Nth GEN row of this key in the
      // batch lines up with the Nth GEN row of this key already in the
      // ledger. Positions within `existingCount` are re-sends → duplicate;
      // only positions beyond it are genuinely new. New ids still count up
      // from `maxN` (not from `existingCount`), so a survivor from a
      // deleted row's gap is never collided with.
      //
      // The unavoidable ambiguity this can't resolve — a NON-overlapping
      // partial file whose same-amount-same-day row is genuinely new, not a
      // re-send — is resolved toward "duplicate": silently double-booking
      // real money is worse than a rare skipped insert Dan can key in by
      // hand.
      const key = `${row.amountCents}:${row.date}`
      const position = (genBatchPosition.get(key) ?? 0) + 1
      genBatchPosition.set(key, position)

      const existingCount = existingGenCount.get(key) ?? 0
      if (position <= existingCount) {
        duplicates.push(row)
        continue
      }

      const maxN = genMaxN.get(key) ?? 0
      importId = `GEN:${key}:${maxN + (position - existingCount)}`
    }

    const match = findMatch(row, existing, claimed)
    if (match) {
      claimed.add(match.id)
      matches.push({ row, importId, existingId: match.id })
      issuedThisBatch.add(importId)
      continue
    }

    inserts.push({ row, importId, kind: row.amountCents > 0 ? 'income' : 'expense' })
    issuedThisBatch.add(importId)
  }

  return { duplicates, matches, inserts, skipped }
}
