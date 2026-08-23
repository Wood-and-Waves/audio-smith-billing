// The decision behind categoryOwnedByCaller (app/money/budget/actions.ts),
// pulled out pure so node --test can pin it. This app's rule is "server
// actions are deliberately untested — extract their brains into pure libs
// instead" (lib/ledgerRules.ts is the model), but this one specific check
// earns the exception the rest of the action doesn't get: it is the first
// write path onto the owner's live books, and this exact bug class already
// regressed once inside this same budget wave and needed a second review
// pass to catch it (see git history around 80f2a4a). It also happens to be
// the rare guard whose whole job is branching over a `{ data, error }`
// shape someone else already fetched — nothing here touches Postgres.
//
// The action still owns the actual query (`.from('ledger_categories')
// .select('owner_id').eq('id', categoryId).maybeSingle()`); this file only
// owns what to do once that call resolves.
//
// No '@/' imports and no JSX — exercised by node --test, same as
// lib/ledgerRules.ts.

export type OwnershipCheck = { ok: true } | { ok: false; error: string }

/**
 * `error` is checked and returned on BEFORE any presence test on `data` —
 * same fail-direction rule this app applies to every guard read that gates
 * a money write (see CLAUDE.md): a blown-up query must fail CLOSED, not be
 * read as "no such category" and wave the caller through to the write it
 * was supposed to block. A caller that also happens to hand in a `data`
 * that would otherwise pass (a matching owner_id) must still be refused
 * when `error` is set — the whole point of this ordering is that it never
 * falls through to success on a failed read.
 */
export function decideCategoryOwnership(
  data: { owner_id: string } | null,
  error: { message: string } | null,
  ownerId: string,
): OwnershipCheck | null {
  if (error) return { ok: false, error: error.message }
  if (!data || data.owner_id !== ownerId) {
    return { ok: false, error: 'That category does not belong to you.' }
  }
  return null
}
