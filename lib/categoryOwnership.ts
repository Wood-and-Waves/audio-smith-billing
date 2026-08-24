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
//
// Grown for budget-phase-two's write paths (assignToCategory,
// moveBetweenCategories): a category id walked for those actions also needs
// to refuse an 'income'-role or `hidden` category — neither is a legal
// assignment target or source (the design's own rule; income rows are
// inflows to Ready to Assign, never budget rows, and a hidden category is
// off the budget screen entirely). Rather than a second decision function,
// `data` grew two optional fields so THIS function stays the one place that
// decision lives. setCategoryTarget/clearCategoryTarget's own call sites
// never select `budget_role`/`hidden` in the first place, so those two
// fields arrive `undefined` there and both new checks below are no-ops —
// their behavior is unchanged, byte for byte, by this growth.

export type OwnershipCheck = { ok: true } | { ok: false; error: string }

export type CategoryOwnershipRow = {
  owner_id: string
  /** Present only when the caller walked it — see the header comment above. */
  budget_role?: string
  hidden?: boolean
}

/**
 * `error` is checked and returned on BEFORE any presence test on `data` —
 * same fail-direction rule this app applies to every guard read that gates
 * a money write (see CLAUDE.md): a blown-up query must fail CLOSED, not be
 * read as "no such category" and wave the caller through to the write it
 * was supposed to block. A caller that also happens to hand in a `data`
 * that would otherwise pass (a matching owner_id) must still be refused
 * when `error` is set — the whole point of this ordering is that it never
 * falls through to success on a failed read.
 *
 * Ownership is decided before role/visibility: a category belonging to
 * someone else is refused with the ownership message even when it also
 * happens to be income or hidden — the caller should never learn anything
 * about a category it doesn't own beyond "not yours."
 */
export function decideCategoryOwnership(
  data: CategoryOwnershipRow | null,
  error: { message: string } | null,
  ownerId: string,
): OwnershipCheck | null {
  if (error) return { ok: false, error: error.message }
  if (!data || data.owner_id !== ownerId) {
    return { ok: false, error: 'That category does not belong to you.' }
  }
  if (data.budget_role === 'income') {
    return { ok: false, error: 'Income categories are not part of the budget.' }
  }
  if (data.hidden) {
    return { ok: false, error: 'Hidden categories cannot be assigned money.' }
  }
  return null
}
