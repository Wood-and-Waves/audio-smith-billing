// Catching a receipt that has already been added.
//
// Dan: "That does happen sometimes where I'll scan the same receipt twice."
// It happens in two different ways, and they deserve different answers.
//
// The SAME FILE picked twice is a fact. It is knowable from the bytes, before
// anything is uploaded, so it costs neither an upload nor an API call — and
// there is nothing for a human to decide, so it is dropped silently.
//
// TWO PHOTOGRAPHS of one receipt is a guess. Vendor, amount and date agreeing
// is strong evidence and nothing more: two $6 coffees at the same Starbucks on
// the same day are two real expenses, and Dan is exactly the person that
// happens to. So that one is only ever FLAGGED — named, unticked, and his to
// overrule.
//
// Pure: no clock, no network, no hashing. The hashing lives in the component
// because it needs the browser's crypto; what arrives here is already a digest.

export type DuplicateCandidate = {
  vendor: string | null
  amountCents: number | null
  spentOn: string | null
}

/** A candidate plus something to call it when reporting a match. */
export type NamedCandidate = DuplicateCandidate & { label: string }

/**
 * Drops files whose bytes are identical to one already in the list.
 *
 * The first occurrence keeps its place — the list is in the order the photos
 * were picked, and reordering it would be surprising for no gain.
 */
export function dropExactRepeats<T extends { hash: string }>(
  files: T[],
): { kept: T[]; dropped: number } {
  const seen = new Set<string>()
  const kept: T[] = []
  for (const f of files) {
    if (seen.has(f.hash)) continue
    seen.add(f.hash)
    kept.push(f)
  }
  return { kept, dropped: files.length - kept.length }
}

/**
 * A comparable identity for a receipt, or null when there is nothing to
 * compare.
 *
 * The amount is what makes a receipt identifiable, so a candidate without one
 * can never be a duplicate. That matters: OCR returns null for an amount it
 * cannot read, and without this guard every unreadable receipt in a batch
 * would be flagged as a repeat of the last unreadable one.
 *
 * The vendor comes off a photograph, so it is never typed identically twice —
 * compared case-insensitively with its whitespace collapsed.
 */
export function receiptKey(c: DuplicateCandidate): string | null {
  if (c.amountCents === null || c.spentOn === null) return null
  const vendor = (c.vendor ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
  return `${vendor}|${c.amountCents}|${c.spentOn}`
}

/**
 * What this receipt appears to repeat, or null.
 *
 * `earlier` is everything it could be a repeat OF: rows above it in the batch,
 * and the expenses already on the show. That second half is the case Dan
 * described — photographing the same receipt a week apart — which a
 * batch-only check would miss entirely.
 *
 * Returns the matched thing's label so the warning can name it. A warning that
 * says only "possible duplicate" leaves him to go and find which one.
 */
export function duplicateOf(
  candidate: DuplicateCandidate,
  earlier: NamedCandidate[],
): string | null {
  const key = receiptKey(candidate)
  if (key === null) return null
  for (const other of earlier) {
    if (receiptKey(other) === key) return other.label
  }
  return null
}

/**
 * Flags every row against everything before it, in one deterministic pass.
 *
 * The incremental check that runs as each receipt finishes reading gives
 * immediate feedback, but it has a hole: with several receipts in flight, a row
 * that finishes early compares itself against rows above it that have not been
 * read yet and therefore have no amount to compare. Two photographs of one
 * receipt at positions 1 and 3 would slip through whenever 3 finished first —
 * precisely the case this feature exists to catch.
 *
 * Running this once the batch settles closes that, because it walks by POSITION
 * rather than by completion order and so produces the same answer every time.
 */
export function markDuplicates(
  rows: NamedCandidate[],
  existing: NamedCandidate[],
): (string | null)[] {
  return rows.map((row, i) => duplicateOf(row, [...rows.slice(0, i), ...existing]))
}
