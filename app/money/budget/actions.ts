'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { isPlainDate, todayInChicago } from '@/lib/dates'
import { FIRST_BUDGET_MONTH, MAX_MONTHS_AHEAD } from '@/lib/budget'
import { decideCategoryOwnership } from '@/lib/categoryOwnership'
import { assignmentDiff, validBudgetMonth, redoTarget } from '@/lib/budgetMoves'

/**
 * Same return shape everywhere in this file, spelled out by Task 7's own
 * interface contract rather than this app's more common `{ error } |
 * { ok: true }` (see app/shows/actions.ts's own `Fail`) — `ok` is always
 * present here, so a caller can branch on `result.ok` without an `in` check.
 */
type Result = { ok: true } | { ok: false; error: string }

/**
 * Same shape as `Result`, plus `wrote` on success. Budget-phase-two's four
 * move-writing actions below can each legitimately do nothing on a call
 * that is otherwise entirely valid — typing back the figure already on
 * screen (assignmentDiff's own null), undo with nothing active, redo with
 * nothing undone or superseded (redoTarget's 'nothing'/'superseded'), or a
 * raced double-undo/redo the update's own row filter turns into a no-op —
 * and every one of those is success, not an error. `wrote` is how the
 * caller (AssignedCell's "Saving…" state; BudgetHistory's own button
 * disabling) tells "a move actually landed" from "correctly did nothing"
 * instead of collapsing both into the same silent `{ ok: true }`.
 */
type WriteResult = { ok: true; wrote: boolean } | { ok: false; error: string }

// Same precedent as app/money/actions.ts's own UUID const: a caller-supplied
// category id lands unescaped in a PostgREST `.or(...)` filter string below
// (currentAssignedCents' aggregate select) — a malformed id is refused here,
// upstream of any query, rather than trusted to fail safely once it reaches
// Postgres.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Confirms `categoryId` is a real category owned by the caller, walking the
 * category's own `owner_id` rather than trusting the id itself — the same
 * rule setTravelLeg (app/shows/actions.ts) applies to a show day's lock,
 * "never trust a caller-supplied id for an authorisation decision." It
 * matters here specifically because RLS does not cover this case: the
 * policy on `ledger_category_targets` only tests `owner_id = auth.uid()`,
 * and both actions below write `owner_id: user.id` themselves, so a forged
 * `categoryId` belonging to someone else would satisfy the policy AND the
 * foreign key (the category genuinely exists) while still writing a target
 * onto another owner's category.
 *
 * `error` is destructured and checked before any presence test on `data` —
 * a failed read must fail closed. Checking `!data` first would read a
 * blown-up query the same as "no such category," and calmly let the caller
 * carry on into the write it was supposed to block.
 *
 * The read lives here (it needs a live Supabase client); the decision on
 * what to do with it is `decideCategoryOwnership` (lib/categoryOwnership.ts)
 * — pulled out so that exact branch, including the fail-closed ordering,
 * runs under node --test without a database. This action is otherwise
 * deliberately untested, same as every other Server Action in this app; this
 * one check earns the exception (see that file's own comment for why).
 *
 * `opts.requireAssignable` is budget-phase-two's own addition: the four
 * move-writing actions below need `budget_role`/`hidden` refused too (an
 * income-role or hidden category is not a legal assignment target or
 * source), while setCategoryTarget/clearCategoryTarget above only ever need
 * plain ownership. Rather than branch the *query* on the flag — a dynamic
 * column list the untyped Supabase client would happily accept but a human
 * reader has to double back to verify — this always selects the same three
 * columns (one row by primary key; the extra two cost nothing) and instead
 * strips `budget_role`/`hidden` back off before they ever reach
 * decideCategoryOwnership when the flag is unset. That keeps
 * setCategoryTarget/clearCategoryTarget's own behavior byte-for-byte
 * unchanged — decideCategoryOwnership only enforces those two checks when
 * it actually receives the fields to check.
 */
async function categoryOwnedByCaller(
  supabase: Awaited<ReturnType<typeof createClient>>,
  categoryId: string,
  ownerId: string,
  opts?: { requireAssignable?: boolean },
): Promise<Result | null> {
  const { data, error } = await supabase
    .from('ledger_categories')
    .select('owner_id, budget_role, hidden')
    .eq('id', categoryId)
    .maybeSingle()
  const row = !data
    ? null
    : opts?.requireAssignable
      ? data
      : { owner_id: data.owner_id }
  return decideCategoryOwnership(row, error, ownerId)
}

/**
 * Sets (or replaces) a category's target. Follows setDayHalfDay
 * (app/shows/actions.ts:955-981): auth is checked for presence only, and
 * the write itself carries no `.eq('owner_id', …)` — but unlike
 * setDayHalfDay's own category, `categoryId` here is never trusted outright;
 * categoryOwnedByCaller above walks it back to its own `owner_id` first, the
 * same "never trust a caller-supplied id" rule setTravelLeg applies to a
 * show day. The one write still ends in a single revalidatePath.
 *
 * amountCents arrives already parsed — TargetEditor runs the raw field
 * through lib/money's parseUSD before ever calling this, the same split
 * every other action in this app uses (see createLedgerAccount's own
 * `openingBalanceCents: number` in app/money/actions.ts). Re-running
 * parseUSD on a number here would be actively wrong: its number branch
 * treats a bare number as DOLLARS and multiplies by 100, which would
 * silently 100x an amount that's already in cents. So this validates the
 * integer directly instead — belt-and-suspenders against a caller that
 * skips the client and posts a bad number straight at the action, which is
 * exactly the case that matters when the write lands on the owner's live
 * books.
 *
 * `monthly` forcing due_date to null (rather than rejecting a caller that
 * sent one) mirrors the DB's own check constraint
 * (`(kind = 'by_date') = (due_date is not null)`, migration 0038) — the
 * server decides what due_date means for a monthly target, not the caller.
 */
export async function setCategoryTarget(
  categoryId: string,
  kind: 'monthly' | 'by_date',
  amountCents: number,
  dueDate: string | null,
): Promise<Result> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'Not signed in.' }

  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
    return { ok: false, error: 'Enter a target amount greater than zero.' }
  }

  if (kind === 'by_date' && (!dueDate || !isPlainDate(dueDate))) {
    return { ok: false, error: 'Pick a valid target date.' }
  }

  const authError = await categoryOwnedByCaller(supabase, categoryId, user.id)
  if (authError) return authError

  const { error } = await supabase.from('ledger_category_targets').upsert(
    {
      owner_id: user.id,
      category_id: categoryId,
      kind,
      amount_cents: amountCents,
      due_date: kind === 'monthly' ? null : dueDate,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'category_id' },
  )
  if (error) return { ok: false, error: error.message }

  revalidatePath('/money/budget')
  return { ok: true }
}

/** Removes a category's target entirely. Deleting zero rows (no target set
 *  yet) is not an error — Supabase's delete doesn't complain when nothing
 *  matches, so this is safe to call even from a row that has nothing to
 *  clear. `categoryId` is walked back to its own `owner_id` the same way
 *  setCategoryTarget does, before the delete — see categoryOwnedByCaller
 *  above for why RLS alone does not cover this. */
export async function clearCategoryTarget(categoryId: string): Promise<Result> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'Not signed in.' }

  const authError = await categoryOwnedByCaller(supabase, categoryId, user.id)
  if (authError) return authError

  const { error } = await supabase
    .from('ledger_category_targets')
    .delete()
    .eq('category_id', categoryId)
  if (error) return { ok: false, error: error.message }

  revalidatePath('/money/budget')
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Budget-phase-two: the four move-writing actions. Every mutation below is
// either an INSERT into `ledger_budget_moves` or an UPDATE of exactly its
// `undone_at` column — no move row is ever updated any other way, and none
// is ever deleted (0038's own doctrine; see that migration's header
// comment). RTA may go negative and a category may go negative; neither
// gets a balance check here — that is the design's own explicit rule
// (YNAB's own "More Assigned Than You Have" banner is the feedback, not a
// server refusal), so none is added.

/**
 * The server-side "current assigned" a typed figure's diff gets computed
 * against — never a client-supplied number, so a stale tab cannot
 * double-assign. Mirrors lib/budget.ts's own `assignedBy` fold inside
 * buildBudget: a category's assigned(month) is the sum of its moves IN
 * minus its moves OUT that month, ignoring any row with `undone_at` set —
 * same doctrine, computed here for one (category, month) pair instead of
 * every category and month buildBudget covers at once.
 *
 * One aggregate select, not paged: the per-month, per-category move count
 * is nowhere near Supabase's 1000-row page cap (CLAUDE.md's own pagination
 * rule exists for exactly that cap, and fetchAllBudgetMoves in
 * app/money/budget/page.tsx is where it actually applies — a whole owner's
 * history, not one category's one month). Ordered by nothing; every row
 * gets summed regardless of order.
 *
 * The final review (2026-08-24) added the explicit `.limit(MAX_MOVES)` and
 * the `data.length === MAX_MOVES` refusal below: "nowhere near the cap" is
 * true today, but a silently truncated page here isn't a missing row on
 * screen the way it is elsewhere — it's a WRONG diff computed against a
 * partial sum and then written straight onto Dan's live books, with no
 * indication anything was off. Hitting exactly `MAX_MOVES` rows is refused
 * outright rather than summed against a partial read, matching this app's
 * own fail-closed rule for a guard that gates a money write (CLAUDE.md).
 *
 * `categoryId` must already be UUID-shape-checked by the caller — it lands
 * unescaped in the `.or(...)` filter string below, the same hazard
 * incomeRoleChangeAllowed (app/money/actions.ts) already guards the same
 * way. `owner_id` is filtered explicitly (CLAUDE.md's owner-scoping rule
 * for a sensitive read) even though RLS already covers the same ground —
 * belt-and-suspenders on the one read a live-budget write is about to
 * trust completely.
 *
 * `error` is destructured and checked before any arithmetic runs — a failed
 * read must fail closed, same as categoryOwnedByCaller above; misreading a
 * blown-up query's `null` data as "nothing assigned yet" would make a
 * failed read look like an honest zero and let a wildly wrong diff through.
 */
const MAX_MOVES_PER_CATEGORY_MONTH = 1000

async function currentAssignedCents(
  supabase: Awaited<ReturnType<typeof createClient>>,
  categoryId: string,
  month: string,
  ownerId: string,
): Promise<{ ok: true; cents: number } | { ok: false; error: string }> {
  const { data, error } = await supabase
    .from('ledger_budget_moves')
    .select('from_category_id, to_category_id, amount_cents')
    .eq('owner_id', ownerId)
    .eq('month', month)
    .is('undone_at', null)
    .or(`from_category_id.eq.${categoryId},to_category_id.eq.${categoryId}`)
    .limit(MAX_MOVES_PER_CATEGORY_MONTH)
  if (error) return { ok: false, error: error.message }
  if ((data ?? []).length === MAX_MOVES_PER_CATEGORY_MONTH) {
    return {
      ok: false,
      error: 'Too many moves recorded for this category this month to total safely. Contact support before assigning here.',
    }
  }
  const cents = (data ?? []).reduce((sum, row) => {
    if (row.to_category_id === categoryId) return sum + row.amount_cents
    if (row.from_category_id === categoryId) return sum - row.amount_cents
    return sum
  }, 0)
  return { ok: true, cents }
}

/**
 * Typing a figure into a category's Assigned cell. Writes the DIFFERENCE
 * between the typed figure and what is actually assigned server-side —
 * never the client's own number — computed by assignmentDiff
 * (lib/budgetMoves.ts). This is the stale-tab guard the whole action exists
 * to enforce: a browser tab left open across a month boundary, or open in
 * two places at once, must not double-assign because it trusted its own
 * stale "current" figure instead of asking again. `currentAssignedCents`
 * above does the one read that makes that possible; this function only
 * orders the steps around it — validate → walk → read → decide → write, in
 * that order, so nothing after a failed step ever runs.
 *
 * `typedCents` MAY be negative — the final phase-two review (2026-08-24)
 * amended the plan's original "reject negatives" line: money carried out of
 * a category legitimately drives that month's Assigned negative, the cell
 * displays that figure, and re-entering it (even unchanged, on a plain
 * Enter) has to be a normal write rather than an error. Only the integer
 * shape is checked here — the sign is assignmentDiff's own business now
 * (lib/budgetMoves.ts's own doc comment there has the full reasoning; see
 * also docs/BACKLOG.md's phase-two entry for the amendment note).
 *
 * A no-op write (typedCents equals what is already assigned) is success,
 * not an error — `{ ok: true, wrote: false }` — nothing about the request
 * was wrong; there was simply nothing to do.
 */
export async function assignToCategory(
  categoryId: string,
  month: string,
  typedCents: number,
): Promise<WriteResult> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'Not signed in.' }

  if (!Number.isSafeInteger(typedCents)) {
    return { ok: false, error: 'Enter a valid amount.' }
  }

  const validMonth = validBudgetMonth(
    month, todayInChicago().slice(0, 7), FIRST_BUDGET_MONTH, MAX_MONTHS_AHEAD,
  )
  if (!validMonth) return { ok: false, error: "That month is outside the budget's range." }

  if (!UUID.test(categoryId)) return { ok: false, error: 'That category does not belong to you.' }

  // Narrowed on `!authError.ok` (not just truthiness) so this assigns
  // cleanly into WriteResult: `Result`'s `{ ok: true }` branch is dead code
  // in practice (decideCategoryOwnership only ever returns `null` for
  // success, never `{ ok: true }`) but the type still carries it, and
  // WriteResult's own `{ ok: true }` requires a `wrote` field Result's
  // doesn't have — this narrowing is what tells the compiler (and a future
  // reader) that only the failure branch ever actually reaches here.
  const authError = await categoryOwnedByCaller(
    supabase, categoryId, user.id, { requireAssignable: true },
  )
  if (authError && !authError.ok) return { ok: false, error: authError.error }

  const current = await currentAssignedCents(supabase, categoryId, validMonth, user.id)
  if (!current.ok) return current

  const move = assignmentDiff(categoryId, current.cents, typedCents)
  if (!move) return { ok: true, wrote: false }

  const { error } = await supabase.from('ledger_budget_moves').insert({
    owner_id: user.id,
    month: validMonth,
    from_category_id: move.fromCategoryId,
    to_category_id: move.toCategoryId,
    amount_cents: move.amountCents,
    note: null,
  })
  if (error) return { ok: false, error: error.message }

  revalidatePath('/money/budget')
  return { ok: true, wrote: true }
}

/**
 * Moving money directly between two categories (the Available pill's own
 * dialog, Task 3), or between a category and Ready to Assign when one side
 * is `null`. Mirrors 0038's own three move-shape checks in its refusal
 * messages, rather than letting a caller find out only from a raw Postgres
 * constraint-violation message:
 *   - `lbm_somewhere`: not both sides null.
 *   - `lbm_direction`: the two sides must differ (no self-move).
 *   - `amount_cents > 0`: validated as a positive safe integer up front,
 *     the same shape check setCategoryTarget already applies to its own
 *     amount.
 *
 * Both non-null ids are walked through categoryOwnedByCaller with
 * `requireAssignable` — an income-role or hidden category is refused as
 * either a source or a target, matching assignToCategory's own rule.
 * `null` (Ready to Assign) needs no walk; it is not a row to own.
 */
export async function moveBetweenCategories(
  fromCategoryId: string | null,
  toCategoryId: string | null,
  month: string,
  amountCents: number,
): Promise<Result> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'Not signed in.' }

  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
    return { ok: false, error: 'Enter an amount greater than zero.' }
  }

  if (fromCategoryId === null && toCategoryId === null) {
    return { ok: false, error: 'Pick a category to move money from or to.' }
  }
  if (fromCategoryId !== null && toCategoryId !== null && fromCategoryId === toCategoryId) {
    return { ok: false, error: 'Pick two different categories.' }
  }

  const validMonth = validBudgetMonth(
    month, todayInChicago().slice(0, 7), FIRST_BUDGET_MONTH, MAX_MONTHS_AHEAD,
  )
  if (!validMonth) return { ok: false, error: "That month is outside the budget's range." }

  for (const id of [fromCategoryId, toCategoryId]) {
    if (id === null) continue
    if (!UUID.test(id)) return { ok: false, error: 'That category does not belong to you.' }
    const authError = await categoryOwnedByCaller(supabase, id, user.id, { requireAssignable: true })
    if (authError) return authError
  }

  const { error } = await supabase.from('ledger_budget_moves').insert({
    owner_id: user.id,
    month: validMonth,
    from_category_id: fromCategoryId,
    to_category_id: toCategoryId,
    amount_cents: amountCents,
    note: null,
  })
  if (error) return { ok: false, error: error.message }

  revalidatePath('/money/budget')
  return { ok: true }
}

/**
 * One move row's id + created_at, newest first by the register's own
 * tie-break order (`created_at desc, id desc` — `lbm_owner_created_idx`,
 * migration 0038). Paired with newestUndoneMove below: this one reads the
 * newest ACTIVE move (`undone_at is null`) — what undo marks, and what
 * redo compares its own candidate against. `owner_id` is filtered
 * explicitly (CLAUDE.md's owner-scoping rule) even though RLS already
 * restricts every row here to the caller — belt-and-suspenders on the read
 * a live undo/redo is about to act on.
 */
async function newestActiveMove(
  supabase: Awaited<ReturnType<typeof createClient>>,
  ownerId: string,
): Promise<
  { ok: true; row: { id: string; created_at: string } | null } | { ok: false; error: string }
> {
  const { data, error } = await supabase
    .from('ledger_budget_moves')
    .select('id, created_at')
    .eq('owner_id', ownerId)
    .is('undone_at', null)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) return { ok: false, error: error.message }
  return { ok: true, row: data }
}

/**
 * The redo-direction mirror of newestActiveMove above: the newest UNDONE
 * move (`undone_at is not null`) — what redo would clear.
 *
 * Ordered by `undone_at desc` FIRST, then `created_at desc, id desc` — NOT
 * `created_at desc, id desc` alone, which is what this read used before the
 * final phase-two review (2026-08-24) caught it. The backfill writes every
 * imported move inside ONE transaction, so every imported row shares one
 * `created_at`; once undo walks past the hand-entered moves into the
 * backfill, `created_at desc, id desc` falls to comparing random UUIDs and
 * picks an ARBITRARY backfill row as the redo candidate — not the one that
 * was actually undone most recently. Ordering by `undone_at` first makes
 * this read the true inverse of undoLastMove's own write (which always sets
 * `undone_at` to "now" on whatever it just marked): the row THIS query
 * returns is, by construction, the row that was undone last.
 *
 * `redoTarget` (lib/budgetMoves.ts) itself is untouched by this — it still
 * compares the returned row's `(created_at, id)` tuple against the newest
 * active move exactly as before ('superseded' is about the register's real
 * chronological order, not about undo order); only WHICH row this function
 * hands it as `newestUndone` changes. This is NOT a no-op for hand moves:
 * a two-deep undo under the old order offered the wrong row for redo and
 * then stranded the other one as 'superseded' — see
 * `isNewerUndone`'s own doc comment (lib/budgetMoves.ts) for the pure
 * version of this same comparator, shared with this file's own SQL order so
 * app/money/budget/page.tsx's matching derivation can never drift from it.
 */
async function newestUndoneMove(
  supabase: Awaited<ReturnType<typeof createClient>>,
  ownerId: string,
): Promise<
  { ok: true; row: { id: string; created_at: string } | null } | { ok: false; error: string }
> {
  const { data, error } = await supabase
    .from('ledger_budget_moves')
    .select('id, created_at, undone_at')
    .eq('owner_id', ownerId)
    .not('undone_at', 'is', null)
    .order('undone_at', { ascending: false })
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) return { ok: false, error: error.message }
  return { ok: true, row: data }
}

/**
 * Undo marks the newest active move as undone; it is never deleted (0038's
 * own doctrine, restated at this section's own header). "Newest" is the
 * register's own tie-break order, the same order newestActiveMove reads by.
 *
 * The update's own filter carries BOTH the row's id AND `.is('undone_at',
 * null)` — not just the id — so two requests racing to undo the same move
 * produce one no-op, never a double-flip: whichever UPDATE lands first
 * flips the row, so the loser's WHERE clause (`undone_at is null`) no
 * longer matches it and updates zero rows. `.select('id')` on the update
 * (same idiom as deleteDraftInvoice, app/invoices/actions.ts) is how that
 * is told apart from a real failure: `updated.length === 0` here is a
 * benign race, reported as `wrote: false`, not an error.
 *
 * ACCEPTED TOCTOU (final review, 2026-08-24): the "this is the newest move"
 * precondition is READ by newestActiveMove above but never RE-ASSERTED in
 * the UPDATE's own WHERE — the filter only re-checks the row's id and
 * `undone_at is null`, not that it is STILL the newest active row at write
 * time. Two genuinely concurrent Undo requests can read the same "newest"
 * row, and if a third request inserts a fresh move in the gap between one
 * caller's read and its write, that caller's UPDATE still lands on the row
 * it read, which is now the SECOND-newest, not the newest. Accepted, not
 * hardened, because it cannot corrupt anything: the only column that ever
 * moves is `undone_at`, every 0038 constraint still holds on the row
 * either way, and buildBudget re-derives the whole budget truthfully from
 * whatever `undone_at` ends up set to — the worst case is undoing a move
 * that isn't the one Dan meant, which Recent Moves shows plainly and a
 * second Undo/Redo click corrects. Dan is the only writer today, so this
 * gap has no real caller. If a second writer is ever added, the hardening
 * path is a check-and-update RPC — one atomic UPDATE ... WHERE id = (SELECT
 * ... ORDER BY ... LIMIT 1) RETURNING ..., the same model
 * `allocate_invoice_number` (migration 0002) uses to make Postgres
 * serialise the read-then-write instead of this file doing it in two
 * round-trips.
 */
export async function undoLastMove(): Promise<WriteResult> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'Not signed in.' }

  const active = await newestActiveMove(supabase, user.id)
  if (!active.ok) return active
  if (!active.row) return { ok: true, wrote: false }

  const { data: updated, error } = await supabase
    .from('ledger_budget_moves')
    .update({ undone_at: new Date().toISOString() })
    .eq('id', active.row.id)
    .eq('owner_id', user.id)
    .is('undone_at', null)
    .select('id')
  if (error) return { ok: false, error: error.message }

  revalidatePath('/money/budget')
  return { ok: true, wrote: (updated ?? []).length > 0 }
}

/**
 * Redo clears `undone_at` on the newest undone move — but only when
 * redoTarget (lib/budgetMoves.ts) says 'ok'. 'nothing' (no undone move at
 * all) and 'superseded' (a fresh move landed after the undo, so
 * resurrecting the undone one would resurrect a state that predates
 * something already built on top of it — standard editor semantics: undo,
 * then a new edit, kills redo) are both reported the same way undo's own
 * race is — `{ ok: true, wrote: false }`. Neither means this call did
 * anything wrong: BudgetHistory's own two `.limit(1)` reads (Task 4) are
 * what keep the Redo button disabled in the ordinary case; this is the
 * same honest-nothing-happened answer for the race a disabled button
 * cannot fully close (two tabs; one makes a new move between the other's
 * page load and its redo click).
 *
 * The two reads run in parallel (Promise.all) — independent of each other,
 * same as incomeRoleChangeAllowed's own four-way Promise.all
 * (app/money/actions.ts). The update's filter carries the row's id AND
 * `.not('undone_at', 'is', null)` — the redo-direction mirror of undo's own
 * `.is('undone_at', null)`, the same double-flip race guarded in reverse.
 *
 * ACCEPTED TOCTOU (final review, 2026-08-24): same shape as undoLastMove's
 * own — the newest-active/newest-undone reads above, and the `redoTarget`
 * decision made from them, are never RE-ASSERTED in the UPDATE's own WHERE.
 * Two genuinely concurrent Redo requests (or a Redo racing a fresh Assign
 * from a second tab) can both read `redoTarget` as `'ok'` and both proceed;
 * or a fresh active move can land in the gap between the read and the
 * write, so the row this call resurrects is, by the time it lands, already
 * SUPERSEDED. Accepted, not hardened, for the same reason as undo's own:
 * only `undone_at` ever moves, every 0038 constraint still holds, and
 * buildBudget re-derives truthfully either way — the worst case is
 * resurrecting a move Dan no longer wants active, visible in Recent Moves
 * and correctable with one more Undo. The hardening path, if a second
 * writer is ever added, is the same one undoLastMove's own comment
 * describes: a check-and-update RPC on the `allocate_invoice_number`
 * (migration 0002) model.
 */
export async function redoLastMove(): Promise<WriteResult> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'Not signed in.' }

  const [active, undone] = await Promise.all([
    newestActiveMove(supabase, user.id),
    newestUndoneMove(supabase, user.id),
  ])
  if (!active.ok) return active
  if (!undone.ok) return undone

  const target = redoTarget({ newestActive: active.row, newestUndone: undone.row })
  if (target !== 'ok' || !undone.row) return { ok: true, wrote: false }

  const { data: updated, error } = await supabase
    .from('ledger_budget_moves')
    .update({ undone_at: null })
    .eq('id', undone.row.id)
    .eq('owner_id', user.id)
    .not('undone_at', 'is', null)
    .select('id')
  if (error) return { ok: false, error: error.message }

  revalidatePath('/money/budget')
  return { ok: true, wrote: (updated ?? []).length > 0 }
}
