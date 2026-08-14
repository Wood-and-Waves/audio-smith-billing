'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { isPlainDate } from '@/lib/dates'
import { CATEGORY_ORDER, type ExpenseCategory } from '@/lib/expenses'

type Fail = { error: string }

/** How long a receipt link lives. Longer than any render, shorter than a leak. */
const SIGNED_URL_SECONDS = 3600

/**
 * Records an expense.
 *
 * The FILES ARE ALREADY UPLOADED by the time this runs — the browser puts them
 * straight into Storage, both because a phone photo exceeds Next's 1MB server
 * action body limit and because a row pointing at a failed upload is a receipt
 * that appears to exist and cannot be opened. Since a receipt is what makes an
 * expense billable, that would let a show bill with a broken attachment.
 */
export async function addExpense(input: {
  showId: string
  category: ExpenseCategory
  whereSpent: string
  amountCents: number
  spentOn: string
  receiptPath: string | null
  receiptOriginal: string | null
  note: string
}): Promise<Fail | { ok: true; id: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  const { data: show } = await supabase
    .from('shows').select('status').eq('id', input.showId).maybeSingle()
  if (!show) return { error: 'That show no longer exists.' }
  if (show.status === 'billed') return { error: 'This show is billed. Unlink it before editing.' }

  if (!CATEGORY_ORDER.includes(input.category)) {
    return { error: `"${input.category}" is not an expense category.` }
  }
  if (!input.whereSpent.trim()) return { error: 'Say where the money went.' }
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    return { error: 'An expense needs an amount greater than zero.' }
  }
  if (!isPlainDate(input.spentOn)) return { error: 'Pick the date of the expense.' }

  const { data, error } = await supabase.from('expenses').insert({
    owner_id: user.id,
    show_id: input.showId,
    category: input.category,
    where_spent: input.whereSpent.trim(),
    amount_cents: input.amountCents,
    spent_on: input.spentOn,
    receipt_path: input.receiptPath,
    receipt_original: input.receiptOriginal,
    note: input.note.trim() || null,
  }).select('id').single()
  if (error) return { error: error.message }

  revalidatePath(`/shows/${input.showId}`)
  return { ok: true, id: data.id }
}

/** Removes an expense and its receipt files. */
export async function deleteExpense(expenseId: string): Promise<Fail | { ok: true; warning?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not signed in.' }

  // Derive the lock from the expense's own show, never a caller-supplied id.
  const { data: expense } = await supabase
    .from('expenses')
    .select('show_id, receipt_path, receipt_original, shows(status)')
    .eq('id', expenseId).maybeSingle()
  if (!expense) return { error: 'That expense no longer exists.' }

  const row = expense as unknown as {
    show_id: string
    receipt_path: string | null
    receipt_original: string | null
    shows: { status: string } | null
  }
  if (row.shows?.status === 'billed') {
    return { error: 'This show is billed. Unlink it before editing.' }
  }

  const { error } = await supabase.from('expenses').delete().eq('id', expenseId)
  if (error) return { error: error.message }

  // Files after the row: an orphaned file costs storage, an orphaned row costs
  // a receipt that cannot be opened.
  const paths = [row.receipt_path, row.receipt_original].filter(Boolean) as string[]
  let warning: string | undefined
  if (paths.length) {
    const { error: storageError } = await supabase.storage.from('receipts').remove(paths)
    // The row is already gone by this point — there is nothing to roll back,
    // so a storage failure here is a warning about a leftover file, not a
    // reason to report the delete itself as failed.
    if (storageError) {
      warning = `The expense was deleted, but its receipt file${paths.length === 1 ? '' : 's'} ` +
        `could not be removed from storage: ${storageError.message}`
    }
  }

  revalidatePath(`/shows/${row.show_id}`)
  return warning ? { ok: true, warning } : { ok: true }
}

/** Short-lived read URLs, keyed by storage path. */
export async function signedReceiptUrls(paths: string[]): Promise<Record<string, string>> {
  if (paths.length === 0) return {}
  const supabase = await createClient()
  const { data, error } = await supabase.storage
    .from('receipts').createSignedUrls(paths, SIGNED_URL_SECONDS)
  if (error || !data) return {}

  const out: Record<string, string> = {}
  for (const row of data) {
    if (row.path && row.signedUrl) out[row.path] = row.signedUrl
  }
  return out
}
