'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { isPlainDate } from '@/lib/dates'

/**
 * Same return shape everywhere in this file, spelled out by Task 7's own
 * interface contract rather than this app's more common `{ error } |
 * { ok: true }` (see app/shows/actions.ts's own `Fail`) — `ok` is always
 * present here, so a caller can branch on `result.ok` without an `in` check.
 */
type Result = { ok: true } | { ok: false; error: string }

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
 */
async function categoryOwnedByCaller(
  supabase: Awaited<ReturnType<typeof createClient>>,
  categoryId: string,
  ownerId: string,
): Promise<Result | null> {
  const { data, error } = await supabase
    .from('ledger_categories')
    .select('owner_id')
    .eq('id', categoryId)
    .maybeSingle()
  if (error) return { ok: false, error: error.message }
  if (!data || data.owner_id !== ownerId) {
    return { ok: false, error: 'That category does not belong to you.' }
  }
  return null
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
